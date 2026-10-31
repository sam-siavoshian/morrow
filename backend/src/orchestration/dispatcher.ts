// Outbox dispatcher: claim due items from the team's actor, perform the side effect, report the result.
// The actor owns retries (backoff 1 s to 60 s, 8 attempts, then the lease fails) and the visibility timeout
// that brings back items a crashed process claimed. Each effect is idempotent on its own:
//  - spawn: the agent name is derived from the lease epoch; an agent already registered under it means a
//    previous attempt got through, so we report "unconfirmed" and let the monitor reconcile. Never a blind retry.
//  - release: verified by exit or absence, safe to repeat.
//  - checkpoint / handoff note: commit-if-changed then push; a repeat re-pushes the same SHA.
import { RelayIntegrationError } from "../integrations/relay/index.ts";
import { redactSecrets } from "../runtime/inspect.ts";
import { worktreePath } from "../integrations/freestyle/index.ts";
import type { TeamRelayAccess } from "../runtime/types.ts";
import { cliName, handoffNote, handoffSpawnText, spawnBrief, subagentBrief, teamLines } from "./brief.ts";
import { lastFailure, otherWorkstreams, taskRoster } from "./comms.ts";
import { describeFailure, findProject, isRetryable, NO_OWNER_GITHUB_ACCESS, ownerGithubToken, vmTarget, type Ctx, type VmLookup } from "./context.ts";
import { digest, handoffNotePath, isResolver } from "./names.ts";
import { ensureTaskThread, handoffTalk, peerContracts } from "./peers.ts";
import { isReadOnlyRole, subagentOptions } from "./subagents.ts";
import type { OutboxClaim, OutboxResult, TaskRecord } from "./workforce.ts";

const MAX_CLAIM = 10;

type Claim<K extends OutboxClaim["kind"]> = Extract<OutboxClaim, { kind: K }>;

const ok = (detail: string, extra: { invocationId?: string | null; sha?: string | null } = {}): OutboxResult => ({
  ok: true,
  invocationId: extra.invocationId ?? null,
  sha: extra.sha ?? null,
  detail: detail.slice(0, 500),
});
const fail = (error: string, retryable: boolean): OutboxResult => ({ ok: false, error: error.slice(0, 500), retryable });

const STEP: Record<OutboxClaim["kind"], string> = {
  spawn: "Start worker",
  release: "Stop worker",
  checkpoint: "Checkpoint",
  handoff_brief: "Write handoff note",
};

/** Stable per item, attempt and result: a replayed completion is a no-op, a different one is a new call. */
export function completionKey(item: Pick<OutboxClaim, "id" | "attempts">, result: OutboxResult): string {
  return `co-${item.id}-a${item.attempts}-${digest(JSON.stringify(result), 12)}`;
}

export function failureResult(kind: OutboxClaim["kind"], error: unknown): OutboxResult {
  const retryable = error instanceof RelayIntegrationError ? error.code !== "invalid_input" : isRetryable(error);
  return fail(describeFailure(STEP[kind], error), retryable);
}

export class Dispatcher {
  readonly #ctx: Ctx;

  constructor(ctx: Ctx) {
    this.#ctx = ctx;
  }

  /** Starts a claim pass for the team unless one is running. Returns whether it started. */
  poke(teamId: string): boolean {
    return this.#ctx.lanes.run(teamId, "claim", () => this.claim(teamId));
  }

