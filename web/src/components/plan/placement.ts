import type { EnvironmentView, ProfileView, TaskDetail, WorkforceMode } from "@morrow/contracts";
import { HARNESS_LABEL } from "@/components/harness/harness-icon";

// Which profile would take each workstream if Start were pressed now. Same rules and weights as
// the backend's choosePicks (backend/src/orchestration/scoring.ts): eligibility first, then pins,
// healthy auth, node online, free slots, and spreading one task across machines. The composer
// sends these exact picks on Start, so what the plan card shows is what runs; the backend
// re-validates every pick and refuses the whole batch if one went stale.
//
// Two ways a person steers it: a compare attempt is bound to its harness, so only profiles of that CLI count; and in
// the plan card a person may choose the profile for any starting workstream (`chosen`), which then wins outright as
// long as it can take the work. That is how one Split task runs Claude Code on the API and Codex on the UI. In
// Manual mode only the picked profiles count, chosen ones included: the backend refuses any other for the whole run.
//
// A split starts with what fits: starting workstreams past the free slots, or past the team's per-task cap, are
// queued and the scheduler gives each the next free slot. A compare starts every attempt at once or not at all.

export type Placement =
  | { kind: "placed"; profileId: string }
  | { kind: "waits"; on: string[] }
  /** A starting workstream with no slot now: it gets the next one that frees up. */
  | { kind: "queued" }
  | { kind: "none"; reason: string };

export type PlacementResult = {
  byWorkstream: Record<string, Placement>;
  /** Picks for Start, roots only; null when Start cannot run (see `blocked`). */
  picks: { workstreamId: string; profileId: string }[] | null;
  /** Why Start cannot run, in one line. */
  blocked: string | null;
};

type Env = Pick<EnvironmentView, "id" | "phase" | "nodeOnline">;

function eligible(p: ProfileView, env: Env | undefined, projectId: string, extraLoad: number): boolean {
  if (p.availability !== "ready" && p.availability !== "busy") return false;
  if (p.auth === "auth_required") return false;
  if (p.scopes !== "all" && !p.scopes.includes(projectId)) return false;
  if (p.activeLeases + extraLoad >= p.maxConcurrent) return false;
  return env?.phase === "ready";
}

function score(p: ProfileView, env: Env | undefined, pins: readonly string[], extraLoad: number, envUse: number): number {
  let total = 0;
  if (pins.includes(p.id)) total += 40;
  if (p.auth === "ok") total += 10;
  if (env?.nodeOnline) total += 5;
  total += 4 * Math.min(3, p.maxConcurrent - p.activeLeases - extraLoad);
  total -= 8 * envUse;
  return total;
}

export function previewPlacement(input: {
  task: Pick<TaskDetail, "projectId" | "workstreams">;
  profiles: readonly ProfileView[];
  environments: readonly Env[];
  pins: readonly string[];
  mode: WorkforceMode;
  /** Profiles the person chose per workstream in the plan card; they win over the score when they can take the work. */
  chosen?: Readonly<Record<string, string>>;
  /** Workers one task may start at once (the team policy's `maxParallelPerTask`); the backend refuses more picks. */
  cap?: number;
}): PlacementResult {
  const { task, pins, mode } = input;
  const chosen = input.chosen ?? {};
  const cap = input.cap ?? Number.POSITIVE_INFINITY;
  const compare = task.workstreams.some((w) => w.harness);
  const byId = new Map(input.profiles.map((p) => [p.id, p]));
  const envs = new Map(input.environments.map((e) => [e.id, e]));
  // Manual: only the profiles the human picked. Auto: anyone, pins preferred.
  const pool = mode === "manual" ? input.profiles.filter((p) => pins.includes(p.id)) : input.profiles;
  const roleOf = new Map(task.workstreams.map((w) => [w.id, w.role]));

  const load = new Map<string, number>();
  const envUse = new Map<string, number>();
  const byWorkstream: Record<string, Placement> = {};
  const picks: { workstreamId: string; profileId: string }[] = [];
  let missing = 0;

  // Chosen workstreams claim the slots under the cap first, so a choice is never quietly queued behind Auto ones.
  const ordered = [...task.workstreams.filter((w) => chosen[w.id]), ...task.workstreams.filter((w) => !chosen[w.id])];
  for (const ws of ordered) {
    if (ws.dependsOn.length > 0) {
      byWorkstream[ws.id] = { kind: "waits", on: ws.dependsOn.map((id) => roleOf.get(id) ?? id) };
      continue;
    }
    if (picks.length >= cap) {
      if (compare || chosen[ws.id]) {
        missing++;
        byWorkstream[ws.id] = { kind: "none", reason: compare ? `This team runs ${cap} at once` : `This team starts ${cap} at once. Set it back to Auto to queue it.` };
      } else byWorkstream[ws.id] = { kind: "queued" };
      continue;
    }
    const fits = (p: ProfileView) => (!ws.harness || p.cli === ws.harness) && eligible(p, envs.get(p.envId), task.projectId, load.get(p.id) ?? 0);
    const choice = chosen[ws.id] ? byId.get(chosen[ws.id]!) : undefined;
    const unpinned = choice && mode === "manual" && !pins.includes(choice.id);
    if (chosen[ws.id] && !(choice && !unpinned && fits(choice))) {
      missing++;
      byWorkstream[ws.id] = {
        kind: "none",
        reason: !choice ? "The profile you chose is gone" : unpinned ? `${choice.label} isn't one of your picked profiles` : `${choice.label} can't take it right now`,
      };
      continue;
    }
    const best =
      choice ??
      pool
        .filter(fits)
        .map((p) => ({ p, s: score(p, envs.get(p.envId), pins, load.get(p.id) ?? 0, envUse.get(p.envId) ?? 0) }))
        .sort((a, b) => b.s - a.s || (a.p.id < b.p.id ? -1 : 1))[0]?.p;
    if (!best && !compare) {
      byWorkstream[ws.id] = { kind: "queued" };
      continue;
    }
    if (!best) {
      missing++;
      byWorkstream[ws.id] = { kind: "none", reason: ws.harness ? `No ${HARNESS_LABEL[ws.harness]} profile is free` : "No ready profile is free" };
      continue;
    }
    load.set(best.id, (load.get(best.id) ?? 0) + 1);
    envUse.set(best.envId, (envUse.get(best.envId) ?? 0) + 1);
    byWorkstream[ws.id] = { kind: "placed", profileId: best.id };
    picks.push({ workstreamId: ws.id, profileId: best.id });
  }

  // Nothing can start, so nothing is waiting in line either: each root says why instead.
  if (picks.length === 0)
    for (const [id, placed] of Object.entries(byWorkstream))
      if (placed.kind === "queued") byWorkstream[id] = { kind: "none", reason: mode === "manual" ? "None of your picked profiles is free" : "No ready profile is free" };

  let blocked: string | null = null;
  if (task.workstreams.length === 0) blocked = "The plan has no workstreams.";
  else if (Object.keys(chosen).some((id) => byWorkstream[id]?.kind === "none"))
    blocked = "A profile you chose can't take its workstream right now. Choose another, or set it back to Auto.";
  else if (compare && missing > 0) blocked = "Not every harness in this compare has a free profile. Connect one, or wait for a slot.";
  else if (picks.length === 0)
    blocked =
      mode === "manual"
        ? "None of your picked profiles has a free slot. Wait for one to free up, or pick more."
        : "No ready CLI profile has a free slot. Connect one or wait for a cooldown to end.";

  return { byWorkstream, picks: blocked ? null : picks, blocked };
}
