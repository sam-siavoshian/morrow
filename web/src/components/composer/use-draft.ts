"use client";

import { useCallback, useSyncExternalStore } from "react";
import { browserDraftStore, draftKey, EMPTY_DRAFT, type Draft } from "./drafts";

const subscribe = (listener: () => void) => browserDraftStore().subscribe(listener);

/**
 * The composer draft for one team + project, saved as it changes. The server and the first client
 * render see an empty draft (no localStorage there); the saved one fills in right after hydration.
 */
export function useDraft(teamId: string, projectId: string | null) {
  const key = draftKey(teamId, projectId ?? "_");
  const draft = useSyncExternalStore(
    subscribe,
    () => browserDraftStore().read(key),
    () => EMPTY_DRAFT,
  );
  const update = useCallback(
    (next: Draft | ((current: Draft) => Draft)) => {
      const store = browserDraftStore();
      store.write(key, typeof next === "function" ? next(store.read(key)) : next);
    },
    [key],
  );
  return [draft, update] as const;
}

export type DraftUpdate = ReturnType<typeof useDraft>[1];
