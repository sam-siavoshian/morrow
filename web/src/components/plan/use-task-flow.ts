"use client";

import type { CliKind, TaskDetail, TaskStrategy, TaskView, WorkforceView } from "@morrow/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ComposerFailure } from "@/components/composer/composer-error";
import { toast } from "@/components/ui/toast";
import { useTimeAfter } from "@/components/ui/timer";
import { useTaskDetail } from "@/components/mission/use-task-detail";
import { ApiError, cancelTask, createTask, getTaskDetail, isApiError, replanTask, startTask } from "@/lib/api";
import { useTeamStore } from "@/lib/store";
import { flowPhase, refinedPrompt, type FlowPhase } from "./plan-flow";

export type FlowBusy = "create" | "start" | "replan" | "refine" | "cancel" | null;

export type CreateInput = {
  projectId: string;
  prompt: string;
  acceptance: string[];
  mode: "auto" | "manual";
  pins: string[];
  strategy: TaskStrategy;
  /** Compare only: the harnesses that each attempt the whole task. */
  harnesses: CliKind[];
};

export type Picks = { workstreamId: string; profileId: string }[];

/** The composer's mode and pins, sent with Start and re-plan: the backend holds the whole run to them. */
export type WorkforceChoice = Pick<CreateInput, "mode" | "pins">;

/** The planner never picked up a re-plan: its queue was busy or the request was dropped. */
export const REPLAN_START_TIMEOUT_MS = 15_000;
/** The POST answered but the task never showed up on the socket. */
export const MISSING_TASK_TIMEOUT_MS = 20_000;

export const lastPlannedAt = (task: TaskView | null) =>
  // The live view carries only the newest trace entry, so the actor reports the latest plan's time.
  task?.plannedAt !== undefined
    ? (task.plannedAt ?? 0)
    : (task?.trace.reduce((at, e) => (e.kind === "task.planned" && e.at > at ? e.at : at), 0) ?? 0);

const asApiError = (error: unknown) => (isApiError(error) ? error : new ApiError("internal", "The request didn't reach the server. Check your connection and try again.", 0));

/** A re-plan in flight, keyed to the task's state when it was sent (server clock, so no skew). */
export type PendingReplan = { taskId: string; base: number; baseUpdatedAt: number; at: number; autoStart: boolean };

export type ReplanProgress = "none" | "waiting" | "planning" | "landed" | "stalled";

/** Where a re-plan stands, from the live task alone. */
export function replanProgress(pending: PendingReplan | null, task: TaskView | null, now: number): ReplanProgress {
  if (!pending || !task || task.id !== pending.taskId) return "none";
  if (task.status === "planning" || task.status === "draft") return "planning";
  if (task.status !== "planned") return "none";
  if (lastPlannedAt(task) > pending.base) return "landed";
  if (task.updatedAt === pending.baseUpdatedAt && now - pending.at > REPLAN_START_TIMEOUT_MS) return "stalled";
  return "waiting";
}

/**
 * Plans the viewer set aside with "Not now", for this tab. Module scope, so coming back to the home
 * (a remount) does not push the same plan at them again; a reload starts fresh.
 */
const setAside = new Set<string>();

/** The viewer's newest plan still waiting on them: the home picks up where they left off. */
export function waitingTaskOf(
  workforce: WorkforceView | null,
  viewerId: string | null,
  skip: ReadonlySet<string> = setAside,
): string | null {
  if (!workforce || !viewerId) return null;
  return (
    Object.values(workforce.tasks)
      .filter((t) => t.createdBy === viewerId && !skip.has(t.id) && (t.status === "draft" || t.status === "planning" || t.status === "planned"))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null
  );
}

/**
 * The composer's task lifecycle: create -> planning -> planned -> start / refine / re-plan.
 * State lives on the server (`workforce.view`); this only remembers which task the composer is
 * showing and which request is in flight. Each timeout is one timer that wakes the flow once.
 */
