// Picks which CLI profile runs what. Hard rules first (the actor would reject anything else), then a score:
// pinned, same CLI as before, a different VM than the one that just failed, healthy auth, free slots,
// node online, and spreading one task's workstreams across machines.
import type { CliKind, EnvironmentView, ProfileView } from "@morrow/contracts";
import type { ReservePick, TaskRecord } from "./workforce.ts";

export interface Preferences {
  pins?: readonly string[];
  /** CLI of the worker being replaced. */
  cli?: CliKind;
  /** Environment of the worker being replaced. */
  avoidEnvId?: string;
  /** Workstreams bound to one harness (compare attempts): only profiles of that CLI may take them. */
  harnessOf?: ReadonlyMap<string, CliKind>;
  /** Workers of each CLI the task already runs: new picks spread across CLIs so peers on different harnesses talk. */
  cliUse?: ReadonlyMap<CliKind, number>;
}

/** Spreading across harnesses beats free-slot and machine preferences, never a pin or a replacement's own CLI. */
const SAME_CLI_PENALTY = 25;

/** Workers of each CLI a task runs now (live, not subagents). */
export function taskCliUse(view: { leases: Record<string, { taskId: string; state: string; profileId: string; parentLeaseId?: string | null }>; profiles: Record<string, { cli: CliKind }> }, taskId: string): Map<CliKind, number> {
  const use = new Map<CliKind, number>();
  for (const lease of Object.values(view.leases)) {
    if (lease.taskId !== taskId || lease.parentLeaseId || !["reserved", "spawning", "running"].includes(lease.state)) continue;
    const cli = view.profiles[lease.profileId]?.cli;
    if (cli) use.set(cli, (use.get(cli) ?? 0) + 1);
  }
  return use;
}

/**
 * The profiles that may take a task's work. Manual: only its pins (the actor refuses any other, so offering the rest
 * would only churn on refusals). Auto: every profile, pins preferred by the score.
 */
export function placementPool<P extends { id: string }>(profiles: readonly P[], task: Pick<TaskRecord, "mode" | "pins">): P[] {
  return task.mode === "manual" ? profiles.filter((p) => task.pins.includes(p.id)) : [...profiles];
}

/** Whether the profile can take one more lease (`extraLoad` already planned in this batch) for `projectId`. */
export function eligible(profile: ProfileView, env: EnvironmentView | undefined, projectId: string, extraLoad = 0): boolean {
  if (profile.availability !== "ready" && profile.availability !== "busy") return false;
  if (profile.auth === "auth_required") return false;
  if (profile.scopes !== "all" && !profile.scopes.includes(projectId)) return false;
  if (profile.activeLeases + extraLoad >= profile.maxConcurrent) return false;
  return env?.phase === "ready";
}

export function score(profile: ProfileView, env: EnvironmentView | undefined, prefs: Preferences, extraLoad = 0, envUse = 0, cliUse = 0): number {
  let total = 0;
  total -= SAME_CLI_PENALTY * cliUse;
  if (prefs.pins?.includes(profile.id)) total += 40;
  if (prefs.cli && profile.cli === prefs.cli) total += 20;
  if (prefs.avoidEnvId && profile.envId !== prefs.avoidEnvId) total += 15;
  if (profile.auth === "ok") total += 10;
  if (env?.nodeOnline) total += 5;
  total += 4 * Math.min(3, profile.maxConcurrent - profile.activeLeases - extraLoad);
  total -= 8 * envUse;
  return total;
}

function rank(
  profiles: readonly ProfileView[],
  envs: ReadonlyMap<string, EnvironmentView>,
  projectId: string,
  prefs: Preferences,
  load: ReadonlyMap<string, number>,
  envUse: ReadonlyMap<string, number>,
  cliUse: ReadonlyMap<CliKind, number> = new Map(),
): ProfileView[] {
  return profiles
    .filter((p) => eligible(p, envs.get(p.envId), projectId, load.get(p.id) ?? 0))
    .map((p) => ({ p, s: score(p, envs.get(p.envId), prefs, load.get(p.id) ?? 0, envUse.get(p.envId) ?? 0, cliUse.get(p.cli) ?? 0) }))
    .sort((a, b) => b.s - a.s || (a.p.id < b.p.id ? -1 : 1))
    .map(({ p }) => p);
}

