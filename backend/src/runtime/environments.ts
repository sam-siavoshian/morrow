import type { EnvironmentView, ServerFrame, TerminalTokenResponse, VmState, WorkforceView } from "@morrow/contracts";
import type { Freestyle } from "freestyle";
import type { ActorGateway } from "../actors/types.ts";
import {
  FreestyleIntegrationError,
  advanceEnvironment,
  deleteTerminalIdentity,
  deleteWarmSnapshots,
  desiredNodeConfig,
  disconnectEnvironment,
  findWarmSnapshot,
  mintTerminalToken,
  newEnvironmentRecord,
  nodeConfigHash,
  pauseEnvironment,
  probeEnvironment,
  probeUsage,
  resolveSnapshotId,
  restartNodeService,
  resumeEnvironment,
  revokeIdentityAccess,
  revokeTerminalAccess,
  warmTarget,
  type AdvanceInput,
  type EnvironmentRecord,
  type NodeProfileInput,
  type ProbeReport,
  type RelayNodeSecrets,
  type UsageReport,
  type WarmTarget,
} from "../integrations/freestyle/index.ts";
import { getVmData, toVmState } from "../integrations/freestyle/vm.ts";
import { HOSTED_RELAY_BASE_URL } from "../integrations/relay/index.ts";
import { AppError, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { Logger } from "../lib/logger.ts";
import { sleep } from "../lib/retry.ts";
import type { EnvironmentPatch, RuntimeActors, StoredEnvironment } from "./actors.ts";
import { KeyedMutex, SingleFlight } from "./keyed.ts";
import type { RelayWorkspaces } from "./relayWorkspaces.ts";

/** Product cap on top of the actor's own limit. */
export const MAX_ENVIRONMENTS_PER_USER = 3;
export const NODE_RESTART_MIN_INTERVAL_MS = 2 * 60_000;
const MAX_DRIVE_STEPS = 40;
const AWAITING_LOGIN_PROBE_MS = 15_000;
/** How long the golden image's resolved snapshot id is trusted before it is read again. */
const BASE_SNAPSHOT_TTL_MS = 10 * 60_000;
const LIVE_LEASE_STATES = new Set(["reserved", "spawning", "running"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

export interface RunnerHooks {
  /** A probe finished. Returns true when a profile's readiness changed (the node config must follow). */
  onProbe(teamId: string, env: StoredEnvironment, report: ProbeReport): Promise<boolean>;
  /** Mark every profile on the environment offline so no new lease lands there. */
  markProfilesOffline(teamId: string, envId: string): Promise<void>;
  /** The environment is gone: its profiles go too (their live leases expire into handoff). */
  removeProfiles(teamId: string, envId: string): Promise<void>;
}

export interface EnvironmentRunnerOptions {
  actors: RuntimeActors;
  gateway: Pick<ActorGateway, "getTeam">;
  /** The owner's decrypted GitHub token for cloning private repos. Throws when it is gone. */
  githubToken: (userId: string) => Promise<string>;
  /**
   * Whether the owner can read every one of these repos on GitHub right now. Gates booting from a warm
   * snapshot, which already holds their code. Without it, warm snapshots are off.
   */
  canReadRepos?: (userId: string, repos: readonly string[]) => Promise<boolean>;
  workspaces: RelayWorkspaces;
  client: () => Freestyle;
  publish: (teamId: string, frame: ServerFrame) => void;
  log: Logger;
  now: () => number;
  snapshot: string;
  hooks: RunnerHooks;
  vmWait?: { timeoutMs?: number; intervalMs?: number };
  backoffMs?: (failures: number) => number;
  /** Delay before re-probing after the node config changed, so the profile sees the node come up. */
  reprobeDelayMs?: number;
}

interface Loaded {
  stored: StoredEnvironment;
  record: EnvironmentRecord;
}

export interface StepOutcome {
  stored: StoredEnvironment;
  record: EnvironmentRecord;
  step: string | null;
  more: boolean;
  probe?: ProbeReport;
}

export function toEnvironmentView(env: StoredEnvironment): EnvironmentView {
  return {
    id: env.id,
    ownerUserId: env.ownerUserId,
    name: env.name,
    linuxUser: env.linuxUser,
    nodeName: env.nodeName,
    phase: env.phase,
    vmState: env.vmState,
    nodeOnline: env.nodeOnline,
    lastError: env.lastError,
    createdAt: env.createdAt,
  };
}

export function liveLeasesOnNode(view: WorkforceView, nodeName: string | null): number {
  if (!nodeName) return 0;
  return Object.values(view.leases).filter((lease) => lease.nodeName === nodeName && LIVE_LEASE_STATES.has(lease.state)).length;
}

/** Freestyle failures carry user-safe messages; anything else stays opaque. */
export function toAppError(error: unknown): unknown {
  if (error instanceof FreestyleIntegrationError) return new AppError(error.apiCode, error.message, { cause: error });
  return error;
}

/**
 * Drives every environment through `advanceEnvironment` in the background and runs the owner/admin
 * lifecycle actions. All work on one environment is serialized by a per-environment lock, and at most
 * one driver loop exists per environment, so two drivers never touch one VM. Each step is persisted to
 * `Team.updateEnvironment` before the next one starts; every step is idempotent on the VM, so a crash
 * mid-step simply re-runs it after restart (boot reconcile + the 15 s loop pick it up).
 *
 * The Team actor stores phase, VM id and state. Step progress, the node config digest and the resume
 * phase live in memory; after a restart they are rebuilt conservatively (steps re-run, the node config
 * is re-applied once, which the VM script skips when nothing changed).
 */
export class EnvironmentRunner {
  readonly #o: EnvironmentRunnerOptions;
  readonly #records = new Map<string, EnvironmentRecord>();
  readonly #locks = new KeyedMutex();
  readonly #drivers = new SingleFlight<void>();
  readonly #probes = new SingleFlight<ProbeReport | null>();
  readonly #usage = new SingleFlight<UsageReport | null>();
  readonly #dirty = new Set<string>();
  readonly #lastProbeAt = new Map<string, number>();
  readonly #restartedAt = new Map<string, number>();
  readonly #createLocks = new KeyedMutex();
  readonly #abort = new AbortController();
  #baseSnapshot: { id: string; at: number } | null = null;
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: EnvironmentRunnerOptions) {
    this.#o = options;
  }

  /** Stops driver loops after their current step and cancels pending re-probes. */
  async stop(): Promise<void> {
    this.#abort.abort();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    await Promise.all([this.#drivers.idle(), this.#probes.idle(), this.#usage.idle()]);
  }

  get #stopped(): boolean {
    return this.#abort.signal.aborted;
  }

  // ---------- create + background driving ----------

  async create(teamId: string, ownerUserId: string, name: string): Promise<StoredEnvironment> {
    const stored = await this.#createLocks.run(`${teamId}/${ownerUserId}`, async () => {
      const mine = (await this.#o.actors.listEnvironments(teamId)).filter((e) => e.ownerUserId === ownerUserId && e.phase !== "disconnected");
      if (mine.length >= MAX_ENVIRONMENTS_PER_USER)
        throw conflict(`You can have at most ${MAX_ENVIRONMENTS_PER_USER} environments in a team. Disconnect one first.`);
      const id = newId("e");
      const result = await this.#o.actors.createEnvironment(teamId, { id, ownerUserId, name });
      if (!result.ok) {
        if (result.reason === "too_many_environments") throw conflict("This team has reached its environment limit.");
        throw notFound("Team not found.");
      }
      const record = newEnvironmentRecord({ id, teamId, ownerUserId, now: this.#o.now() });
      this.#records.set(key(teamId, id), record);
      const updated = await this.#o.actors.updateEnvironment(teamId, id, { linuxUser: record.linuxUser, nodeName: record.nodeName });
      if (!updated) throw notFound("Environment not found.");
      return updated;
    });
    this.#o.log.info("environment created", { teamId, envId: stored.id });
    this.kick(teamId, stored.id);
    return stored;
  }

  /** Run (or re-run) the driver loop in the background. Safe to call any number of times. */
  kick(teamId: string, envId: string): void {
    if (this.#stopped) return;
    this.#dirty.add(key(teamId, envId));
    this.drive(teamId, envId).catch((error) => this.#o.log.error("environment driver failed", { teamId, envId, error }));
  }

  /** Single-flight driver: steps until settled, backing off on retryable failures. */
  drive(teamId: string, envId: string): Promise<void> {
    const k = key(teamId, envId);
    return this.#drivers.run(k, async () => {
      for (let i = 0; i < MAX_DRIVE_STEPS && !this.#stopped; i++) {
        this.#dirty.delete(k);
        const outcome = await this.#locks.run(k, () => this.#step(teamId, envId, false));
        if (!outcome) {
          if (this.#dirty.has(k)) continue;
          return;
        }
        if (outcome.step === "failed" && outcome.record.phase !== "error") {
          await sleep(this.#backoff(outcome.record.failures), this.#abort.signal).catch(() => {});
          continue;
        }
        if (!outcome.more && !this.#dirty.has(k)) return;
      }
    });
  }

  /** Steps the environments of one team that have work to do. Called at boot and every 15 s. */
  async reconcileTeam(teamId: string, options: { viewers: boolean }): Promise<number> {
    let kicked = 0;
    for (const env of await this.#o.actors.listEnvironments(teamId)) {
      const k = key(teamId, env.id);
      const due =
        env.phase === "provisioning" ||
        env.phase === "bootstrapping" ||
        env.phase === "ready" ||
        (env.phase === "awaiting_login" && options.viewers && this.#o.now() - (this.#lastProbeAt.get(k) ?? 0) >= AWAITING_LOGIN_PROBE_MS);
      if (due && !this.#drivers.has(k)) {
        this.kick(teamId, env.id);
        kicked++;
      }
    }
    return kicked;
  }

  /** The full record (VM id, Linux user, node name, phase). Holds no secret. */
  async record(teamId: string, envId: string): Promise<EnvironmentRecord | null> {
    return (await this.#load(teamId, envId))?.record ?? null;
  }

  // ---------- owner / admin actions ----------

  pause(teamId: string, envId: string): Promise<StoredEnvironment> {
    return this.#locks.run(key(teamId, envId), async () => {
      const loaded = await this.#require(teamId, envId);
      if (loaded.stored.phase === "paused") return loaded.stored;
      const busy = async () => liveLeasesOnNode(await this.#o.actors.getWorkforceView(teamId), loaded.stored.nodeName) > 0;
      if (await busy()) throw conflict("A worker is running on this environment. Wait for it to finish before pausing.");
      // Close the window between the check and the pause: offline profiles cannot take a new lease.
      await this.#o.hooks.markProfilesOffline(teamId, envId);
      if (await busy()) {
        this.#scheduleProbe(teamId, envId, 0);
        throw conflict("A worker just started on this environment. Wait for it to finish before pausing.");
      }
      try {
        const record = await pauseEnvironment(loaded.record, { hasLiveLease: false, client: this.#o.client(), now: this.#o.now() });
        const stored = await this.#persist(teamId, loaded.stored, { ...record, lastError: null });
        this.#o.log.info("environment paused", { teamId, envId });
        return stored ?? loaded.stored;
      } catch (error) {
        this.#scheduleProbe(teamId, envId, 0);
        throw toAppError(error);
      }
    });
  }

  /** Resumes a paused environment, or retries one parked in `error`. */
  async resume(teamId: string, envId: string): Promise<StoredEnvironment> {
    const stored = await this.#locks.run(key(teamId, envId), async () => {
      const loaded = await this.#require(teamId, envId);
      if (loaded.stored.phase === "error") {
        const outcome = await this.#step(teamId, envId, true, loaded);
        this.#o.log.info("environment retry requested", { teamId, envId });
        return outcome?.stored ?? loaded.stored;
      }
      if (loaded.stored.phase !== "paused") throw conflict("This environment is not paused.");
      try {
        const record = await resumeEnvironment(loaded.record, { client: this.#o.client(), now: this.#o.now(), vmWait: this.#o.vmWait });
        this.#o.log.info("environment resumed", { teamId, envId });
        return (await this.#persist(teamId, loaded.stored, record)) ?? loaded.stored;
      } catch (error) {
        throw toAppError(error);
      }
    });
    this.kick(teamId, envId);
    this.#scheduleProbe(teamId, envId, 0);
    return stored;
  }

  /**
   * A short-lived terminal token for the owner's browser. Every environment has its own Freestyle
   * identity (created on first use and stored on the environment) whose only grant is this VM as the
   * engineer's Linux user, so a token can never open another VM. The owner's older user-wide identity
   * loses its grant on this VM. The caller checks ownership and phase; this rechecks under the lock.
   */
  mintTerminal(teamId: string, envId: string): Promise<TerminalTokenResponse> {
    return this.#locks.run(key(teamId, envId), async () => {
      const { stored } = await this.#require(teamId, envId);
      const vmId = stored.freestyleVmId;
      const linuxUser = stored.linuxUser;
      if (stored.phase === "disconnected" || !vmId || !linuxUser) throw conflict("This environment is not ready for a terminal yet.");
      const client = this.#o.client();
      try {
        let identityId = stored.freestyleIdentityId ?? null;
        if (!identityId) {
          identityId = (await client.identities.create()).identityId;
          const saved = await this.#o.actors.updateEnvironment(teamId, envId, { freestyleIdentityId: identityId }).catch(async (error) => {
            await deleteTerminalIdentity({ identityId: identityId!, client }).catch(() => undefined);
            throw error;
          });
          if (!saved) {
            await deleteTerminalIdentity({ identityId, client });
            throw conflict("This environment is not ready for a terminal yet.");
          }
          this.#o.log.info("terminal identity created", { teamId, envId });
        }
        const legacy = (await this.#o.actors.getUserSecrets(stored.ownerUserId))?.freestyleIdentityId ?? null;
        if (legacy) await revokeTerminalAccess({ identityId: legacy, vmId, client });
        return (await mintTerminalToken({ identityId, vmId, linuxUser, client })).response;
      } catch (error) {
        throw toAppError(error);
      }
    });
  }

  /**
   * Sign-out everywhere: cut every terminal grant and token the user holds, on their own
   * environments' identities in `teamIds` and on their older user-wide identity. Best effort per
   * identity; returns how many identities could not be cut (their tokens still expire within 15 min).
   */
  async revokeUserTerminals(userId: string, teamIds: readonly string[], legacyIdentityId: string | null): Promise<{ failed: number }> {
    const client = this.#o.client();
    const identityIds = legacyIdentityId ? [legacyIdentityId] : [];
    for (const teamId of teamIds) {
      for (const env of await this.#o.actors.listEnvironments(teamId)) {
        if (env.ownerUserId === userId && env.phase !== "disconnected" && env.freestyleIdentityId) identityIds.push(env.freestyleIdentityId);
      }
    }
    let failed = 0;
    for (const identityId of identityIds) {
      try {
        await revokeIdentityAccess({ identityId, client });
      } catch (error) {
        failed++;
        this.#o.log.error("terminal revoke failed", { userId, error });
      }
    }
    return { failed };
  }

  /**
   * Deletes the environment's terminal identity, revokes `identityIds`' grants (older user-wide
   * identities), deletes the VM and removes the environment's profiles. Terminal.
   */
  disconnect(teamId: string, envId: string, identityIds: string[]): Promise<StoredEnvironment> {
    return this.#locks.run(key(teamId, envId), async () => {
      const loaded = await this.#require(teamId, envId);
      if (loaded.stored.phase === "disconnected") return loaded.stored;
      const client = this.#o.client();
      let record = loaded.record;
      try {
        const envIdentity = loaded.stored.freestyleIdentityId;
        if (envIdentity) await deleteTerminalIdentity({ identityId: envIdentity, client });
        // A crash between creating the VM and persisting its id leaves a VM only the slug can find.
        if (!record.freestyleVmId) {
          const found = await getVmData(client, record.vmSlug);
          if (found) record = { ...record, freestyleVmId: found.id };
        }
        record = await disconnectEnvironment(record, { deleteVm: true, identityIds, client, now: this.#o.now() });
      } catch (error) {
        throw toAppError(error);
      }
      const stored = (await this.#persist(teamId, loaded.stored, record)) ?? loaded.stored;
      this.#records.delete(key(teamId, envId));
      await this.#o.hooks.removeProfiles(teamId, envId);
      this.#o.log.info("environment disconnected", { teamId, envId });
      return { ...stored, phase: "disconnected" };
    });
  }

  /** Deletes a member's warm snapshots in the team: they hold code the member may no longer read. */
  forgetWarmSnapshots(teamId: string, userId: string): Promise<number> {
    return deleteWarmSnapshots(this.#o.client(), { teamId, ownerUserId: userId });
  }

  /**
   * Health probe now. In `awaiting_login` this is the provisioning step itself (it moves the
   * environment to `ready` once a CLI is logged in). Null when the environment cannot be probed.
   */
  probe(teamId: string, envId: string): Promise<ProbeReport | null> {
    const k = key(teamId, envId);
    return this.#probes.run(k, () =>
      this.#locks.run(k, async () => {
        const loaded = await this.#load(teamId, envId);
        if (!loaded) return null;
        const { stored, record } = loaded;
        if (stored.phase === "awaiting_login") {
          const outcome = await this.#step(teamId, envId, false, loaded);
          if (outcome?.more) this.kick(teamId, envId);
          return outcome?.probe ?? null;
        }
        if (stored.phase !== "ready" || !record.freestyleVmId) return null;
        let report: ProbeReport;
        try {
          report = await probeEnvironment({ client: this.#o.client(), vmId: record.freestyleVmId, linuxUser: record.linuxUser });
        } catch (error) {
          throw toAppError(error);
        }
        await this.#afterProbe(teamId, stored, report);
        return report;
      }),
    );
  }

  /**
   * Subscription usage of the CLIs on a ready, running environment, read on the VM as its engineer (the token
   * stays there). Not under the environment lock: it changes nothing on the VM, and a slow vendor must not hold
   * up a driver step. Null when the environment cannot be read now.
   */
  readUsage(teamId: string, envId: string): Promise<UsageReport | null> {
    return this.#usage.run(key(teamId, envId), async () => {
      const loaded = await this.#load(teamId, envId);
      if (!loaded) return null;
      const { stored, record } = loaded;
      if (stored.phase !== "ready" || stored.vmState !== "running" || !record.freestyleVmId) return null;
      try {
        return await probeUsage({ client: this.#o.client(), vmId: record.freestyleVmId, linuxUser: record.linuxUser });
      } catch (error) {
        throw toAppError(error);
      }
    });
  }

  /** Restart the Relay broker unit. Rate-limited per environment; every restart is logged. */
  restartNode(teamId: string, envId: string, reason: string): Promise<boolean> {
    const k = key(teamId, envId);
    const last = this.#restartedAt.get(k);
    if (last !== undefined && this.#o.now() - last < NODE_RESTART_MIN_INTERVAL_MS) {
      this.#o.log.info("relay node restart skipped (rate limited)", { teamId, envId, reason });
      return Promise.resolve(false);
    }
    this.#restartedAt.set(k, this.#o.now());
    return this.#locks.run(k, async () => {
      const loaded = await this.#load(teamId, envId);
      if (!loaded || loaded.stored.phase !== "ready" || !loaded.record.freestyleVmId) return false;
      const vm = this.#o.client().vms.ref(loaded.record.freestyleVmId);
      const result = await restartNodeService(vm, loaded.record.linuxUser);
      this.#o.log.warn("relay node restarted", { teamId, envId, nodeName: loaded.stored.nodeName, reason, active: result.active });
      if (result.restarted) this.#scheduleProbe(teamId, envId, this.#o.reprobeDelayMs ?? 5_000);
      return result.restarted;
    });
  }

  // ---------- status ----------

  /**
   * Applies observed VM states to the stored environments and publishes `env.status` on change.
   * `states` comes from one list sweep; without it each VM is read individually.
   */
  async applyVmStates(teamId: string, states: Map<string, VmState> | null): Promise<void> {
    const client = this.#o.client();
    for (const env of await this.#o.actors.listEnvironments(teamId)) {
      if (env.phase === "disconnected" || !env.freestyleVmId) continue;
      let state: VmState | null;
      if (states) state = states.get(env.freestyleVmId) ?? null;
      else {
        const data = await getVmData(client, env.freestyleVmId).catch((error) => {
          this.#o.log.warn("vm status read failed", { teamId, envId: env.id, error });
          return undefined;
        });
        if (data === undefined) continue;
        state = data ? toVmState(data.state) : null;
      }
      if (state === null) {
        // The VM is gone. The driver parks the environment in `error` with a clear message.
        if (env.phase === "ready" || env.phase === "awaiting_login" || env.phase === "bootstrapping") this.kick(teamId, env.id);
        continue;
      }
      if (state !== env.vmState) await this.setLive(teamId, env.id, { vmState: state });
    }
  }

  /** Records observed VM/node state and tells viewers. */
  async setLive(teamId: string, envId: string, patch: Pick<EnvironmentPatch, "vmState" | "nodeOnline">): Promise<void> {
    const updated = await this.#o.actors.updateEnvironment(teamId, envId, patch);
    if (!updated) return;
    const cached = this.#records.get(key(teamId, envId));
    if (cached && patch.vmState) this.#records.set(key(teamId, envId), { ...cached, vmState: patch.vmState });
    this.#o.publish(teamId, {
      kind: "env.status",
      teamId,
      data: { envId, vmState: updated.vmState, nodeOnline: updated.nodeOnline, at: this.#o.now() },
    });
  }

  // ---------- internals ----------

  async #step(teamId: string, envId: string, retry: boolean, preloaded?: Loaded): Promise<StepOutcome | null> {
    const loaded = preloaded ?? (await this.#load(teamId, envId));
    if (!loaded) return null;
    const { stored, record } = loaded;
    if (stored.phase === "disconnected" || stored.phase === "paused" || (stored.phase === "error" && !retry)) return null;

    const prepared = await this.#prepare(teamId, stored, record);
    if ("wait" in prepared) {
      const waiting = prepared.wait === null ? stored : await this.#persist(teamId, stored, { ...record, lastError: prepared.wait });
      return waiting ? { stored: waiting, record, step: null, more: false } : null;
    }
    const result = await advanceEnvironment(record, { ...prepared.input, retry });
    if (result.probe) this.#lastProbeAt.set(key(teamId, envId), this.#o.now());
    const persisted = result.record === record ? stored : await this.#persist(teamId, stored, result.record);
    if (!persisted) return null;
    if (result.step && result.step !== "probe") this.#o.log.info("environment step", { teamId, envId, step: result.step, phase: result.record.phase });
    if (result.step === "failed") this.#o.log.warn("environment step failed", { teamId, envId, failures: result.record.failures, error: result.record.lastError });
    if (result.warning) this.#o.log.warn("environment step warning", { teamId, envId, step: result.step, warning: result.warning });
    if (result.probe) await this.#afterProbe(teamId, persisted, result.probe);
    if (result.step === "sync node") this.#scheduleProbe(teamId, envId, this.#o.reprobeDelayMs ?? 5_000);
    return { stored: persisted, record: result.record, step: result.step, more: result.more, probe: result.probe };
  }

  /**
   * Everything advanceEnvironment needs, or why not to run now. `wait: null` means "nothing to do"
   * (node config already current, or deferred while workers run on the node).
   */
  async #prepare(
    teamId: string,
    stored: StoredEnvironment,
    record: EnvironmentRecord,
  ): Promise<{ input: AdvanceInput } | { wait: string | null }> {
    let relay: RelayNodeSecrets;
    try {
      const access = await this.#o.workspaces.access(teamId);
      if (!access) return { wait: "Agent Relay is not configured on this server." };
      relay = { workspaceKey: access.workspaceKey, baseUrl: access.config.baseUrl === HOSTED_RELAY_BASE_URL ? null : access.config.baseUrl };
    } catch (error) {
      this.#o.log.warn("environment waiting for relay", { teamId, envId: stored.id, error });
      return { wait: "Waiting for Agent Relay to become available." };
    }
    const view = await this.#o.actors.getWorkforceView(teamId);
    const profiles: NodeProfileInput[] = Object.values(view.profiles)
      .filter((p) => p.envId === stored.id)
      .map((p) => ({ cli: p.cli, ready: p.auth === "ok" }));

    if (stored.phase === "ready") {
      const hash = nodeConfigHash({ linuxUser: record.linuxUser, nodeName: record.nodeName, config: desiredNodeConfig(profiles), relay });
      if (hash === record.nodeConfigHash) return { wait: null };
      // A node config change restarts the broker, which kills its workers. Wait for them to finish.
      if (liveLeasesOnNode(view, stored.nodeName) > 0) return { wait: null };
    }

    const team = await this.#o.gateway.getTeam(teamId);
    const repos = team?.projects.map((p) => p.repoFullName) ?? [];
    const warm = await this.#warmPlan(teamId, stored, record, repos);
    let githubToken: string | null = null;
    if (stored.phase === "bootstrapping" && repos.some((r) => !record.progress.repos.includes(r))) {
      githubToken = await this.#o.githubToken(stored.ownerUserId).catch(() => {
        this.#o.log.warn("owner github token unavailable; cloning public repos only", { teamId, envId: stored.id });
        return null;
      });
    }
    return {
      input: {
        relay,
        profiles,
        repos,
        githubToken,
        snapshot: warm.snapshot ?? this.#o.snapshot,
        warm: warm.target,
        client: this.#o.client(),
        now: this.#o.now,
        vmWait: this.#o.vmWait,
      },
    };
  }

  /**
   * The owner's warm snapshot (warm.ts): where to save it once the repos are cloned and, for a new VM, the
   * one to boot from. A VM boots from it only while the owner can still read every repo, so it never hands
   * back code they lost access to. Any failure here falls back to the golden image.
   */
  async #warmPlan(
    teamId: string,
    stored: StoredEnvironment,
    record: EnvironmentRecord,
    repos: readonly string[],
  ): Promise<{ snapshot: string | null; target: WarmTarget | null }> {
    const gate = this.#o.canReadRepos;
    const booting = stored.phase === "provisioning";
    const saving = stored.phase === "bootstrapping" && !record.progress.warm;
    if (!gate || repos.length === 0 || (!booting && !saving)) return { snapshot: null, target: null };
    try {
      const client = this.#o.client();
      const target = warmTarget({ teamId, ownerUserId: stored.ownerUserId, baseSnapshotId: await this.#baseSnapshotId(client), repos });
      if (!booting) return { snapshot: null, target };
      const found = await findWarmSnapshot(client, target.slug);
      if (!found || !(await gate(stored.ownerUserId, repos))) return { snapshot: null, target };
      this.#o.log.info("environment booting from warm snapshot", { teamId, envId: stored.id });
      return { snapshot: found, target };
    } catch (error) {
      this.#o.log.warn("warm snapshot unavailable; using the golden image", { teamId, envId: stored.id, error });
      return { snapshot: null, target: null };
    }
  }

  /** The golden image's snapshot id. Part of the warm key: a rebuild keeps the slug but must not reuse old images. */
  async #baseSnapshotId(client: Freestyle): Promise<string> {
    const now = this.#o.now();
    if (this.#baseSnapshot && now - this.#baseSnapshot.at < BASE_SNAPSHOT_TTL_MS) return this.#baseSnapshot.id;
    const id = await resolveSnapshotId(client, this.#o.snapshot);
    this.#baseSnapshot = { id, at: now };
    return id;
  }

  async #afterProbe(teamId: string, stored: StoredEnvironment, report: ProbeReport): Promise<void> {
    this.#lastProbeAt.set(key(teamId, stored.id), this.#o.now());
    if (report.ok) {
      const nodeOnline = report.relay.node === "active";
      if (nodeOnline !== stored.nodeOnline) await this.setLive(teamId, stored.id, { nodeOnline });
    }
    const changed = await this.#o.hooks.onProbe(teamId, stored, report);
    if (changed) this.kick(teamId, stored.id);
  }

  async #load(teamId: string, envId: string): Promise<Loaded | null> {
    const k = key(teamId, envId);
    const stored = await this.#o.actors.getEnvironment(teamId, envId);
    if (!stored) {
      this.#records.delete(k);
      return null;
    }
    const cached = this.#records.get(k);
    const base = cached ?? newEnvironmentRecord({ id: stored.id, teamId, ownerUserId: stored.ownerUserId, now: stored.createdAt });
    const record: EnvironmentRecord = {
      ...base,
      phase: stored.phase,
      vmState: stored.vmState,
      freestyleVmId: stored.freestyleVmId,
      lastError: stored.lastError,
      createdAt: stored.createdAt,
    };
    // Rebuilt after a restart: retry from the earliest phase that is safe to repeat.
    if (!cached && stored.phase === "error") record.resumePhase = stored.freestyleVmId ? "bootstrapping" : "provisioning";
    return { stored, record };
  }

  async #require(teamId: string, envId: string): Promise<Loaded> {
    const loaded = await this.#load(teamId, envId);
    if (!loaded) throw notFound("Environment not found.");
    return loaded;
  }

  /** Writes the fields the Team actor keeps. Null when the environment vanished or was disconnected. */
  async #persist(teamId: string, stored: StoredEnvironment, record: EnvironmentRecord): Promise<StoredEnvironment | null> {
    const k = key(teamId, stored.id);
    this.#records.set(k, record);
    const lastError = record.lastError === null ? null : record.lastError.replace(CONTROL_CHARS, " ").trim().slice(0, 500) || null;
    const next: EnvironmentPatch = {
      phase: record.phase,
      vmState: record.vmState,
      freestyleVmId: record.freestyleVmId,
      linuxUser: record.linuxUser,
      nodeName: record.nodeName,
      lastError,
    };
    const patch: EnvironmentPatch = {};
    for (const [field, value] of Object.entries(next) as [keyof EnvironmentPatch, unknown][]) {
      if (stored[field] !== value) (patch as Record<string, unknown>)[field] = value;
    }
    if (Object.keys(patch).length === 0) return stored;
    const updated = await this.#o.actors.updateEnvironment(teamId, stored.id, patch);
    if (!updated) {
      this.#records.delete(k);
      return null;
    }
    this.#o.publish(teamId, { kind: "env.view", teamId, data: toEnvironmentView(updated) });
    return updated;
  }

  #scheduleProbe(teamId: string, envId: string, delayMs: number): void {
    if (this.#stopped) return;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.probe(teamId, envId).catch((error) => this.#o.log.warn("scheduled probe failed", { teamId, envId, error }));
    }, delayMs);
    timer.unref?.();
    this.#timers.add(timer);
  }

  #backoff(failures: number): number {
    return (this.#o.backoffMs ?? ((n: number) => Math.min(1_000 * 2 ** Math.max(0, n - 1), 30_000)))(failures);
  }
}

function key(teamId: string, envId: string): string {
  return `${teamId}/${envId}`;
}
