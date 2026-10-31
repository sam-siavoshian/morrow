import {
  AcceptInviteBody,
  Id,
  RealtimeTicketBody,
  type InvitePreviewView,
  type MeView,
  type RealtimeTicketResponse,
  type RepoSummary,
} from "@morrow/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { toMeTeam, toTeamView, toUserView } from "../../actors/views.ts";
import { toRepoSummary, type GithubRepo } from "../../integrations/github/client.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { AppError, conflict, internalError, notFound, unauthenticated } from "../../lib/errors.ts";
import type { AppEnv } from "../context.ts";
import { describeZodError, readJson } from "../errors.ts";
import { githubTokenFor, mapGithubError } from "../githubAccess.ts";
import { rateLimit } from "../middleware.ts";
import { identityFor } from "./teams.ts";

const INVITE_CODE = /^[A-Za-z0-9_-]{43}$/;
const INVALID_INVITE = "This invite link is not valid.";
const SEARCH_PAGES = 5;

const ReposQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().trim().max(100).optional(),
});

/** `<teamId>.<code>`: team ids may contain dots, codes never do, so split on the last one. */
export function parseInviteToken(token: string): { teamId: string; code: string } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const teamId = token.slice(0, dot);
  const code = token.slice(dot + 1);
  if (!Id.safeParse(teamId).success || !INVITE_CODE.test(code)) return null;
  return { teamId, code };
}

/** Signed-in routes outside a team: /api/me, invites, GitHub repos, realtime tickets. */
export function coreRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/me", rateLimit("read"), async (c) => {
    const deps = c.get("deps");
    const userId = c.get("userId");
    const user = await deps.actors.getUser(userId);
    if (!user) throw unauthenticated();
    const teams = await Promise.all(user.teamIds.map((id) => deps.actors.getTeam(id)));
    const view: MeView = {
      user: toUserView(user),
      teams: teams.flatMap((t) => (t ? (toMeTeam(t, userId) ?? []) : [])),
      features: {
        freestyle: deps.env.freestyle !== null,
        relay: deps.env.relay !== null,
        githubWebUrl: deps.env.github.webUrl,
      },
    };
    return c.json(view);
  });

  /**
   * What `/join/[token]` shows before Accept. Every way an invite can be unusable (malformed, unknown team, wrong
   * code, expired, used up) answers the same 404, so this cannot be used to find teams. The code is hashed and
   * looked up by key exactly as accept does; the hash never leaves the actor.
   */
  r.get("/invites/preview", rateLimit("auth"), async (c) => {
    const deps = c.get("deps");
    const parsed = parseInviteToken(c.req.query("token") ?? "");
    const preview = parsed ? await deps.actors.getInvitePreview(parsed.teamId, sha256Hex(parsed.code), c.get("userId")) : null;
    if (!preview) throw notFound(INVALID_INVITE);
    let inviter = preview.inviter;
    if (!inviter) {
      // The creator left the team; their GitHub card still says who sent the link.
      const user = await deps.actors.getUser(preview.createdBy).catch(() => null);
      inviter = user ? { login: user.login, avatarUrl: user.avatarUrl } : null;
    }
    const view: InvitePreviewView = { teamName: preview.teamName, inviter, expiresAt: preview.expiresAt };
    return c.json(view);
  });

  r.post("/invites/accept", rateLimit("mutation"), async (c) => {
    const deps = c.get("deps");
    const userId = c.get("userId");
    const body = await readJson(c, AcceptInviteBody);
    const parsed = parseInviteToken(body.token);
    if (!parsed) throw notFound(INVALID_INVITE);
    const member = await identityFor(deps, userId);
    const result = await deps.actors.acceptInvite(parsed.teamId, { hash: sha256Hex(parsed.code), member });
    if (!result.ok) {
      if (result.reason === "expired") throw notFound("This invite has expired. Ask for a new link.");
      if (result.reason === "exhausted") throw conflict("This invite has been used up. Ask for a new link.");
      if (result.reason === "full") throw conflict("This team is full.");
      throw notFound(INVALID_INVITE);
    }
    // Idempotent: re-accepting as an existing member repairs the user's team list without spending a use.
    await deps.actors.addUserTeam(userId, parsed.teamId);
    const team = await deps.actors.getTeam(parsed.teamId);
    const view = team ? toTeamView(team, userId) : null;
    if (!view) throw internalError(new Error("joined team is not readable"));
    c.get("log").info("invite accepted", { teamId: parsed.teamId, alreadyMember: result.alreadyMember });
    return c.json(view, result.alreadyMember ? 200 : 201);
  });

  r.get("/github/repos", rateLimit("github"), async (c) => {
    const deps = c.get("deps");
    const query = ReposQuery.safeParse(c.req.query());
    if (!query.success) throw new AppError("bad_request", describeZodError(query.error));
    const { page, perPage, q } = query.data;
    const token = await githubTokenFor(deps, c.get("userId"));
    try {
      if (!q) {
        const { repos, hasMore } = await deps.github.listRepos(token, page, perPage);
        return c.json({ repos: repos.map(toRepoSummary) satisfies RepoSummary[], nextPage: hasMore ? page + 1 : null });
      }
      // GitHub has no "search my accessible repos" endpoint; filter the most recently pushed ones.
      const needle = q.toLowerCase();
      const matches: GithubRepo[] = [];
      for (let p = 1; p <= SEARCH_PAGES; p++) {
        const { repos, hasMore } = await deps.github.listRepos(token, p, 100);
        matches.push(...repos.filter((repo) => repo.full_name.toLowerCase().includes(needle)));
        if (!hasMore || matches.length >= page * perPage + 1) break;
      }
      const slice = matches.slice((page - 1) * perPage, page * perPage);
      return c.json({ repos: slice.map(toRepoSummary), nextPage: matches.length > page * perPage ? page + 1 : null });
    } catch (error) {
      throw mapGithubError(error);
    }
  });

  r.post("/realtime/ticket", rateLimit("ticket"), async (c) => {
    const deps = c.get("deps");
    const userId = c.get("userId");
    const { teamId } = await readJson(c, RealtimeTicketBody);
    const team = await deps.actors.getTeam(teamId);
    if (!team?.members.some((m) => m.userId === userId)) throw notFound("Team not found.");
    const { ticket, expiresAt } = deps.tickets.issue(userId, teamId);
    const response: RealtimeTicketResponse = { url: `${deps.env.realtimeUrl}/realtime?ticket=${encodeURIComponent(ticket)}`, expiresAt };
    return c.json(response);
  });

  return r;
}
