// Composer drafts per team + project in localStorage (t3code composerDraftStore, trimmed down).
// Only what the user typed is stored: the prompt and the acceptance criteria. Never ids of
// sessions, never tokens. Writes are debounced and flushed on `beforeunload`.

import { TASK_CRITERION_MAX, TASK_PROMPT_MAX } from "@morrow/contracts";

export const DRAFT_STORAGE_KEY = "morrow:composer-drafts:v1";
export const DRAFT_DEBOUNCE_MS = 300;
/** The banner stays scannable at 10 lines; the API itself takes up to `TASK_CRITERIA_MAX`. */
export const UI_MAX_CRITERIA = 10;
/** Oldest drafts beyond this are dropped so storage never grows without bound. */
export const MAX_DRAFTS = 40;

export type Draft = { text: string; criteria: string[] };

type StoredDraft = Draft & { updatedAt: number };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export const draftKey = (teamId: string, projectId: string) => `${teamId}:${projectId}`;

export const EMPTY_DRAFT: Draft = Object.freeze({ text: "", criteria: [] }) as Draft;

const isEmpty = (d: Draft) => d.text.trim() === "" && d.criteria.every((c) => c.trim() === "");

/** Clamps a draft to what the API would accept, so a stale or tampered entry cannot blow up the UI. */
export function sanitizeDraft(value: unknown): Draft | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = typeof raw.text === "string" ? raw.text.slice(0, TASK_PROMPT_MAX) : "";
  const criteria = Array.isArray(raw.criteria)
    ? raw.criteria
        .filter((c): c is string => typeof c === "string")
        .slice(0, UI_MAX_CRITERIA)
        .map((c) => c.slice(0, TASK_CRITERION_MAX))
    : [];
  return { text, criteria };
}

function parse(json: string | null): Record<string, StoredDraft> {
  if (!json) return {};
  try {
    const data = JSON.parse(json) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, StoredDraft> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const draft = sanitizeDraft(value);
      if (!draft || isEmpty(draft)) continue;
      const at = (value as { updatedAt?: unknown }).updatedAt;
      out[key] = { ...draft, updatedAt: typeof at === "number" && Number.isFinite(at) ? at : 0 };
    }
    return out;
  } catch {
    return {};
  }
}

export type DraftStore = {
  /** Same object back until that key is written again (a useSyncExternalStore snapshot). */
  read(key: string): Draft;
  subscribe(listener: () => void): () => void;
  write(key: string, draft: Draft): void;
  /** Writes anything pending right now. */
  flush(): void;
};

type Options = {
  debounceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/** `storage` null (private mode, server) keeps drafts in memory for the session. */
export function createDraftStore(storage: Storage | null, options: Options = {}): DraftStore {
  const debounceMs = options.debounceMs ?? DRAFT_DEBOUNCE_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let cache: Record<string, StoredDraft> | null = null;
  let timer: unknown = null;
  let dirty = false;
  const views = new Map<string, Draft>();
  const listeners = new Set<() => void>();

  const load = () => {
    if (cache) return cache;
    try {
      cache = parse(storage?.getItem(DRAFT_STORAGE_KEY) ?? null);
    } catch {
      cache = {};
    }
    return cache;
  };

  const flush = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!dirty || !storage) return;
    dirty = false;
    const entries = Object.entries(load())
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_DRAFTS);
    cache = Object.fromEntries(entries);
    try {
      if (entries.length === 0) storage.removeItem(DRAFT_STORAGE_KEY);
      else storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // Quota or disabled storage: the draft stays in memory for this tab.
    }
  };

  return {
    read(key) {
      const seen = views.get(key);
      if (seen) return seen;
      const found = load()[key];
      const view = found ? { text: found.text, criteria: [...found.criteria] } : EMPTY_DRAFT;
      views.set(key, view);
      return view;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    write(key, draft) {
      // What was typed shows as is (even past the limit, so the counter can say so); storage gets the clamp.
      views.set(key, { text: String(draft.text ?? ""), criteria: Array.isArray(draft.criteria) ? [...draft.criteria] : [] });
      for (const listener of [...listeners]) listener();
      const clean = sanitizeDraft(draft) ?? EMPTY_DRAFT;
      const all = load();
      if (isEmpty(clean)) {
        if (!(key in all)) return;
        delete all[key];
      } else {
        all[key] = { ...clean, updatedAt: now() };
      }
      dirty = true;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, debounceMs);
    },
    flush,
  };
}

let browserStore: DraftStore | null = null;

/** The tab's draft store, flushed on `beforeunload`. Call only in the browser. */
export function browserDraftStore(): DraftStore {
  if (browserStore) return browserStore;
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  const store = createDraftStore(storage);
  window.addEventListener("beforeunload", () => store.flush());
  // Mobile browsers often skip beforeunload; pagehide still fires.
  window.addEventListener("pagehide", () => store.flush());
  browserStore = store;
  return store;
}
