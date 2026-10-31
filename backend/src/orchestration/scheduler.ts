// The reconcile pass, per team, at boot and every 15 s: let the actor sweep its deadlines, then move every
// started task forward. Workstreams whose dependencies are done get a worker; stopped workers get a
// replacement (handoff); finished tasks get verified. All decisions re-read the actor first, and the actor
// rejects anything stale (a live lease on the workstream, an old epoch), so two processes cannot double-book.
import type { ProfileView, TaskDetail, TaskView } from "@morrow/contracts";
import { harnessOf } from "./compare.ts";
import { teamEnvironments, type Ctx } from "./context.ts";
import { isResolver, newKey } from "./names.ts";
import { busyWorkstreams, parallelCap } from "./policy.ts";
import { choosePicks, chooseReplacement, placementPool, taskCliUse } from "./scoring.ts";
import type { Verifier } from "./verifier.ts";
import type { TaskRecord, WorkforceSnapshot } from "./workforce.ts";

/** Workers that never started, per workstream, before auto-scheduling stops and a human has to step in. */
export const MAX_FAILED_STARTS = 3;
/** Workers that stopped mid-work (limits, crashes), per workstream, before handoffs stop. */
export const MAX_HANDOFFS = 8;

const LIVE = new Set(["reserved", "spawning", "running"]);
const STARTED = new Set(["planned", "starting", "running", "handoff", "resolving"]);

export interface PassResult {
  reserved: number;
  handoffs: number;
  verifying: number;
  /** Non-terminal tasks or live leases: the team still needs watching. */
  busy: boolean;
}

/**
 * For a conflict resolver: the profiles that last worked on the workstreams on either side of the conflict (its
 * `dependsOn`), so a worker that already knows one side gets it when it has a free slot. Empty otherwise.
 */
export function resolverPins(task: Pick<TaskDetail, "workstreams">, view: Pick<WorkforceSnapshot, "leases">): string[] {
  const resolver = task.workstreams.find((w) => isResolver(w) && w.status === "pending");
  if (!resolver) return [];
  const sides = task.workstreams.filter((w) => resolver.dependsOn.includes(w.id) && w.leaseId);
  return [...new Set(sides.flatMap((w) => view.leases[w.leaseId!]?.profileId ?? []))];
}

export class Scheduler {
  readonly #ctx: Ctx;
  readonly #verifier: Verifier;

  constructor(ctx: Ctx, verifier: Verifier) {
    this.#ctx = ctx;
    this.#verifier = verifier;
  }

  /**
   * `sweep: false` skips asking the actor to sweep its deadlines first. The actor's own alarm sweeps them; the ask is
   * a safety net (local dev loses alarms on restart), so with a pushed view it runs on a slow period only.
   */
  async pass(teamId: string, options: { sweep?: boolean } = {}): Promise<PassResult> {
    const ctx = this.#ctx;
    if (options.sweep !== false) {
      await ctx.wf.reconcile(teamId, ctx.now());
      ctx.memory.team(teamId).sweptAt = ctx.now();
    }
    const view = await ctx.wf.getView(teamId);
    const memory = ctx.memory.team(teamId);
    memory.view = view;
    const result: PassResult = { reserved: 0, handoffs: 0, verifying: 0, busy: Object.values(view.leases).some((l) => LIVE.has(l.state)) };

    const open = Object.values(view.tasks).filter((t) => !["completed", "failed", "cancelled"].includes(t.status));
    if (open.length > 0) result.busy = true;
    const openIds = new Set(open.map((t) => t.id));
    for (const key of memory.waitNoted.keys()) if (!openIds.has(key.slice(0, key.indexOf("/")))) memory.waitNoted.delete(key);
    const started = open.filter((t) => STARTED.has(t.status) && Object.values(view.leases).some((l) => l.taskId === t.id));
    if (started.length > 0) {
      const envs = await teamEnvironments(ctx, teamId);
      const cap = await parallelCap(ctx, teamId);
      for (const task of started) {
        result.handoffs += await this.#handoffs(teamId, task, view, envs);
        result.reserved += await this.#reserveReady(teamId, task, view, envs, cap);
      }
    }
    for (const task of open) {
      if (task.status !== "verifying") continue;
      result.verifying++;
      this.#verifier.maybeRun(teamId, task.id);
    }
    return result;
  }