/**
 * One profile per workstream, greedily, or null when some workstream has no eligible profile. With `partial`, a
 * workstream without one is skipped instead (null only when none fits), so a few free slots still get used.
 */
export function choosePicks(
  workstreamIds: readonly string[],
  profiles: readonly ProfileView[],
  envs: ReadonlyMap<string, EnvironmentView>,
  projectId: string,
  prefs: Preferences = {},
  options: { partial?: boolean } = {},
): ReservePick[] | null {
  const load = new Map<string, number>();
  const envUse = new Map<string, number>();
  const cliUse = new Map<CliKind, number>(prefs.cliUse ?? []);
  const picks: ReservePick[] = [];
  for (const workstreamId of workstreamIds) {
    const harness = prefs.harnessOf?.get(workstreamId);
    const pool = harness ? profiles.filter((p) => p.cli === harness) : profiles;
    const best = rank(pool, envs, projectId, prefs, load, envUse, cliUse)[0];
    if (!best) {
      if (options.partial) continue;
      return null;
    }
    load.set(best.id, (load.get(best.id) ?? 0) + 1);
    envUse.set(best.envId, (envUse.get(best.envId) ?? 0) + 1);
    cliUse.set(best.cli, (cliUse.get(best.cli) ?? 0) + 1);
    picks.push({ workstreamId, profileId: best.id });
  }
  return options.partial && picks.length === 0 ? null : picks;
}

/**
 * Best replacement for a stopped worker: same CLI preferred, another VM preferred, never the same profile. A
 * workstream bound to a harness (`harness`, a compare attempt) only ever gets a profile of that CLI. `allowSame`
 * (a manual task, whose pins may be just that one profile) falls back to the same profile once it is eligible
 * again, say after its cooldown, rather than waiting for good.
 */
export function chooseReplacement(
  from: Pick<ProfileView, "id" | "cli" | "envId"> | undefined,
  profiles: readonly ProfileView[],
  envs: ReadonlyMap<string, EnvironmentView>,
  projectId: string,
  harness: CliKind | null = null,
  allowSame = false,
): ProfileView | null {
  const fits = profiles.filter((p) => harness === null || p.cli === harness);
  const prefs = { cli: from?.cli, avoidEnvId: from?.envId };
  const other = rank(fits.filter((p) => p.id !== from?.id), envs, projectId, prefs, new Map(), new Map())[0];
  if (other || !allowSame) return other ?? null;
  return rank(fits.filter((p) => p.id === from?.id), envs, projectId, prefs, new Map(), new Map())[0] ?? null;
}

/**
 * Worker slots a task could use at once: every slot, busy or free, of the profiles that may take its work and can
 * run now (signed in, not limited or offline, in scope, VM ready). The planner sizes a split to this rather than to
 * the slots free this minute: a plan outlives the minute, and workstreams past the free slots wait for one.
 */
export function slotCapacity(profiles: readonly ProfileView[], envs: ReadonlyMap<string, EnvironmentView>, projectId: string): number {
  return profiles.filter((p) => eligible({ ...p, activeLeases: 0 }, envs.get(p.envId), projectId)).reduce((n, p) => n + p.maxConcurrent, 0);
}

/** Worker slots free right now for `projectId`: the free slots of every profile that could take a lease. */
export function freeSlots(profiles: readonly ProfileView[], envs: ReadonlyMap<string, EnvironmentView>, projectId: string): number {
  return profiles.filter((p) => eligible(p, envs.get(p.envId), projectId)).reduce((n, p) => n + Math.max(0, p.maxConcurrent - p.activeLeases), 0);
}

/** Profiles that can run a planner call, best first. Only Claude and Codex have a headless JSON mode we parse. */
export function plannerCandidates(
  profiles: readonly ProfileView[],
  envs: ReadonlyMap<string, EnvironmentView>,
  projectId: string,
  pins: readonly string[] = [],
): ProfileView[] {
  const headless = profiles.filter((p) => p.cli === "claude" || p.cli === "codex");
  return rank(headless, envs, projectId, { pins }, new Map(), new Map());
}
