"use client";

import { APP_NAME } from "@morrow/contracts";
import { useEffect } from "react";

/** `Workforce · Morrow`, matching the root metadata template. */
export const formatDocumentTitle = (title: string | null): string => {
  const clean = title?.replace(/\s+/g, " ").trim().slice(0, 120);
  return clean ? `${clean} · ${APP_NAME}` : APP_NAME;
};

type Entry = { title: string | null; priority: number };

// Every mounted title, newest last. The highest priority wins, the newest among equals: a page's
// own title beats the shell's per-route default whatever order their effects run in.
const entries: Entry[] = [];
let observer: MutationObserver | null = null;

export function resolveDocumentTitle(list: readonly Entry[]): string | null {
  let best: Entry | null = null;
  // A null title is "nothing to say yet" (still loading), not "clear the title".
  for (const entry of list) if (entry.title && (!best || entry.priority >= best.priority)) best = entry;
  return best ? formatDocumentTitle(best.title) : null;
}

function apply(): void {
  const title = resolveDocumentTitle(entries);
  if (title !== null && document.title !== title) document.title = title;
}

// Next writes route metadata titles after navigations; put ours back when it does.
function watchHead(): void {
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver(() => {
    if (entries.length > 0) apply();
  });
  observer.observe(document.head, { subtree: true, childList: true, characterData: true });
}

function push(entry: Entry): () => void {
  entries.push(entry);
  watchHead();
  apply();
  return () => {
    const index = entries.lastIndexOf(entry);
    if (index !== -1) entries.splice(index, 1);
    if (entries.length === 0) {
      observer?.disconnect();
      observer = null;
    } else apply();
  };
}

/** Sets the tab title (`<title> · Morrow`) while mounted. Pages use the default priority. */
export function useDocumentTitle(title: string | null, priority = 1): void {
  useEffect(() => push({ title, priority }), [title, priority]);
}
