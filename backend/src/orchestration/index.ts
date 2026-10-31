// Orchestration entry point: planner, dispatcher, monitor, handoff, verifier and reconcilers, wired to the
// TeamWorkforce actors, the team runtime and the Relay signal bus. Construction is pure; `start` begins the
// loops (one 1 s clock, per-team lanes) and `stop` drains them.
//
// Per team and tick, with a pushed view (feed.ts, one actor socket per tracked team): claim when the pushed outbox
// summary says an item is due; schedule, verify and notify workers when the view changed (at most every 5 s); watch
// leases every 5 s from the pushed view; and at least once a minute claim, sweep and pass anyway, in case a push was
// missed. Without a live socket the loops poll as before: claims every 1 s while the team is hot (activity in the
// last minute) and every 10 s otherwise, reconcile/schedule/verify every 15 s.
//
// Teams are tracked from the team directory (a durable list of teams with unfinished work, so work resumes after a
// backend or Terse restart), the control plane's actor inventory (a hint), the runtime's active set, bus signals and
// API calls.
import { githubTokenFor } from "../http/githubAccess.ts";
import type { AppDeps } from "../http/context.ts";
import type { TeamRouteModule } from "../http/app.ts";
import { taskRoutes } from "../http/routes/tasks.ts";
import type { RuntimeBus } from "../runtime/bus.ts";
import type { Logger } from "../lib/logger.ts";
import type { TeamRuntimeApi } from "../runtime/types.ts";
import { Comms } from "./comms.ts";
import { DEFAULT_TIMING, type Ctx, type Timing } from "./context.ts";
import { listActiveTeams, type TeamDirectoryApi } from "./directory.ts";
import { Dispatcher } from "./dispatcher.ts";
import { createWorkforceFeed, wrapWorkforce, type FeedChange, type WorkforceFeed } from "./feed.ts";
import { Lanes, type LaneLimits } from "./lanes.ts";
import { Memory } from "./memory.ts";
import { Monitor } from "./monitor.ts";
import { freestyleVmPort, liveRelayPort, type Ports } from "./ports.ts";
import { Scheduler } from "./scheduler.ts";
import { TaskService } from "./service.ts";
import { Verifier } from "./verifier.ts";
import { createWorkforceClient, listWorkforceTeamIds, type WorkforceApi } from "./workforce.ts";
import type { OutboxSummary } from "../actors/workforceState.ts";

const DEFAULT_LANES: LaneLimits = { perTeam: 6, global: 64 };
/** How long a team stays tracked after its last activity with nothing live (lets cleanup items drain). */
const TRACK_GRACE_MS = 10 * 60_000;
const DRAIN_MS = 10_000;
/** A task create waits this long for the team directory before going ahead without it. */
const NOTE_WORK_TIMEOUT_MS = 5_000;
/** A team dropped as idle is not picked up again from the inventory hint for this long (the directory still can). */
const HINT_QUIET_MS = 60 * 60_000;
const HINT_QUIET_MAX = 10_000;

export type FeedFactory = (onChange: (teamId: string, change: FeedChange) => void) => WorkforceFeed;

export interface OrchestrationOptions {
  ports?: Partial<Ports>;
  workforce?: WorkforceApi;
  timing?: Partial<Timing>;
  lanes?: Partial<LaneLimits>;
  /** Teams with a TeamWorkforce actor, as a hint; defaults to the control plane's actor inventory. */
  listTeams?: () => Promise<string[]>;
  /** The durable list of teams with unfinished work. Without it, restarts rely on the inventory hint alone. */
  directory?: TeamDirectoryApi;
  /**
   * Pushed TeamWorkforce state. `"actors"` holds a socket per tracked team through the app's actor gateway; a
   * factory is a test seam. Without it the loops poll the actors.
   */
  feed?: "actors" | FeedFactory;
  /** Clock tick; tests drive `tick()` themselves and pass 0 to disable the timer. */
  tickMs?: number;
  /** How often to ask the control plane for teams again after the first answer. */
  reseedMs?: number;
  /**
   * Give a one-workstream plan review and research partners when worker slots are free, so its agents have peers
   * to talk to (planner/shape.ts `addPartners`). On by default; tests of a single worker's lifecycle turn it off.
   */
  partners?: boolean;
}

