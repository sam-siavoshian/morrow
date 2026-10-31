"use client";

import type { BranchDiffView } from "@morrow/contracts";
import { useEffect, useRef, useState } from "react";
import { getWorkstreamDiff } from "@/lib/api";

export type DiffState = { data: BranchDiffView | null; error: unknown; loading: boolean };
export type DiffTarget = {
  id: string;
  /** Changes when the branch may have moved (a checkpoint, a push, a GitHub change): refetch then. */
  version: string;
  /** False while nothing can be on GitHub yet (pending, no checkpoint): no request. */
  ready: boolean;
};

/** A burst of checkpoints or GitHub changes costs one refetch per workstream. */
const REFETCH_DELAY_MS = 700;

/**
 * Each workstream's diff against the task base, for the chips on the graph and the crew list and for the Diff tab.
 * One request per workstream and version, read through the backend's GitHub cache with the viewer's own token.
 * What was on screen stays while a refetch runs.
 */
export function useWorkstreamDiffs(teamId: string, taskId: string, targets: readonly DiffTarget[]): ReadonlyMap<string, DiffState> {
  const [state, setState] = useState<ReadonlyMap<string, DiffState & { version: string }>>(new Map());
  const loaded = useRef(new Map<string, string>());
  const signature = targets.map((t) => `${t.id}@${t.ready ? t.version : "-"}`).join(",");

  useEffect(() => {
    const aborts: AbortController[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const target of targets) {
      if (!target.ready || loaded.current.get(target.id) === target.version) continue;
      const abort = new AbortController();
      aborts.push(abort);
      const delay = loaded.current.has(target.id) ? REFETCH_DELAY_MS : 0;
      setState((prev) => withEntry(prev, target.id, { ...(prev.get(target.id) ?? { data: null, error: null }), loading: true, version: target.version }));
      timers.push(
        setTimeout(() => {
          getWorkstreamDiff(teamId, taskId, target.id, { signal: abort.signal }).then(
            (data) => {
              loaded.current.set(target.id, target.version);
              setState((prev) => withEntry(prev, target.id, { data, error: null, loading: false, version: target.version }));
            },
            (error: unknown) => {
              if (abort.signal.aborted) return;
              loaded.current.set(target.id, target.version);
              setState((prev) => withEntry(prev, target.id, { data: prev.get(target.id)?.data ?? null, error, loading: false, version: target.version }));
            },
          );
        }, delay),
      );
    }
    return () => {
      for (const t of timers) clearTimeout(t);
      for (const a of aborts) a.abort();
    };
    // `signature` is `targets` by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, taskId, signature]);

  return state;
}

function withEntry<T>(map: ReadonlyMap<string, T>, key: string, value: T): Map<string, T> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}
