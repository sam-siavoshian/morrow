"use client";

import type { TaskDetail, TaskView } from "@morrow/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getTaskDetail } from "@/lib/api";

/**
 * At most one detail fetch per task per this long. Team reads share a rate limit (about 2 a second per member),
 * so a busy task's changes are coalesced instead of each costing a request.
 */
export const DETAIL_REFETCH_MS = 1500;

export type TaskDetailState = {
  /** The newest detail fetched for this task, or null before the first one lands. It can trail the live view by one fetch. */
  data: TaskDetail | null;
  /** The detail covers the live task's latest change. */
  current: boolean;
  /** Why the latest fetch failed, or null. */
  error: string | null;
  retry: () => void;
};

/** True when `detail` already reflects `task`'s latest change. */
export const coversLive = (detail: TaskDetail | null, task: Pick<TaskView, "id" | "updatedAt"> | null): boolean =>
  detail !== null && task !== null && detail.id === task.id && detail.updatedAt >= task.updatedAt;

/** Details kept for tasks opened in this tab, newest last, so going back to one renders at once. */
export const DETAIL_CACHE_SIZE = 20;
const cache = new Map<string, TaskDetail>();
const cacheKey = (teamId: string, taskId: string) => `${teamId}/${taskId}`;

export function cachedTaskDetail(teamId: string, taskId: string): TaskDetail | null {
  return cache.get(cacheKey(teamId, taskId)) ?? null;
}

/**
 * The cached detail of `taskId`, whatever its team (task ids are unique). For helpers that see only the live view, such
 * as a worker's status, to say why it ended once the detail has loaded.
 */
export function cachedTaskDetailById(taskId: string): TaskDetail | null {
  for (const detail of cache.values()) if (detail.id === taskId) return detail;
  return null;
}

export function rememberTaskDetail(teamId: string, detail: TaskDetail): void {
  const key = cacheKey(teamId, detail.id);
  const known = cache.get(key);
  // A slow response must not replace a newer one.
  if (known && known.updatedAt > detail.updatedAt) return;
  cache.delete(key);
  cache.set(key, detail);
  for (const old of cache.keys()) {
    if (cache.size <= DETAIL_CACHE_SIZE) break;
    cache.delete(old);
  }
}

/** How long to wait before the next fetch, given when the last one started. */
export const refetchDelay = (lastFetchAt: number, now: number): number => Math.max(0, lastFetchAt + DETAIL_REFETCH_MS - now);

/**
 * The task's full text (prompt, plan, workstream text, verification, whole trace), which the live view leaves out.
 * Fetched when the task is shown and again whenever its `updatedAt` moves, throttled by `DETAIL_REFETCH_MS`.
 */
export function useTaskDetail(teamId: string, task: Pick<TaskView, "id" | "updatedAt"> | null): TaskDetailState {
  const taskId = task?.id ?? null;
  const version = task?.updatedAt ?? 0;
  const [state, setState] = useState<{ data: TaskDetail | null; error: { taskId: string; message: string } | null }>({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const lastFetchAt = useRef(0);
  // Whether the next run must fetch anyway (Try again), for the effect to read.
  const forced = useRef(false);

  useEffect(() => {
    if (!taskId) return;
    // A fetch that landed after this change (here or on an earlier visit) already covers it.
    if (!forced.current && coversLive(cachedTaskDetail(teamId, taskId), { id: taskId, updatedAt: version })) return;
    forced.current = false;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      lastFetchAt.current = Date.now();
      getTaskDetail(teamId, taskId, { signal: abort.signal }).then(
        (data) => {
          rememberTaskDetail(teamId, data);
          setState({ data, error: null });
        },
        (error: unknown) => {
          if (abort.signal.aborted) return;
          setState((prev) => ({ data: prev.data, error: { taskId, message: errorMessage(error, "Couldn't load the task's details.") } }));
        },
      );
    }, refetchDelay(lastFetchAt.current, Date.now()));
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [teamId, taskId, version, attempt]);

  const retry = useCallback(() => {
    lastFetchAt.current = 0;
    forced.current = true;
    setAttempt((n) => n + 1);
  }, []);

  // The last detail this tab saw for the task shows at once; the fetch above brings it up to date if needed.
  const data = !taskId ? null : state.data?.id === taskId ? state.data : cachedTaskDetail(teamId, taskId);
  return {
    data,
    current: coversLive(data, task),
    error: state.error?.taskId === taskId ? state.error.message : null,
    retry,
  };
}