  /** One claim pass. Effects run in their own lane slots; this returns once they are started. */
  async claim(teamId: string): Promise<number> {
    const ctx = this.#ctx;
    const free = ctx.lanes.free(teamId);
    if (free <= 0) return 0;
    const memory = ctx.memory.team(teamId);
    const now = ctx.now();
    memory.lastClaimAt = now;
    const claims = await ctx.wf.claimOutbox(teamId, now, Math.min(MAX_CLAIM, free));
    let started = 0;
    const unstarted: OutboxClaim[] = [];
    for (const item of claims) {
      // Our own slow effect, claimed again after the visibility timeout: it will complete under its first claim.
      if (ctx.lanes.busy(teamId, `item:${item.id}`)) continue;
      if (ctx.lanes.run(teamId, `item:${item.id}`, () => this.perform(teamId, item))) started++;
      else unstarted.push(item);
    }
    // Claimed but never started: the process began stopping while the claim was in flight, or the slots filled.
    // Hand them straight back; otherwise they stay hidden for the visibility timeout (up to 6 minutes for a spawn).
    await Promise.all(unstarted.map((item) => this.#giveBack(teamId, item)));
    if (claims.length > 0) memory.hotUntil = now + ctx.timing.hotWindowMs;
    return started;
  }

  /** Returns an untouched claim as a retryable failure: due again after the actor's first backoff step. */
  async #giveBack(teamId: string, item: OutboxClaim): Promise<void> {
    const result = fail(`${STEP[item.kind]} did not start: the backend was stopping or busy. Retrying.`, true);
    try {
      await this.#ctx.wf.completeOutbox(teamId, item.id, result, completionKey(item, result));
    } catch (error) {
      // The visibility timeout still brings it back.
      this.#ctx.log.warn("outbox claim not handed back", { teamId, item: item.id, kind: item.kind, error });
    }
  }

  async perform(teamId: string, item: OutboxClaim): Promise<OutboxResult> {
    const log = this.#ctx.log.child({ teamId, item: item.id, kind: item.kind, attempt: item.attempts });
    let result: OutboxResult;
    try {
      result = await this.#effect(teamId, item);
    } catch (error) {
      log.warn("outbox effect failed", { error });
      result = failureResult(item.kind, error);
    }
    const done = await this.#ctx.wf.completeOutbox(teamId, item.id, result, completionKey(item, result));
    log.info("outbox item completed", { ok: result.ok, accepted: done.ok, state: done.ok ? done.state : done.reason });
    return result;
  }

  #effect(teamId: string, item: OutboxClaim): Promise<OutboxResult> {
    switch (item.kind) {
      case "spawn":
        return this.#spawn(teamId, item);
      case "release":
        return this.#release(teamId, item);
      case "checkpoint":
        return this.#checkpoint(teamId, item);
      case "handoff_brief":
        return this.#handoffNote(teamId, item);
    }
  }

  async #spawn(teamId: string, item: Claim<"spawn">): Promise<OutboxResult> {
    const ctx = this.#ctx;
    const p = item.payload;
    const access = await ctx.runtime.relay(teamId);
    if (!access) return fail("Relay is not set up for this team", false);

    // A registered agent under this lease's name means an earlier attempt started it. Reconcile, never respawn.
    const existing = await ctx.ports.relay.findAgent(access, p.agentName);
    if (existing) return ok("unconfirmed: agent already registered", { invocationId: existing.invocationId });

    const vm = await vmTarget(ctx, teamId, p.envId);
    if (!vm.ok) return fail(vm.reason, vm.reason === "the environment has no VM yet");
    if (vm.env.phase !== "ready") return fail(`the environment is ${vm.env.phase}`, true);
    const [task, project] = await Promise.all([ctx.wf.getTask(teamId, p.taskId), findProject(ctx, teamId, p.projectId)]);
    if (!task) return fail("the task no longer exists", false);
    if (!project) return fail("the project is no longer linked", false);
    const ws = task.workstreams.find((w) => w.id === p.workstreamId);
    if (!ws) return fail("the workstream no longer exists", false);

    let prepared: { text: string; workerCwd: string; channels: string[]; readOnly: boolean };
    if (p.subagent) {
      // A subagent works in its parent's worktree as it is: never fetch, reset or create anything under it.
      const record = task.subagents?.find((r) => r.leaseId === item.leaseId);
      if (!record) return fail("the subagent request no longer exists", false);
      // No channel: a subagent hears only from its parent and Morrow, by direct message. Review and research run
      // with the CLI's own read-only switches, not just the brief's word.
      prepared = {
        workerCwd: worktreePath(vm.target.linuxUser, project.repoFullName, p.branch),
        channels: [],
        readOnly: isReadOnlyRole(p.subagent.role),
        text: subagentBrief({
          leaseId: item.leaseId,
          agent: p.agentName,
          cli: p.cli,
          parentAgent: p.subagent.parentAgentName,
          parentCli: p.subagent.parentCli,
          role: p.subagent.role,
          task: record.task,
          taskTitle: task.title,
          workstream: ws,
          testCommand: project.testCommand,
        }),
      };
    } else {
      const worker = await this.#prepareWorker(teamId, item, vm, task, project, ws, access);
      prepared = { text: worker.text, workerCwd: worker.workerCwd, channels: [worker.channel], readOnly: false };
    }

