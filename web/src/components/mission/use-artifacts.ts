"use client";

import type { ArtifactsView } from "@morrow/contracts";
import { useEffect, useRef, useState } from "react";
import { errorMessage, getArtifacts, isApiError } from "@/lib/api";

export type ArtifactsState = { data: ArtifactsView | null; error: string | null; loading: boolean };

const REFETCH_DELAY_MS = 800;

/**
 * The task's branches, PR and preview from GitHub. Refetched (debounced) whenever the task changes,
 * since a checkpoint or verification moves them. A task the backend cannot find yet is not an error.
 */
export function useArtifacts(teamId: string, taskId: string, version: number): ArtifactsState {
  const [state, setState] = useState<ArtifactsState>({ data: null, error: null, loading: true });
  const fetched = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    const delay = fetched.current ? REFETCH_DELAY_MS : 0;
    const timer = setTimeout(() => {
      fetched.current = true;
      getArtifacts(teamId, taskId, { signal: abort.signal }).then(
        (data) => setState({ data, error: null, loading: false }),
        (error: unknown) => {
          if (abort.signal.aborted) return;
          const quiet = isApiError(error) && (error.code === "not_found" || error.code === "feature_disabled");
          setState((prev) => ({ data: prev.data, error: quiet ? null : errorMessage(error, "Couldn't load branches."), loading: false }));
        },
      );
    }, delay);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [teamId, taskId, version]);

  return state;
}