/**
 * The control plane's actor inventory is a best-effort, per-process list (Terse configuration reference, "Host
 * lifecycle reports"): it starts empty after a Terse restart and forgets idle actors. One answer is never final,
 * so the backend asks again on this period and picks up teams with unfinished work that nothing else touched.
 */
export const RESEED_MS = 5 * 60_000;
/** After a failed ask, wait this long, not one tick, so a control plane outage is not a log line a second. */
export const SEED_RETRY_MS = 10_000;

/** Asks for every team on first use, again every `reseedMs`, and after a failure no sooner than SEED_RETRY_MS. */
export function createSeeder(input: {
  listTeams: () => Promise<string[]>;
  track: (teamId: string) => void;
  now: () => number;
  reseedMs: number;
  log: Pick<Logger, "info" | "warn">;
}): { seed(): Promise<void> | undefined; seeded(): boolean } {
  const { listTeams, track, now, reseedMs, log } = input;
  let seeded = false;
  let seeding = false;
  let seededAt = 0;
  let failedAt = Number.NEGATIVE_INFINITY;
  return {
    seeded: () => seeded,
    seed() {
      const at = now();
      if (seeding || (seeded && at - seededAt < reseedMs) || at - failedAt < SEED_RETRY_MS) return undefined;
      seeding = true;
      return listTeams()
        .then((ids) => {
          for (const id of ids) track(id);
          log.info(seeded ? "orchestration re-listed teams" : "orchestration seeded teams", { teams: ids.length });
          seeded = true;
          seededAt = now();
        })
        .catch((error: unknown) => {
          failedAt = now();
          log.warn("could not list teams; will retry", { error, retryInMs: SEED_RETRY_MS });
        })
        .finally(() => {
          seeding = false;
        });
    },
  };
}

export interface Orchestration {
  routes: TeamRouteModule;
  start(): void;
  stop(): Promise<void>;
  /** One loop iteration over every tracked team. Exposed for tests and diagnostics. */
  tick(): void;
  /** Starts tracking a team (also done by API calls and bus signals). */
  track(teamId: string): void;
  readonly service: TaskService;
  readonly dispatcher: Dispatcher;
  readonly monitor: Monitor;
  readonly scheduler: Scheduler;
  readonly verifier: Verifier;
  /** What workers are told (architecture 9.8). The GitHub layer hands review comments to `comms.reviewComment`. */
  readonly comms: Comms;
  readonly ctx: Ctx;
  /** Pushed TeamWorkforce state, when enabled. Exposed for tests and diagnostics. */
  readonly feed: WorkforceFeed | null;
}

interface Due {
  watchAt: number;
  reconcileAt: number;
}

/** What orchestration needs from the app: config, logging, the Team actor door, GitHub and the clock. */
export type OrchestrationDeps = Pick<AppDeps, "env" | "log" | "actors" | "github" | "keys" | "now">;

