import {
  CreateEnvironmentBody,
  Id,
  InspectTicketBody,
  RegisterProfileBody,
  UpdateProfileBody,
  type EnvironmentView,
  type ProfileView,
  type RealtimeTicketResponse,
  type TerminalTokenResponse,
  type WorkerLogResponse,
  type WorkforceEnvironmentView,
} from "@morrow/contracts";
import { Hono, type Context } from "hono";
import { badRequest, conflict, featureDisabled, forbidden, notFound } from "../../lib/errors.ts";
import type { StoredEnvironment } from "../../runtime/actors.ts";
import { toEnvironmentView } from "../../runtime/environments.ts";
import type { AppEnv } from "../context.ts";
import { readJson } from "../errors.ts";
import { rateLimit, requireTeam } from "../middleware.ts";
import { withEnvironmentQuota } from "../quotas.ts";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LIVE_LEASE = new Set(["reserved", "spawning", "running"]);
const TERMINAL_PHASES = new Set(["awaiting_login", "ready"]);
const DEFAULT_ENVIRONMENT_NAME = "Cloud environment";

type C = Context<AppEnv>;

function requireFreestyle(c: C): void {
  if (!c.get("deps").env.freestyle) throw featureDisabled("Cloud environments are not configured on this server.");
}

function requireRelay(c: C): void {
  if (!c.get("deps").env.relay) throw featureDisabled("Agent Relay is not configured on this server.");
}

/** Loads `:envId` from this team only: another team's id is a plain 404. */
async function loadEnv(c: C): Promise<StoredEnvironment> {
  const envId = c.req.param("envId");
  if (!envId || !Id.safeParse(envId).success) throw notFound("Environment not found.");
  const env = await c.get("deps").runtime.store.getEnvironment(c.get("team").id, envId);
  if (!env) throw notFound("Environment not found.");
  return env;
}

function requireOwner(c: C, env: { ownerUserId: string }): void {
  if (env.ownerUserId !== c.get("userId")) throw forbidden("Only the owner of this environment can do that.");
}

function requireOwnerOrAdmin(c: C, env: { ownerUserId: string }): void {
  if (env.ownerUserId !== c.get("userId") && c.get("role") === "member") throw forbidden("Only the owner or a team admin can do that.");
}

async function detail(c: C, env: StoredEnvironment): Promise<WorkforceEnvironmentView> {
  const workforce = await c.get("deps").runtime.profiles.workforce(c.get("team").id);
  const found = workforce.environments.find((e) => e.id === env.id);
  return found ?? { ...toEnvironmentView(env), profiles: [], liveLeases: 0 };
}

/**
 * Environments, CLI profiles, terminals, inspect tickets and the workforce view. Mounted under
 * /api/teams behind requireSession + per-method rate limits; CSRF/Origin already apply to mutations.
 */
