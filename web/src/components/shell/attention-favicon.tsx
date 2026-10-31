"use client";

import { useEffect, useSyncExternalStore } from "react";
import { drawBadge, installBadge } from "./favicon-badge";

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Badges the tab icon with the "Needs you" count while the tab is in the background. */
export function AttentionFavicon({ count }: { count: number }) {
  const hidden = useSyncExternalStore(subscribeVisibility, () => document.hidden, () => false);
  useEffect(() => {
    if (!hidden || count <= 0) return;
    const image = drawBadge(count);
    return image ? installBadge(image) : undefined;
  }, [hidden, count]);
  return null;
}
