// Task operations behind the HTTP routes. Authorization (team membership, roles) happens in the route; this
// layer validates against actor state and turns actor rejections into browser-safe errors.
import type {
  ArtifactsView,
  CancelTaskResponse,
  CreateTaskBody,
  DeleteTaskResponse,
  PickAttemptBody,
  PickAttemptResponse,
  ProfileView,
  RelayMessageView,
  ReplanBody,
  RetryTaskResponse,
  Role,
  StartTaskBody,
  StartTaskResponse,
  TaskMessageBody,
  TaskMessageResponse,
  TaskMessageTarget,
  WorkforceMode,
} from "@morrow/contracts";
import { CLI_LABEL, MAX_TASK_WORKSTREAMS, TaskDetail } from "@morrow/contracts";
import { humanAgentName, MAX_MESSAGE_TEXT_BYTES } from "../integrations/relay/index.ts";
import { badRequest, conflict, dependencyUnavailable, featureDisabled, forbidden, notFound } from "../lib/errors.ts";
import { addedBrief, addedTitle } from "./addAgent.ts";
import { utf8Bytes } from "./brief.ts";
import { comparePlan, harnessOf, isCompare } from "./compare.ts";
import { findProject, memberGithubToken, repoWebUrl, teamEnvironments, type Ctx } from "./context.ts";
import { dispatcherSpeaker } from "./ports.ts";
import { digest, integrationBranch, newKey, newTaskId } from "./names.ts";
import { planTask } from "./planner/index.ts";
import { cleanLine } from "./planner/shape.ts";
import { busyWorkstreams, parallelCap } from "./policy.ts";
import { choosePicks, placementPool, taskCliUse } from "./scoring.ts";
import type { PlanInput, TaskRecord, WorkforceResult } from "./workforce.ts";

const LIVE = new Set(["reserved", "spawning", "running"]);
// Matches the contract (4000 chars) in bytes, so multi-byte text cannot push the planner prompt past its budget.
const MAX_FEEDBACK_BYTES = 4096;
const PICK_REASONS: Record<string, string> = {
  profile_limited: "is cooling down after a usage limit",
  profile_offline: "is offline",
  profile_auth_required: "needs its CLI logged in again",
  out_of_scope: "is not allowed on this project",
  over_capacity: "has no free slot",
  wrong_harness: "runs a different CLI than that attempt",
  not_pinned: "is not one of the profiles picked for this task",
  unknown_profile: "does not exist",
  unknown_workstream: "is not part of this plan",
  duplicate_workstream: "was picked twice",
  workstream_not_pending: "is not waiting for a worker",
  already_leased: "already has a worker",
  task_not_startable: "cannot start in its current state",
  unknown_task: "does not exist",
};
const NO_PINS = "Manual needs at least one picked profile. Pick one, or switch to Auto.";
/** Why the actor refused a task's mode and pins, for the person who chose them. */
const WORKFORCE_REFUSALS = {
  no_pins: () => badRequest(NO_PINS),
  unknown_pin: () => badRequest("A picked profile is no longer part of this team. Pick your profiles again."),
  harness_not_pinned: () => badRequest("None of the picked profiles runs one of this compare's harnesses. Pick a profile for each harness, or switch to Auto."),
  task_started: () => conflict("This task has already started, so its profiles can no longer change."),
  unknown_task: () => notFound("Task not found."),
} as const;
/** Why a worker could not be added, past the profile's own reasons (`PICK_REASONS`). */
const ADD_REFUSALS = {
  not_split: "A compare task runs one attempt per harness, so it can't take another agent. Start a new task instead.",
  task_not_running: "Agents can only be added while the task is running.",
  too_many_workstreams: "This task already has as many workstreams as one task can hold.",
} as const;
const PICK_REFUSALS = {
  not_compare: () => conflict("Only a compare task has attempts to pick."),
  task_terminal: () => conflict("This task has already finished."),
  already_picked: () => conflict("An attempt was already picked."),
  unknown_workstream: () => notFound("That attempt is not part of this task."),
  attempt_not_done: () => conflict("That attempt has not finished yet."),
  nothing_finished: () => conflict("No attempt has finished yet. Cancel the task to stop them all."),
  unknown_task: () => notFound("Task not found."),
} as const;

