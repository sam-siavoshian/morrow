import { Id, type ServerFrame, type VmState } from "@morrow/contracts";
import type { Freestyle } from "freestyle";
import type { ActorGateway } from "../actors/types.ts";
import type { Env } from "../env.ts";
import type { Keys } from "../http/context.ts";
import { githubTokenFor } from "../http/githubAccess.ts";
import type { GithubClient } from "../integrations/github/client.ts";
import type { TeamEvents } from "../http/teamEvents.ts";
import { DEFAULT_BASE_SNAPSHOT, freestyle, type EnvironmentRecord, type WorkerLogTail } from "../integrations/freestyle/index.ts";
import { toVmState } from "../integrations/freestyle/vm.ts";
import { RelayIntegrationError, type Speaker, type TeamRelayObserverOptions } from "../integrations/relay/index.ts";
import { isRelayNotFound } from "../integrations/relay/errors.ts";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import type { RealtimeHub, ViewerContext } from "../realtime/hub.ts";
import type { TicketStore } from "../realtime/tickets.ts";
import type { RuntimeActors, StoredEnvironment } from "./actors.ts";
import type { RuntimeBus, RuntimeSignal } from "./bus.ts";
import { EnvironmentRunner } from "./environments.ts";
import { InspectHub } from "./inspect.ts";
import { ObserverManager, type ObserverLike } from "./observers.ts";
import { notifySignedOut, ProfileService } from "./profiles.ts";
import { RelayWorkspaces } from "./relayWorkspaces.ts";
import { WorkerLogService } from "./workerLogs.ts";
import type { TeamRelayAccess, TeamRuntimeApi } from "./types.ts";

export interface RuntimeTiming {
  reconcileMs: number;
  /** A touched team stays active this long without viewers. */
  touchTtlMs: number;
  statusViewersMs: number;
  statusAllMs: number;
  probeMs: number;
  /** A ready node still offline after this long gets its broker restarted. */
  nodeOfflineGraceMs: number;
  /** Live inspect: the slowest log poll while a worker is quiet (polling is the fallback when streaming fails). */
  inspectPollMs: number;
  /** Live inspect follows logs as they are written (a Freestyle PTY per viewed worker) instead of polling. */
  inspectStreaming: boolean;
}

export const DEFAULT_TIMING: RuntimeTiming = {
  reconcileMs: 15_000,
  touchTtlMs: 30 * 60_000,
  statusViewersMs: 10_000,
  statusAllMs: 60_000,
  probeMs: 60_000,
  nodeOfflineGraceMs: 60_000,
  inspectPollMs: 1_500,
  inspectStreaming: true,
};

export interface TeamRuntimeOptions {
  env: Env;
  log: Logger;
  keys: Keys;
  gateway: ActorGateway;
  actors: RuntimeActors;
  hub: RealtimeHub;
  tickets: TicketStore;
  bus: RuntimeBus;
  teamEvents: TeamEvents;
  now: () => number;
  /** Defaults to the shared SDK client built from FREESTYLE_API_KEY. */
  freestyleClient?: () => Freestyle;
  /** Checks repo access before an environment boots from a warm snapshot. Without it, warm snapshots are off. */
  github?: Pick<GithubClient, "getRepo">;
  timing?: Partial<RuntimeTiming>;
  createObserver?: (options: TeamRelayObserverOptions) => ObserverLike;
  observerFlushMs?: number;
  vmWait?: { timeoutMs?: number; intervalMs?: number };
  backoffMs?: (failures: number) => number;
  reprobeDelayMs?: number;
}

/**
 * The live machinery between HTTP and the vendors: one Relay workspace and observer per team, the
 * environment runner and its loops, CLI profile health, and read-only inspect. Orchestration sees it
 * only through `TeamRuntimeApi`.
 *
 * Which teams get background work: teams with viewers, teams touched in the last 30 min, teams with
 * live leases, and (for environment reconcile and VM polling) every team that owns a Morrow VM, found
 * at boot and every minute by listing VMs by metadata. Single backend instance (architecture 13).
 */
