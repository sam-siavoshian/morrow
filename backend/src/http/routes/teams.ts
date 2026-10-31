import {
  CreateInviteBody,
  CreateTeamBody,
  Id,
  LinkProjectBody,
  RenameTeamBody,
  UpdateMemberRoleBody,
  UpdatePolicyBody,
  UpdateProjectBody,
  type CreateInviteResponse,
  type InviteListResponse,
  type ProjectView,
  type TeamView,
} from "@morrow/contracts";
import { Hono, type Context } from "hono";
import type { MemberIdentity, ProjectRecord } from "../../actors/types.ts";
import { toTeamView } from "../../actors/views.ts";
import { canPush } from "../../integrations/github/client.ts";
import { detectTestCommand } from "../../integrations/github/testCommand.ts";
import { randomToken, sha256Hex } from "../../lib/crypto.ts";
import { badRequest, conflict, forbidden, internalError, notFound } from "../../lib/errors.ts";
import { newId, slugify } from "../../lib/ids.ts";
import type { AppDeps, AppEnv } from "../context.ts";
import { readJson } from "../errors.ts";
import { githubTokenFor, mapGithubError } from "../githubAccess.ts";
import { rateLimit, requireTeam } from "../middleware.ts";
import { withTeamQuota } from "../quotas.ts";

const HOUR_MS = 60 * 60 * 1000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The actors refuse control characters in single-line fields; reject them here as a 400, not a 500. */
function assertSingleLine(value: string | null, field: string): void {
  if (value !== null && CONTROL_CHARS.test(value)) throw badRequest(`Invalid request. ${field}: must be a single line of text`);
}

export async function identityFor(deps: AppDeps, userId: string): Promise<MemberIdentity> {
  const user = await deps.actors.getUser(userId);
  // The session layer already proved the user exists; a vanished user here is an invariant break.
  if (!user) throw internalError(new Error(`user ${userId} disappeared mid-request`));
  return { userId, login: user.login, name: user.name, avatarUrl: user.avatarUrl };
}

/** The caller's view of the team right after a write, read back from the actor (the write's own truth). */
async function freshView(c: Context<AppEnv>, teamId: string): Promise<TeamView> {
  const team = await c.get("deps").actors.getTeam(teamId);
  const view = team ? toTeamView(team, c.get("userId")) : null;
  if (!view) throw notFound("Team not found.");
  return view;
}

