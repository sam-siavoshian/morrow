"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "@/lib/motion";

// t3code Sidebar.motion: rows glide to their new place in 150ms, travelling at most 40px, and new
// rows fade in. Positions are offsetTop inside the list, so scrolling never reads as movement.
const TIMING: KeyframeAnimationOptions = { duration: 150, easing: "ease-out" };
export const MAX_TRAVEL = 40;

export const clampTravel = (delta: number): number => Math.max(-MAX_TRAVEL, Math.min(MAX_TRAVEL, delta));

/** Animates direct children carrying `data-flip-key` whenever `version` changes. */
export function useListFlip(listRef: RefObject<HTMLElement | null>, version: unknown): void {
  const positions = useRef<Map<string, number> | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-flip-key]"));
    const next = new Map(items.map((item) => [item.dataset.flipKey!, item.offsetTop]));
    const previous = positions.current;
    positions.current = next;
    // First paint, or the user asked for less motion: just record where things are.
    if (!previous || prefersReducedMotion() || typeof list.animate !== "function") return;
    for (const item of items) {
      const before = previous.get(item.dataset.flipKey!);
      if (before === undefined) {
        item.animate([{ opacity: 0 }, { opacity: 1 }], TIMING);
        continue;
      }
      const delta = clampTravel(before - next.get(item.dataset.flipKey!)!);
      if (Math.abs(delta) < 1) continue;
      item.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], TIMING);
    }
  }, [listRef, version]);
}
