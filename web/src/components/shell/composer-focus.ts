"use client";

import { useEffect, useRef } from "react";

/** Window event the composer listens for. Fired by New task (button, palette, mod+shift+o). */
export const COMPOSER_FOCUS_EVENT = "morrow:composer-focus";

/** A request older than this is stale: the composer never mounted, so nobody asked for it any more. */
const REQUEST_TTL_MS = 5_000;

// A request made while the composer is not mounted yet (navigating to the home page) waits here
// until it mounts, so the focus is never lost to the route change.
let pendingAt: number | null = null;

export function requestComposerFocus(now: number = Date.now()): void {
  pendingAt = now;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT));
}

/** True once if a fresh focus request is waiting. */
export function takeComposerFocusRequest(now: number = Date.now()): boolean {
  const fresh = pendingAt !== null && now - pendingAt <= REQUEST_TTL_MS;
  pendingAt = null;
  return fresh;
}

/**
 * For the composer: runs `focus` on every New task, including one made just before it mounted.
 * The handler runs after the event, on the next frame, so the route change has painted.
 */
export function useComposerFocusRequest(focus: () => void): void {
  const focusRef = useRef(focus);
  useEffect(() => {
    focusRef.current = focus;
  });
  useEffect(() => {
    let frame = 0;
    const run = () => {
      if (!takeComposerFocusRequest()) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => focusRef.current());
    };
    window.addEventListener(COMPOSER_FOCUS_EVENT, run);
    run();
    return () => {
      window.removeEventListener(COMPOSER_FOCUS_EVENT, run);
      cancelAnimationFrame(frame);
    };
  }, []);
}
