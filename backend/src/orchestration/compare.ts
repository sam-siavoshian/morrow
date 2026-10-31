// Compare tasks (docs/multi-harness.md): every picked harness attempts the whole task on its own branch, at the same
// time, and a person picks the attempt to ship. The plan is made here, without a planner call: there is nothing to
// split, and it saves a run on a teammate's subscription. The actor enforces the rest (one harness per attempt, a
// profile of that CLI only, the pick).
import { CLI_LABEL, type CliKind, type TaskStrategy } from "@morrow/contracts";
import { isResolver, workstreamBranch } from "./names.ts";
import { cleanLine, cleanText, type PlanTask } from "./planner/shape.ts";
import type { PlanInput, TaskRecord } from "./workforce.ts";

const LIMITS = { title: 120, brief: 12_000 };

type Strategic = Pick<TaskRecord, "strategy">;

/** Tasks stored before strategies existed are split. */
export const strategyOf = (task: Strategic): TaskStrategy => task.strategy ?? "split";
export const isCompare = (task: Strategic): boolean => strategyOf(task) === "compare";

/** The id of a compare attempt: one per harness, so the harness names it. */
export const attemptId = (cli: CliKind): string => `ws-${cli}`;

/** One attempt per harness, each owning the whole change on its own branch. */
export function comparePlan(task: PlanTask, harnesses: readonly CliKind[]): PlanInput {
  const acceptance = task.acceptance.length > 0 ? `\n\nAcceptance criteria:\n${task.acceptance.map((a) => `- ${a}`).join("\n")}` : "";
  const brief = cleanText(`${task.prompt}${acceptance}`, LIMITS.brief);
  const names = harnesses.map((cli) => CLI_LABEL[cli]).join(", ");
  return {
    source: "compare",
    profileId: null,
    rationale: `Compare: ${names} each attempt the whole task on their own branch at the same time. When they finish, pick the attempt to ship, or finish without shipping for a review.`,
    warnings: [],
    workstreams: harnesses.map((cli) => ({
      id: attemptId(cli),
      role: cli,
      title: cleanLine(`${CLI_LABEL[cli]} attempt: ${task.title}`, LIMITS.title),
      brief,
      why: `${CLI_LABEL[cli]} attempts the whole task on its own branch, independently of the others.`,
      branch: workstreamBranch(task.id, cli),
      dependsOn: [],
      ownership: ["**"],
      harness: cli,
    })),
  };
}

/**
 * The workstreams verification checks: every one for a split task; for a compare task only the picked attempt and a
 * conflict resolver. Never the attempts that were not picked. Empty for a compare task with no pick (it never
 * reaches verification without one).
 */
export function shippedWorkstreams<W extends { id: string; role: string }>(task: Strategic & Pick<TaskRecord, "pickedWorkstreamId"> & { workstreams: W[] }): W[] {
  if (!isCompare(task)) return task.workstreams;
  if (!task.pickedWorkstreamId) return [];
  return task.workstreams.filter((ws) => ws.id === task.pickedWorkstreamId || isResolver(ws));
}

/** Which harness each bound workstream needs (compare attempts); split workstreams are absent. */
export function harnessOf(task: { workstreams: readonly { id: string; harness?: CliKind }[] }): Map<string, CliKind> {
  return new Map(task.workstreams.flatMap((ws) => (ws.harness ? [[ws.id, ws.harness] as const] : [])));
}