/** Mounted under /api/teams behind requireSession + per-method rate limiting. */
export function teamRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("userId");
    const body = await readJson(c, CreateTeamBody);
    assertSingleLine(body.name, "name");
    const owner = await identityFor(deps, userId);
    const team = await withTeamQuota(deps.actors, userId, async () => {
      const teamId = newId("t");
      const created = await deps.actors.createTeam({ teamId, name: body.name, slug: slugify(body.name), owner });
      await deps.actors.addUserTeam(userId, teamId);
      return created;
    });
    const teamId = team.id;
    c.get("log").info("team created", { teamId });
    void deps.teamEvents.emitTeamCreated({ teamId, ownerUserId: userId });
    const view = toTeamView(team, userId);
    if (!view) throw internalError(new Error("team created without its owner"));
    return c.json(view, 201);
  });

  r.get("/:teamId", requireTeam(), (c) => {
    const view = toTeamView(c.get("team"), c.get("userId"));
    if (!view) throw notFound("Team not found.");
    return c.json(view);
  });

  /** Rename. The slug is kept: it was minted at creation. */
  r.patch("/:teamId", requireTeam("owner", "admin"), async (c) => {
    const team = c.get("team");
    const { name } = await readJson(c, RenameTeamBody);
    assertSingleLine(name, "name");
    await c.get("deps").actors.renameTeam(team.id, name);
    c.get("log").info("team renamed", { teamId: team.id });
    return c.json(await freshView(c, team.id));
  });

  /** Inspect and parallelism settings. Any subset; the actor merges it atomically. */
  r.patch("/:teamId/policy", requireTeam("owner", "admin"), async (c) => {
    const team = c.get("team");
    const patch = await readJson(c, UpdatePolicyBody);
    await c.get("deps").actors.setTeamPolicy(team.id, patch);
    c.get("log").info("team policy changed", { teamId: team.id, ...patch });
    return c.json(await freshView(c, team.id));
  });

  r.post("/:teamId/invites", requireTeam("owner", "admin"), async (c) => {
    const deps = c.get("deps");
    const body = await readJson(c, CreateInviteBody);
    const team = c.get("team");
    const code = randomToken(32);
    const id = newId("inv");
    const expiresAt = deps.now() + body.expiresInHours * HOUR_MS;
    await deps.actors.createInvite(team.id, { id, hash: sha256Hex(code), createdBy: c.get("userId"), expiresAt, maxUses: body.maxUses });
    c.get("log").info("invite created", { teamId: team.id, inviteId: id, maxUses: body.maxUses });
    const response: CreateInviteResponse = { id, url: `${deps.env.appOrigin}/join/${team.id}.${code}`, expiresAt };
    return c.json(response, 201);
  });

  /** Invites that still work. The code was shown once at creation and the hash never leaves the actor. */
  r.get("/:teamId/invites", requireTeam("owner", "admin"), async (c) => {
    const invites = await c.get("deps").actors.listInvites(c.get("team").id);
    return c.json({ invites } satisfies InviteListResponse);
  });

  r.delete("/:teamId/invites/:inviteId", requireTeam("owner", "admin"), async (c) => {
    const team = c.get("team");
    const inviteId = c.req.param("inviteId");
    if (!Id.safeParse(inviteId).success || !(await c.get("deps").actors.revokeInvite(team.id, inviteId))) throw notFound("Invite not found.");
    c.get("log").info("invite revoked", { teamId: team.id, inviteId });
    return c.body(null, 204);
  });

  /**
   * Owner: removes anyone but themselves. Admin: removes members only. Anyone but the owner may leave.
   * The owner cannot be removed (there is no ownership transfer yet).
   */
  r.delete("/:teamId/members/:userId", requireTeam(), async (c) => {
    const deps = c.get("deps");
    const team = c.get("team");
    const actorId = c.get("userId");
    const actorRole = c.get("role");
    const targetId = c.req.param("userId");
    const target = Id.safeParse(targetId).success ? team.members.find((m) => m.userId === targetId) : undefined;
    if (!target) throw notFound("Member not found.");
    const self = target.userId === actorId;
    if (target.role === "owner") throw forbidden(self ? "The owner cannot leave the team." : "The owner cannot be removed.");
    if (!self) {
      if (actorRole === "member") throw forbidden("Only owners and admins can remove members.");
      if (actorRole === "admin" && target.role !== "member") throw forbidden("Admins can only remove members.");
    }
    const result = await deps.actors.removeMember(team.id, target.userId);
    if (!result.ok) throw forbidden("The owner cannot be removed.");
    await deps.actors.removeUserTeam(target.userId, team.id);
    deps.hub.kick(team.id, target.userId);
    c.get("log").info("member removed", { teamId: team.id, targetUserId: target.userId, self });
    void deps.teamEvents.emitMemberRemoved({ teamId: team.id, userId: target.userId, removedBy: actorId });
    return c.body(null, 204);
  });

  /**
   * Owner only: make a member an admin, or an admin a member. The owner's own role never changes (no ownership
   * transfer), so the owner cannot demote themselves. Setting the role someone already has is a no-op.
   */
  r.patch("/:teamId/members/:userId", requireTeam("owner"), async (c) => {
    const deps = c.get("deps");
    const team = c.get("team");
    const targetId = c.req.param("userId");
    const target = Id.safeParse(targetId).success ? team.members.find((m) => m.userId === targetId) : undefined;
    if (!target) throw notFound("Member not found.");
    if (target.role === "owner") throw forbidden("The owner's role cannot change.");
    const { role } = await readJson(c, UpdateMemberRoleBody);
    const result = await deps.actors.setMemberRole(team.id, target.userId, role);
    if (!result.ok) {
      // The member left, or the roles moved, between the membership read and the write.
      if (result.reason === "not_a_member") throw notFound("Member not found.");
      throw forbidden("The owner's role cannot change.");
    }
    if (result.changed) c.get("log").info("member role changed", { teamId: team.id, targetUserId: target.userId, role });
    return c.json(await freshView(c, team.id));
  });

  r.post("/:teamId/projects", requireTeam("owner", "admin"), rateLimit("github"), async (c) => {
    const deps = c.get("deps");
    const team = c.get("team");
    const userId = c.get("userId");
    const body = await readJson(c, LinkProjectBody);
    assertSingleLine(body.testCommand, "testCommand");
    const token = await githubTokenFor(deps, userId);

    const repo = await deps.github
      .getRepo(token, body.repoFullName)
      .catch((error) => Promise.reject(mapGithubError(error, "Repository not found, or you do not have access to it.")));
    if (!canPush(repo)) throw forbidden("You need push access to link this repository.");
    if (team.projects.some((p) => p.repoFullName.toLowerCase() === repo.full_name.toLowerCase())) throw conflict("This repository is already linked to the team.");

    let testCommand = body.testCommand;
    if (testCommand === null) {
      try {
        const files = await deps.github.listRootFiles(token, repo.full_name, repo.default_branch);
        const pkg = files.includes("package.json")
          ? await deps.github.readSmallFile(token, repo.full_name, "package.json", repo.default_branch)
          : null;
        testCommand = detectTestCommand(files, pkg);
      } catch (error) {
        // Detection is a convenience; the user can set the command later.
        c.get("log").warn("test command detection failed", { teamId: team.id, error });
      }
    }

    const project: ProjectRecord = {
      id: newId("p"),
      repoFullName: repo.full_name,
      repoId: repo.id,
      defaultBranch: repo.default_branch,
      testCommand,
      createdBy: userId,
    };
    const result = await deps.actors.linkProject(team.id, project);
    if (!result.ok) throw conflict("This repository is already linked to the team.");
    c.get("log").info("project linked", { teamId: team.id, projectId: project.id });
    const view: ProjectView = {
      id: project.id,
      repoFullName: project.repoFullName,
      defaultBranch: project.defaultBranch,
      testCommand: project.testCommand,
    };
    return c.json(view, 201);
  });

  /**
   * Sets or clears (null) the project's test command. Same roles as linking. The command runs on a VM as the
   * engineer's Linux user, the uid the agents already have, so the body bounds its size and keeps it to one line.
   * The Team actor's view change reaches every viewer as `team.view`.
   */
  r.patch("/:teamId/projects/:projectId", requireTeam("owner", "admin"), async (c) => {
    const deps = c.get("deps");
    const team = c.get("team");
    const projectId = c.req.param("projectId");
    if (!Id.safeParse(projectId).success || !team.projects.some((p) => p.id === projectId)) throw notFound("Project not found.");
    const { testCommand } = await readJson(c, UpdateProjectBody);
    const project = await deps.actors.setProjectTestCommand(team.id, projectId, testCommand);
    // Unlinked between the membership read and the write.
    if (!project) throw notFound("Project not found.");
    c.get("log").info("project test command changed", { teamId: team.id, projectId, cleared: testCommand === null });
    return c.json(await freshView(c, team.id));
  });

  r.delete("/:teamId/projects/:projectId", requireTeam("owner", "admin"), async (c) => {
    const deps = c.get("deps");
    const team = c.get("team");
    const projectId = c.req.param("projectId");
    if (!Id.safeParse(projectId).success || !team.projects.some((p) => p.id === projectId)) throw notFound("Project not found.");
    if (!(await deps.actors.unlinkProject(team.id, projectId))) throw notFound("Project not found.");
    c.get("log").info("project unlinked", { teamId: team.id, projectId });
    return c.body(null, 204);
  });

  return r;
}