export function createOrchestration(input: {
  deps: OrchestrationDeps;
  runtime: TeamRuntimeApi;
  bus: RuntimeBus;
  options?: OrchestrationOptions;
}): Orchestration {
  const { deps, runtime, bus } = input;
  const options = input.options ?? {};
  const log = deps.log.child({ mod: "orchestration" });
  const ports: Ports = {
    vm: options.ports?.vm ?? freestyleVmPort(),
    relay: options.ports?.relay ?? liveRelayPort(),
    git: options.ports?.git ?? deps.github,
    githubToken: options.ports?.githubToken ?? ((userId) => githubTokenFor(deps, userId)),
  };
  const feed: WorkforceFeed | null =
    options.feed === "actors"
      ? createWorkforceFeed({ gateway: deps.actors, log: log.child({ mod: "feed" }), now: deps.now, onChange: (teamId, change) => onFeedChange(teamId, change) })
      : options.feed
        ? options.feed((teamId, change) => onFeedChange(teamId, change))
        : null;
  const workforce = options.workforce ?? createWorkforceClient(deps.env.terse, log.child({ mod: "workforce" }));
  const ctx: Ctx = {
    wf: feed ? wrapWorkforce(workforce, feed) : workforce,
    runtime,
    teams: deps.actors,
    ports,
    memory: new Memory(),
    lanes: new Lanes({ ...DEFAULT_LANES, ...options.lanes }, log),
    log,
    now: deps.now,
    timing: { ...DEFAULT_TIMING, ...options.timing },
    githubWebUrl: deps.env.github.webUrl,
    partners: options.partners ?? true,
  };
  const listTeams = options.listTeams ?? (() => listWorkforceTeamIds(deps.env.terse));
  const directory = options.directory ?? null;
  /** Directory generation per team, from its listing or our own `noteWork`; reported back with `noteIdle`. */
  const gens = new Map<string, number>();
  const noting = new Map<string, Promise<void>>();
  /** Teams recently dropped as idle, so the inventory hint (which remembers idle actors for a day) does not churn them. */
  const quietUntil = new Map<string, number>();

  const tracked = new Set<string>();
  const due = new Map<string, Due>();
  const dispatcher = new Dispatcher(ctx);
  const comms = new Comms(ctx, (teamId) => onWork(teamId));
  /** Tells workers what changed. Runs after anything that can change a task and on every reconcile tick. */
  const notify = (teamId: string) =>
    ctx.lanes.run(teamId, "notify", async () => {
      const revision = feed?.revision(teamId) ?? -1;
      await comms.pass(teamId);
      const memory = ctx.memory.team(teamId);
      memory.notifiedRevision = revision;
      memory.notifiedAt = ctx.now();
    });
  /** With a live feed, a notify pass only when the view moved since the last clean one (or the safety period ran out). */
  const notifyIfChanged = (teamId: string) => {
    const memory = ctx.memory.team(teamId);
    if (feed?.live(teamId) && feed.revision(teamId) === memory.notifiedRevision && ctx.now() - memory.notifiedAt < ctx.timing.safetyMs) return false;
    return notify(teamId);
  };
  const track = (teamId: string) => {
    tracked.add(teamId);
    feed?.watch(teamId);
    const memory = ctx.memory.team(teamId);
    memory.trackUntil = Math.max(memory.trackUntil, ctx.now() + TRACK_GRACE_MS);
  };
  const untrack = (teamId: string) => {
    tracked.delete(teamId);
    quietUntil.delete(teamId);
    quietUntil.set(teamId, ctx.now() + HINT_QUIET_MS);
    while (quietUntil.size > HINT_QUIET_MAX) quietUntil.delete(quietUntil.keys().next().value!);
    due.delete(teamId);
    ctx.memory.forget(teamId);
    feed?.unwatch(teamId);
    const gen = gens.get(teamId);
    gens.delete(teamId);
    // Only clears the entry if no work was noted since `gen` (by us or another replica).
    if (directory && gen !== undefined)
      directory.noteIdle(teamId, gen).catch((error: unknown) => log.warn("team directory: could not mark a team idle; the next re-list retries", { teamId, error }));
  };
  /** Best effort, single flight per team; never throws. A miss is retried by the next scheduling pass. */
  const noteWork = (teamId: string): Promise<void> => {
    if (!directory) return Promise.resolve();
    const pending = noting.get(teamId);
    if (pending) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("team directory did not answer in time")), NOTE_WORK_TIMEOUT_MS);
    });
    const note = Promise.race([directory.noteWork(teamId), timeout])
      .then((result) => {
        gens.set(teamId, Math.max(gens.get(teamId) ?? 0, result.gen));
      })
      .catch((error: unknown) => log.warn("team directory: could not note work; the next scheduling pass retries", { teamId, error }))
      .finally(() => {
        clearTimeout(timer);
        noting.delete(teamId);
      });
    noting.set(teamId, note);
    return note;
  };
  const onWork = (teamId: string) => {
    track(teamId);
    ctx.memory.team(teamId).hotUntil = ctx.now() + ctx.timing.hotWindowMs;
    dispatcher.poke(teamId);
    notify(teamId);
  };
  const monitor = new Monitor(ctx, onWork, (teamId, agentName, messageId) => {
    ctx.lanes.run(teamId, `status:${agentName}`, () => comms.status(teamId, agentName, messageId));
  }, (teamId, agentName, messageId, text) => comms.subagent(teamId, agentName, messageId, text), (teamId, agentName, messageId, text) => comms.contract(teamId, agentName, messageId, text), comms);
  const verifier = new Verifier(ctx);
  const scheduler = new Scheduler(ctx, verifier);
  const service = new TaskService(ctx, {
    onWork,
    plan: (teamId, taskId, run) => {
      track(teamId);
      return ctx.lanes.run(teamId, `plan:${taskId}`, run);
    },
    verify: (teamId, taskId) => {
      track(teamId);
      verifier.maybeRun(teamId, taskId);
    },
    noteWork: (teamId) => {
      track(teamId);
      return noteWork(teamId);
    },
  });

  /** The directory's active teams (generations recorded), plus the inventory hint minus teams recently found idle. */
  const listAll = async (): Promise<string[]> => {
    const [listed, hint] = await Promise.allSettled([directory ? listActiveTeams(directory) : Promise.resolve(new Map<string, number>()), listTeams()]);
    const now = ctx.now();
    for (const [teamId, until] of quietUntil) if (until <= now) quietUntil.delete(teamId);
    const ids = new Set<string>();
    if (listed.status === "fulfilled")
      for (const [teamId, gen] of listed.value) {
        ids.add(teamId);
        gens.set(teamId, Math.max(gens.get(teamId) ?? 0, gen));
      }
    if (hint.status === "fulfilled") for (const teamId of hint.value) if (!quietUntil.has(teamId)) ids.add(teamId);
    if (hint.status === "rejected" && !directory) throw hint.reason;
    if (hint.status === "rejected") log.warn("actor inventory unavailable; using the team directory alone", { error: hint.reason });
    if (listed.status === "rejected") {
      // Track what the hint found now; the failure makes the seeder ask again soon.
      for (const teamId of ids) seedTrack(teamId);
      throw listed.reason;
    }
    return [...ids];
  };
  /** A listing is not activity: it starts tracking a team but never extends one already tracked. */
  const seedTrack = (teamId: string) => {
    if (!tracked.has(teamId)) track(teamId);
  };

  const seeder = createSeeder({ listTeams: listAll, track: seedTrack, now: ctx.now, reseedMs: options.reseedMs ?? RESEED_MS, log });
  const seed = seeder.seed;

  const reconcile = (teamId: string, sweep = true) =>
    ctx.lanes.run(teamId, "reconcile", async () => {
      const memory = ctx.memory.team(teamId);
      memory.decidedRevision = feed?.revision(teamId) ?? -1;
      const result = await scheduler.pass(teamId, { sweep });
      if (result.reserved > 0 || result.handoffs > 0) onWork(teamId);
      else notifyIfChanged(teamId);
      if (result.busy) {
        memory.trackUntil = ctx.now() + TRACK_GRACE_MS;
        // A team found by the inventory hint, or whose note failed at task create, goes into the directory now.
        if (directory && !gens.has(teamId)) void noteWork(teamId);
      } else if (ctx.now() > memory.trackUntil && !runtime.activeTeamIds().includes(teamId)) untrack(teamId);
    });

  const isDue = (summary: OutboxSummary, now: number) => summary.nextDueAt !== null && summary.nextDueAt <= now;

  /** A push: claim at once if something is due (the tick covers later due times and view changes). */
  function onFeedChange(teamId: string, change: FeedChange): void {
    if (!tracked.has(teamId) || !change.summary) return;
    const memory = ctx.memory.team(teamId);
    const now = ctx.now();
    if (isDue(change.summary, now) && now - memory.lastClaimAt >= ctx.timing.claimHotMs) dispatcher.poke(teamId);
  }

  // A merge conflict became a resolution step: lease its resolver now rather than on the next pass.
  verifier.onResolving = (teamId) => {
    reconcile(teamId);
  };

  const tick = () => {
    const now = ctx.now();
    const { timing } = ctx;
    for (const teamId of runtime.activeTeamIds()) track(teamId);
    for (const teamId of tracked) {
      const memory = ctx.memory.team(teamId);
      const at = due.get(teamId) ?? { watchAt: 0, reconcileAt: 0 };
      const sinceClaim = now - memory.lastClaimAt;
      const live = feed?.live(teamId) ?? false;
      const summary = live ? feed!.summary(teamId) : null;
      if (summary) {
        if ((isDue(summary, now) && sinceClaim >= timing.claimHotMs) || sinceClaim >= timing.safetyMs) dispatcher.poke(teamId);
      } else if (sinceClaim >= (memory.hotUntil > now ? timing.claimHotMs : timing.claimIdleMs)) dispatcher.poke(teamId);
      if (now >= at.watchAt && ctx.lanes.run(teamId, "watch", () => monitor.watch(teamId))) at.watchAt = now + timing.monitorMs;
      if (live) {
        const sweep = now - memory.sweptAt >= timing.safetyMs;
        const changed = feed!.revision(teamId) !== memory.decidedRevision;
        if (now >= at.reconcileAt && (sweep || changed) && reconcile(teamId, sweep)) at.reconcileAt = now + timing.decideMinMs;
      } else if (now >= at.reconcileAt && reconcile(teamId)) at.reconcileAt = now + timing.reconcileMs;
      due.set(teamId, at);
    }
    seed();
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    routes: taskRoutes(service),
    service,
    dispatcher,
    monitor,
    scheduler,
    verifier,
    comms,
    ctx,
    feed,
    tick,
    track,

    start() {
      if (timer || unsubscribe) return;
      unsubscribe = bus.subscribe((signal) => {
        if (!tracked.has(signal.teamId)) track(signal.teamId);
        monitor.handle(signal);
      });
      seed();
      tick();
      const tickMs = options.tickMs ?? 1_000;
      if (tickMs > 0) timer = setInterval(tick, tickMs);
      heartbeat = setInterval(() => {
        log.info("orchestration heartbeat", {
          teams: tracked.size,
          hot: [...tracked].filter((id) => ctx.memory.team(id).hotUntil > ctx.now()).length,
          jobs: ctx.lanes.size,
          watches: [...tracked].reduce((n, id) => n + ctx.memory.team(id).watches.size, 0),
          seeded: seeder.seeded(),
          ...(feed ? { pushed: [...tracked].filter((id) => feed.live(id)).length } : {}),
        });
      }, ctx.timing.heartbeatMs);
      log.info("orchestration started", { tickMs });
    },

    async stop() {
      if (timer) clearInterval(timer);
      if (heartbeat) clearInterval(heartbeat);
      timer = heartbeat = null;
      unsubscribe?.();
      unsubscribe = null;
      feed?.stop();
      const left = await ctx.lanes.drain(DRAIN_MS);
      log.info("orchestration stopped", { unfinishedJobs: left });
    },
  };
}
