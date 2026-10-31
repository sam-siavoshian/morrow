// Planning flow: hold a ready profile's slot, run its CLI headless on its VM as that engineer, validate and
// reshape the answer, record the plan. Anything that goes wrong records the deterministic fallback plan with
// the reason, so a task never sits in `planning`. A usage limit or expired login seen in the planner call
// updates the profile, exactly as it would for a worker.
import { MAX_TASK_WORKSTREAMS, type ProfileView } from "@morrow/contracts";
import { classify, cooldownUntil } from "../classifier.ts";
import { findProject, memberGithubToken, teamEnvironments, vmTarget, type Ctx } from "../context.ts";
import { digest, newKey } from "../names.ts";
import { freeSlots, placementPool, plannerCandidates, slotCapacity } from "../scoring.ts";
import { isCompare } from "../compare.ts";
import type { TaskRecord } from "../workforce.ts";
import { repoContext } from "./context.ts";
import { parsePlannerRun } from "./parse.ts";
import { plannerPrompt, type PreviousPlan } from "./prompt.ts";
import { addPartners, cleanLine, cleanText, crewTarget, fallbackPlan, shapePlan, type PlannerPlan, type PlanTask } from "./shape.ts";

export interface PlanRequest {
  teamId: string;
  taskId: string;
  /** Plan at most this many workstreams ("Start with fewer agents"); never above the task's own cap. Omitted, the planner decides. */
  maxAgents?: number;
  /** The user's feedback on the current plan. Untrusted: it only ever reaches the planner as fenced prompt data. */
  feedback?: string;
}

export type PlanOutcome = "cli" | "fallback" | "skipped";

const MAX_PROFILE_TRIES = 3;
const MAX_PROMPT_BYTES = 44_000;
const MAX_FEEDBACK_CHARS = 4_000;

export async function planTask(ctx: Ctx, req: PlanRequest): Promise<PlanOutcome> {
  const { teamId, taskId } = req;
  const log = ctx.log.child({ teamId, taskId, op: "plan" });
  const task = await ctx.wf.getTask(teamId, taskId);
  // A compare task's plan is one attempt per harness, recorded at create; the planner never touches it.
  if (!task || isCompare(task)) return "skipped";
  const planTaskInput: PlanTask = { id: task.id, title: task.title, prompt: task.prompt, acceptance: task.acceptance };
  const feedback = req.feedback ? cleanText(req.feedback, MAX_FEEDBACK_CHARS) || undefined : undefined;
  const revision = feedback ? { feedback, previous: previousPlan(task) } : undefined;
  const fallback = (reason: string) => fallbackPlan(planTaskInput, reason, feedback);

  // Filled in once the pool is known: how many workers the task should start with so its agents have peers.
  let crew = 1;
  const record = async (shaped: PlannerPlan): Promise<PlanOutcome> => {
    // A single-topic task still gets a review (and research) partner when slots are free: agents talk to peers.
    const staffed = addPartners(shaped, task.id, crew);
    if (staffed !== shaped) log.info("partners added", { from: shaped.workstreams.length, to: staffed.workstreams.length });
    const plan: PlannerPlan = feedback ? { ...staffed, feedback } : staffed;
    const result = await ctx.wf.recordPlan(teamId, taskId, plan, newKey("rp"));
    if (!result.ok) {
      log.warn("plan not recorded", { reason: result.reason, source: plan.source });
      return "skipped";
    }
    log.info("plan recorded", { source: plan.source, workstreams: plan.workstreams.length, generation: result.generation });
    return plan.source;
  };

  const project = await findProject(ctx, teamId, task.projectId);
  const view = await ctx.wf.getView(teamId);
  const envs = await teamEnvironments(ctx, teamId);
  // A planner call spends a profile's plan too: a manual task plans only on its pins (the actor holds it to that).
  const pool = placementPool(Object.values(view.profiles), task);
  const candidates = project && ctx.ports.vm.enabled() ? plannerCandidates(pool, envs, project.id, task.pins) : [];
  // As many workstreams as the work needs, up to the worker slots that could take them and the hard ceiling. The
  // team policy caps workers at once, not the plan: workstreams past it wait for a slot. Never above the task's
  // own cap (tasks stored before this was the ceiling keep theirs) or a "fewer agents" request.
  const maxAgents = Math.max(1, Math.min(MAX_TASK_WORKSTREAMS, slotCapacity(pool, envs, task.projectId), task.maxAgents, req.maxAgents ?? task.maxAgents));
  // Slots free now, not the capacity: partners only get added when they can start alongside the work.
  crew = ctx.partners === false ? 1 : crewTarget(project ? freeSlots(pool, envs, project.id) : 0, maxAgents);

  let held: ProfileView | null = null;
  for (const profile of candidates.slice(0, MAX_PROFILE_TRIES)) {
    const begun = await ctx.wf.beginPlanning(teamId, taskId, profile.id, newKey("bp"));
    if (begun.ok) {
      held = profile;
      break;
    }
    if (begun.reason === "unknown_task" || begun.reason === "task_not_plannable") {
      log.info("task is not plannable", { reason: begun.reason });
      return "skipped";
    }
  }

  if (!held) {
    const begun = await ctx.wf.beginPlanning(teamId, taskId, null, newKey("bp"));
    if (!begun.ok) {
      log.info("task is not plannable", { reason: begun.reason });
      return "skipped";
    }
    const reason = !project
      ? "the project is no longer linked"
      : !ctx.ports.vm.enabled()
        ? "Freestyle is not configured"
        : candidates.length > 0
          ? "every planner profile was busy"
          : task.mode === "manual"
            ? "none of the picked profiles is a ready Claude or Codex profile"
            : "no ready Claude or Codex profile";
    return record(fallback(reason));
  }

  let plan: PlannerPlan;
  try {
    plan = await runCliPlanner(ctx, { teamId, task, profile: held, planTaskInput, maxAgents, project: project!, revision, fallback });
  } catch (error) {
    log.warn("planner call failed", { error, profileId: held.id });
    plan = fallback("the planner call failed");
  }
  return record(plan);
}