export function environmentRoutes(teams: Hono<AppEnv>): void {
  const r = new Hono<AppEnv>();

  r.get("/:teamId/workforce", requireTeam(), async (c) => {
    const deps = c.get("deps");
    deps.runtime.noteTeam(c.get("team").id);
    return c.json(await deps.runtime.profiles.workforce(c.get("team").id));
  });

  r.get("/:teamId/environments", requireTeam(), async (c) => {
    const envs = await c.get("deps").runtime.store.listEnvironments(c.get("team").id);
    const views: EnvironmentView[] = envs.filter((e) => e.phase !== "disconnected").map(toEnvironmentView);
    return c.json({ environments: views });
  });

  r.post("/:teamId/environments", requireTeam(), async (c) => {
    requireFreestyle(c);
    requireRelay(c);
    const deps = c.get("deps");
    const team = c.get("team");
    const body = await readJson(c, CreateEnvironmentBody);
    const name = body.name ?? DEFAULT_ENVIRONMENT_NAME;
    if (CONTROL_CHARS.test(name)) throw badRequest("Invalid request. name: must be a single line of text");
    deps.runtime.noteTeam(team.id);
    const userId = c.get("userId");
    const env = await withEnvironmentQuota(deps.actors, userId, () => deps.runtime.environments.create(team.id, userId, name));
    return c.json(toEnvironmentView(env), 201);
  });

  r.get("/:teamId/environments/:envId", requireTeam(), async (c) => c.json(await detail(c, await loadEnv(c))));

  r.post("/:teamId/environments/:envId/pause", requireTeam(), async (c) => {
    requireFreestyle(c);
    const env = await loadEnv(c);
    requireOwnerOrAdmin(c, env);
    const updated = await c.get("deps").runtime.environments.pause(c.get("team").id, env.id);
    return c.json(toEnvironmentView(updated));
  });

  r.post("/:teamId/environments/:envId/resume", requireTeam(), async (c) => {
    requireFreestyle(c);
    const env = await loadEnv(c);
    requireOwner(c, env);
    const updated = await c.get("deps").runtime.environments.resume(c.get("team").id, env.id);
    return c.json(toEnvironmentView(updated));
  });

  r.post("/:teamId/environments/:envId/disconnect", requireTeam(), async (c) => {
    requireFreestyle(c);
    const deps = c.get("deps");
    const env = await loadEnv(c);
    requireOwnerOrAdmin(c, env);
    const owner = await deps.runtime.store.getUserSecrets(env.ownerUserId);
    const identityIds = owner?.freestyleIdentityId ? [owner.freestyleIdentityId] : [];
    const updated = await deps.runtime.environments.disconnect(c.get("team").id, env.id, identityIds);
    return c.json(toEnvironmentView(updated));
  });

  /**
   * The owner's private terminal, from the environment's own Freestyle identity (one VM, one Linux user).
   * The token goes to this browser only and is never logged.
   */
  r.post("/:teamId/environments/:envId/terminal", requireTeam(), rateLimit("terminal"), async (c) => {
    requireFreestyle(c);
    const deps = c.get("deps");
    const env = await loadEnv(c);
    requireOwner(c, env);
    if (!TERMINAL_PHASES.has(env.phase) || !env.freestyleVmId || !env.linuxUser)
      throw conflict(env.phase === "paused" ? "Resume this environment to open its terminal." : "This environment is not ready for a terminal yet.");
    const response = await deps.runtime.environments.mintTerminal(c.get("team").id, env.id);
    c.get("log").info("terminal token minted", { envId: env.id });
    c.header("cache-control", "no-store");
    return c.json(response satisfies TerminalTokenResponse);
  });

  r.post("/:teamId/environments/:envId/profiles", requireTeam(), async (c) => {
    requireFreestyle(c);
    const env = await loadEnv(c);
    requireOwner(c, env);
    const body = await readJson(c, RegisterProfileBody);
    if (CONTROL_CHARS.test(body.label)) throw badRequest("Invalid request. label: must be a single line of text");
    const profile: ProfileView = await c.get("deps").runtime.profiles.register(c.get("team"), env.id, c.get("userId"), body);
    return c.json(profile, 201);
  });

  r.post("/:teamId/profiles/:profileId/check", requireTeam(), async (c) => {
    requireFreestyle(c);
    const deps = c.get("deps");
    const profile = await loadProfile(c);
    requireOwner(c, profile);
    return c.json(await deps.runtime.profiles.check(c.get("team").id, profile.id));
  });

  /** Workers at once for one login. Its owner's call, like every other change to it: it spends their subscription. */
  r.patch("/:teamId/profiles/:profileId", requireTeam(), async (c) => {
    requireFreestyle(c);
    const profile = await loadProfile(c);
    requireOwner(c, profile);
    const body = await readJson(c, UpdateProfileBody);
    const updated: ProfileView = await c.get("deps").runtime.profiles.update(c.get("team").id, profile.envId, profile.id, body);
    return c.json(updated);
  });

  r.delete("/:teamId/profiles/:profileId", requireTeam(), async (c) => {
    requireFreestyle(c);
    const profile = await loadProfile(c);
    requireOwner(c, profile);
    await c.get("deps").runtime.profiles.remove(c.get("team").id, profile.id);
    return c.body(null, 204);
  });

  /** Ticket for `/realtime/inspect/:leaseId`: any member, only while the lease is live and policy allows. */
  r.post("/:teamId/inspect/ticket", requireTeam(), rateLimit("ticket"), async (c) => {
    requireFreestyle(c);
    const deps = c.get("deps");
    const team = c.get("team");
    const { leaseId } = await readJson(c, InspectTicketBody);
    if (!team.policy.allowInspect) throw forbidden("This team does not allow inspecting workers.");
    const lease = await deps.runtime.store.getLease(team.id, leaseId);
    if (!lease || !LIVE_LEASE.has(lease.state)) throw notFound("This worker is not running.");
    const { ticket, expiresAt } = deps.tickets.issue(c.get("userId"), team.id, { purpose: "inspect", leaseId });
    const url = `${deps.env.realtimeUrl}/realtime/inspect/${encodeURIComponent(leaseId)}?ticket=${encodeURIComponent(ticket)}`;
    return c.json({ url, expiresAt } satisfies RealtimeTicketResponse);
  });

  /**
   * An ended worker's last output, why it ended and what it left. Same gate as live inspect: any member, team policy
   * `allowInspect`, the lease in this team (another team's id is a plain 404). A live lease is 409: it streams. Why the
   * log could not be read comes back as `unavailable`, never as a 5xx.
   */
  r.get("/:teamId/leases/:leaseId/log", requireTeam(), rateLimit("workerLog"), async (c) => {
    const deps = c.get("deps");
    const team = c.get("team");
    const leaseId = c.req.param("leaseId");
    if (!leaseId || !Id.safeParse(leaseId).success) throw notFound("Worker not found.");
    if (!team.policy.allowInspect) throw forbidden("This team does not allow inspecting workers.");
    const result = await deps.runtime.workerLogs.read(team.id, leaseId);
    if (!result) throw notFound("Worker not found.");
    c.header("cache-control", "no-store");
    return c.json(result satisfies WorkerLogResponse);
  });

  teams.route("/", r);
}

async function loadProfile(c: C) {
  const profileId = c.req.param("profileId");
  if (!profileId || !Id.safeParse(profileId).success) throw notFound("Profile not found.");
  const profile = await c.get("deps").runtime.store.getProfile(c.get("team").id, profileId);
  if (!profile) throw notFound("Profile not found.");
  return profile;
}
