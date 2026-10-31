// Reads the TeamWorkforce actor's emitted state. The actor emits its view in three parts (`profilesView`,
// `tasksView`, `leasesView`) plus a small `outboxSummary`, so a change to one part does not resend the others.
// Actors deployed before that split emit one `view` field; both shapes are read here, so the backend can be deployed
// first and keep working while actors are on either version.
import { WorkforceView } from "@morrow/contracts";
import type { Logger } from "../lib/logger.ts";

/** The view as the actor's `getView` returns it: `{ profiles, tasks, leases }`, unparsed. */
export type RawWorkforceView = { profiles: Record<string, unknown>; tasks: Record<string, unknown>; leases: Record<string, unknown> };

export type OutboxSummary = { open: number; nextDueAt: number | null };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The composed view, or null when the state carries neither shape. */
export function composeWorkforceView(state: Record<string, unknown>): RawWorkforceView | null {
  const { profilesView, tasksView, leasesView } = state;
  if (isRecord(profilesView) && isRecord(tasksView) && isRecord(leasesView)) return { profiles: profilesView, tasks: tasksView, leases: leasesView };
  const view = state.view;
  if (isRecord(view) && isRecord(view.profiles) && isRecord(view.tasks) && isRecord(view.leases)) {
    return { profiles: view.profiles, tasks: view.tasks, leases: view.leases };
  }
  return null;
}

/** The emitted outbox summary, or null for an actor that does not emit one (claims then fall back to polling). */
export function outboxSummaryOf(state: Record<string, unknown>): OutboxSummary | null {
  const summary = state.outboxSummary;
  if (!isRecord(summary)) return null;
  const { open, nextDueAt } = summary;
  if (typeof open !== "number" || !Number.isInteger(open) || open < 0) return null;
  if (nextDueAt !== null && (typeof nextDueAt !== "number" || !Number.isFinite(nextDueAt))) return null;
  return { open, nextDueAt };
}

/** The browser-facing view (contract-parsed) from either shape, or null (logged) when it does not match the contract. */
export function parseWorkforceState(state: Record<string, unknown>, log: Pick<Logger, "error">): WorkforceView | null {
  const parsed = WorkforceView.safeParse(composeWorkforceView(state));
  if (!parsed.success) {
    log.error("workforce view does not match the contract", { issues: parsed.error.issues.slice(0, 3) });
    return null;
  }
  return parsed.data;
}