interface CliPlanRun {
  teamId: string;
  task: TaskRecord;
  profile: ProfileView;
  planTaskInput: PlanTask;
  maxAgents: number;
  project: { repoFullName: string; defaultBranch: string };
  revision: { feedback: string; previous: PreviousPlan | null } | undefined;
  fallback: (reason: string) => PlannerPlan;
}

/** The plan the user is giving feedback on, with dependencies named by role as the planner wrote them. */
function previousPlan(task: TaskRecord): PreviousPlan | null {
  if (!task.plan || task.workstreams.length === 0) return null;
  const roleOf = new Map(task.workstreams.map((ws) => [ws.id, ws.role]));
  return {
    rationale: task.plan.rationale,
    workstreams: task.workstreams.map((ws) => ({
      role: ws.role,
      title: ws.title,
      brief: ws.brief,
      ownership: ws.ownership,
      dependsOn: ws.dependsOn.map((id) => roleOf.get(id) ?? id),
    })),
  };
}

async function runCliPlanner(ctx: Ctx, run: CliPlanRun): Promise<PlannerPlan> {
  const { teamId, task, profile, planTaskInput, maxAgents, project, revision, fallback } = run;
  const cli = profile.cli === "codex" ? "codex" : "claude";
  const vm = await vmTarget(ctx, teamId, profile.envId);
  if (!vm.ok) return fallback(vm.reason);

  // Backend-side GitHub reads for the prompt; the token itself never goes to the VM.
  const token = (await memberGithubToken(ctx, task.createdBy)) ?? (await memberGithubToken(ctx, profile.ownerUserId));
  const context = await repoContext(ctx.ports.git, token, project.repoFullName, project.defaultBranch, ctx.log);
  const promptFor = (repo: typeof context) =>
    plannerPrompt({
      task: planTaskInput,
      repoFullName: project.repoFullName,
      defaultBranch: project.defaultBranch,
      maxWorkstreams: maxAgents,
      context: repo,
      revision,
    });
  // The prompt rides base64 in one VM env value (64 KB): drop repo context first, then give up.
  let prompt = promptFor(context);
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) prompt = promptFor({ paths: [], partial: true, readme: null });
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) return fallback("the task is too long for the planner");
  const result = await ctx.ports.vm.runPlanner({ ...vm.target, cli, prompt, timeoutMs: ctx.timing.plannerTimeoutMs });
  const parsed = parsePlannerRun(cli, result);
  if (parsed.ok) return shapePlan(planTaskInput, parsed.output, { maxAgents, source: "cli", profileId: profile.id });

  const now = ctx.now();
  const signal = classify(parsed.text, now);
  if (signal.kind === "usage_limit") {
    const eventId = `lim-plan-${task.id}-${digest(`${profile.id}|${now}|${signal.match}`)}`;
    await ctx.wf.markProfileLimited(teamId, profile.id, cooldownUntil(signal, now), cleanLine(signal.match, 300) || "Usage limit", "detected", eventId);
    return fallback("the planner hit a usage limit");
  }
  if (signal.kind === "auth_required") {
    await ctx.wf.updateProfileHealth(teamId, profile.id, { auth: "auth_required", online: true, observedAt: now }, `auth-plan-${task.id}-${digest(`${profile.id}|${now}`)}`);
    return fallback("the planner CLI needs a login");
  }
  return fallback(parsed.detail);
}