export class TeamRuntime implements TeamRuntimeApi {
  readonly workspaces: RelayWorkspaces;
  readonly observers: ObserverManager;
  readonly environments: EnvironmentRunner;
  readonly profiles: ProfileService;
  readonly inspect: InspectHub;
  /** Ended workers' last output (`GET .../leases/:leaseId/log`) and the bounded copy kept of each worker's log. */
  readonly workerLogs: WorkerLogService;
  readonly timing: RuntimeTiming;
  /** The runtime's Terse door (environments, Relay secrets, profiles, leases). */
  readonly store: RuntimeActors;
  readonly #o: TeamRuntimeOptions;
  readonly #log: Logger;
  readonly #client: () => Freestyle;
  readonly #touched = new Map<string, number>();
  /** Teams known to own environments. */
  readonly #known = new Set<string>();
  readonly #liveLeaseTeams = new Set<string>();
  readonly #offlineChecks = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #timers: ReturnType<typeof setInterval>[] = [];
  readonly #busy = new Set<string>();
  #lastSweepAt = 0;
  #lastHeartbeatAt = 0;
  #started = false;

  constructor(options: TeamRuntimeOptions) {
    this.#o = options;
    this.#log = options.log;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.#client = options.freestyleClient ?? freestyle;
    this.store = options.actors;
    const { env, actors, gateway, hub, now } = options;

    this.workspaces = new RelayWorkspaces({
      config: env.relay ? { baseUrl: env.relay.baseUrl } : null,
      actors,
      key: options.keys.data,
      teamExists: async (teamId) => (await gateway.getTeam(teamId)) !== null,
      log: this.#log.child({ mod: "relay" }),
      now,
    });
    this.observers = new ObserverManager({
      workspaces: this.workspaces,
      actors,
      publish: (teamId, frame) => void hub.publish(teamId, frame),
      bus: options.bus,
      log: this.#log.child({ mod: "observer" }),
      flushIntervalMs: options.observerFlushMs,
      createObserver: options.createObserver,
    });
    this.profiles = new ProfileService({
      actors,
      log: this.#log.child({ mod: "profiles" }),
      now,
      features: { freestyle: env.freestyle !== null, relay: env.relay !== null },
    });
    this.environments = new EnvironmentRunner({
      actors,
      gateway,
      githubToken: (userId) => githubTokenFor({ keys: options.keys, actors: gateway }, userId),
      canReadRepos: options.github ? (userId, repos) => this.#canReadRepos(options.github!, userId, repos) : undefined,
      workspaces: this.workspaces,
      client: this.#client,
      publish: (teamId, frame) => void hub.publish(teamId, frame),
      log: this.#log.child({ mod: "environments" }),
      now,
      snapshot: env.freestyle?.baseSnapshot ?? DEFAULT_BASE_SNAPSHOT,
      vmWait: options.vmWait,
      backoffMs: options.backoffMs,
      reprobeDelayMs: options.reprobeDelayMs,
      hooks: {
        onProbe: (teamId, stored, report) => this.profiles.onProbe(teamId, stored, report),
        markProfilesOffline: (teamId, envId) => this.profiles.markOffline(teamId, envId),
        removeProfiles: (teamId, envId) => this.profiles.removeForEnvironment(teamId, envId),
      },
    });
    this.profiles.attach(this.environments);
    this.inspect = new InspectHub({
      tickets: options.tickets,
      appOrigin: env.appOrigin,
      actors,
      gateway,
      client: this.#client,
      log: this.#log.child({ mod: "inspect" }),
      now,
      pollMs: this.timing.inspectPollMs,
      streaming: this.timing.inspectStreaming,
    });
    this.workerLogs = new WorkerLogService({
      actors,
      client: this.#client,
      enabled: env.freestyle !== null,
      log: this.#log.child({ mod: "worker-logs" }),
    });

    hub.onViewerJoin((ctx) => this.#onViewerJoin(ctx));
    notifySignedOut(hub, this.#log.child({ mod: "profiles" }));
    hub.onClientFrame("relay.history", (ctx, frame) => this.#onHistory(ctx, frame.channel, frame.before));
    hub.onClientFrame("relay.thread", (ctx, frame) => this.#onThread(ctx, frame.messageId));
    options.teamEvents.onTeamCreated(async ({ teamId }) => {
      await this.workspaces.access(teamId);
    });
    options.teamEvents.onMemberRemoved(({ teamId, userId }) => this.#onMemberRemoved(teamId, userId));
    options.bus.subscribe((signal) => this.#onSignal(signal));
  }

  /** The Freestyle SDK client. Throws FeatureDisabledError without a key. */
  freestyleClient(): Freestyle {
    return this.#client();
  }

  get freestyleEnabled(): boolean {
    return this.#o.env.freestyle !== null;
  }

  // ---------- TeamRuntimeApi ----------

  relay(teamId: string): Promise<TeamRelayAccess | null> {
    return this.workspaces.access(teamId);
  }

  speakerFor(teamId: string, userId: string): Promise<Speaker | null> {
    return this.workspaces.speakerFor(teamId, userId);
  }

  async environment(teamId: string, envId: string): Promise<EnvironmentRecord | null> {
    return this.environments.record(teamId, envId);
  }

  publish(teamId: string, frame: ServerFrame): void {
    this.#o.hub.publish(teamId, frame);
  }

  activeTeamIds(): string[] {
    const cutoff = this.#o.now() - this.timing.touchTtlMs;
    const active = new Set(this.#o.hub.activeTeamIds());
    for (const [teamId, at] of this.#touched) {
      if (at >= cutoff) active.add(teamId);
      else this.#touched.delete(teamId);
    }
    for (const teamId of this.#liveLeaseTeams) active.add(teamId);
    return [...active];
  }

  touchTeam(teamId: string): void {
    if (!Id.safeParse(teamId).success) return;
    this.#touched.set(teamId, this.#o.now());
    this.#known.add(teamId);
    if (this.#started) this.observers.ensure(teamId).catch((error) => this.#log.warn("observer start failed", { teamId, error }));
  }

  rememberWorkerLog(teamId: string, agentName: string, tail: WorkerLogTail): void {
    this.workerLogs.remember(teamId, agentName, tail);
  }

  async restartNode(teamId: string, envId: string, reason = "requested by orchestration"): Promise<boolean> {
    if (!this.freestyleEnabled) return false;
    return this.environments.restartNode(teamId, envId, reason);
  }

  /** Routes call this so the loops cover a team as soon as it has an environment. */
  noteTeam(teamId: string): void {
    this.#known.add(teamId);
  }

  /** Sign-out everywhere: the user's inspect sockets close and every terminal grant and token they hold is cut. */
  async signOutEverywhere(userId: string): Promise<void> {
    this.inspect.closeUser(null, userId);
    if (!this.freestyleEnabled) return;
    const user = await this.#o.actors.getUserSecrets(userId);
    if (!user) return;
    const { failed } = await this.environments.revokeUserTerminals(userId, user.teamIds, user.freestyleIdentityId);
    this.#log.info("terminal access revoked", { userId, failed });
  }

  // ---------- lifecycle ----------

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const t = this.timing;
    this.#every(t.reconcileMs, "reconcile", () => this.reconcile());
    this.#every(t.statusViewersMs, "status", () => this.pollStatus());
    this.#every(t.probeMs, "probe", () => this.probeActive());
    // Boot reconcile: find every team that owns a VM, then resume whatever was mid-flight.
    void this.#guard("boot", async () => {
      await this.pollStatus(true);
      await this.reconcile();
    });
    this.#log.info("team runtime started", { freestyle: this.freestyleEnabled, relay: this.workspaces.enabled });
  }

  async stop(): Promise<void> {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.length = 0;
    for (const timer of this.#offlineChecks.values()) clearTimeout(timer);
    this.#offlineChecks.clear();
    this.inspect.shutdown();
    await this.environments.stop();
    await this.observers.stopAll();
  }

  /** Environment reconcile for known teams, then observer start/stop for active ones. */
  async reconcile(): Promise<void> {
    const active = new Set(this.activeTeamIds());
    const teams = new Set([...this.#known, ...active]);
    const liveLeaseTeams = new Set<string>();
    for (const teamId of teams) {
      try {
        const view = await this.#o.actors.getWorkforceView(teamId);
        if (Object.values(view.leases).some((l) => l.state === "reserved" || l.state === "spawning" || l.state === "running")) liveLeaseTeams.add(teamId);
        if (this.freestyleEnabled) {
          const envs = (await this.#o.actors.listEnvironments(teamId)).filter((e) => e.phase !== "disconnected");
          if (envs.length > 0) {
            this.#known.add(teamId);
            await this.#disconnectOrphans(teamId, envs);
          } else if (!active.has(teamId)) this.#known.delete(teamId);
          await this.environments.reconcileTeam(teamId, { viewers: this.#o.hub.hasViewers(teamId) });
        }
      } catch (error) {
        this.#log.warn("team reconcile failed", { teamId, error });
      }
    }
    this.#liveLeaseTeams.clear();
    for (const teamId of liveLeaseTeams) this.#liveLeaseTeams.add(teamId);
    if (this.#o.now() - this.#lastHeartbeatAt >= 60_000) {
      this.#lastHeartbeatAt = this.#o.now();
      this.#log.info("runtime heartbeat", {
        knownTeams: this.#known.size,
        activeTeams: active.size,
        liveLeaseTeams: liveLeaseTeams.size,
        observers: this.observers.teams().length,
        inspect: this.inspect.stats(),
      });
    }

    if (!this.workspaces.enabled) return;
    const wanted = new Set(this.activeTeamIds());
    for (const teamId of this.observers.teams()) if (!wanted.has(teamId)) await this.observers.stop(teamId);
    for (const teamId of wanted) {
      await this.observers.ensure(teamId).catch((error) => this.#log.warn("observer start failed", { teamId, error }));
    }
  }

  /**
   * VM states: every tick for teams with viewers (one read per VM); once a minute (or `sweep`) one
   * paged list of every Morrow VM covers the rest and discovers teams.
   */
  async pollStatus(sweep = false): Promise<void> {
    if (!this.freestyleEnabled) return;
    const viewers = new Set(this.#o.hub.activeTeamIds());
    for (const teamId of viewers) {
      await this.environments.applyVmStates(teamId, null).catch((error) => this.#log.warn("vm status poll failed", { teamId, error }));
    }
    if (!sweep && this.#o.now() - this.#lastSweepAt < this.timing.statusAllMs) return;
    this.#lastSweepAt = this.#o.now();
    const { states, teams } = await this.#listVms();
    for (const teamId of teams) this.#known.add(teamId);
    for (const teamId of this.#known) {
      if (viewers.has(teamId)) continue;
      await this.environments.applyVmStates(teamId, states).catch((error) => this.#log.warn("vm status sweep failed", { teamId, error }));
    }
  }

  /**
   * Health probes for ready environments of teams with viewers or live leases, and their usage reads when due
   * (in the background: a slow vendor must not hold up the next environment's probe).
   */
  async probeActive(): Promise<void> {
    if (!this.freestyleEnabled) return;
    const teams = new Set([...this.#o.hub.activeTeamIds(), ...this.#liveLeaseTeams]);
    for (const teamId of teams) {
      for (const env of await this.#o.actors.listEnvironments(teamId).catch(() => [])) {
        if (env.phase !== "ready") continue;
        await this.environments.probe(teamId, env.id).catch((error) => this.#log.warn("periodic probe failed", { teamId, envId: env.id, error }));
        this.profiles.refreshUsage(teamId, env.id).catch((error) => this.#log.warn("usage read failed", { teamId, envId: env.id, error }));
      }
    }
  }

  // ---------- handlers ----------

  async #onViewerJoin(ctx: ViewerContext): Promise<void> {
    if (!this.workspaces.enabled) return;
    const frame = await this.observers.history(ctx.teamId, null, null);
    if (frame) ctx.send(frame);
  }

  async #onHistory(ctx: ViewerContext, channel: string | null, before: string | null): Promise<void> {
    if (!this.workspaces.enabled) {
      ctx.send({ kind: "error", teamId: ctx.teamId, code: "feature_disabled", message: "Agent Relay is not configured on this server." });
      return;
    }
    try {
      const frame = await this.observers.history(ctx.teamId, channel, before);
      if (frame) ctx.send(frame);
    } catch (error) {
      if (error instanceof RelayIntegrationError && error.code === "invalid_input") {
        ctx.send({ kind: "error", teamId: ctx.teamId, code: "bad_request", message: "Unknown channel or cursor." });
        return;
      }
      this.#log.warn("relay history failed", { teamId: ctx.teamId, error });
      const code = error instanceof AppError ? error.code : "dependency_unavailable";
      ctx.send({ kind: "error", teamId: ctx.teamId, code, message: "Could not load history. Try again shortly." });
    }
  }

  /** A task thread for mission control: the same visibility as channel history (every member reads the workspace). */
  async #onThread(ctx: ViewerContext, messageId: string): Promise<void> {
    if (!this.workspaces.enabled) {
      ctx.send({ kind: "error", teamId: ctx.teamId, code: "feature_disabled", message: "Agent Relay is not configured on this server." });
      return;
    }
    try {
      const frame = await this.observers.thread(ctx.teamId, messageId);
      if (frame) ctx.send(frame);
    } catch (error) {
      if (isRelayNotFound(error) || (error instanceof RelayIntegrationError && error.code === "invalid_input")) {
        ctx.send({ kind: "error", teamId: ctx.teamId, code: "not_found", message: "That thread does not exist." });
        return;
      }
      this.#log.warn("relay thread failed", { teamId: ctx.teamId, error });
      const code = error instanceof AppError ? error.code : "dependency_unavailable";
      ctx.send({ kind: "error", teamId: ctx.teamId, code, message: "Could not load the thread. Try again shortly." });
    }
  }

  /** True only when the owner's token reads every repo now. Any doubt (no token, error, rate limit) is false. */
  async #canReadRepos(github: Pick<GithubClient, "getRepo">, userId: string, repos: readonly string[]): Promise<boolean> {
    const token = await githubTokenFor({ keys: this.#o.keys, actors: this.#o.gateway }, userId).catch(() => null);
    if (!token) return false;
    try {
      for (const repo of repos) await github.getRepo(token, repo);
      return true;
    } catch {
      return false;
    }
  }

  async #onMemberRemoved(teamId: string, userId: string): Promise<void> {
    this.inspect.closeUser(teamId, userId);
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["disconnect member environments", () => this.#disconnectMemberEnvironments(teamId, userId)],
      ["delete member warm snapshots", async () => (this.freestyleEnabled ? this.environments.forgetWarmSnapshots(teamId, userId) : 0)],
      [
        "rotate observer token",
        async () => {
          if (await this.workspaces.rotateObserver(teamId)) await this.observers.restart(teamId);
        },
      ],
      ["revoke member identity", () => this.workspaces.revokeMember(teamId, userId)],
    ];
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        this.#log.error("member removal cleanup failed", { teamId, step, error });
      }
    }
  }

  /**
   * A removed member's environments in the team are disconnected: terminal identity deleted and grants
   * revoked, VM deleted (its node and Relay key with it), profiles removed so their live leases expire
   * into handoff from the last pushed checkpoint. Work after that checkpoint is lost on purpose: nothing
   * from the VM of someone who just lost access is pushed. The reconcile loop retries any failure.
   */
  async #disconnectMemberEnvironments(teamId: string, userId: string): Promise<void> {
    if (!this.freestyleEnabled) return;
    const envs = (await this.#o.actors.listEnvironments(teamId)).filter((e) => e.ownerUserId === userId && e.phase !== "disconnected");
    if (envs.length === 0) return;
    const legacy = (await this.#o.actors.getUserSecrets(userId))?.freestyleIdentityId ?? null;
    let failed = 0;
    for (const env of envs) {
      try {
        await this.environments.disconnect(teamId, env.id, legacy ? [legacy] : []);
        this.#log.info("removed member's environment disconnected", { teamId, envId: env.id });
      } catch (error) {
        failed++;
        this.#log.error("removed member's environment not disconnected", { teamId, envId: env.id, error });
      }
    }
    if (failed > 0) throw new Error(`${failed} of ${envs.length} environments not disconnected yet`);
  }

  /** Reconcile backstop for member removal (a crash or vendor outage mid-cleanup): owners who left the team. */
  async #disconnectOrphans(teamId: string, envs: StoredEnvironment[]): Promise<void> {
    const team = await this.#o.gateway.getTeam(teamId);
    if (!team) return;
    const members = new Set(team.members.map((m) => m.userId));
    const gone = new Set(envs.filter((e) => !members.has(e.ownerUserId)).map((e) => e.ownerUserId));
    for (const userId of gone) {
      this.#log.warn("environment owner is no longer a member", { teamId });
      await this.#disconnectMemberEnvironments(teamId, userId);
    }
  }

  /** Node status from Relay: keep `nodeOnline` current, and recover a ready node that stays offline. */
  async #onSignal(signal: RuntimeSignal): Promise<void> {
    if (signal.kind !== "node.status" || !signal.event.nodeName || !this.freestyleEnabled) return;
    const { teamId } = signal;
    const env = (await this.#o.actors.listEnvironments(teamId)).find((e) => e.nodeName === signal.event.nodeName && e.phase !== "disconnected");
    if (!env) return;
    const online = signal.event.status === "online";
    if (env.nodeOnline !== online) await this.environments.setLive(teamId, env.id, { nodeOnline: online });
    const k = `${teamId}/${env.id}`;
    const pending = this.#offlineChecks.get(k);
    if (online) {
      if (pending) clearTimeout(pending);
      this.#offlineChecks.delete(k);
      return;
    }
    if (pending || env.phase !== "ready") return;
    const timer = setTimeout(() => {
      this.#offlineChecks.delete(k);
      void this.#guard("node offline check", async () => {
        const current = await this.#o.actors.getEnvironment(teamId, env.id);
        if (!current || current.phase !== "ready" || current.nodeOnline) return;
        const view = await this.#o.actors.getWorkforceView(teamId);
        if (!Object.values(view.profiles).some((p) => p.envId === env.id && p.auth === "ok")) return;
        await this.environments.restartNode(teamId, env.id, "node stayed offline");
      });
    }, this.timing.nodeOfflineGraceMs);
    timer.unref?.();
    this.#offlineChecks.set(k, timer);
  }

  async #listVms(): Promise<{ states: Map<string, VmState>; teams: Set<string> }> {
    const states = new Map<string, VmState>();
    const teams = new Set<string>();
    const fs = this.#client();
    for (let offset = 0; offset < 2_000; offset += 100) {
      const page = await fs.vms.list({ metadata: "app:morrow", limit: 100, offset });
      for (const vm of page.vms) {
        states.set(vm.id, toVmState(vm.state));
        const team = (vm as { metadata?: Record<string, string> }).metadata?.team;
        if (team && Id.safeParse(team).success) teams.add(team);
      }
      if (page.vms.length < 100) break;
    }
    return { states, teams };
  }

  #every(ms: number, name: string, fn: () => Promise<void>): void {
    const timer = setInterval(() => void this.#guard(name, fn), ms);
    timer.unref?.();
    this.#timers.push(timer);
  }

  /** One run per loop at a time; a slow run is skipped over, never stacked. */
  async #guard(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.#busy.has(name)) return;
    this.#busy.add(name);
    const started = performance.now();
    try {
      await fn();
    } catch (error) {
      this.#log.warn("runtime loop failed", { loop: name, error });
    } finally {
      this.#busy.delete(name);
      const ms = Math.round(performance.now() - started);
      if (ms > 5_000) this.#log.info("runtime loop slow", { loop: name, ms });
    }
  }
}