export function useTaskFlow(teamId: string, viewerId: string | null) {
  const router = useRouter();
  // `undefined`: nothing chosen yet, so resume the viewer's waiting plan. `null`: show none.
  const [chosen, setChosen] = useState<{ id: string | null; at: number } | undefined>(undefined);
  const [busy, setBusy] = useState<FlowBusy>(null);
  const [failure, setFailure] = useState<ComposerFailure | null>(null);
  const [pending, setPending] = useState<PendingReplan | null>(null);
  const [autoStarted, setAutoStarted] = useState<number | null>(null);

  const workforce = useTeamStore((s) => s.workforce);
  // A chosen task this tab saw that then left the live view was deleted (here or by a teammate): back to composing.
  const [seenTaskId, setSeenTaskId] = useState<string | null>(null);
  const chosenTask = chosen?.id ? (workforce?.tasks[chosen.id] ?? null) : null;
  if (chosenTask && seenTaskId !== chosenTask.id) setSeenTaskId(chosenTask.id);
  const deleted = Boolean(chosen?.id && workforce && !chosenTask && seenTaskId === chosen.id);
  const activeTaskId = chosen === undefined ? waitingTaskOf(workforce, viewerId) : deleted ? null : chosen.id;
  const task = activeTaskId ? (workforce?.tasks[activeTaskId] ?? null) : null;

  const stallCheck = useTimeAfter(pending ? pending.at + REPLAN_START_TIMEOUT_MS : null);
  const progress = replanProgress(pending, task, stallCheck);
  const settled = flowPhase(activeTaskId, task);
  // The shown plan's text (prompt, plan, workstream text) is not in the live view.
  const detail = useTaskDetail(teamId, settled.kind === "planning" || settled.kind === "planned" ? task : null);
  // Between the re-plan POST and the planner picking it up, the old plan is stale: show planning.
  const phase: FlowPhase = progress === "waiting" && settled.kind === "planned" ? { kind: "planning", task: settled.task } : settled;

  const lostCheck = useTimeAfter(chosen?.id ? chosen.at + MISSING_TASK_TIMEOUT_MS : null);
  const lost = Boolean(chosen?.id && !deleted && !task && workforce && lostCheck && lostCheck - chosen.at > MISSING_TASK_TIMEOUT_MS);
  const derivedFailure: ComposerFailure | null =
    progress === "stalled"
      ? {
          title: "The planner didn't start",
          error: new ApiError("conflict", "The planner agent may be busy planning other tasks. Try again in a moment.", 0),
          retry: null,
          at: pending!.at,
        }
      : lost
        ? { title: "Lost track of the task", error: new ApiError("not_found", "It is not in the live view. Check the sidebar.", 0), retry: null, at: chosen!.at }
        : null;

  const fail = (title: string, error: unknown, retry: (() => void) | null) =>
    setFailure({ title, error: asApiError(error), retry, at: Date.now() });

  // One request at a time: a double Enter must never create two tasks. React flushes discrete
  // events one by one, so the second Enter already sees `busy`.
  async function run<T>(kind: Exclude<FlowBusy, null>, work: () => Promise<T>): Promise<T | undefined> {
    if (busy) return undefined;
    setBusy(kind);
    setFailure(null);
    try {
      return await work();
    } finally {
      setBusy(null);
    }
  }

  async function create(input: CreateInput): Promise<boolean> {
    try {
      const result = await run("create", () => createTask(teamId, input));
      if (!result) return false;
      setPending(null);
      setChosen({ id: result.taskId, at: Date.now() });
      return true;
    } catch (error) {
      fail("Couldn't plan the task", error, () => void create(input));
      return false;
    }
  }

  async function start(picks: Picks | null, workforce?: WorkforceChoice) {
    const id = activeTaskId;
    if (!id || !picks) return;
    try {
      const result = await run("start", () => startTask(teamId, id, { picks, ...workforce }));
      if (!result) return;
      setPending(null);
      setChosen({ id: null, at: Date.now() });
      router.push(`/t/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(id)}`);
    } catch (error) {
      fail("Couldn't start", error, () => void start(picks, workforce));
    }
  }

  /** `maxAgents` plans at most that many workstreams ("Start with fewer agents"); omitted, the planner decides. */
  async function replan(options: { maxAgents?: number; pins: string[]; mode?: WorkforceChoice["mode"]; autoStart?: boolean }) {
    const current = task;
    if (!current) return;
    try {
      const result = await run("replan", () => replanTask(teamId, current.id, { maxAgents: options.maxAgents, pins: options.pins, mode: options.mode }));
      if (!result) return;
      setPending({
        taskId: current.id,
        base: lastPlannedAt(current),
        baseUpdatedAt: current.updatedAt,
        at: Date.now(),
        autoStart: options.autoStart ?? false,
      });
    } catch (error) {
      fail("Couldn't plan again", error, () => void replan(options));
    }
  }

  /**
   * The backend's re-plan takes only `maxAgents` and `pins`, so feedback can't ride along. Refine files
   * a new task whose prompt carries the feedback, then cancels the old plan.
   */
  async function refine(feedback: string, settings: Pick<CreateInput, "mode" | "pins" | "strategy" | "harnesses">): Promise<boolean> {
    const old = detail.data;
    if (!old) {
      fail("Couldn't refine", new ApiError("conflict", "The plan is still loading. Try again in a moment.", 0), null);
      return false;
    }
    const prompt = refinedPrompt(old.prompt, feedback);
    if (!prompt) {
      fail("Couldn't refine", new ApiError("bad_request", "The task and your feedback are over 8,000 characters together.", 0), null);
      return false;
    }
    try {
      const result = await run("refine", async () => {
        const created = await createTask(teamId, { ...settings, projectId: old.projectId, prompt, acceptance: old.acceptance, title: old.title });
        // An old plan left open would sit in "Needs you".
        await cancelTask(teamId, old.id).catch(() => {
          toast.warning("The earlier plan is still open", { description: "Cancel it from mission control if you don't need it." });
        });
        return created;
      });
      if (!result) return false;
      setPending(null);
      setChosen({ id: result.taskId, at: Date.now() });
      return true;
    } catch (error) {
      fail("Couldn't refine the plan", error, () => void refine(feedback, settings));
      return false;
    }
  }

  /** Cancels the tracked task and hands its text back so nothing typed is lost (null text if it could not be read). */
  async function cancel(): Promise<{ task: TaskView; text: Pick<TaskDetail, "prompt" | "acceptance"> | null } | null> {
    const current = task;
    if (!current) return null;
    const known = detail.data;
    try {
      const result = await run("cancel", () => cancelTask(teamId, current.id));
      if (!result) return null;
      setPending(null);
      setChosen({ id: null, at: Date.now() });
      const text = known ?? (await getTaskDetail(teamId, current.id).catch(() => null));
      return { task: current, text };
    } catch (error) {
      fail("Couldn't cancel", error, () => void cancel());
      return null;
    }
  }

  /** Stops showing the task here; it stays in the sidebar under Needs you. */
  function dismiss() {
    if (activeTaskId) setAside.add(activeTaskId);
    setPending(null);
    setFailure(null);
    setChosen({ id: null, at: Date.now() });
  }

  /** "Start with fewer agents": once the smaller plan lands, start it (once). */
  const autoStartDue = progress === "landed" && pending?.autoStart === true && autoStarted !== pending.at;
  function runAutoStart(picks: Picks | null, workforce?: WorkforceChoice) {
    if (!autoStartDue || !pending) return;
    setAutoStarted(pending.at);
    if (picks) void start(picks, workforce);
  }

  return {
    activeTaskId,
    task,
    /** The shown task's full text, fetched while it is planning or planned. */
    detail,
    phase,
    busy,
    autoStarting: pending?.autoStart === true && progress !== "landed",
    autoStartDue,
    failure: failure ?? derivedFailure,
    clearFailure: () => {
      setFailure(null);
      if (progress === "stalled") setPending(null);
      if (lost) setChosen({ id: null, at: Date.now() });
    },
    create,
    start,
    replan,
    refine,
    cancel,
    dismiss,
    runAutoStart,
    /** When the planner started on the shown task, for the elapsed timer. */
    planningSince: task && (task.status === "planning" || task.status === "draft") ? task.updatedAt : (chosen?.at ?? 0),
  };
}

export type TaskFlow = ReturnType<typeof useTaskFlow>;
