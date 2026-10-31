import type { RelayAgent, RelayNode } from "@agent-relay/sdk";
import type { Logger } from "../../lib/logger.ts";
import { sleep } from "../../lib/retry.ts";
import { adminThinClient } from "./clients.ts";
import type { RelayConfig } from "./config.ts";
import { isRelayNotFound } from "./errors.ts";
import { assertNodeName, assertWorkerName } from "./names.ts";
import { publishedLiveAgents, type RelayReader } from "./reader.ts";
import { fleetInvocationId } from "./spawn.ts";

export interface ExitRecord {
  agentName: string;
  invocationId: string | null;
  reason: string | null;
  at: number;
}

/** `agent.exited` facts seen on the observer stream, bounded. Populated by `TeamRelayObserver`. */
export class ExitLedger {
  readonly #max: number;
  readonly #byName = new Map<string, ExitRecord>();
  constructor(max = 2000) {
    this.#max = max;
  }
  record(exit: ExitRecord): void {
    // A later inference must not hide the proof already held for the same incarnation.
    const prior = this.#byName.get(exit.agentName);
    if (prior && isConclusiveExit(prior) && !isConclusiveExit(exit) && prior.invocationId === exit.invocationId) return;
    this.#byName.delete(exit.agentName);
    this.#byName.set(exit.agentName, exit);
    while (this.#byName.size > this.#max) this.#byName.delete(this.#byName.keys().next().value!);
  }
  get(agentName: string): ExitRecord | undefined {
    return this.#byName.get(agentName);
  }
  get size(): number {
    return this.#byName.size;
  }
}

/**
 * `missing_from_inventory` is the engine's own inference from its copy of the node inventory, which lags and,
 * under database pressure, loses the inventory entirely. Observed live: emitted for a worker that was still
 * running and posting, 10 s before its spawn even completed. Only the broker's word (`deregistered`) or a
 * release (`released`) proves an exit; an inference is checked against the inventory like any absence.
 */
const INFERRED_EXIT_REASONS: ReadonlySet<string> = new Set(["missing_from_inventory"]);

export function isConclusiveExit(exit: Pick<ExitRecord, "reason">): boolean {
  return !exit.reason || !INFERRED_EXIT_REASONS.has(exit.reason);
}

/** Carried between reads by the caller (per lease). Start with {@link initialReconcileMemo}. */
export interface ReconcileMemo {
  /** Absent reads counted so far, each from a newer node heartbeat than the one before. */
  absentReads: number;
  /** Our clock when the counted streak began. */
  firstAbsentAt: number | null;
  /** The node heartbeat (engine clock) of the last counted absent read. */
  lastAbsentHeartbeatAt: number | null;
}
export const initialReconcileMemo = (): ReconcileMemo => ({ absentReads: 0, firstAbsentAt: null, lastAbsentHeartbeatAt: null });

export type WorkerState = "running" | "gone" | "unknown";
export type ReconcileReason =
  | "live"
  | "exited"
  | "absent"
  | "absent_unconfirmed"
  | "starting"
  | "inventory_missing"
  | "inventory_stale"
  | "node_offline"
  | "node_missing"
  | "read_failed";

export interface ReconcileResult {
  state: WorkerState;
  reason: ReconcileReason;
  /** From the agent record (`metadata.fleet.invocation_id`), when one exists. */
  invocationId: string | null;
  memo: ReconcileMemo;
}

export interface WorkerObservation {
  node: RelayNode | null;
  agent: RelayAgent | null;
  exit: ExitRecord | undefined;
  expectedInvocationId: string | null;
  now: number;
  /** When the worker started (our clock), if known: absence right after it is not counted. */
  startedAt?: number | null;
}

/** How much absence from the node's inventory proves a worker gone. */
export interface AbsencePolicy {
  /** Absent reads, each from a newer node heartbeat than the last, before absence is conclusive. */
  reads: number;
  /** And the streak must span at least this long. */
  spanMs: number;
  /** Absence within this long of `startedAt` is not counted: the engine's copy of a new worker's inventory lags. */
  graceMs: number;
}

/**
 * Watching a live worker: one wrongly called gone is released and loses its work, while a real exit is
 * reported by the broker (`deregistered`). So absence alone must hold across several broker heartbeats
 * (every 12 s) and well past the spawn.
 */
export const WATCH_ABSENCE: AbsencePolicy = { reads: 3, spanMs: 30_000, graceMs: 60_000 };
/** After our own release the worker is meant to stop: two newer heartbeats without it suffice. */
export const RELEASE_ABSENCE: AbsencePolicy = { reads: 2, spanMs: 0, graceMs: 0 };
/** A node record whose last heartbeat is older than this carries an inventory too stale to prove absence. */
export const INVENTORY_MAX_AGE_MS = 60_000;
const RELEASE_POLL_MS = 2_000;

/**
 * Relay spawn/release results are not trustworthy alone (observed live: a release that "failed" while the
 * worker exited, a spawn that "failed" while the worker ran), and neither is the engine's node record under
 * load (observed live: online and live with a fresh heartbeat but no inventory while the worker ran). Truth,
 * in order:
 *  1. a conclusive `agent.exited` for this incarnation -> gone.
 *  2. node missing, or not online/live -> unknown; the absence streak resets.
 *  3. name in the node's `relay:live-agents:v1` -> running.
 *  4. no inventory on the record, or a heartbeat older than INVENTORY_MAX_AGE_MS -> unknown; nothing counts.
 *  5. absent within `graceMs` of the start -> unknown; nothing counts.
 *  6. absent: counts once per newer node heartbeat; gone once `reads` absences span `spanMs`.
 */
export function decideWorkerState(
  obs: WorkerObservation,
  memo: ReconcileMemo,
  agentName: string,
  policy: AbsencePolicy = WATCH_ABSENCE,
): ReconcileResult {
  const invocationId = obs.agent ? fleetInvocationId(obs.agent.metadata) : null;
  const incarnation = obs.expectedInvocationId ?? invocationId;
  const exitMatches =
    !!obs.exit && isConclusiveExit(obs.exit) && (!obs.exit.invocationId || !incarnation || obs.exit.invocationId === incarnation);
  const fresh = initialReconcileMemo();
  if (exitMatches) return { state: "gone", reason: "exited", invocationId, memo: fresh };
  if (!obs.node) return { state: "unknown", reason: "node_missing", invocationId, memo: fresh };
  if (obs.node.status !== "online" || obs.node.live !== true) return { state: "unknown", reason: "node_offline", invocationId, memo: fresh };
  const names = publishedLiveAgents(obs.node);
  if (names?.includes(agentName)) return { state: "running", reason: "live", invocationId, memo: fresh };
  if (names === null) return { state: "unknown", reason: "inventory_missing", invocationId, memo };
  const heartbeat = obs.node.lastHeartbeatAt ? Date.parse(obs.node.lastHeartbeatAt) : NaN;
  if (!Number.isFinite(heartbeat) || obs.now - heartbeat > INVENTORY_MAX_AGE_MS) return { state: "unknown", reason: "inventory_stale", invocationId, memo };
  if (typeof obs.startedAt === "number" && obs.now - obs.startedAt < policy.graceMs) return { state: "unknown", reason: "starting", invocationId, memo };

  // The same heartbeat read twice is one observation, not two.
  if (memo.lastAbsentHeartbeatAt !== null && heartbeat <= memo.lastAbsentHeartbeatAt)
    return { state: "unknown", reason: "absent_unconfirmed", invocationId, memo };
  const firstAbsentAt = memo.firstAbsentAt ?? obs.now;
  const next: ReconcileMemo = { absentReads: memo.absentReads + 1, firstAbsentAt, lastAbsentHeartbeatAt: heartbeat };
  if (next.absentReads >= policy.reads && obs.now - firstAbsentAt >= policy.spanMs) return { state: "gone", reason: "absent", invocationId, memo: next };
  return { state: "unknown", reason: "absent_unconfirmed", invocationId, memo: next };
}

export async function reconcileWorker(input: {
  reader: RelayReader;
  agentName: string;
  nodeName: string;
  expectedInvocationId?: string | null;
  memo: ReconcileMemo;
  exits?: Pick<ExitLedger, "get">;
  startedAt?: number | null;
  policy?: AbsencePolicy;
  now?: () => number;
}): Promise<ReconcileResult> {
  const agentName = assertWorkerName(input.agentName);
  const nodeName = assertNodeName(input.nodeName);
  let node: RelayNode | null;
  let agent: RelayAgent | null;
  try {
    [node, agent] = await Promise.all([input.reader.getNode(nodeName), input.reader.getAgent(agentName)]);
  } catch {
    // A failed read is not evidence either way; keep the streak as it was.
    return { state: "unknown", reason: "read_failed", invocationId: null, memo: input.memo };
  }
  return decideWorkerState(
    {
      node,
      agent,
      exit: input.exits?.get(agentName),
      expectedInvocationId: input.expectedInvocationId ?? null,
      now: (input.now ?? Date.now)(),
      startedAt: input.startedAt ?? null,
    },
    input.memo,
    agentName,
    input.policy,
  );
}

export interface ReleaseResult {
  /** The worker is verified gone (a conclusive exit seen, or absent from two newer node inventories). */
  gone: boolean;
  /** The agent record is deleted, so the name is free again. */
  deleted: boolean;
}

/**
 * Release with `deleteAgent`. The release action result is ignored on purpose: live, a release of a running
 * worker ended `agent_release_generation_conflict` although the worker exited, and its record survived. So we
 * wait for exit/absence as truth, then release the now-offline record again, which deletes it synchronously.
 * Returns `gone: false` when the wait budget ran out; the monitor's reconcile picks it up from there.
 */
export async function releaseWorker(input: {
  config: RelayConfig;
  workspaceKey: string;
  reader: RelayReader;
  agentName: string;
  nodeName: string;
  reason: string;
  exits?: Pick<ExitLedger, "get">;
  waitMs?: number;
  pollMs?: number;
  logger?: Logger;
}): Promise<ReleaseResult> {
  const agentName = assertWorkerName(input.agentName);
  const nodeName = assertNodeName(input.nodeName);
  const reason = input.reason.slice(0, 200);
  const admin = adminThinClient(input.config, input.workspaceKey);

  const release = async (): Promise<"deleted" | "dispatched"> => {
    try {
      const result = await admin.agents.release({ name: agentName, reason, deleteAgent: true });
      return (result as { status?: unknown }).status === "completed" ? "deleted" : "dispatched";
    } catch (error) {
      if (isRelayNotFound(error)) return "deleted";
      throw error;
    }
  };

  if ((await release()) === "deleted") return { gone: true, deleted: true };

  const deadline = Date.now() + (input.waitMs ?? 20_000);
  const pollMs = input.pollMs ?? RELEASE_POLL_MS;
  let memo = initialReconcileMemo();
  for (;;) {
    const verdict = await reconcileWorker({ reader: input.reader, agentName, nodeName, memo, exits: input.exits, policy: RELEASE_ABSENCE });
    memo = verdict.memo;
    if (verdict.state === "gone") break;
    if (Date.now() + pollMs > deadline) {
      input.logger?.warn("relay.release.unverified", { agent: agentName, node: nodeName, reason: verdict.reason });
      return { gone: false, deleted: false };
    }
    await sleep(pollMs);
  }
  try {
    return { gone: true, deleted: (await release()) === "deleted" };
  } catch (error) {
    input.logger?.warn("relay.release.delete_failed", { agent: agentName, err: error });
    return { gone: true, deleted: false };
  }
}
