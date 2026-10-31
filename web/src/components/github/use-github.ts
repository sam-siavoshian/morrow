"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type Resource<T> = {
  data: T | null;
  /** The last failure (an ApiError when the server answered). Cleared by the next success. */
  error: unknown;
  /** A request for the current key and version is still out. */
  loading: boolean;
  /** Fetch again now. */
  reload: () => void;
};

/** A burst of `github.changed` frames (a merge touches the list and the pull request) costs one refetch. */
const REFETCH_DELAY_MS = 400;

type Settled<T> = { key: string; token: string; data: T | null; error: unknown };

/**
 * Loads one GitHub-layer resource. A new `key` is a different resource (nothing from the old one is shown); a new
 * `version` (a `github.changed` frame, a new checkpoint, the task moving) refetches in place, keeping what is on screen until the
 * answer arrives. A null `key` means there is nothing to load.
 */
export function useGithubResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, version: number | string): Resource<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });
  const token = `${version}:${nonce}`;
  const sameKey = key !== null && settled?.key === key;

  useEffect(() => {
    if (key === null) return;
    const abort = new AbortController();
    const timer = setTimeout(
      () => {
        loadRef.current(abort.signal).then(
          (data) => {
            if (!abort.signal.aborted) setSettled({ key, token, data, error: null });
          },
          (error: unknown) => {
            if (abort.signal.aborted) return;
            // Keep what is on screen for this resource; say what went wrong next to it.
            setSettled((prev) => ({ key, token, data: prev?.key === key ? prev.data : null, error }));
          },
        );
      },
      sameKey ? REFETCH_DELAY_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
    // `sameKey` only picks the delay; it must not start a fetch of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, token]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return {
    data: sameKey ? settled!.data : null,
    error: sameKey ? settled!.error : null,
    loading: key !== null && (!sameKey || settled!.token !== token),
    reload,
  };
}
