"use client";

import { useCallback, useSyncExternalStore } from "react";

// Small per-browser preferences (shelf state, project filter, task visits). Never secrets: nothing
// here is sensitive, and every value is parsed back defensively because anyone can edit it.

const listeners = new Map<string, Set<() => void>>();
const cache = new Map<string, string | null>();

export function readLocalPref(key: string): string | null {
  if (cache.has(key)) return cache.get(key)!;
  let value: string | null = null;
  try {
    value = localStorage.getItem(key);
  } catch {
    value = null;
  }
  cache.set(key, value);
  return value;
}

export function writeLocalPref(key: string, value: string | null): void {
  cache.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, quota): the value lasts for this page.
  }
  for (const listener of listeners.get(key) ?? []) listener();
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  // Another tab changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return;
    cache.delete(key);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    set.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * A raw localStorage string, live across components and tabs. Null on the server and on the first
 * client render, so hydration always matches.
 */
export function useLocalPref(key: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    useCallback((listener) => subscribe(key, listener), [key]),
    () => readLocalPref(key),
    () => null,
  );
  const set = useCallback((next: string | null) => writeLocalPref(key, next), [key]);
  return [value, set];
}

/** JSON.parse that never throws. */
export function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
