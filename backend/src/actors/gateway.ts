import { TeamView } from "@morrow/contracts";
import type { Env } from "../env.ts";
import { createTerseTransport, generated, pingTerse, prepareActorSocket, type ActorRpcTransport } from "./client.ts";
import { conflict, forbidden, internalError, notFound, unauthenticated } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { DIRECTORY_ID } from "../orchestration/directory.ts";
import { invoke, type InvokeOptions } from "./invoke.ts";
import type { ActorGateway, GithubProfile, SocketActor, TeamRecord, UserRecord } from "./types.ts";
import { parseWorkforceState } from "./workforceState.ts";

/** Socket metadata for backend-held actor sockets. Actors reject sockets without a `userId`. */
export const BACKEND_SOCKET_USER = "system.backend";

const TeamProjection = TeamView.omit({ viewerRole: true });
const PING_TIMEOUT_MS = 2_500;

export interface GatewayDependencies {
  transport?: ActorRpcTransport;
  fetch?: typeof globalThis.fetch;
  retry?: InvokeOptions["retry"];
}

/** GitHub profile fields the actors validate strictly; anything odd is trimmed or dropped, never fatal. */
function normalizeProfile(p: GithubProfile): GithubProfile {
  const clean = (s: string | null, max: number) => {
    if (s === null) return null;
    const v = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
    return v || null;
  };
  const avatar = p.avatarUrl && p.avatarUrl.length <= 500 && /^https?:\/\//i.test(p.avatarUrl) ? p.avatarUrl : null;
  const email = p.email && p.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) ? p.email : null;
  return { githubId: p.githubId, login: p.login, name: clean(p.name, 255), avatarUrl: avatar, email };
}

/**
 * The backend's typed door into Terse. Every call goes through `invoke`, which retries `unavailable`,
 * retries `outcome_unknown` only for idempotent operations, and turns failures into safe AppErrors.
 * Actor `{ ok: false, reason }` results are mapped to domain results or AppErrors here, so routes
 * never see actor vocabulary.
 */
