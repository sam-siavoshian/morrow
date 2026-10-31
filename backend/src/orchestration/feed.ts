// Pushed TeamWorkforce state for orchestration. One actor socket per tracked team; the actor pushes its view parts
// and an outbox summary after every change, so the loops read the view from memory and claim when the summary says
// something is due, instead of calling the actor on timers. When a socket is down (or the actor predates the
// summary) the loops fall back to their old polling, so the feed only ever saves calls; it is never needed for
// correctness.
//
// Read-your-writes: a write's state update is published to sockets before the write's response is sent (Terse host,
// commit then publish then respond), but the two travel different paths. So after any write to a team made through
// `wrapWorkforce`, `view` returns null (the caller reads from the actor) until the write has settled for SETTLE_MS.
import type { ActorGateway } from "../actors/types.ts";
import { composeWorkforceView, outboxSummaryOf, type OutboxSummary } from "../actors/workforceState.ts";
import type { Logger } from "../lib/logger.ts";
import { ActorSubscription } from "../realtime/actorSubscription.ts";
import type { WorkforceApi, WorkforceSnapshot } from "./workforce.ts";

export const SETTLE_MS = 1_000;
/**
 * TeamWorkforce reads that do not start with `get`. Anything not a read is treated as a write; a read missing here only
 * costs a few extra `getView` calls after it, never a stale answer.
 */
const OTHER_READS = new Set(["stoppingSubagents"]);

export interface FeedChange {
  /** The view (profiles, tasks or leases) changed, not just the summary. */
  viewChanged: boolean;
  summary: OutboxSummary | null;
}

export interface WorkforceFeed {
  watch(teamId: string): void;
  unwatch(teamId: string): void;
  stop(): void;
  /** Open and holding a snapshot from the current connection. */
  live(teamId: string): boolean;
  /** The pushed view, or null when the caller must ask the actor (not live, or a write has not settled). */
  view(teamId: string): WorkforceSnapshot | null;
  /** The pushed outbox summary, or null when not live or the actor does not emit one. */
  summary(teamId: string): OutboxSummary | null;
  /** Bumped on every pushed view change; lets callers skip work when nothing moved. */
  revision(teamId: string): number;
  beginWrite(teamId: string): void;
  endWrite(teamId: string): void;
  readonly size: number;
}

interface Entry {
  sub: ActorSubscription;
  parts: unknown[];
  view: WorkforceSnapshot | null;
  summary: OutboxSummary | null;
  revision: number;
  writes: number;
  settledAt: number;
}

export function createWorkforceFeed(input: {
  gateway: Pick<ActorGateway, "prepareSocket">;
  log: Logger;
  now: () => number;
  onChange: (teamId: string, change: FeedChange) => void;
  /** Test seams. */
  subscription?: { baseDelayMs?: number; maxDelayMs?: number; pingMs?: number; pongTimeoutMs?: number };
}): WorkforceFeed {
  const { gateway, log, now, onChange } = input;
  const teams = new Map<string, Entry>();
  let stopped = false;

  const apply = (teamId: string, entry: Entry, state: Record<string, unknown>) => {
    const parts = "profilesView" in state ? [state.profilesView, state.tasksView, state.leasesView] : [state.view];
    // Unchanged fields keep their object identity across `state_update` merges, so identity is a change check.
    const viewChanged = entry.view === null || parts.length !== entry.parts.length || parts.some((part, i) => part !== entry.parts[i]);
    if (viewChanged) {
      const view = composeWorkforceView(state);
      if (!view) {
        log.warn("pushed workforce state has no view", { teamId });
        return;
      }
      entry.parts = parts;
      entry.view = view as unknown as WorkforceSnapshot;
      entry.revision++;
    }
    entry.summary = outboxSummaryOf(state);
    onChange(teamId, { viewChanged, summary: entry.summary });
  };

  const isLive = (entry: Entry | undefined): entry is Entry => !!entry && entry.sub.live && entry.view !== null;

  return {
    watch(teamId) {
      if (stopped || teams.has(teamId)) return;
      const entry: Entry = { sub: null as unknown as ActorSubscription, parts: [], view: null, summary: null, revision: 0, writes: 0, settledAt: 0 };
      entry.sub = new ActorSubscription({
        actor: "TeamWorkforce",
        teamId,
        gateway,
        log,
        onState: (state) => apply(teamId, entry, state),
        ...input.subscription,
      });
      teams.set(teamId, entry);
      entry.sub.start();
    },
    unwatch(teamId) {
      teams.get(teamId)?.sub.stop();
      teams.delete(teamId);
    },
    stop() {
      stopped = true;
      for (const entry of teams.values()) entry.sub.stop();
      teams.clear();
    },
    live: (teamId) => isLive(teams.get(teamId)),
    view(teamId) {
      const entry = teams.get(teamId);
      if (!isLive(entry) || entry.writes > 0 || now() - entry.settledAt < SETTLE_MS) return null;
      return entry.view;
    },
    summary(teamId) {
      const entry = teams.get(teamId);
      return isLive(entry) ? entry.summary : null;
    },
    revision: (teamId) => teams.get(teamId)?.revision ?? 0,
    beginWrite(teamId) {
      const entry = teams.get(teamId);
      if (entry) entry.writes++;
    },
    endWrite(teamId) {
      const entry = teams.get(teamId);
      if (!entry) return;
      entry.writes = Math.max(0, entry.writes - 1);
      entry.settledAt = now();
    },
    get size() {
      return teams.size;
    },
  };
}

/**
 * The workforce door the loops use: `getView` answers from the feed when it can, every other read goes to the actor,
 * and every write marks the team unsettled for the feed while it runs and for SETTLE_MS after.
 */
export function wrapWorkforce(wf: WorkforceApi, feed: WorkforceFeed): WorkforceApi {
  const cache = new Map<string | symbol, unknown>();
  return new Proxy(wf, {
    get(target, prop, receiver) {
      const method = Reflect.get(target, prop, receiver) as unknown;
      if (typeof method !== "function" || typeof prop !== "string") return method;
      if (cache.has(prop)) return cache.get(prop);
      let wrapped: unknown;
      if (prop === "getView") {
        wrapped = (teamId: string) => {
          const view = feed.view(teamId);
          return view ? Promise.resolve(view) : (method as WorkforceApi["getView"]).call(target, teamId);
        };
      } else if (prop.startsWith("get") || OTHER_READS.has(prop)) {
        wrapped = method.bind(target);
      } else {
        wrapped = async (teamId: string, ...args: unknown[]) => {
          feed.beginWrite(teamId);
          try {
            return await (method as (...a: unknown[]) => Promise<unknown>).call(target, teamId, ...args);
          } finally {
            feed.endWrite(teamId);
          }
        };
      }
      cache.set(prop, wrapped);
      return wrapped;
    },
  });
}
