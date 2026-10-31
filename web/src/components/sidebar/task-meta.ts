import type { CliKind, TaskView } from "@morrow/contracts";
import { INBOX_GROUPS, taskRowStatus, type Inbox, type InboxGroup, type TaskRowStatus, type TaskWorker } from "@/lib/store/selectors";

/** What the row's status slot says. Precedence comes from `taskRowStatus` (t3code-ux 12.1). */
export type RowStatusKind =
  | "approval"
  | "choosing"
  | "input"
  | "recovering"
  | "resolving"
  | "planning"
  | "working"
  | "verifying"
  | "waiting"
  | "failed"
  | "done"
  | "cancelled";

export type RowStatus = {
  kind: RowStatusKind;
  label: string;
  /** Epoch ms the live work started; the row counts up from it. */
  since: number | null;
};

export const GROUP_LABEL: Record<InboxGroup, string> = {
  "needs-you": "Needs you",
  running: "Running",
  recovering: "Recovering",
  done: "Done",
};

/** When the current run started: the first reservation after the latest plan, else creation. */
export function runStartedAt(task: TaskView): number {
  // The live view carries only the trace's tail, so the actor reads this from the whole trace.
  if (task.runStartedAt !== undefined) return task.runStartedAt ?? task.createdAt;
  // Views written before that carry the whole trace.
  let plannedAt = -1;
  for (const entry of task.trace) if (entry.kind === "task.planned") plannedAt = entry.at;
  const reserved = task.trace.find((entry) => entry.kind === "worker.reserved" && entry.at >= plannedAt);
  return reserved?.at ?? task.createdAt;
}

/**
 * The row's status. A running task with no live worker is Waiting (between handoffs or still
 * reserving); a finished one only says Done while it is unread (completed since the last visit).
 */
export function rowStatus(task: TaskView, liveWorkers: number, unread: boolean, asked = false): RowStatus | null {
  const status: TaskRowStatus = taskRowStatus(task, asked);
  switch (status) {
    case "approval":
      return { kind: "approval", label: "Review plan", since: null };
    case "choosing":
      return { kind: "choosing", label: "Pick an attempt", since: null };
    case "input":
      return { kind: "input", label: "Needs input", since: null };
    case "recovering":
      return { kind: "recovering", label: "Recovering", since: null };
    case "planning":
      return { kind: "planning", label: "Planning", since: task.createdAt };
    case "verifying":
      return { kind: "verifying", label: "Verifying", since: runStartedAt(task) };
    case "resolving":
      return { kind: "resolving", label: "Resolving conflict", since: task.trace.findLast((e) => e.kind === "task.conflict_detected")?.at ?? null };
    case "running":
      return liveWorkers > 0 ? { kind: "working", label: "Working", since: runStartedAt(task) } : { kind: "waiting", label: "Waiting", since: null };
    case "failed":
      return { kind: "failed", label: "Failed", since: null };
    case "done":
      return unread ? { kind: "done", label: "Done", since: null } : null;
    case "cancelled":
      return null;
  }
}

/** Distinct branches the task's workstreams use, active ones first. */
export function taskBranches(task: TaskView): string[] {
  const ordered = [...task.workstreams].sort((a, b) => Number(b.status === "active") - Number(a.status === "active"));
  return [...new Set(ordered.map((w) => w.branch).filter(Boolean))];
}

/**
 * A live worker the task leased itself. A subagent (a lease with a parent) is part of its parent's work: mission
 * control nests it there, and the inbox does not count it as another agent.
 */
export const isLiveWorker = (w: TaskWorker): boolean => w.live && !w.lease.parentLeaseId;

/** One harness per live worker, in lease order. */
export const liveHarnesses = (workers: readonly TaskWorker[]): CliKind[] =>
  workers.flatMap((w) => (isLiveWorker(w) && w.profile ? [w.profile.cli] : []));

/** Done after the last visit is the unread signal (t3code `hasUnseenCompletion`): never visited is not unread. */
export function isUnread(task: TaskView, lastVisitedAt: number | undefined): boolean {
  if (task.status !== "completed" || lastVisitedAt === undefined) return false;
  return task.updatedAt > lastVisitedAt;
}

export type ShelfState = Record<InboxGroup, boolean>;

export const DONE_PAGE_FIRST = 10;
export const DONE_PAGE_MORE = 25;

/** Task ids in the order the sidebar shows them: open shelves only, Done cut at its page size. */
export function visibleTaskIds(inbox: Inbox, expanded: ShelfState, doneLimit: number): string[] {
  const ids: string[] = [];
  for (const group of INBOX_GROUPS) {
    if (!expanded[group]) continue;
    const tasks = group === "done" ? inbox.done.slice(0, doneLimit) : inbox[group];
    for (const task of tasks) ids.push(task.id);
  }
  return ids;
}

/** Previous / next in sidebar order, stopping at the ends. With nothing open, next is the first and previous the last. */
export function adjacentTaskId(order: readonly string[], current: string | null, direction: 1 | -1): string | null {
  if (order.length === 0) return null;
  const index = current ? order.indexOf(current) : -1;
  if (index === -1) return direction === 1 ? order[0]! : order.at(-1)!;
  return order[index + direction] ?? null;
}

/** The task id in a team path (`/t/<team>/tasks/<id>`), or null. */
export function taskIdFromPath(pathname: string | null): string | null {
  const match = pathname?.match(/^\/t\/[^/]+\/tasks\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}
