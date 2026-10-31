import type {
  CliKind,
  EnvironmentPhase,
  LeaseState,
  ProfileAuth,
  ProfileScopes,
  ProfileUsage,
  ProfileView,
  TraceEntry,
  VmState,
  WorkforceView,
  WorkstreamStatus,
} from "@morrow/contracts";
import { createTerseTransport, generated, type ActorRpcTransport } from "../actors/client.ts";
import { invoke, type InvokeOptions } from "../actors/invoke.ts";
import type { Env } from "../env.ts";
import { internalError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";

/** `Team.environments[id]` including the Freestyle VM id the public view leaves out. */
export interface StoredEnvironment {
  id: string;
  ownerUserId: string;
  name: string;
  freestyleVmId: string | null;
  linuxUser: string | null;
  nodeName: string | null;
  phase: EnvironmentPhase;
  vmState: VmState;
  nodeOnline: boolean;
  lastError: string | null;
  /**
   * The Freestyle identity behind this environment's terminal tokens, one per environment. Absent on
   * environments whose Team actor record predates the field; the first terminal mint creates it.
   */
  freestyleIdentityId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type EnvironmentPatch = Partial<
  Pick<StoredEnvironment, "name" | "freestyleVmId" | "linuxUser" | "nodeName" | "phase" | "vmState" | "nodeOnline" | "lastError" | "freestyleIdentityId">
>;

/** `Team.relay`: ids in clear, every secret as a backend-encrypted blob. */
export interface StoredRelay {
  workspaceId: string;
  baseUrl: string;
  workspaceKeyEnc: string;
  dispatcherTokenEnc: string;
  observerTokenEnc: string;
  observerTokenId: string;
  cursor: string | null;
}

export type RelayConfigInput = Omit<StoredRelay, "cursor">;

export interface UserSecrets {
  id: string;
  login: string;
  teamIds: string[];
  /** teamId -> encrypted `h-<login>` agent token. */
  relayHumanTokens: Record<string, string>;
  /**
   * The user-wide terminal identity from before per-environment identities. Never minted from again;
   * kept so its grants and tokens can still be revoked (first mint per VM, disconnect, sign-out everywhere).
   */
  freestyleIdentityId: string | null;
}

export interface StoredProfile {
  id: string;
  envId: string;
  ownerUserId: string;
  nodeName: string;
  cli: CliKind;
  label: string;
  auth: ProfileAuth;
  maxConcurrent: number;
}

export interface StoredLease {
  id: string;
  taskId: string;
  workstreamId: string;
  profileId: string;
  epoch: number;
  agentName: string;
  nodeName: string;
  state: LeaseState;
  /** Why it ended, one line (the actor keeps it from `endLease`). Null or absent while live and on older leases. */
  endReason?: string | null;
  /** Its last change: when it ended, for an ended lease. */
  updatedAt?: number;
}

/** What the runtime reads of a task: its workstreams and trace (an ended worker's log view). */
export interface StoredTask {
  id: string;
  workstreams: {
    id: string;
    title: string;
    branch: string;
    status: WorkstreamStatus;
    leaseId: string | null;
    lastCheckpoint: { sha: string; summary: string; epoch: number; at: number } | null;
  }[];
  trace: TraceEntry[];
}

export interface RegisterProfileInput {
  id: string;
  envId: string;
  ownerUserId: string;
  nodeName: string;
  cli: CliKind;
  label: string;
  scopes: ProfileScopes;
  maxConcurrent: number;
}

export interface ProfileHealthInput {
  auth: ProfileAuth;
  online: boolean;
  observedAt: number;
}

export type CreateEnvironmentResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "no_team" | "not_a_member" | "environment_exists" | "too_many_environments" };

export type RegisterProfileResult = { ok: true; profile: ProfileView } | { ok: false; reason: "profile_owner_mismatch" | "too_many_profiles" };

/**
 * The team runtime's door into Terse: environments, Relay secrets, CLI profiles and leases. Kept apart
 * from the core `ActorGateway` so the runtime and the HTTP core evolve independently. Every call goes
 * through `invoke` (retries, safe errors); every write here is set-style or keyed, so all are idempotent.
 */
export interface RuntimeActors {
  createEnvironment(teamId: string, input: { id: string; ownerUserId: string; name: string }): Promise<CreateEnvironmentResult>;
  /** Null when the environment is unknown or already disconnected (terminal). */
  updateEnvironment(teamId: string, envId: string, patch: EnvironmentPatch): Promise<StoredEnvironment | null>;
  getEnvironment(teamId: string, envId: string): Promise<StoredEnvironment | null>;
  listEnvironments(teamId: string): Promise<StoredEnvironment[]>;

  getRelay(teamId: string): Promise<StoredRelay | null>;
  /** False when the team does not exist. */
  setRelay(teamId: string, config: RelayConfigInput): Promise<boolean>;
  setRelayCursor(teamId: string, cursor: string): Promise<void>;

  getUserSecrets(userId: string): Promise<UserSecrets | null>;
  /** False when the user is not (or no longer) in the team. */
  setRelayHumanToken(userId: string, teamId: string, tokenEnc: string): Promise<boolean>;

  registerProfile(teamId: string, input: RegisterProfileInput): Promise<RegisterProfileResult>;
  updateProfileHealth(teamId: string, profileId: string, health: ProfileHealthInput, eventId: string): Promise<{ applied: boolean } | null>;
  /** Latest usage reading; monotonic by `observedAt`, so a replay is a no-op. Null for an unknown profile. */
  recordProfileUsage(teamId: string, profileId: string, usage: ProfileUsage): Promise<{ applied: boolean } | null>;
  removeProfile(teamId: string, profileId: string): Promise<{ removed: boolean; expiredLeaseIds: string[] }>;
  getProfile(teamId: string, profileId: string): Promise<StoredProfile | null>;
  getLease(teamId: string, leaseId: string): Promise<StoredLease | null>;
  getTask(teamId: string, taskId: string): Promise<StoredTask | null>;
  getWorkforceView(teamId: string): Promise<WorkforceView>;
}

export interface RuntimeActorsDependencies {
  transport?: ActorRpcTransport;
  retry?: InvokeOptions["retry"];
}

export function createRuntimeActors(config: Env["terse"], log: Logger, deps: RuntimeActorsDependencies = {}): RuntimeActors {
  const transport = deps.transport ?? createTerseTransport(config);
  const opts: InvokeOptions = { log, retry: deps.retry };
  const team = (id: string) => generated.actors.Team.get(id, transport);
  const user = (id: string) => generated.actors.User.get(id, transport);
  const workforce = (id: string) => generated.actors.TeamWorkforce.get(id, transport);
  const call = <T>(op: string, fn: () => Promise<T>) => invoke(fn, { op, idempotent: true }, opts);

  return {
    createEnvironment: (teamId, input) => call("Team.createEnvironment", () => team(teamId).createEnvironment(input)),

    async updateEnvironment(teamId, envId, patch) {
      const res = await call("Team.updateEnvironment", () => team(teamId).updateEnvironment(envId, patch));
      return res.ok ? res.environment : null;
    },

    getEnvironment: (teamId, envId) => call("Team.getEnvironment", () => team(teamId).getEnvironment(envId)),
    listEnvironments: (teamId) => call("Team.getEnvironments", () => team(teamId).getEnvironments()),
    getRelay: (teamId) => call("Team.getRelay", () => team(teamId).getRelay()),

    async setRelay(teamId, relay) {
      const res = await call("Team.setRelay", () => team(teamId).setRelay(relay));
      return res.ok;
    },

    async setRelayCursor(teamId, cursor) {
      const res = await call("Team.setRelayCursor", () => team(teamId).setRelayCursor(cursor));
      if (!res.ok) throw internalError(new Error("relay cursor saved before the workspace was configured"));
    },

    async getUserSecrets(userId) {
      const raw = await call("User.get", () => user(userId).get());
      if (!raw) return null;
      return {
        id: raw.id,
        login: raw.profile.login,
        teamIds: raw.teamIds,
        relayHumanTokens: raw.relayHumanTokens,
        freestyleIdentityId: raw.freestyleIdentityId,
      };
    },

    async setRelayHumanToken(userId, teamId, tokenEnc) {
      const res = await call("User.setRelayHumanToken", () => user(userId).setRelayHumanToken(teamId, tokenEnc));
      return res.ok;
    },

    async registerProfile(teamId, input) {
      const res = await call("TeamWorkforce.registerProfile", () => workforce(teamId).registerProfile(input));
      return res.ok ? { ok: true, profile: res.profile } : { ok: false, reason: res.reason };
    },

    async updateProfileHealth(teamId, profileId, health, eventId) {
      const res = await call("TeamWorkforce.updateProfileHealth", () => workforce(teamId).updateProfileHealth(profileId, health, eventId));
      return res.ok ? { applied: res.applied } : null;
    },

    async recordProfileUsage(teamId, profileId, usage) {
      const res = await call("TeamWorkforce.recordProfileUsage", () => workforce(teamId).recordProfileUsage(profileId, usage));
      return res.ok ? { applied: res.applied } : null;
    },

    async removeProfile(teamId, profileId) {
      const res = await call("TeamWorkforce.removeProfile", () => workforce(teamId).removeProfile(profileId));
      return { removed: res.removed, expiredLeaseIds: res.expiredLeaseIds };
    },

    getProfile: (teamId, profileId) => call("TeamWorkforce.getProfile", () => workforce(teamId).getProfile(profileId)),
    getLease: (teamId, leaseId) => call("TeamWorkforce.getLease", () => workforce(teamId).getLease(leaseId)),
    getTask: (teamId, taskId) => call("TeamWorkforce.getTask", () => workforce(teamId).getTask(taskId)),
    getWorkforceView: (teamId) => call("TeamWorkforce.getView", () => workforce(teamId).getView()),
  };
}
