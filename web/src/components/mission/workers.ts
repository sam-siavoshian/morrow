import type { CliKind, SubagentRole, SubagentView, TaskDetail, TaskView, TraceEntry, WorkstreamDetail } from "@morrow/contracts";
import type { TaskWorker } from "@/lib/store/selectors";
import { leaseWhy, type EndWhy } from "./end-reason";
import { cachedTaskDetailById } from "./use-task-detail";

/** What one worker is doing, for its status slot. Never a token balance. */
export type WorkerState =
  | { kind: "starting" }
  | { kind: "working"; since: number }
  | { kind: "waiting"; on: string | null }
  | { kind: "cooldown"; until: number | null }
  | { kind: "failed"; why?: EndWhy }
  | { kind: "done" }
  | { kind: "stopped"; reason: string; why?: EndWhy };

/**
 * `latest`: this is the newest lease its workstream has had. A finished workstream drops its lease
 * id, so the newest lease still counts as the one that finished it.
 *
 * A worker that failed or stopped early says why (`why`) when its task's trace does: `trace`, or the task detail this
 * tab already loaded. The live view leaves reasons out (its size ceiling), so a row says why once the detail lands.
 */
export function workerState(worker: TaskWorker, task: TaskView, latest = false, trace?: readonly TraceEntry[]): WorkerState {
  const { lease, profile } = worker;
  const why = () => {
    const found = leaseWhy(trace ?? cachedTaskDetailById(task.id)?.trace, lease.id);
    return found ? { why: found } : {};
  };
  const workstream = task.workstreams.find((w) => w.id === lease.workstreamId) ?? worker.workstream;
  const current = workstream?.leaseId === lease.id || (latest && (workstream?.leaseId ?? null) === null);
  switch (lease.state) {
    case "reserved":
    case "spawning":
      return { kind: "starting" };
    case "running":
      return current && workstream?.status === "done" ? { kind: "done" } : { kind: "working", since: lease.createdAt };
    case "failed":
      return { kind: "failed", ...why() };
    case "expired":
      if (profile?.availability === "limited") return { kind: "cooldown", until: profile.cooldownUntil };
      return { kind: "stopped", reason: current ? "Stopped" : "Handed off", ...why() };
    case "released":
      if (current && workstream?.status === "done") return { kind: "done" };
      if (task.status === "cancelled") return { kind: "stopped", reason: "Cancelled" };
      if (task.status === "completed") return { kind: "done" };
      return { kind: "stopped", reason: current ? "Released" : "Handed off" };
  }
}

/** A helper one worker started on another CLI of its machine (docs/subagents.md). */
export type SubagentItem = {
  leaseId: string;
  parentLeaseId: string;
  agentName: string;
  cli: CliKind | null;
  /** Null until the task detail with its record has loaded. */
  role: SubagentRole | null;
  /** What it was asked to do and what it said back: agent text, always shown as text. */
  task: string | null;
  summary: string | null;
  status: "starting" | "running" | SubagentView["status"];
  startedAt: number;
  finishedAt: number | null;
};

/**
 * Splits a task's leases into the workers it shows and each worker's subagents. Live subagents come from the view
 * (by `parentLeaseId`); finished ones only from the task detail's records, since the view drops them. A record
 * that has ended wins over a live lease, which can trail it by one frame.
 */
export function splitSubagents(
  workers: readonly TaskWorker[],
  records: readonly SubagentView[] | undefined,
): { workers: TaskWorker[]; subagents: Map<string, SubagentItem[]> } {
  const top = workers.filter((w) => !w.lease.parentLeaseId);
  const byLease = new Map((records ?? []).map((r) => [r.leaseId, r]));
  const items = new Map<string, SubagentItem>();
  for (const { lease, profile, live } of workers) {
    if (!lease.parentLeaseId) continue;
    const record = byLease.get(lease.id);
    const ended = record && record.status !== "running" ? record.status : null;
    items.set(lease.id, {
      leaseId: lease.id,
      parentLeaseId: lease.parentLeaseId,
      agentName: lease.agentName,
      cli: profile?.cli ?? record?.cli ?? null,
      role: record?.role ?? null,
      task: record?.task ?? null,
      summary: record?.summary ?? null,
      status: ended ?? (!live ? "cancelled" : lease.state === "running" ? "running" : "starting"),
      startedAt: lease.createdAt,
      finishedAt: record?.finishedAt ?? null,
    });
  }
  for (const record of records ?? []) {
    if (items.has(record.leaseId)) continue;
    items.set(record.leaseId, {
      leaseId: record.leaseId,
      parentLeaseId: record.parentLeaseId,
      agentName: record.agentName,
      cli: record.cli,
      role: record.role,
      task: record.task,
      summary: record.summary,
      status: record.status,
      startedAt: record.createdAt,
      finishedAt: record.finishedAt,
    });
  }
  const subagents = new Map<string, SubagentItem[]>();
  for (const item of [...items.values()].sort((a, b) => a.startedAt - b.startedAt || (a.leaseId < b.leaseId ? -1 : 1))) {
    const list = subagents.get(item.parentLeaseId) ?? [];
    list.push(item);
    subagents.set(item.parentLeaseId, list);
  }
  return { workers: top, subagents };
}

/** Workstreams nobody holds yet, with the one they wait on. */
export function waitingWorkstreams(task: TaskDetail): { workstream: WorkstreamDetail; on: string | null }[] {
  return task.workstreams
    .filter((w) => w.leaseId === null && w.status === "pending")
    .map((workstream) => {
      const blocker = workstream.dependsOn.map((id) => task.workstreams.find((w) => w.id === id)).find((w) => w && w.status !== "done");
      return { workstream, on: blocker?.title ?? null };
    });
}

/** Lease ids that are the newest of their workstream. */
export function latestLeaseIds(workers: readonly TaskWorker[]): Set<string> {
  const newest = new Map<string, TaskWorker["lease"]>();
  for (const { lease } of workers) {
    const seen = newest.get(lease.workstreamId);
    if (!seen || lease.createdAt > seen.createdAt || (lease.createdAt === seen.createdAt && lease.epoch > seen.epoch)) newest.set(lease.workstreamId, lease);
  }
  return new Set([...newest.values()].map((l) => l.id));
}

/** Grouped by workstream in plan order, each workstream's leases oldest first, so a handoff reads top to bottom. */
export function orderWorkers(workers: readonly TaskWorker[], task: TaskView): TaskWorker[] {
  const rank = new Map(task.workstreams.map((w, i) => [w.id, i]));
  return [...workers].sort(
    (a, b) =>
      (rank.get(a.lease.workstreamId) ?? Infinity) - (rank.get(b.lease.workstreamId) ?? Infinity) ||
      a.lease.createdAt - b.lease.createdAt ||
      a.lease.epoch - b.lease.epoch,
  );
}
