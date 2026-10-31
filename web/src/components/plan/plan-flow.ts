import type { TaskView } from "@morrow/contracts";

// The composer's plan flow as pure functions: which phase the tracked task is in, and what the
// primary button does. Compose -> (send) -> planning -> planned -> Start | Refine | Re-plan.

export type FlowPhase =
  | { kind: "compose" }
  /** Created or re-planning; `task` is null until `workforce.view` carries it. */
  | { kind: "planning"; task: TaskView | null }
  | { kind: "planned"; task: TaskView }
  /** Someone pressed Start (here or in mission control). */
  | { kind: "started"; task: TaskView }
  /** Cancelled, failed or gone before it started. */
  | { kind: "ended"; task: TaskView | null; reason: string };

const STARTED = new Set<TaskView["status"]>(["starting", "running", "handoff", "choosing", "verifying", "resolving", "completed"]);

export function flowPhase(activeTaskId: string | null, task: TaskView | null): FlowPhase {
  if (!activeTaskId) return { kind: "compose" };
  // Not in a snapshot yet: the POST answered before the socket pushed the new view.
  if (!task) return { kind: "planning", task: null };
  switch (task.status) {
    case "draft":
    case "planning":
      return { kind: "planning", task };
    case "planned":
      return task.workstreams.length > 0 ? { kind: "planned", task } : { kind: "planning", task };
    case "cancelled":
      return { kind: "ended", task, reason: "This task was cancelled." };
    case "failed":
      return { kind: "ended", task, reason: "This task failed before it started." };
    default:
      return STARTED.has(task.status) ? { kind: "started", task } : { kind: "planning", task };
  }
}

export type PrimaryAction =
  /** Round arrow: create the task and plan it. */
  | "send"
  /** Split pill: Start, with fewer agents / re-plan in the chevron. */
  | "start"
  /** Pill: re-plan with the typed feedback. */
  | "refine"
  /** Disabled while the planner works. */
  | "planning";

export function primaryAction(phase: FlowPhase, hasText: boolean): PrimaryAction {
  if (phase.kind === "planning") return "planning";
  if (phase.kind === "planned") return hasText ? "refine" : "start";
  return "send";
}

/** A compare task has no planner to re-run: its attempts are the harnesses picked at create. */
export const canReplan = (task: Pick<TaskView, "strategy">): boolean => task.strategy !== "compare";

/** The re-plan cap for "Start with fewer agents": one less than the plan has now, never below one. Null for compare. */
export function fewerAgents(task: Pick<TaskView, "workstreams" | "maxAgents" | "strategy">): number | null {
  if (!canReplan(task)) return null;
  const current = Math.min(task.maxAgents, task.workstreams.length);
  return current > 1 ? current - 1 : null;
}

/**
 * The backend's re-plan takes only `maxAgents` and `pins`, so feedback cannot ride along.
 * Refine therefore files a new task whose prompt carries the feedback, then cancels the old plan.
 */
export function refinedPrompt(original: string, feedback: string, limit = 8000): string | null {
  const note = feedback.trim();
  if (!note) return null;
  const text = `${original.trimEnd()}\n\nFeedback on the previous plan:\n${note}`;
  return text.length <= limit ? text : null;
}

/**
 * A line saying what the planner is doing. The backend does not yet trace which profile holds the
 * planner, so this only names one when the latest trace entry says so.
 */
export function planningLine(task: TaskView | null): string {
  const last = task?.trace.at(-1);
  if (last && last.kind !== "task.created" && last.kind !== "task.planned" && last.message) return last.message;
  return "Planning the task";
}