export interface Hooks {
  /** Something new is in the outbox: dispatch soon. */
  onWork(teamId: string): void;
  /** Run planning in the background (bounded, single-flight per task). */
  plan(teamId: string, taskId: string, run: () => Promise<void>): boolean;
  /** Run verification for a verifying task now instead of on the next scheduling pass. */
  verify(teamId: string, taskId: string): void;
  /**
   * Records in the team directory that the team has work, before the work exists, so a restart finds it. Best effort:
   * it never throws, and a team it missed is noted on its next scheduling pass.
   */
  noteWork?(teamId: string): Promise<void>;
}

export class TaskService {
  readonly #ctx: Ctx;
  readonly #hooks: Hooks;

  constructor(ctx: Ctx, hooks: Hooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  async #task(teamId: string, taskId: string): Promise<TaskRecord> {
    const task = await this.#ctx.wf.getTask(teamId, taskId);
    if (!task) throw notFound("Task not found.");
    return task;
  }

  /** The planner reads the task's stored mode and pins itself, so a re-plan sets them first. */
  #planInBackground(teamId: string, taskId: string, maxAgents: number | undefined, feedback?: string): boolean {
    const started = this.#hooks.plan(teamId, taskId, async () => {
      await planTask(this.#ctx, { teamId, taskId, maxAgents, feedback });
    });
    if (!started) this.#ctx.log.warn("planning not started: queue busy", { teamId, taskId });
    return started;
  }

  async create(teamId: string, userId: string, body: CreateTaskBody): Promise<{ taskId: string }> {
    const project = await findProject(this.#ctx, teamId, body.projectId);
    if (!project) throw notFound("Project not found.");
    const taskId = newTaskId();
    const cap = await parallelCap(this.#ctx, teamId);
    const compare = body.strategy === "compare";
    // Every compare attempt runs at once, so the team's per-task cap must fit all of them.
    if (compare && body.harnesses.length > cap)
      throw badRequest(`This team runs at most ${cap} ${cap === 1 ? "worker" : "workers"} per task. Pick ${cap === 1 ? "one harness" : `${cap} harnesses`} or fewer, or use Split.`);
    // Manual is a rule for the whole run (the actor holds every lease to the pins), so it needs a pin, and in a compare
    // a pin of each harness: an attempt no pinned profile can run would never start.
    if (body.mode === "manual" && body.pins.length === 0) throw badRequest(NO_PINS);
    if (compare && body.mode === "manual") {
      const view = await this.#ctx.wf.getView(teamId);
      const pinned = new Set(body.pins.flatMap((id) => view.profiles[id]?.cli ?? []));
      const missing = body.harnesses.filter((cli) => !pinned.has(cli)).map((cli) => CLI_LABEL[cli]);
      if (missing.length > 0)
        throw badRequest(
          missing.length === 1
            ? `None of the picked profiles runs ${missing[0]}. Pick a ${missing[0]} profile, drop it from the compare, or switch to Auto.`
            : `None of the picked profiles runs ${missing.join(" or ")}. Pick a profile for each, drop them from the compare, or switch to Auto.`,
        );
    }
    // A compare is one attempt per harness. A split gets as many workstreams as the planner finds the work needs,
    // up to the hard ceiling; the planner also bounds it by the team's worker slots. `body.maxAgents` is ignored.
    const maxAgents = compare ? body.harnesses.length : MAX_TASK_WORKSTREAMS;
    const title = cleanLine(body.title ?? body.prompt.split("\n", 1)[0] ?? "", 120) || "Untitled task";
    await this.#hooks.noteWork?.(teamId);
    const created = await this.#ctx.wf.createTask(
      teamId,
      {
        id: taskId,
        projectId: project.id,
        title,
        prompt: body.prompt,
        acceptance: body.acceptance,
        createdBy: userId,
        maxAgents,
        strategy: body.strategy,
        mode: body.mode,
        pins: body.pins,
      },
      newKey("ct"),
    );
    if (!created.ok) {
      if (created.reason === "too_many_active_tasks") throw conflict("This team has too many active tasks.");
      if (created.reason === "task_exists") throw conflict("That task already exists.");
      throw WORKFORCE_REFUSALS[created.reason]();
    }
    this.#ctx.runtime.touchTeam(teamId);
    if (compare) {
      // Nothing to split: the plan is one attempt per harness, recorded now, with no planner run.
      const plan = comparePlan({ id: taskId, title, prompt: body.prompt, acceptance: body.acceptance }, body.harnesses);
      await this.#recordComparePlan(teamId, taskId, userId, plan);
    } else this.#planInBackground(teamId, taskId, undefined);
    return { taskId };
  }

  /**
   * Sets a task's mode and pins before it starts. The actor refuses once a worker was placed, so a running manual task
   * can never be widened, however the request was made.
   */
  async #setWorkforce(teamId: string, task: TaskRecord, mode: WorkforceMode, pins: readonly string[]): Promise<void> {
    const result: WorkforceResult<"setTaskWorkforce"> = await this.#ctx.wf.setTaskWorkforce(teamId, task.id, mode, [...pins], newKey("tw"));
    if (!result.ok) throw WORKFORCE_REFUSALS[result.reason]();
  }

  async replan(teamId: string, taskId: string, body: ReplanBody): Promise<{ taskId: string }> {
    if (body.feedback !== undefined && utf8Bytes(body.feedback) > MAX_FEEDBACK_BYTES) throw badRequest("Feedback is too long. Keep it under 4 KB.");
    const task = await this.#task(teamId, taskId);
    if (isCompare(task)) throw conflict("A compare task has no plan to refine. Start a new task to change it.");
    if (task.status === "planning") throw conflict("This task is being planned. Wait for the plan, then try again.");
    if (task.status !== "draft" && task.status !== "planned") throw conflict("Only a task that has not started can be planned again.");
    await this.#setWorkforce(teamId, task, body.mode ?? task.mode, body.pins);
    if (!this.#planInBackground(teamId, taskId, body.maxAgents, body.feedback))
      throw conflict("This task is already being planned, or the planner is busy. Try again in a moment.");
    return { taskId };
  }

  async start(teamId: string, taskId: string, body: StartTaskBody): Promise<StartTaskResponse> {
    const ctx = this.#ctx;
    let task = await this.#task(teamId, taskId);
    if (task.status !== "planned" || task.workstreams.length === 0) throw conflict("This task is not ready to start.");
    if (body.picks?.length === 0) throw badRequest("Pick at least one workstream.");
    if (body.mode !== undefined || body.pins !== undefined) {
      const mode = body.mode ?? task.mode;
      const pins = body.pins ?? task.pins;
      if (mode === "manual" && pins.length === 0) throw badRequest(NO_PINS);
      await this.#setWorkforce(teamId, task, mode, pins);
      task = { ...task, mode, pins: [...new Set(pins)] };
    }
    // The policy may have dropped since planning: start at most `cap` workers; the scheduler adds the rest as slots free up.
    const cap = await parallelCap(ctx, teamId);
    const budget = cap - busyWorkstreams(task);
    if (budget <= 0) throw conflict(`This task already runs ${cap} ${cap === 1 ? "worker" : "workers"}, the most this team allows.`);
    let picks = body.picks;
    if (picks && picks.length > budget) throw badRequest(`This team runs at most ${cap} ${cap === 1 ? "worker" : "workers"} per task. Pick fewer workstreams.`);
    if (!picks) {
      // Roots first; dependent workstreams get a worker when their dependencies are done. A split starts with the
      // roots that have a free slot now and the scheduler places the rest as slots free up; a compare starts every
      // attempt at once or none.
      const roots = task.workstreams.filter((w) => w.status === "pending" && w.dependsOn.length === 0).map((w) => w.id).slice(0, budget);
      const view = await ctx.wf.getView(teamId);
      const profiles = placementPool(Object.values(view.profiles), task);
      const envs = await teamEnvironments(ctx, teamId);
      const harnesses = harnessOf(task);
      const manual = task.mode === "manual";
      picks = choosePicks(roots, profiles, envs, task.projectId, { pins: task.pins, harnessOf: harnesses, cliUse: taskCliUse(view, task.id) }, { partial: !isCompare(task) }) ?? undefined;
      if (!picks) {
        if (!isCompare(task))
          throw conflict(
            manual
              ? "None of the picked profiles has a free slot for this task. Wait for one to free up, or pick more profiles."
              : "No ready CLI profile has a free slot for this task. Connect one or wait for a cooldown to end.",
          );
        // Name the harnesses that have no free profile, so the person knows what to connect or drop.
        const missing = roots.filter((id) => !choosePicks([id], profiles, envs, task.projectId, { harnessOf: harnesses })).flatMap((id) => {
          const cli = harnesses.get(id);
          return cli ? [CLI_LABEL[cli]] : [];
        });
        throw conflict(
          missing.length > 0
            ? manual
              ? `None of the picked ${missing.join(" or ")} profiles has a free slot. Wait for one to free up, or pick another.`
              : `No ready ${missing.join(" or ")} profile has a free slot. Connect one, wait for one to free up, or start a new task without ${missing.length === 1 ? "it" : "them"}.`
            : "Not every picked harness has a ready profile with a free slot. Wait for one to free up, or start a new task with fewer harnesses.",
        );
      }
    }
    const result = await ctx.wf.reserveWorkers(teamId, taskId, picks, newKey("rw"));
    if (!result.ok) {
      const why = result.picks
        .filter((p) => !p.ok)
        .map((p) => (p.reason === "unknown_workstream" || p.reason === "workstream_not_pending" || p.reason === "duplicate_workstream" || p.reason === "already_leased"
          ? `Workstream ${p.workstreamId} ${PICK_REASONS[p.reason]}`
          : `Profile ${p.profileId} ${PICK_REASONS[p.reason ?? ""] ?? "cannot take this work"}`))
        .join(". ");
      throw conflict(`Could not start: ${why}.`);
    }
    ctx.runtime.touchTeam(teamId);
    this.#hooks.onWork(teamId);
    return { leases: result.leases };
  }

  async message(teamId: string, taskId: string, userId: string, body: TaskMessageBody): Promise<TaskMessageResponse> {
    const ctx = this.#ctx;
    if (utf8Bytes(body.text) > MAX_MESSAGE_TEXT_BYTES) throw badRequest("That message is too long.");
    const task = await this.#task(teamId, taskId);
    const access = await ctx.runtime.relay(teamId);
    const speaker = access ? await ctx.runtime.speakerFor(teamId, userId) : null;
    if (!access || !speaker) throw featureDisabled("Messaging is not set up for this team yet.");
    const key = newKey("msg");
    if (body.to === "team") {
      const channel = await ctx.ports.relay.ensureChannel(access, task.projectId);
      return { message: await ctx.ports.relay.post(access, speaker, channel, body.text, key) };
    }
    if (typeof body.to !== "string" && body.to.kind !== "worker") {
      if (!body.key) throw badRequest("Adding an agent needs a request key.");
      return this.#addAgent(teamId, task, userId, body.to, body.text, body.key);
    }
    // Direct messages only reach this task's live workers, never arbitrary workspace names.
    const name = typeof body.to === "string" ? body.to : body.to.name;
    const view = await ctx.wf.getView(teamId);
    const worker = Object.values(view.leases).find((l) => l.taskId === task.id && l.agentName === name && LIVE.has(l.state));
    if (!worker) throw notFound("That worker is not running on this task.");
    return { message: await ctx.ports.relay.direct(access, speaker, worker.agentName, body.text, key) };
  }

  /**
   * Adds a worker to a running task from its @ menu, on one profile or on the best free profile of one VM, with the
   * message as its brief. Any member may, like a message: steering a live worker already spends a teammate's plan.
   * The actor decides everything that changes (the task's state, pins, scope, health, free slots, the team's and the
   * task's caps) in one transition and replays a retry with the same key, so the checks here are only the ones it
   * cannot make: the profile or VM is this team's, and the VM is set up.
   */
  async #addAgent(
    teamId: string,
    task: TaskRecord,
    userId: string,
    target: Exclude<TaskMessageTarget, { kind: "worker" }>,
    text: string,
    clientKey: string,
  ): Promise<TaskMessageResponse> {
    const ctx = this.#ctx;
    const [view, team] = await Promise.all([ctx.wf.getView(teamId), ctx.teams.getTeam(teamId)]);
    if (!team) throw notFound("Task not found.");
    const envs = new Map(team.environments.map((env) => [env.id, env]));
    let candidates: ProfileView[];
    let envName: string;
    if (target.kind === "profile") {
      const found = view.profiles[target.id];
      const env = found ? envs.get(found.envId) : undefined;
      // A profile whose VM the team no longer lists is as gone as an unknown one.
      if (!found || !env) throw notFound("That agent is not part of this team.");
      if (env.phase !== "ready") throw conflict(`${found.label} ${PICK_REASONS.profile_offline}: ${env.name} is not running.`);
      candidates = [found];
      envName = env.name;
    } else {
      const env = envs.get(target.id);
      if (!env) throw notFound("That VM is not part of this team.");
      if (env.phase !== "ready") throw conflict(`${env.name} is not running, so no agent there can take work.`);
      candidates = Object.values(view.profiles).filter((p) => p.envId === env.id);
      if (candidates.length === 0) throw conflict(`${env.name} has no agent set up yet.`);
      envName = env.name;
    }
    const cap = team.policy.maxParallelPerTask;
    const member = team.members.find((m) => m.userId === userId);
    const login = member?.login ?? "A teammate";
    const relayName = member ? humanAgentName(member.login) : "the person who added you";
    const result = await ctx.wf.addWorkstream(
      teamId,
      task.id,
      {
        profileIds: candidates.map((p) => p.id),
        title: addedTitle(text, login),
        brief: addedBrief(login, relayName, text),
        byUserId: userId,
        maxLive: cap,
      },
      // Scoped to the caller, so one member's key can never replay another's request.
      `aw-${digest(`${userId}:${clientKey}`, 32)}`,
    );
    if (!result.ok) {
      switch (result.reason) {
        case "unknown_task":
          throw notFound("Task not found.");
        case "not_split":
        case "task_not_running":
        case "too_many_workstreams":
          throw conflict(ADD_REFUSALS[result.reason]);
        case "task_at_capacity":
          throw conflict(`This task already runs ${cap} ${cap === 1 ? "agent" : "agents"}, its limit. Wait for one to finish, then add another.`);
        case "no_eligible_profile":
          throw conflict(
            `No agent on ${envName} can take this task's work right now. Each one is busy, offline, signed out${task.mode === "manual" ? ", cooling down or not picked for this task" : " or cooling down"}.`,
          );
        default:
          throw conflict(`${candidates[0]!.label} ${PICK_REASONS[result.reason] ?? "cannot take this work"}.`);
      }
    }
    ctx.runtime.touchTeam(teamId);
    this.#hooks.onWork(teamId);
    const profile = view.profiles[result.lease.profileId];
    ctx.log.info("agent added to task", { teamId, taskId: task.id, leaseId: result.lease.id, profileId: result.lease.profileId });
    const what = profile ? `${CLI_LABEL[profile.cli]} on ${envs.get(profile.envId)?.name ?? envName}` : envName;
    const notice = `${login} added ${result.lease.agentName} (${what}) to this task: "${cleanLine(text, 200)}"`;
    // Keyed by the lease, so a replayed request never posts it twice.
    const message = await this.#notice(teamId, task.projectId, notice, `add-${result.lease.id}`);
    return { message, lease: result.lease };
  }

  /**
   * A compare task: ship one finished attempt (the others stop, verification runs on it alone), or finish without
   * shipping. Same rule as cancel and retry (the creator, an owner or an admin): it stops teammates' workers and
   * decides what goes to the default branch.
   */
  /**
   * Records a compare plan right after create. No planner runs later, so a task left without its plan would sit in
   * `planning` for good: one retry with the same key (the actor replays it), then the task is cancelled and the
   * user is told to try again.
   */
  async #recordComparePlan(teamId: string, taskId: string, userId: string, plan: PlanInput): Promise<void> {
    const ctx = this.#ctx;
    const key = newKey("rp");
    let failure: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const recorded = await ctx.wf.recordPlan(teamId, taskId, plan, key);
        if (recorded.ok) return;
        failure = recorded.reason;
        break;
      } catch (error) {
        failure = error;
      }
    }
    ctx.log.error("compare plan not recorded; cancelling the task", { teamId, taskId, error: failure });
    await ctx.wf.cancelTask(teamId, taskId, userId, newKey("cx")).catch((error: unknown) => ctx.log.error("could not cancel a compare task without a plan", { teamId, taskId, error }));
    throw dependencyUnavailable("Could not start the compare task. Try again shortly.", failure);
  }

  async pick(teamId: string, taskId: string, userId: string, role: Role, body: PickAttemptBody): Promise<PickAttemptResponse> {
    const ctx = this.#ctx;
    const task = await this.#task(teamId, taskId);
    if (task.createdBy !== userId && role !== "owner" && role !== "admin") throw forbidden("Only the task's creator or a team admin can pick an attempt.");
    const result = await ctx.wf.pickAttempt(teamId, taskId, body.workstreamId, userId, newKey("pk"));
    if (!result.ok) throw PICK_REFUSALS[result.reason]();
    ctx.runtime.touchTeam(teamId);
    this.#hooks.onWork(teamId);
    if (result.status === "verifying") this.#hooks.verify(teamId, taskId);
    const picked = body.workstreamId ? task.workstreams.find((w) => w.id === body.workstreamId) : null;
    const stopped = result.releasedLeaseIds.length > 0 ? " The other attempts are stopped." : "";
    await this.#notice(
      teamId,
      task.projectId,
      picked
        ? `${await this.#login(teamId, userId)} picked the ${picked.harness ? CLI_LABEL[picked.harness] : picked.role} attempt on ${picked.branch} for "${cleanLine(task.title, 120)}".${stopped}`
        : `${await this.#login(teamId, userId)} finished "${cleanLine(task.title, 120)}" without shipping an attempt.${stopped}`,
      `pick-${task.id}`,
    );
    return { status: result.status, releasedLeaseIds: result.releasedLeaseIds };
  }

  /** A member's GitHub login for a message, or a neutral word when it cannot be read. */
  async #login(teamId: string, userId: string): Promise<string> {
    const team = await this.#ctx.teams.getTeam(teamId).catch(() => null);
    const member = team?.members.find((m) => m.userId === userId);
    return member?.login ?? "A teammate";
  }

  /** A system line in the project's channel, so everyone in the thread sees the decision. Best effort: null when not posted. */
  async #notice(teamId: string, projectId: string, text: string, key: string): Promise<RelayMessageView | null> {
    const ctx = this.#ctx;
    try {
      const access = await ctx.runtime.relay(teamId);
      if (!access) return null;
      const channel = await ctx.ports.relay.ensureChannel(access, projectId);
      return await ctx.ports.relay.post(access, dispatcherSpeaker(access), channel, text, key);
    } catch (error) {
      ctx.log.warn("could not post a notice to the team", { teamId, error });
      return null;
    }
  }

  async cancel(teamId: string, taskId: string, userId: string, role: Role): Promise<CancelTaskResponse> {
    const task = await this.#task(teamId, taskId);
    if (task.createdBy !== userId && role !== "owner" && role !== "admin") throw forbidden("Only the task's creator or a team admin can cancel it.");
    const result = await this.#ctx.wf.cancelTask(teamId, taskId, userId, newKey("cx"));
    if (!result.ok) throw conflict("This task has already finished.");
    this.#hooks.onWork(teamId);
    return { releasedLeaseIds: result.releasedLeaseIds };
  }

  /**
   * Deletes a task for the whole team. One that has not ended is cancelled first, so its workers stop exactly as on
   * cancel; then its record, plan and trace go. Same rule as cancel (the creator, or an owner or admin). Branches and
   * pull requests on GitHub are left alone: the code is the team's to keep.
   */
  async delete(teamId: string, taskId: string, userId: string, role: Role): Promise<DeleteTaskResponse> {
    const ctx = this.#ctx;
    const task = await this.#task(teamId, taskId);
    if (task.createdBy !== userId && role !== "owner" && role !== "admin") throw forbidden("Only the task's creator or a team admin can delete it.");
    const result = await ctx.wf.deleteTask(teamId, taskId, userId, newKey("dl"));
    // Deleted by someone else between the read and the write.
    if (!result.ok) throw notFound("Task not found.");
    const memory = ctx.memory.team(teamId);
    memory.verifyAttempts.delete(taskId);
    memory.verifyAfter.delete(taskId);
    this.#hooks.onWork(teamId);
    return { releasedLeaseIds: result.releasedLeaseIds };
  }

  /**
   * The way out of `failed`: verify again when every workstream is done, else new workers for the rest. Same rule as
   * cancel (the creator, or an owner or admin): a retry spends teammates' plan usage and verifies with the creator's
   * GitHub access.
   */
  async retry(teamId: string, taskId: string, userId: string, role: Role): Promise<RetryTaskResponse> {
    const ctx = this.#ctx;
    const task = await this.#task(teamId, taskId);
    if (task.createdBy !== userId && role !== "owner" && role !== "admin") throw forbidden("Only the task's creator or a team admin can retry it.");
    if (task.status !== "failed") throw conflict("Only a failed task can be retried.");
    await this.#hooks.noteWork?.(teamId);
    const result = await ctx.wf.retryTask(teamId, taskId, userId, newKey("rt"));
    if (!result.ok)
      throw conflict(result.reason === "no_workstreams" ? "This task has no plan to retry. Start a new task instead." : "Only a failed task can be retried.");
    // Forget the last run's retry backoff and give-ups, so the new run starts clean.
    const memory = ctx.memory.team(teamId);
    memory.verifyAttempts.delete(taskId);
    memory.verifyAfter.delete(taskId);
    for (const id of result.reopenedWorkstreamIds) memory.gaveUp.delete(`${taskId}/${id}`);
    ctx.runtime.touchTeam(teamId);
    if (result.mode === "verify") {
      this.#hooks.verify(teamId, taskId);
      return { mode: "verify", leases: [] };
    }
    const leases = await this.#reserveReady(teamId, taskId);
    this.#hooks.onWork(teamId);
    return { mode: "replan", leases };
  }

  /**
   * Workers for the pending workstreams whose dependencies are done, within the policy cap. Best effort: the retry
   * already happened, so a missing slot or an error leaves the rest to the scheduler's next pass.
   */
  async #reserveReady(teamId: string, taskId: string): Promise<StartTaskResponse["leases"]> {
    const ctx = this.#ctx;
    try {
      const task = await this.#task(teamId, taskId);
      const budget = (await parallelCap(ctx, teamId)) - busyWorkstreams(task);
      const done = new Set(task.workstreams.filter((w) => w.status === "done").map((w) => w.id));
      const ready = task.workstreams
        .filter((w) => w.status === "pending" && w.dependsOn.every((d) => done.has(d)))
        .map((w) => w.id)
        .slice(0, Math.max(0, budget));
      if (ready.length === 0) return [];
      const view = await ctx.wf.getView(teamId);
      const pool = placementPool(Object.values(view.profiles), task);
      const picks = choosePicks(ready, pool, await teamEnvironments(ctx, teamId), task.projectId, { pins: task.pins, harnessOf: harnessOf(task), cliUse: taskCliUse(view, task.id) });
      if (!picks) return [];
      const reserved = await ctx.wf.reserveWorkers(teamId, taskId, picks, newKey("rw"));
      return reserved.ok ? reserved.leases : [];
    } catch (error) {
      ctx.log.warn("retry: could not reserve workers now; the scheduler will", { teamId, taskId, error });
      return [];
    }
  }

  /**
   * The task with its full text, for screens that show it (plan review, mission control). Briefs and file ownership
   * are dropped by the schema: only workers and the planner read them.
   */
  async detail(teamId: string, taskId: string): Promise<TaskDetail> {
    return TaskDetail.parse(await this.#task(teamId, taskId));
  }

  async artifacts(teamId: string, taskId: string, userId: string): Promise<ArtifactsView> {
    const ctx = this.#ctx;
    const task = await this.#task(teamId, taskId);
    const project = await findProject(ctx, teamId, task.projectId);
    const repo = project?.repoFullName ?? null;
    const branches = task.workstreams.map((ws) => ({
      workstreamId: ws.id,
      branch: ws.branch,
      headSha: ws.lastCheckpoint?.sha ?? null,
      url: repo ? repoWebUrl(ctx, repo, `tree/${ws.branch}`) : null,
    }));
    let pullRequest: ArtifactsView["pullRequest"] = null;
    const token = project ? await memberGithubToken(ctx, userId) : null;
    if (project && token) {
      try {
        const pr = await ctx.ports.git.findPullRequest(token, project.repoFullName, integrationBranch(task.id), project.defaultBranch);
        if (pr) pullRequest = { number: pr.number, url: pr.url, state: pr.state };
      } catch (error) {
        ctx.log.warn("artifacts: pull request lookup failed", { teamId, taskId, error });
      }
    }
    return { branches, pullRequest, previewUrl: null };
  }
}