export function createActorGateway(config: Env["terse"], log: Logger, deps: GatewayDependencies = {}): ActorGateway {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const transport = deps.transport ?? createTerseTransport(config, fetchFn);
  const opts: InvokeOptions = { log, retry: deps.retry };
  const user = (id: string) => generated.actors.User.get(id, transport);
  const team = (id: string) => generated.actors.Team.get(id, transport);

  const call = <T>(op: string, idempotent: boolean, fn: () => Promise<T>) => invoke(fn, { op, idempotent }, opts);

  const parseTeam = (raw: unknown, teamId: string): TeamRecord | null => {
    if (raw === null || raw === undefined) return null;
    const parsed = TeamProjection.safeParse(raw);
    if (!parsed.success || parsed.data.id !== teamId) {
      log.error("team projection does not match the contract", { teamId, issues: parsed.success ? "id mismatch" : parsed.error.issues.slice(0, 3) });
      return null;
    }
    return parsed.data;
  };

  const getTeam = async (teamId: string): Promise<TeamRecord | null> => {
    const raw = await call("Team.getView", true, () => team(teamId).getView());
    if (raw === null) return null;
    const record = parseTeam(raw, teamId);
    if (!record) throw internalError(new Error("team projection invalid"));
    return record;
  };

  const getUser = async (userId: string): Promise<UserRecord | null> => {
    const raw = await call("User.get", true, () => user(userId).get());
    if (!raw) return null;
    return {
      id: raw.id,
      githubId: raw.profile.githubId,
      login: raw.profile.login,
      name: raw.profile.name,
      avatarUrl: raw.profile.avatarUrl,
      email: raw.profile.email,
      sessionVersion: raw.sessionVersion,
      teamIds: raw.teamIds,
    };
  };

  return {
    async upsertUserFromGithub(profile, githubTokenEnc) {
      const p = normalizeProfile(profile);
      const userId = `u-${p.githubId}`;
      // Set semantics: replaying the same upsert is harmless.
      await call("User.upsertFromGithub", true, () => user(userId).upsertFromGithub({ ...p, githubTokenEnc }));
      const record = await getUser(userId);
      if (!record) throw internalError(new Error("user missing right after upsert"));
      // Keep the member cards on each team current; best effort, never blocks sign-in.
      const identity = { userId, login: p.login, name: p.name, avatarUrl: p.avatarUrl };
      for (const teamId of record.teamIds) {
        call("Team.updateMemberProfile", true, () => team(teamId).updateMemberProfile(identity)).catch(() => {});
      }
      return record;
    },

    getUser,

    async getGithubTokenEnc(userId) {
      const raw = await call("User.get", true, () => user(userId).get());
      return raw?.githubTokenEnc ?? null;
    },

    async bumpSessionVersion(userId) {
      // Not idempotent: a replay would bump twice (harmless, but we never blind-retry outcome_unknown).
      const res = await call("User.bumpSessionVersion", false, () => user(userId).bumpSessionVersion());
      if (!res.ok) throw unauthenticated();
      return res.sessionVersion;
    },

    async addUserTeam(userId, teamId) {
      const res = await call("User.addTeam", true, () => user(userId).addTeam(teamId));
      if (!res.ok) {
        if (res.reason === "too_many_teams") throw conflict("You are in too many teams. Leave one first.");
        throw internalError(new Error(`User.addTeam: ${res.reason}`));
      }
    },

    async removeUserTeam(userId, teamId) {
      const res = await call("User.removeTeam", true, () => user(userId).removeTeam(teamId));
      // A user record that no longer exists has nothing to remove.
      if (!res.ok && res.reason !== "unknown_user") throw internalError(new Error(`User.removeTeam: ${res.reason}`));
    },

    async createTeam({ teamId, name, slug, owner }) {
      // The fresh random team id doubles as the idempotency key, so an outcome_unknown retry is safe.
      const res = await call("Team.create", true, () => team(teamId).create({ name, slug, owner }, `create-${teamId}`));
      if (!res.ok) throw conflict("That team already exists.");
      // Best effort: the directory row only helps a restarted backend find the team. Work noted later writes it anyway.
      await call("TeamDirectory.noteTeam", true, () => generated.actors.TeamDirectory.get(DIRECTORY_ID, transport).noteTeam(teamId)).catch((error: unknown) =>
        log.warn("team not recorded in the directory", { teamId, error }),
      );
      const record = await getTeam(teamId);
      if (!record) throw internalError(new Error("team missing right after create"));
      return record;
    },

    getTeam,

    async createInvite(teamId, invite) {
      const res = await call("Team.createInvite", false, () => team(teamId).createInvite(invite));
      if (!res.ok) {
        if (res.reason === "no_team") throw notFound("Team not found.");
        if (res.reason === "not_a_member") throw forbidden();
        if (res.reason === "too_many_invites") throw conflict("This team has too many active invites. Let some expire first.");
        throw conflict("Could not create the invite. Try again.");
      }
    },

    async listInvites(teamId) {
      return call("Team.listInvites", true, () => team(teamId).listInvites());
    },

    async revokeInvite(teamId, inviteId) {
      const res = await call("Team.revokeInvite", true, () => team(teamId).revokeInvite(inviteId));
      if (!res.ok) throw notFound("Team not found.");
      return res.revoked;
    },

    async acceptInvite(teamId, { hash, member }) {
      // Re-accepting as a member is a no-op in the actor, so retries are safe.
      const res = await call("Team.acceptInvite", true, () => team(teamId).acceptInvite(hash, member));
      if (res.ok) return { ok: true, role: res.role, alreadyMember: res.alreadyMember };
      switch (res.reason) {
        case "expired":
          return { ok: false, reason: "expired" };
        case "exhausted":
          return { ok: false, reason: "exhausted" };
        case "too_many_members":
          return { ok: false, reason: "full" };
        default:
          return { ok: false, reason: "invalid" };
      }
    },

    async removeMember(teamId, userId) {
      const res = await call("Team.removeMember", true, () => team(teamId).removeMember(userId));
      return res.ok ? { ok: true, removed: res.removed } : { ok: false, reason: "last_owner" };
    },

    async setMemberRole(teamId, userId, role) {
      // Set semantics: a replay lands on the same role.
      const res = await call("Team.setMemberRole", true, () => team(teamId).setMemberRole(userId, role));
      if (res.ok) return { ok: true, changed: res.changed };
      if (res.reason === "no_team") throw notFound("Team not found.");
      return { ok: false, reason: res.reason };
    },

    async renameTeam(teamId, name) {
      const res = await call("Team.rename", true, () => team(teamId).rename(name));
      if (!res.ok) throw notFound("Team not found.");
    },

    async setTeamPolicy(teamId, patch) {
      const res = await call("Team.setPolicy", true, () => team(teamId).setPolicy(patch));
      if (!res.ok) throw notFound("Team not found.");
    },

    async getInvitePreview(teamId, hash, userId) {
      return call("Team.getInviteByHash", true, () => team(teamId).getInviteByHash(hash, userId));
    },

    async linkProject(teamId, project) {
      const res = await call("Team.linkProject", true, () =>
        team(teamId).linkProject({
          id: project.id,
          repoFullName: project.repoFullName,
          repoId: project.repoId,
          defaultBranch: project.defaultBranch,
          testCommand: project.testCommand,
          createdBy: project.createdBy,
        }),
      );
      if (res.ok) return res.created || res.projectId === project.id ? { ok: true } : { ok: false, reason: "duplicate" };
      if (res.reason === "project_exists") return { ok: false, reason: "duplicate" };
      if (res.reason === "no_team") throw notFound("Team not found.");
      if (res.reason === "not_a_member") throw forbidden();
      throw conflict("This team has too many projects.");
    },

    async unlinkProject(teamId, projectId) {
      const res = await call("Team.unlinkProject", true, () => team(teamId).unlinkProject(projectId));
      return res.ok;
    },

    async setProjectTestCommand(teamId, projectId, testCommand) {
      // Set semantics: a replay lands on the same command.
      const res = await call("Team.setProjectTestCommand", true, () => team(teamId).setProjectTestCommand(projectId, testCommand));
      return res.ok ? res.project : null;
    },

    async prepareSocket(actor: SocketActor, teamId: string) {
      return prepareActorSocket(config, actor, { actorId: teamId, metadata: { userId: BACKEND_SOCKET_USER } }, fetchFn);
    },

    mapTeamState(state, teamId) {
      return parseTeam(state.view, teamId);
    },

    mapWorkforceState(state) {
      return parseWorkforceState(state, log);
    },

    ping: () => pingTerse(config, PING_TIMEOUT_MS, fetchFn),
  };
}
