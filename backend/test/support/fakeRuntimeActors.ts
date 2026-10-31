// In-memory stand-in for the runtime's Terse door, mirroring the actor rules the runtime relies on:
// environment caps and the terminal `disconnected` phase, profile ownership, health ordering, live
// leases. Used where Terse itself is not under test (route matrix, inspect, observers).
import type { LeaseView, ProfileView, WorkforceView } from "@morrow/contracts";
import type {
  EnvironmentPatch,
  RegisterProfileInput,
  RuntimeActors,
  StoredEnvironment,
  StoredLease,
  StoredRelay,
  StoredTask,
  UserSecrets,
} from "../../src/runtime/actors.ts";

export interface FakeRuntimeActors extends RuntimeActors {
  envs: Map<string, Map<string, StoredEnvironment>>;
  relays: Map<string, StoredRelay>;
  users: Map<string, UserSecrets>;
  profiles: Map<string, Map<string, ProfileView>>;
  leases: Map<string, Map<string, StoredLease>>;
  tasks: Map<string, Map<string, StoredTask>>;
  calls: string[];
  /** Runs after each environment write: lets a test "crash" the backend at an exact step. */
  onUpdate: ((teamId: string, envId: string, patch: EnvironmentPatch) => void) | null;
  putEnvironment(teamId: string, env: Partial<StoredEnvironment> & { id: string; ownerUserId: string }): StoredEnvironment;
  putLease(teamId: string, lease: Partial<StoredLease> & { id: string; nodeName: string }): StoredLease;
  putTask(teamId: string, task: Partial<StoredTask> & { id: string }): StoredTask;
}

const LIVE = new Set(["reserved", "spawning", "running"]);

