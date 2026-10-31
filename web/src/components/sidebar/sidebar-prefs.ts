"use client";

import { Id } from "@morrow/contracts";
import { useCallback, useMemo } from "react";
import { INBOX_GROUPS, type InboxGroup } from "@/lib/store/selectors";
import { parseJson, readLocalPref, useLocalPref, writeLocalPref } from "./local-pref";
import type { ShelfState } from "./task-meta";

const SHELVES_KEY = "morrow:sidebar:shelves";
const projectKey = (teamId: string) => `morrow:sidebar:project:${teamId}`;
const visitsKey = (teamId: string) => `morrow:task-visits:${teamId}`;

/** Most visits remembered per team; the oldest fall off. */
export const VISIT_CAP = 300;

const ALL_OPEN: ShelfState = { "needs-you": true, running: true, recovering: true, done: true };

export function parseShelves(raw: string | null): ShelfState {
  const value = parseJson(raw);
  if (!value || typeof value !== "object") return ALL_OPEN;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(INBOX_GROUPS.map((g) => [g, record[g] !== false])) as ShelfState;
}

export function useShelves(): [ShelfState, (group: InboxGroup) => void] {
  const [raw, setRaw] = useLocalPref(SHELVES_KEY);
  const shelves = useMemo(() => parseShelves(raw), [raw]);
  const toggle = useCallback(
    (group: InboxGroup) => setRaw(JSON.stringify({ ...shelves, [group]: !shelves[group] })),
    [shelves, setRaw],
  );
  return [shelves, toggle];
}

/** The project filter for a team; null is All projects. Ids that no longer exist read as null. */
export function useProjectFilter(teamId: string, projectIds: readonly string[] | null): [string | null, (id: string | null) => void] {
  const [raw, setRaw] = useLocalPref(projectKey(teamId));
  const valid = raw !== null && Id.safeParse(raw).success && (projectIds === null || projectIds.includes(raw));
  return [valid ? raw : null, setRaw];
}

export type Visits = Record<string, number>;

export function parseVisits(raw: string | null): Visits {
  const value = parseJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const visits: Visits = {};
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (Id.safeParse(id).success && typeof at === "number" && Number.isFinite(at) && at > 0) visits[id] = at;
  }
  return visits;
}

/** Adds a visit and keeps only the newest `cap`. */
export function withVisit(visits: Visits, taskId: string, at: number, cap = VISIT_CAP): Visits {
  const next = { ...visits, [taskId]: at };
  const entries = Object.entries(next);
  if (entries.length <= cap) return next;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, cap));
}

export function useTaskVisits(teamId: string): Visits {
  const [raw] = useLocalPref(visitsKey(teamId));
  return useMemo(() => parseVisits(raw), [raw]);
}

export function recordTaskVisit(teamId: string, taskId: string, at = Date.now()): void {
  const key = visitsKey(teamId);
  writeLocalPref(key, JSON.stringify(withVisit(parseVisits(readLocalPref(key)), taskId, at)));
}