  /** Ended leases of one workstream since the task's last retry (a retry gives every workstream a fresh budget). */
  #endedLeases(view: WorkforceSnapshot, task: TaskView, workstreamId: string, state: "failed" | "expired"): number {
    // The view carries only the trace's tail; `retriedAt` is read from the whole stored trace. Views written
    // before it existed carry the whole trace instead.
    const since = (task.retriedAt === undefined ? task.trace.findLast((e) => e.kind === "task.retried")?.at : task.retriedAt) ?? 0;
    return Object.values(view.leases).filter(
      // A subagent shares its parent's workstream but never counts as one of its workers (docs/subagents.md).
      (l) => l.taskId === task.id && l.workstreamId === workstreamId && !l.parentLeaseId && l.state === state && l.createdAt >= since,
    ).length;
  }

  #giveUp(teamId: string, task: TaskView, workstreamId: string, why: string): void {
    const memory = this.#ctx.memory.team(teamId);
    const key = `${task.id}/${workstreamId}`;
    if (memory.gaveUp.has(key)) return;
    memory.gaveUp.add(key);
    this.#ctx.log.warn("auto-scheduling stopped for workstream", { teamId, taskId: task.id, workstreamId, why });
  }

  /**
   * A manual task's workstream has no free pinned profile: the actor notes it in the trace in plain words (once per
   * wait). It never falls back to an unpinned profile. Best effort: a failed note is retried on the next pass.
   */
  async #noteWaiting(teamId: string, task: Pick<TaskRecord, "id" | "pins" | "workstreams">, workstreamId: string, view: WorkforceSnapshot): Promise<void> {
    const memory = this.#ctx.memory.team(teamId);
    const key = `${task.id}/${workstreamId}`;
    // A new worker since, or the pins all gone, is a new wait; the same one is not asked for again.
    const leaseId = task.workstreams.find((w) => w.id === workstreamId)?.leaseId ?? "";
    const signature = `${leaseId}|${task.pins.some((id) => view.profiles[id]) ? "busy" : "gone"}`;
    if (memory.waitNoted.get(key) === signature) return;
    try {
      const noted = await this.#ctx.wf.noteWaiting(teamId, task.id, workstreamId, "no_pinned_profile");
      if (noted.ok) memory.waitNoted.set(key, signature);
      if (noted.ok && noted.noted) this.#ctx.log.info("waiting for a pinned profile", { teamId, taskId: task.id, workstreamId });
    } catch (error) {
      this.#ctx.log.warn("could not note a wait for a pinned profile", { teamId, taskId: task.id, workstreamId, error });
    }
  }

  /**
   * Pending workstreams with every dependency done get a worker, up to the policy's per-task cap (workstreams in
   * handoff keep their slot). One all-or-nothing reservation per task for the ones a free profile can take; the rest
   * wait for the next pass. A manual task only ever offers its pinned profiles, and says so when none is free.
   */
  async #reserveReady(teamId: string, task: TaskView, view: WorkforceSnapshot, envs: Awaited<ReturnType<typeof teamEnvironments>>, cap: number): Promise<number> {
    const budget = cap - busyWorkstreams(task);
    if (budget <= 0 || !task.workstreams.some((w) => w.status === "pending")) return 0;
    // The live view leaves out dependencies and roles: read them from the stored task.
    const full = await this.#ctx.wf.getTask(teamId, task.id);
    if (!full) return 0;
    const done = new Set(full.workstreams.filter((w) => w.status === "done").map((w) => w.id));
    const ready = full.workstreams
      .filter((ws) => {
        if (ws.status !== "pending" || !ws.dependsOn.every((d) => done.has(d))) return false;
        if (this.#endedLeases(view, task, ws.id, "failed") < MAX_FAILED_STARTS) return true;
        this.#giveUp(teamId, task, ws.id, `${MAX_FAILED_STARTS} workers failed to start`);
        return false;
      })
      .slice(0, budget);
    if (ready.length === 0) return 0;
    const picks = choosePicks(
      ready.map((w) => w.id),
      placementPool(Object.values(view.profiles), full),
      envs,
      task.projectId,
      { pins: [...new Set([...resolverPins(full, view), ...full.pins])], harnessOf: harnessOf(full), cliUse: taskCliUse(view, task.id) },
      { partial: true },
    );
    if (full.mode === "manual") {
      const placed = new Set(picks?.map((p) => p.workstreamId));
      for (const ws of ready) if (!placed.has(ws.id)) await this.#noteWaiting(teamId, full, ws.id, view);
    }
    if (!picks) return 0;
    const reserved = await this.#ctx.wf.reserveWorkers(teamId, task.id, picks, newKey("rw"));
    if (!reserved.ok) {
      this.#ctx.log.info("auto-reserve rejected", { teamId, taskId: task.id, picks: reserved.picks.map((p) => p.reason) });
      return 0;
    }
    return reserved.leases.length;
  }

  /** Workstreams in handoff whose worker is gone get the best replacement profile (a pinned one in a manual task). */
  async #handoffs(teamId: string, task: TaskView, view: WorkforceSnapshot, envs: Awaited<ReturnType<typeof teamEnvironments>>): Promise<number> {
    let count = 0;
    const profiles = Object.values(view.profiles);
    const booked = new Map<string, number>();
    // The live view leaves out the mode and pins: read them from the stored task, once, only when a handoff is due.
    let stored: TaskRecord | null | undefined;
    for (const ws of task.workstreams) {
      if (ws.status !== "handoff" || !ws.leaseId) continue;
      const from = view.leases[ws.leaseId];
      if (!from || LIVE.has(from.state)) continue;
      if (this.#endedLeases(view, task, ws.id, "expired") >= MAX_HANDOFFS || this.#endedLeases(view, task, ws.id, "failed") >= MAX_FAILED_STARTS) {
        this.#giveUp(teamId, task, ws.id, "too many workers stopped on this workstream");
        continue;
      }
      stored ??= await this.#ctx.wf.getTask(teamId, task.id);
      if (!stored) return count;
      const manual = stored.mode === "manual";
      // Count replacements booked earlier in this pass, so two handoffs do not pile onto one free slot.
      const adjusted: ProfileView[] = placementPool(profiles, stored).map((p) => ({ ...p, activeLeases: p.activeLeases + (booked.get(p.id) ?? 0) }));
      // A compare attempt is replaced only by the same harness: anything else would turn it into a second run of
      // another attempt's CLI. With none free it waits in handoff while the other attempts keep going. A manual task
      // may go back to the same pinned profile (its only pin, after a cooldown) rather than wait for good.
      const to = chooseReplacement(view.profiles[from.profileId], adjusted, envs, task.projectId, ws.harness ?? null, manual);
      if (!to) {
        if (manual) await this.#noteWaiting(teamId, stored, ws.id, view);
        continue;
      }
      const result = await this.#ctx.wf.requestHandoff(teamId, task.id, ws.id, from.epoch, to.id, newKey("ho"));
      if (result.ok) {
        count++;
        booked.set(to.id, (booked.get(to.id) ?? 0) + 1);
        this.#ctx.log.info("handoff requested", { teamId, taskId: task.id, workstreamId: ws.id, from: from.id, to: result.lease.id });
      } else {
        this.#ctx.log.info("handoff rejected", { teamId, taskId: task.id, workstreamId: ws.id, reason: result.reason });
      }
    }
    return count;
  }
}
