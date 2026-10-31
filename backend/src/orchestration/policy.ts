// The team policy's per-task worker cap: workers one task runs at once, applied at start and on every scheduling
// pass (and to a compare at create, whose attempts all run at once). It never shrinks a plan: workstreams past it wait.
import type { TaskView } from "@morrow/contracts";
import type { Ctx } from "./context.ts";

/**
 * The team's `policy.maxParallelPerTask`: how many workers one task may run at once. Read live on every
 * decision, so a policy change applies to the next start or scheduling pass. 1 when the team is gone.
 */
export async function parallelCap(ctx: Pick<Ctx, "teams">, teamId: string): Promise<number> {
  const team = await ctx.teams.getTeam(teamId);
  return team?.policy.maxParallelPerTask ?? 1;
}

/** Workstreams that hold a worker slot: running, or waiting for a replacement worker after a handoff. */
export function busyWorkstreams(task: Pick<TaskView, "workstreams">): number {
  return task.workstreams.filter((ws) => ws.status === "active" || ws.status === "handoff").length;
}