    const outcome = await ctx.ports.relay.spawn(access, {
      name: p.agentName,
      node: p.nodeName,
      cli: p.cli,
      task: prepared.text,
      channels: prepared.channels,
      workerCwd: prepared.workerCwd,
      ...(prepared.readOnly ? { readOnly: true } : {}),
    });
    // Say which switch a read-only start tripped on, so the parent hears why instead of a bare spawn code.
    const readOnlyNote = prepared.readOnly ? ` (${cliName(p.cli)} could not start read-only on this machine)` : "";
    switch (outcome.outcome) {
      case "started":
        await ctx.wf
          .recordSpawnStatus(teamId, item.leaseId, p.epoch, "running", outcome.invocationId, `rs-run-${item.leaseId}-e${p.epoch}`)
          .catch((error: unknown) => ctx.log.warn("could not record running worker", { teamId, leaseId: item.leaseId, error }));
        return ok("started", { invocationId: outcome.invocationId });
      case "unconfirmed":
        return ok(`unconfirmed: ${outcome.code}`, { invocationId: outcome.invocationId });
      case "retryable":
        return fail(`Relay could not start it yet (${outcome.code})`, true);
      case "failed":
        if (outcome.code === "relay_quota") return fail("Agent Relay plan limit reached: the team's workspace has used its message or agent allowance.", false);
        return fail(`Relay refused the spawn (${outcome.code})${readOnlyNote}`, false);
    }
  }

  /** A workstream worker's worktree, brief (and brief note when long) and channel. */
  async #prepareWorker(
    teamId: string,
    item: Claim<"spawn">,
    vm: Extract<VmLookup, { ok: true }>,
    task: TaskRecord,
    project: NonNullable<Awaited<ReturnType<typeof findProject>>>,
    ws: TaskRecord["workstreams"][number],
    access: TeamRelayAccess,
  ): Promise<{ text: string; workerCwd: string; channel: string }> {
    const ctx = this.#ctx;
    const p = item.payload;
    // The VM owner's token only (null: public repos only). A repo they cannot read fails with a clear error.
    const token = await ownerGithubToken(ctx, vm.env);
    const tree = await ctx.ports.vm.ensureWorktree({
      ...vm.target,
      repoFullName: project.repoFullName,
      branch: p.branch,
      baseBranch: project.defaultBranch,
      githubToken: token,
    });
    if (tree.state !== "ok") ctx.log.warn("worktree left as it was", { teamId, branch: p.branch, state: tree.state });
    const channel = await ctx.ports.relay.ensureChannel(access, p.projectId);
    // The task thread workers coordinate in (architecture 9.8). Without one they fall back to the channel.
    const threadId = await ensureTaskThread(ctx, teamId, access, task, channel);

    const [roster, view] = await Promise.all([taskRoster(ctx, teamId, task), ctx.wf.getView(teamId)]);
    const own = view.profiles[p.profileId];
    const subagentClis = own ? subagentOptions(view, own).map((o) => o.cli) : [];
    const briefBase = { leaseId: item.leaseId, channel, testCommand: project.testCommand, workstream: ws, creator: roster.creator, subagentClis, strategy: task.strategy, threadId, cli: p.cli };
    let text: string;
    if (p.handoff) {
      text = handoffSpawnText({ ...briefBase, taskTitle: task.title });
    } else {
      const brief = spawnBrief({
        ...briefBase,
        task,
        others: otherWorkstreams(task, roster, ws.id),
        humans: roster.humans,
        self: { agent: p.agentName, cli: p.cli, machine: roster.logins.get(vm.env.ownerUserId) ?? null },
        lastFailure: lastFailure(task),
        contracts: await peerContracts(ctx, teamId, access, task, ws.id),
      });
      if (brief.note) {
        await ctx.ports.vm.writeNote({ ...vm.target, repoFullName: project.repoFullName, branch: p.branch, ...brief.note });
      }
      text = brief.text;
    }
    return { text, workerCwd: tree.path, channel };
  }

  async #release(teamId: string, item: Claim<"release">): Promise<OutboxResult> {
    const ctx = this.#ctx;
    const access = await ctx.runtime.relay(teamId);
    if (!access) return ok("relay disabled: nothing to stop");
    const result = await ctx.ports.relay.release(access, item.payload, ctx.memory.team(teamId).exits);
    if (!result.gone) return fail("the worker has not stopped yet", true);
    return ok(result.deleted ? "stopped" : "stopped; agent record kept");
  }

  async #checkpoint(teamId: string, item: Claim<"checkpoint">): Promise<OutboxResult> {
    const ctx = this.#ctx;
    const p = item.payload;
    const vm = await vmTarget(ctx, teamId, p.envId);
    if (!vm.ok) return fail(`unverified: ${vm.reason}`, false);
    const task = await ctx.wf.getTask(teamId, p.taskId);
    const project = task ? await findProject(ctx, teamId, task.projectId) : null;
    if (!task || !project) return fail("the task or its project no longer exists", false);
    const token = await ownerGithubToken(ctx, vm.env);
    if (!token) return fail(`Checkpoint: ${NO_OWNER_GITHUB_ACCESS}`, false);
    // A resolver that stopped mid-merge: never push a half-resolved integration branch. Its replacement redoes the merge.
    const resolving = task.workstreams.some((w) => w.id === p.workstreamId && isResolver(w));
    const result = await ctx.ports.vm.checkpoint({
      ...vm.target,
      repoFullName: project.repoFullName,
      branch: p.branch,
      message: `morrow: checkpoint ${p.workstreamId} e${p.epoch}`,
      githubToken: token,
      checkConflicts: resolving,
    });
    if (result.unresolved.length > 0) return ok(`Not pushed: ${p.agentName} left the merge with unresolved conflicts`);
    return ok(`Checkpoint of ${p.agentName}'s worktree${result.committed ? "" : " (no new changes)"}`, { sha: result.sha });
  }

  async #handoffNote(teamId: string, item: Claim<"handoff_brief">): Promise<OutboxResult> {
    const ctx = this.#ctx;
    const p = item.payload;
    const toLease = await ctx.wf.getLease(teamId, p.toLeaseId);
    if (!toLease) return fail("the replacement lease no longer exists", false);
    const profile = await ctx.wf.getProfile(teamId, toLease.profileId);
    if (!profile) return fail("the replacement profile no longer exists", false);
    const vm = await vmTarget(ctx, teamId, profile.envId);
    if (!vm.ok) return fail(vm.reason, vm.reason === "the environment has no VM yet");
    const task = await ctx.wf.getTask(teamId, p.taskId);
    const ws = task?.workstreams.find((w) => w.id === p.workstreamId);
    const project = task ? await findProject(ctx, teamId, task.projectId) : null;
    if (!task || !ws || !project) return fail("the task, workstream or project no longer exists", false);
    const token = await ownerGithubToken(ctx, vm.env);
    if (!token) return fail(`Write handoff note: ${NO_OWNER_GITHUB_ACCESS}`, false);

    const target = { ...vm.target, repoFullName: project.repoFullName, branch: p.branch };
    await ctx.ports.vm.ensureWorktree({ ...target, baseBranch: project.defaultBranch, githubToken: token });
    const changed = await ctx.ports.git
      .compare(token, project.repoFullName, project.defaultBranch, p.branch)
      .then((c) => c.files)
      .catch(() => [] as string[]);
    const fromLease = await ctx.wf.getLease(teamId, p.fromLeaseId);
    const fromAgent = fromLease?.agentName ?? `the e${p.fromEpoch} worker`;
    const memory = ctx.memory.team(teamId);
    const lastSignal = memory.watches.get(p.fromLeaseId)?.lastSignal ?? null;
    const roster = await taskRoster(ctx, teamId, task);
    // What peers asked the stopped worker and every published contract: read from Relay, best effort.
    const access = await ctx.runtime.relay(teamId).catch(() => null);
    const talk = fromLease ? await handoffTalk(ctx, teamId, access, task, fromLease.agentName) : { toOld: [], open: [] };
    const content = handoffNote({
      task,
      workstream: ws,
      fromAgent,
      toAgent: p.toAgentName,
      reason: lastSignal && lastSignal.kind !== "none" ? `${p.reason}: ${lastSignal.kind.replace("_", " ")}` : p.reason,
      checkpointSha: ws.lastCheckpoint?.sha ?? p.lastCheckpointSha,
      decisions: fromLease ? memory.said(fromLease.agentName) : [],
      changedFiles: changed,
      testCommand: project.testCommand,
      // A raw log line, committed to the branch: credential-shaped tokens are masked first.
      lastError: lastSignal && lastSignal.kind !== "none" ? redactSecrets(lastSignal.match) : null,
      team: teamLines({
        creator: roster.creator,
        humans: roster.humans,
        workstream: ws,
        others: otherWorkstreams(task, roster, ws.id),
        self: { agent: p.toAgentName, cli: profile.cli, machine: roster.logins.get(vm.env.ownerUserId) ?? null },
      }),
      threadId: task.threadId ?? null,
      peerMessages: talk.toOld,
      openQuestions: talk.open,
      contracts: await peerContracts(ctx, teamId, access, task, null),
    });
    await ctx.ports.vm.writeNote({ ...target, relPath: handoffNotePath(ws.id), content });
    const result = await ctx.ports.vm.checkpoint({
      ...target,
      message: `morrow: handoff note ${ws.id} e${p.toEpoch}`,
      githubToken: token,
      checkConflicts: isResolver(ws),
    });
    // The note is on disk either way; a half-done merge in this worktree is the replacement's to finish, never pushed.
    if (result.unresolved.length > 0) return ok("handoff note written; not committed while the merge has unresolved conflicts");
    return ok("handoff note committed", { sha: result.sha });
  }
}