export function fakeRuntimeActors(): FakeRuntimeActors {
  const envs = new Map<string, Map<string, StoredEnvironment>>();
  const relays = new Map<string, StoredRelay>();
  const users = new Map<string, UserSecrets>();
  const profiles = new Map<string, Map<string, ProfileView>>();
  const leases = new Map<string, Map<string, StoredLease>>();
  const tasks = new Map<string, Map<string, StoredTask>>();
  const calls: string[] = [];
  const of = <V>(m: Map<string, Map<string, V>>, teamId: string) => {
    let inner = m.get(teamId);
    if (!inner) m.set(teamId, (inner = new Map()));
    return inner;
  };
  const clone = <T>(v: T): T => structuredClone(v);
  const activeLeases = (teamId: string, profileId: string) =>
    [...of(leases, teamId).values()].filter((l) => l.profileId === profileId && LIVE.has(l.state)).length;

  const fake: FakeRuntimeActors = {
    envs,
    relays,
    users,
    profiles,
    leases,
    tasks,
    calls,
    onUpdate: null,

    putEnvironment(teamId, env) {
      const now = Date.now();
      const full: StoredEnvironment = {
        name: "Env",
        freestyleVmId: null,
        linuxUser: null,
        nodeName: null,
        phase: "provisioning",
        vmState: "unknown",
        nodeOnline: false,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        ...env,
      };
      of(envs, teamId).set(env.id, full);
      return clone(full);
    },

    putLease(teamId, lease) {
      const full: StoredLease = { taskId: "task-1", workstreamId: "ws-1", profileId: "cp-x", epoch: 1, agentName: "w-task1-be-e1", state: "running", ...lease };
      of(leases, teamId).set(lease.id, full);
      return clone(full);
    },

    putTask(teamId, task) {
      const full: StoredTask = { workstreams: [], trace: [], ...task };
      of(tasks, teamId).set(task.id, full);
      return clone(full);
    },

    async createEnvironment(teamId, input) {
      calls.push(`createEnvironment:${input.id}`);
      const map = of(envs, teamId);
      const existing = map.get(input.id);
      if (existing) return existing.ownerUserId === input.ownerUserId ? { ok: true, created: false } : { ok: false, reason: "environment_exists" };
      const mine = [...map.values()].filter((e) => e.ownerUserId === input.ownerUserId && e.phase !== "disconnected");
      if (mine.length >= 5) return { ok: false, reason: "too_many_environments" };
      fake.putEnvironment(teamId, input);
      return { ok: true, created: true };
    },

    async updateEnvironment(teamId, envId, patch) {
      calls.push(`updateEnvironment:${envId}:${Object.keys(patch).join(",")}`);
      const env = of(envs, teamId).get(envId);
      if (!env || env.phase === "disconnected") return null;
      const next = { ...env, ...patch, updatedAt: Date.now() };
      of(envs, teamId).set(envId, next);
      fake.onUpdate?.(teamId, envId, patch);
      return clone(next);
    },

    async getEnvironment(teamId, envId) {
      const env = of(envs, teamId).get(envId);
      return env ? clone(env) : null;
    },

    async listEnvironments(teamId) {
      return [...of(envs, teamId).values()].map(clone).sort((a, b) => a.createdAt - b.createdAt);
    },

    async getRelay(teamId) {
      return clone(relays.get(teamId) ?? null);
    },

    async setRelay(teamId, config) {
      calls.push("setRelay");
      const prev = relays.get(teamId);
      relays.set(teamId, { ...config, cursor: prev && prev.workspaceId === config.workspaceId ? prev.cursor : null });
      return true;
    },

    async setRelayCursor(teamId, cursor) {
      const prev = relays.get(teamId);
      if (!prev) throw new Error("relay not configured");
      relays.set(teamId, { ...prev, cursor });
    },

    async getUserSecrets(userId) {
      return clone(users.get(userId) ?? null);
    },

    async setRelayHumanToken(userId, teamId, tokenEnc) {
      const user = users.get(userId);
      if (!user || !user.teamIds.includes(teamId)) return false;
      user.relayHumanTokens = { ...user.relayHumanTokens, [teamId]: tokenEnc };
      return true;
    },

    async registerProfile(teamId, input: RegisterProfileInput) {
      calls.push(`registerProfile:${input.cli}`);
      const map = of(profiles, teamId);
      const existing = map.get(input.id);
      if (existing && (existing.ownerUserId !== input.ownerUserId || existing.envId !== input.envId)) return { ok: false, reason: "profile_owner_mismatch" };
      // Like the actor: an existing id is updated in place, its health and usage untouched.
      const profile: ProfileView = existing ? { ...existing, cli: input.cli, label: input.label, scopes: input.scopes, maxConcurrent: input.maxConcurrent } : {
        id: input.id,
        envId: input.envId,
        ownerUserId: input.ownerUserId,
        cli: input.cli,
        label: input.label,
        auth: "unknown",
        availability: "ready",
        cooldownUntil: null,
        limitedReason: null,
        limitedSource: null,
        maxConcurrent: input.maxConcurrent,
        activeLeases: 0,
        scopes: input.scopes,
        lastSeenAt: null,
      };
      map.set(input.id, profile);
      return { ok: true, profile: clone(profile) };
    },

    async updateProfileHealth(teamId, profileId, health, eventId) {
      calls.push(`updateProfileHealth:${profileId}:${health.auth}:${health.online}:${eventId.split("-")[0]}`);
      const map = of(profiles, teamId);
      const profile = map.get(profileId);
      if (!profile) return null;
      if (profile.lastSeenAt !== null && health.observedAt < profile.lastSeenAt) return { applied: false };
      const availability = profile.availability === "limited" ? "limited" : health.online ? "ready" : "offline";
      map.set(profileId, { ...profile, auth: health.auth, availability, lastSeenAt: health.observedAt });
      return { applied: true };
    },

    async recordProfileUsage(teamId, profileId, usage) {
      calls.push(`recordProfileUsage:${profileId}:${usage.source}`);
      const map = of(profiles, teamId);
      const profile = map.get(profileId);
      if (!profile) return null;
      if (profile.usage && usage.observedAt <= profile.usage.observedAt) return { applied: false };
      map.set(profileId, { ...profile, usage });
      return { applied: true };
    },

    async removeProfile(teamId, profileId) {
      calls.push(`removeProfile:${profileId}`);
      const map = of(profiles, teamId);
      if (!map.has(profileId)) return { removed: false, expiredLeaseIds: [] };
      map.delete(profileId);
      const expired: string[] = [];
      for (const lease of of(leases, teamId).values()) {
        if (lease.profileId === profileId && LIVE.has(lease.state)) {
          lease.state = "expired";
          expired.push(lease.id);
        }
      }
      return { removed: true, expiredLeaseIds: expired };
    },

    async getProfile(teamId, profileId) {
      const p = of(profiles, teamId).get(profileId);
      if (!p) return null;
      const env = of(envs, teamId).get(p.envId);
      return { id: p.id, envId: p.envId, ownerUserId: p.ownerUserId, nodeName: env?.nodeName ?? "n-000000000000", cli: p.cli, label: p.label, auth: p.auth, maxConcurrent: p.maxConcurrent };
    },

    async getLease(teamId, leaseId) {
      return clone(of(leases, teamId).get(leaseId) ?? null);
    },

    async getTask(teamId, taskId) {
      return clone(of(tasks, teamId).get(taskId) ?? null);
    },

    async getWorkforceView(teamId): Promise<WorkforceView> {
      const profileViews: Record<string, ProfileView> = {};
      for (const p of of(profiles, teamId).values()) {
        const active = activeLeases(teamId, p.id);
        profileViews[p.id] = { ...p, activeLeases: active, availability: p.availability === "ready" && active > 0 ? "busy" : p.availability };
      }
      const leaseViews: Record<string, LeaseView> = {};
      for (const l of of(leases, teamId).values()) {
        leaseViews[l.id] = { id: l.id, taskId: l.taskId, workstreamId: l.workstreamId, profileId: l.profileId, epoch: l.epoch, agentName: l.agentName, nodeName: l.nodeName, state: l.state, createdAt: 0 };
      }
      return { profiles: profileViews, tasks: {}, leases: leaseViews };
    },
  };
  return fake;
}
