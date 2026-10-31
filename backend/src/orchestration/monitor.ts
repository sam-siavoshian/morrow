// Watches workers. Two inputs:
//  - Relay signals from the bus (messages, agent active/exited, node status). The handler only records facts
//    and queues work; it never awaits a vendor call, so the observer stream is never held up.
//  - A periodic pass per team: reconcile spawning leases older than 120 s, and every 20 s per running lease
//    reconcile liveness and classify the tail of its log (usage limit, expired login, crash).
// Every report carries the lease epoch and a stable event id, so replays and stale reports are no-ops.
//
// Engine gap (relaycast-engine 11.x/12.x): after a worker CLI crash the node's control link can keep failing and
// no `agent.exited` arrives, so reconcile stays `unknown`. A lease is treated as dead when it reads `unknown`
// more than `unknownDeadReads` times in a row with a crash in its log, or when its node is offline longer than
// `nodeDeadMs`. Then the node is restarted once and the lease ends, which hands the workstream off.
//
// The opposite gap, under hosted Relay database pressure: the node record drops its inventory, and the engine
// emits `agent.exited (missing_from_inventory)` for workers that are still running. Ending such a lease releases
// (kills) a live worker. So an inferred exit only feeds reconcile, and an absence verdict is overruled when the
// worker's own log on the VM changed after the absence began.
//
// Talk (activity.ts): who last posted where is kept from the same message stream. A worker whose log keeps changing
// but who has not posted in the thread or channel for 90 s is nudged (backing off, capped), unless its last post
// asked a person who has not answered; test results its log prints go to the task thread. Both only while another
// worker of the task is running.
import type { RelayMessageView } from "@morrow/contracts";
import {
  DISPATCHER_NAME,
  initialReconcileMemo,
  isConclusiveExit,
  isHandoffAck,
  type AgentActiveInfo,
  type AgentExitedInfo,
  type ReconcileResult,
} from "../integrations/relay/index.ts";
import { FreestyleIntegrationError } from "../integrations/freestyle/errors.ts";
import type { RuntimeSignal } from "../runtime/bus.ts";
import type { TeamRelayAccess } from "../runtime/types.ts";
import { afterNudge, ANSWER_NUDGE_MS, ANSWER_NUDGES_PER_LEASE, nextNudge, nudgesDue, parseTestSummary, type TestSummary } from "./activity.ts";
import { classify, cooldownUntil, type Signal } from "./classifier.ts";
import { isStatusRequest, type NudgeInput } from "./comms.ts";
import { endDetail } from "./endReason.ts";
import { findProject, NO_OWNER_GITHUB_ACCESS, ownerGithubToken, vmTarget, type Ctx } from "./context.ts";
import type { ControlMessage, TeamMemory } from "./memory.ts";
import { digest, isResolver } from "./names.ts";
import { dispatcherSpeaker } from "./ports.ts";
import { isPeerName, parseContract, talkOf } from "./peers.ts";
import { cleanLine } from "./planner/shape.ts";
import { isSubagentMessage, isSubagentResult } from "./subagents.ts";
import type { Lease, WorkforceSnapshot } from "./workforce.ts";
import { parseWorkerUsage, type WorkerUsage } from "./workerUsage.ts";

type LeaseView = WorkforceSnapshot["leases"][string];

const MAX_CONTROL_ATTEMPTS = 5;
const LIVE = new Set(["reserved", "spawning", "running"]);
const WORKER_PREFIX = "w-";

export type SubagentHandler = (teamId: string, agentName: string, messageId: string, text: string) => Promise<unknown>;
/** A peer protocol line from a worker (`CONTRACT`), handled by the comms layer. */
export type PeerHandler = (teamId: string, agentName: string, messageId: string, text: string) => Promise<unknown>;

/** What the monitor says on its own to keep workers talking, sent by the comms layer. */
export interface MonitorTalk {
  /** A system line in the task thread. */
  activity(teamId: string, taskId: string, text: string, key: string): Promise<unknown>;
  /** A direct message to a quiet worker. "skipped": nothing was sent (no Relay, no task). */
  nudge(teamId: string, input: NudgeInput): Promise<"sent" | "gone" | "skipped">;
}

/**
 * True when the worker's latest post asked a person (an `h-` mention) who has not posted since: it is waiting on the
 * user, and a nudge would only spend its plan.
 */
export function waitingOnPerson(memory: Pick<TeamMemory, "talk" | "lastPost">, agent: string, lastPostAt: number | undefined): boolean {
  if (lastPostAt === undefined) return false;
  let latest: { at: number; to: string[] } | null = null;
  for (const t of memory.talk()) if (t.from === agent && (!latest || t.at >= latest.at)) latest = t;
  if (!latest || latest.at < lastPostAt) return false;
  const asked = latest.at;
  return latest.to.some((name) => name.startsWith("h-") && (memory.lastPost(name) ?? 0) < asked);
}

/** `ACK <leaseId>` / `DONE <leaseId> <summary>` on the first line, exact tokens. */
export function parseControl(message: Pick<RelayMessageView, "type" | "text">): { verb: "ACK" | "DONE"; leaseId: string; rest: string } | null {
  if (message.type !== "message") return null;
  const first = message.text.trim().split("\n", 1)[0] ?? "";
  const match = /^(ACK|DONE)\s+([A-Za-z0-9._-]{1,128})(?:\s+(.*))?$/.exec(first);
  if (!match) return null;
  return { verb: match[1] as "ACK" | "DONE", leaseId: match[2]!, rest: (match[3] ?? "").trim() };
}

export class Monitor {
  readonly #ctx: Ctx;
  /** Called after a change that creates outbox work, so the dispatcher picks it up promptly. */
  readonly #onWork: (teamId: string) => void;
  /** A worker asked for the task's state (`STATUS`); answered by the comms layer. */
  readonly #onStatus: ((teamId: string, agentName: string, messageId: string) => void) | null;
  /** A subagent request or result (docs/subagents.md); answered by the comms layer. */
  readonly #onSubagent: SubagentHandler | null;
  /** A worker's interface contract (peers.ts); recorded by the comms layer. */
  readonly #onPeer: PeerHandler | null;
  /** Nudges and test-result lines (activity.ts); sent by the comms layer. */
  readonly #talk: MonitorTalk | null;

  constructor(
    ctx: Ctx,
    onWork: (teamId: string) => void,
    onStatus?: (teamId: string, agentName: string, messageId: string) => void,
    onSubagent?: SubagentHandler,
    onPeer?: PeerHandler,
    talk?: MonitorTalk,
  ) {
    this.#ctx = ctx;
    this.#onWork = onWork;
    this.#onStatus = onStatus ?? null;
    this.#onSubagent = onSubagent ?? null;
    this.#onPeer = onPeer ?? null;
    this.#talk = talk ?? null;
  }

  // ---------- bus ----------

  /** Bus handler. Synchronous on purpose: records facts, queues work, returns. */
  handle(signal: RuntimeSignal): void {
    const ctx = this.#ctx;
    const memory = ctx.memory.team(signal.teamId);
    switch (signal.kind) {
      case "message": {
        const { message } = signal;
        // Who asked whom: kept for the handoff note of a worker that stops before it answers (peers.ts).
        const talk = talkOf(message);
        if (talk) memory.noteTalk(talk);
        // Who posted where peers read (a channel or thread, not a DM): what the quiet check measures from.
        if (message.type === "message" && message.channel && isPeerName(message.from.name)) memory.notePost(message.from.name, message.createdAt);
        if (!message.from.name.startsWith(WORKER_PREFIX)) return;
        memory.remember(message.from.name, message.text);
        const control = parseControl(message);
        if (!control) {
          if (isStatusRequest(message.text)) this.#onStatus?.(signal.teamId, message.from.name, message.id);
          else if (isSubagentMessage(message.text)) this.#subagent(signal.teamId, message.from.name, message.id, message.text);
          // A contract counts only where peers can read it: the channel or its threads, not a direct message.
          else if (this.#onPeer && message.type === "message" && message.channel && parseContract(message.text)) this.#peer(signal.teamId, message.from.name, message.id, message.text);
          return;
        }
        if (control.verb === "DONE") memory.finishing.add(message.from.name);
        if (!memory.enqueueControl({ ...control, message, attempts: 0 })) {
          memory.finishing.delete(message.from.name);
          ctx.log.warn("control queue full; message dropped", { teamId: signal.teamId, verb: control.verb });
          return;
        }
        memory.hotUntil = ctx.now() + ctx.timing.hotWindowMs;
        this.drainControls(signal.teamId);
        return;
      }
      case "agent.active":
        ctx.lanes.run(signal.teamId, `active:${signal.event.agentName}`, () => this.#onActive(signal.teamId, signal.event));
        return;
      case "agent.exited": {
        const { event } = signal;
        memory.exits.record({ agentName: event.agentName, invocationId: event.invocationId, reason: event.reason, at: event.at });
        if (memory.finishing.has(event.agentName)) {
          memory.deferredExits.set(event.agentName, event);
          return;
        }
        ctx.lanes.run(signal.teamId, `exit:${event.agentName}`, () => this.#onExit(signal.teamId, event));
        return;
      }
      case "node.status": {
        const name = signal.event.nodeName;
        if (!name) return;
        if (signal.event.status === "offline") {
          if (!memory.nodeOfflineSince.has(name)) memory.nodeOfflineSince.set(name, signal.event.at);
        } else memory.nodeOfflineSince.delete(name);
        return;
      }
    }
  }

  /** Records a contract in its own lane job, off the bus. Dropped (and logged) when the lanes are full. */
  #peer(teamId: string, agent: string, messageId: string, text: string): void {
    const handler = this.#onPeer;
    if (!handler) return;
    const started = this.#ctx.lanes.run(teamId, `peer:${messageId}`, async () => {
      await handler(teamId, agent, messageId, text);
    });
    if (!started) this.#ctx.log.warn("contract dropped: no lane free", { teamId, agent });
  }

  /**
   * Runs a subagent request in its own lane job. A subagent's RESULT holds back its exit like a DONE does, so an
   * exit that races the result never records the subagent as failed. A request dropped for want of a lane slot gets
   * no answer; the MCP server resends it once under the same ref.
   */
  #subagent(teamId: string, agent: string, messageId: string, text: string): void {
    const handler = this.#onSubagent;
    if (!handler) return;
    const memory = this.#ctx.memory.team(teamId);
    const result = isSubagentResult(text);
    if (result) memory.finishing.add(agent);
    const started = this.#ctx.lanes.run(teamId, `sa:${messageId}`, async () => {
      try {
        await handler(teamId, agent, messageId, text);
      } finally {
        if (result) await this.#settleFinishing(teamId, agent);
      }
    });
    if (!started) {
      if (result) memory.finishing.delete(agent);
      this.#ctx.log.info("subagent request dropped: no free lane", { teamId, agent });
    }
  }

  async #liveLeaseOf(teamId: string, agentName: string): Promise<LeaseView | null> {
    const view = await this.#ctx.wf.getView(teamId);
    this.#ctx.memory.team(teamId).view = view;
    return Object.values(view.leases).find((l) => l.agentName === agentName && LIVE.has(l.state)) ?? null;
  }

  async #onActive(teamId: string, event: AgentActiveInfo): Promise<void> {
    const lease = await this.#liveLeaseOf(teamId, event.agentName);
    if (!lease || lease.state === "running") return;
    await this.#ctx.wf.recordSpawnStatus(teamId, lease.id, lease.epoch, "running", null, `rs-run-${lease.id}-e${lease.epoch}`);
  }

  async #onExit(teamId: string, event: AgentExitedInfo): Promise<void> {
    const view = await this.#liveLeaseOf(teamId, event.agentName);
    if (!view) return;
    const lease = await this.#ctx.wf.getLease(teamId, view.id);
    // An exit of an older incarnation under the same name is not this lease's exit.
    if (!lease || (event.invocationId && lease.spawnInvocationId && event.invocationId !== lease.spawnInvocationId)) return;
    if (!isConclusiveExit(event)) {
      // The engine's guess; the ledger has it and the watch pass checks it against the inventory and the VM.
      this.#ctx.log.info("relay inferred an exit; verifying before ending the lease", { teamId, leaseId: lease.id, reason: event.reason });
      return;
    }
    await this.#ended(teamId, lease, event.reason ? `agent exited (${event.reason})` : "agent exited");
  }

  /** Ends a live lease as exited (reserved/spawning become failed in the actor). */
  async #ended(teamId: string, lease: Pick<Lease, "id" | "epoch">, why: string): Promise<void> {
    // Kept on the lease and in the trace, so members see why it stopped (endReason.ts).
    const detail = endDetail(why, this.#ctx.memory.team(teamId).watches.get(lease.id)?.lastSignal ?? null);
    const result = await this.#ctx.wf.recordSpawnStatus(teamId, lease.id, lease.epoch, "exited", null, `rs-exit-${lease.id}-e${lease.epoch}`, detail);
    this.#ctx.log.info("worker ended", { teamId, leaseId: lease.id, why, detail, accepted: result.ok });
    this.#onWork(teamId);
  }

  // ---------- ACK / DONE ----------

  /** Applies queued control messages for the team, one at a time, in its own lane. */
  drainControls(teamId: string): void {
    const memory = this.#ctx.memory.team(teamId);
    if (memory.controls.length === 0) return;
    this.#ctx.lanes.run(teamId, "controls", async () => {
      const retry: ControlMessage[] = [];
      while (memory.controls.length > 0) {
        const control = memory.controls.shift()!;
        let settled = true;
        try {
          settled = await this.#applyControl(teamId, control);
        } catch (error) {
          this.#ctx.log.warn("control message failed", { teamId, verb: control.verb, error });
          settled = false;
        }
        if (!settled && control.attempts + 1 < MAX_CONTROL_ATTEMPTS) retry.push({ ...control, attempts: control.attempts + 1 });
        else if (control.verb === "DONE") await this.#settleFinishing(teamId, control.message.from.name);
      }
      memory.controls.push(...retry);
    });
  }

  /** True when the message is fully handled (applied or rightly ignored); false to try again later. */
  async #applyControl(teamId: string, control: ControlMessage): Promise<boolean> {
    const ctx = this.#ctx;
    const sender = control.message.from.name;
    const lease = await ctx.wf.getLease(teamId, control.leaseId);
    // Anyone with the workspace key can post this text; only the lease's own agent counts (architecture 10).
    if (!lease || lease.agentName !== sender) {
      ctx.log.warn("control message ignored: sender is not the lease's worker", { teamId, verb: control.verb, leaseId: control.leaseId });
      return true;
    }
    if (control.verb === "ACK") {
      if (!isHandoffAck(control.message, { leaseId: lease.id, agentName: lease.agentName })) return true;
      const result = await ctx.wf.ackHandoff(teamId, lease.id, lease.epoch, `ack-${lease.id}-e${lease.epoch}`);
      ctx.log.info("handoff ack", { teamId, leaseId: lease.id, accepted: result.ok, reason: result.ok ? null : result.reason });
      return true;
    }
    return this.#finish(teamId, lease, control.rest);
  }

  /**
   * DONE: the backend commits and pushes the worker's tree itself and completes the workstream with that SHA.
   * The agent's own claims about commits are not trusted.
   */
  async #finish(teamId: string, lease: Lease, summary: string): Promise<boolean> {
    const ctx = this.#ctx;
    if (!LIVE.has(lease.state)) return true;
    const task = await ctx.wf.getTask(teamId, lease.taskId);
    const ws = task?.workstreams.find((w) => w.id === lease.workstreamId);
    if (!task || !ws || ws.status === "done" || ws.leaseId !== lease.id) return true;
    // Subagents write to this tree too: nothing is committed while one may still be running. A live one is the
    // worker's to wait for or cancel; one that is only being stopped is waited for (the DONE is retried).
    const stopping = await ctx.wf.stoppingSubagents(teamId, lease.id);
    if (stopping.length > 0) {
      const view = await ctx.wf.getView(teamId);
      const live = Object.values(view.leases).filter((l) => l.parentLeaseId === lease.id && LIVE.has(l.state)).map((l) => l.agentName).sort();
      ctx.log.info("DONE held: subagents still running", { teamId, leaseId: lease.id, live: live.length, stopping: stopping.length });
      if (live.length === 0) return false;
      await this.#notice(
        teamId,
        task.projectId,
        `@${lease.agentName} your subagents ${live.join(", ")} are still running, so nothing was committed. Wait for their results (they come to you from @${DISPATCHER_NAME}) or stop them with TASK_CANCEL, then post DONE again.`,
        `donewait-${lease.id}-e${lease.epoch}-${digest(live.join(","))}`,
      );
      return true;
    }
    // A DONE from a replacement proves it took over, same as its ACK.
    if (ws.status === "handoff") await ctx.wf.ackHandoff(teamId, lease.id, lease.epoch, `ack-${lease.id}-e${lease.epoch}`);

    const profile = await ctx.wf.getProfile(teamId, lease.profileId);
    const vm = profile ? await vmTarget(ctx, teamId, profile.envId) : null;
    const project = await findProject(ctx, teamId, task.projectId);
    if (!vm?.ok || !project) {
      ctx.log.warn("cannot checkpoint finished work", { teamId, leaseId: lease.id, reason: vm && !vm.ok ? vm.reason : "missing profile or project" });
      return true;
    }
    // Only the VM owner's token goes to their VM. Without it the work stays put and the team is told why.
    const token = await ownerGithubToken(ctx, vm.env);
    const blocked = () =>
      this.#notice(
        teamId,
        task.projectId,
        `Could not push ${lease.agentName}'s finished work on ${ws.branch}. ${NO_OWNER_GITHUB_ACCESS} Then ask the worker to post DONE again.`,
        `nopush-${lease.id}-e${lease.epoch}`,
      );
    if (!token) {
      ctx.log.warn("cannot push finished work: the environment owner has no working GitHub token", { teamId, leaseId: lease.id });
      await blocked();
      return true;
    }
    let checkpoint;
    try {
      checkpoint = await ctx.ports.vm.checkpoint({
        ...vm.target,
        repoFullName: project.repoFullName,
        branch: ws.branch,
        message: `morrow: ${ws.id} done e${lease.epoch}`,
        githubToken: token,
        checkConflicts: isResolver(ws),
      });
    } catch (error) {
      if (!(error instanceof FreestyleIntegrationError && error.kind === "dependency_rejected")) throw error;
      ctx.log.warn("cannot push finished work: GitHub denied the environment owner", { teamId, leaseId: lease.id });
      await blocked();
      return true;
    }
    if (checkpoint.unresolved.length > 0) {
      // A resolver said DONE with the merge unfinished. Nothing was pushed; it keeps its lease and can say DONE again.
      const files = checkpoint.unresolved.slice(0, 10).join(", ");
      ctx.log.info("resolver DONE refused: unresolved conflicts", { teamId, leaseId: lease.id, files: checkpoint.unresolved.length });
      await this.#notice(
        teamId,
        task.projectId,
        `@${lease.agentName} the merge on ${ws.branch} still has conflicts in: ${files}. Resolve them, remove every conflict marker, commit, then post DONE again.`,
        `unresolved-${lease.id}-e${lease.epoch}-${digest(checkpoint.unresolved.join("\n"))}`,
      );
      return true;
    }
    const result = await ctx.wf.completeWorkstream(
      teamId,
      lease.id,
      lease.epoch,
      checkpoint.sha,
      cleanLine(summary, 500) || "Workstream completed",
      `done-${lease.id}-e${lease.epoch}`,
    );
    ctx.log.info("workstream done", { teamId, leaseId: lease.id, accepted: result.ok, reason: result.ok ? null : result.reason });
    this.#onWork(teamId);
    return true;
  }

  /** A system message in the project's thread, so every member sees why work is stuck. Best effort. */
  async #notice(teamId: string, projectId: string, text: string, key: string): Promise<void> {
    const ctx = this.#ctx;
    try {
      const access = await ctx.runtime.relay(teamId);
      if (!access) return;
      const channel = await ctx.ports.relay.ensureChannel(access, projectId);
      await ctx.ports.relay.post(access, dispatcherSpeaker(access), channel, text, key);
    } catch (error) {
      ctx.log.warn("could not post a notice to the team", { teamId, error });
    }
  }

  async #settleFinishing(teamId: string, agentName: string): Promise<void> {
    const memory = this.#ctx.memory.team(teamId);
    memory.finishing.delete(agentName);
    const deferred = memory.deferredExits.get(agentName);
    if (!deferred) return;
    memory.deferredExits.delete(agentName);
    await this.#onExit(teamId, deferred);
  }

  // ---------- periodic pass ----------

  /** One watch pass over the team's live leases. Runs in the team's `watch` lane. */
  async watch(teamId: string): Promise<void> {
    const ctx = this.#ctx;
    const memory = ctx.memory.team(teamId);
    this.drainControls(teamId);
    const view = await ctx.wf.getView(teamId);
    memory.view = view;
    const live = Object.values(view.leases).filter((l) => LIVE.has(l.state));
    const liveIds = new Set(live.map((l) => l.id));
    for (const id of memory.watches.keys()) if (!liveIds.has(id)) memory.watches.delete(id);
    if (live.length === 0) return;
    const access = await ctx.runtime.relay(teamId);
    if (!access) return;

    for (const view of live) {
      if (memory.finishing.has(view.agentName)) continue;
      try {
        if (view.parentLeaseId && ctx.now() - view.createdAt > ctx.timing.subagentMaxMs) {
          await this.#overdueSubagent(teamId, view);
          continue;
        }
        if (view.state === "spawning") await this.#reconcileSpawning(teamId, access, view);
        else if (view.state === "running") await this.#checkRunning(teamId, access, view, view.profileId);
      } catch (error) {
        ctx.log.warn("lease check failed", { teamId, leaseId: view.id, error });
      }
    }
  }

  /**
   * A subagent that never reported. Recorded as its failed result under the same key a RESULT uses, so a late RESULT
   * is a no-op; the actor releases it and its parent is told (a `subagent.finished` trace entry).
   */
  async #overdueSubagent(teamId: string, view: LeaseView): Promise<void> {
    const ctx = this.#ctx;
    const minutes = Math.round(ctx.timing.subagentMaxMs / 60_000);
    const result = await ctx.wf.recordSubagentResult(
      teamId,
      view.id,
      view.epoch,
      "failed",
      `Stopped by Morrow: no result after ${minutes} minutes.`,
      `sr-${view.id}-e${view.epoch}`,
    );
    ctx.log.warn("subagent stopped: no result in time", { teamId, leaseId: view.id, minutes, recorded: result.ok && result.recorded });
    this.#onWork(teamId);
  }

  async #reconcileSpawning(teamId: string, access: TeamRelayAccess, view: LeaseView): Promise<void> {
    const ctx = this.#ctx;
    // A lease's updatedAt is never before its createdAt, so this skips only leases the check below would skip too.
    if (ctx.now() - view.createdAt < ctx.timing.spawnReconcileAfterMs) return;
    const lease = await ctx.wf.getLease(teamId, view.id);
    if (!lease || lease.state !== "spawning" || ctx.now() - lease.updatedAt < ctx.timing.spawnReconcileAfterMs) return;
    const verdict = await this.#reconcile(teamId, access, lease);
    if (verdict.state === "running") {
      await ctx.wf.recordSpawnStatus(teamId, lease.id, lease.epoch, "running", verdict.invocationId, `rs-run-${lease.id}-e${lease.epoch}`);
    } else if (verdict.state === "gone") {
      await ctx.wf.recordSpawnStatus(teamId, lease.id, lease.epoch, "failed", null, `rs-fail-${lease.id}-e${lease.epoch}`, endDetail("never reported running", null));
      this.#onWork(teamId);
    }
  }

  async #checkRunning(
    teamId: string,
    access: TeamRelayAccess,
    view: LeaseView,
    profileId: string,
  ): Promise<void> {
    const ctx = this.#ctx;
    const memory = ctx.memory.team(teamId);
    const watch = memory.watch(view.id);
    const now = ctx.now();
    if (now - watch.lastLogAt < ctx.timing.logPollMs) return;
    watch.lastLogAt = now;

    const lease = await ctx.wf.getLease(teamId, view.id);
    if (!lease || lease.state !== "running") return;
    const verdict = await this.#reconcile(teamId, access, lease);
    if (verdict.state === "gone") return this.#ended(teamId, lease, `reconcile: ${verdict.reason}`);
    watch.unknownReads = verdict.state === "unknown" ? watch.unknownReads + 1 : 0;
    if (verdict.state === "running") memory.nodeOfflineSince.delete(lease.nodeName);
    else if (verdict.reason === "node_offline" && !memory.nodeOfflineSince.has(lease.nodeName)) memory.nodeOfflineSince.set(lease.nodeName, now);

    // This pass's view already has the profile's id, env and CLI; ask the actor only if it is missing.
    const profile = memory.view?.profiles[profileId] ?? (await ctx.wf.getProfile(teamId, profileId));
    if (!profile) return;
    const { signal, usage, modifiedAt, tests } = await this.#readSignal(teamId, profile.envId, lease.agentName, now);
    if (signal.kind !== "none" && signal.kind !== "transient") watch.lastSignal = signal;
    if (usage && (profile.cli === "claude" || profile.cli === "codex") && usage.line !== watch.lastUsageLine) {
      watch.lastUsageLine = usage.line;
      await ctx.wf
        .recordProfileUsage(teamId, profile.id, usage.usage)
        .catch((error: unknown) => ctx.log.warn("worker usage not recorded", { teamId, leaseId: lease.id, error }));
    }

    if (signal.kind === "usage_limit") {
      const eventId = `lim-${lease.id}-e${lease.epoch}-${digest(`${signal.patternId}|${signal.match}`)}`;
      const result = await ctx.wf.markProfileLimited(teamId, profile.id, cooldownUntil(signal, now), cleanLine(signal.match, 300) || "Usage limit", "detected", eventId);
      ctx.log.info("usage limit detected", { teamId, leaseId: lease.id, profileId: profile.id, pattern: signal.patternId, accepted: result.ok });
      this.#onWork(teamId);
      return;
    }
    if (signal.kind === "auth_required") {
      await ctx.wf.updateProfileHealth(teamId, profile.id, { auth: "auth_required", online: true, observedAt: now }, `auth-${lease.id}-e${lease.epoch}`);
      return this.#ended(teamId, lease, "login expired");
    }

    // A worker whose log is still changing is not silent, however long Relay has been unsure (a degraded Relay
    // reads unknown for minutes) and whatever crash-like line it printed earlier. It is also working, not waiting.
    const writing = modifiedAt !== null && modifiedAt >= now - 2 * ctx.timing.logPollMs;
    if (verdict.state === "running") {
      await this.#keepTalking(teamId, access, lease, profile.cli, writing, tests, now).catch((error: unknown) =>
        ctx.log.warn("could not nudge or post for a worker", { teamId, leaseId: lease.id, error }),
      );
    }

    const offlineSince = memory.nodeOfflineSince.get(lease.nodeName);
    const nodeDead = offlineSince !== undefined && now - offlineSince > ctx.timing.nodeDeadMs;
    const crashedSilently = watch.unknownReads > ctx.timing.unknownDeadReads && watch.lastSignal?.kind === "crash" && !writing;
    if (!nodeDead && !crashedSilently) return;
    const why = nodeDead ? "node offline" : "worker crashed and its node stopped reporting";
    if (!watch.restartRequested) {
      watch.restartRequested = true;
      await ctx.runtime
        .restartNode(teamId, profile.envId, why)
        .then((restarted) => ctx.log.info("node restart requested", { teamId, envId: profile.envId, restarted }))
        .catch((error: unknown) => ctx.log.warn("node restart failed", { teamId, envId: profile.envId, error }));
    }
    await this.#ended(teamId, lease, why);
  }

  /**
   * Keeps a working worker talking (activity.ts): posts the test results its log printed to the task thread, and
   * nudges it when it has posted nothing for a while. Only while another worker of the task runs: talk is for peers.
   * A nudge is recorded after it went out (or its recipient is gone); a failed send is retried on the next poll under
   * the same Relay key.
   */
  async #keepTalking(teamId: string, access: TeamRelayAccess, lease: Lease, cli: string, writing: boolean, tests: TestSummary | null, now: number): Promise<void> {
    const talk = this.#talk;
    if (!talk || lease.parentLeaseId) return;
    const memory = this.#ctx.memory.team(teamId);
    const peers = new Set(
      Object.values(memory.view?.leases ?? {})
        .filter((l) => l.taskId === lease.taskId && l.id !== lease.id && l.state === "running" && !l.parentLeaseId)
        .map((l) => l.agentName),
    );
    if (peers.size === 0) return;
    const watch = memory.watch(lease.id);
    if (tests && memory.noteTests(watch, digest(tests.line, 16))) {
      const text = `${lease.agentName} ran the tests (${tests.runner}): ${tests.passed} passed, ${tests.failed} failed.`;
      await talk.activity(teamId, lease.taskId, text, `ts-${digest(`${lease.id}|e${lease.epoch}|${tests.line}`, 24)}`);
    }
    // A peer asked it something a minute ago and it has posted nothing since: remind it, working or idle.
    const lastSeen = memory.lastPost(lease.agentName) ?? -Infinity;
    const owed = memory
      .talk()
      .filter((t) => peers.has(t.from) && t.to.includes(lease.agentName) && t.at > lastSeen && now - t.at >= ANSWER_NUDGE_MS && !watch.answered.includes(t.id))
      .sort((a, b) => a.at - b.at)[0];
    if (owed && watch.answered.length < ANSWER_NUDGES_PER_LEASE) {
      const base = { leaseId: lease.id, epoch: lease.epoch, agent: lease.agentName, taskId: lease.taskId, cli, index: 0, anchor: owed.at, quietMs: now - owed.at, waitingOn: [] };
      const result = await talk.nudge(teamId, { ...base, question: { id: owed.id, from: owed.from, at: owed.at } });
      if (result !== "skipped") watch.answered.push(owed.id);
      return;
    }
    if (!writing) return;
    // After a restart this process has not seen the worker post: read the task thread once before judging silence.
    const since = lease.updatedAt;
    if (memory.lastPost(lease.agentName) === undefined && nudgesDue(now - since) > 0 && !memory.seededTasks.has(lease.taskId)) {
      if (!(await this.#seedPosts(teamId, access, lease.taskId))) return;
      memory.seedTask(lease.taskId);
    }
    const last = memory.lastPost(lease.agentName);
    const anchor = Math.max(last ?? 0, since);
    const next = nextNudge(watch.nudge, anchor, now);
    if (!next || waitingOnPerson(memory, lease.agentName, last)) return;
    const waitingOn = memory
      .talk()
      .filter((t) => t.at > anchor && peers.has(t.from) && t.to.includes(lease.agentName))
      .map((t) => t.from);
    const result = await talk.nudge(teamId, {
      leaseId: lease.id,
      epoch: lease.epoch,
      agent: lease.agentName,
      taskId: lease.taskId,
      cli,
      index: next.index,
      anchor,
      quietMs: next.quietMs,
      waitingOn,
    });
    if (result !== "skipped") watch.nudge = afterNudge(watch.nudge, anchor, next.index);
  }

  /** Learns who posted in a task's thread, and who asked whom, from Relay. False when the thread could not be read. */
  async #seedPosts(teamId: string, access: TeamRelayAccess, taskId: string): Promise<boolean> {
    const ctx = this.#ctx;
    const memory = ctx.memory.team(teamId);
    const task = await ctx.wf.getTask(teamId, taskId);
    if (!task?.threadId) return true;
    try {
      for (const message of await ctx.ports.relay.thread(access, task.threadId)) {
        if (message.id === task.threadId || !isPeerName(message.from.name)) continue;
        memory.notePost(message.from.name, message.createdAt);
        const talk = talkOf(message);
        if (talk) memory.noteTalk(talk);
      }
      return true;
    } catch (error) {
      ctx.log.warn("task thread unavailable for the quiet check", { teamId, taskId, error });
      return false;
    }
  }

  /**
   * Relay's verdict on a live lease. An absence verdict stands only if the worker's log on the VM has not changed
   * since the absence began: the broker writes every byte of the CLI's output there, so a newer change means the
   * process was alive while Relay's inventory said otherwise. Then the streak starts over.
   */
  async #reconcile(teamId: string, access: TeamRelayAccess, lease: Lease): Promise<ReconcileResult> {
    const ctx = this.#ctx;
    const memory = ctx.memory.team(teamId);
    const watch = memory.watch(lease.id);
    const verdict = await ctx.ports.relay.reconcile(
      access,
      { agentName: lease.agentName, nodeName: lease.nodeName, expectedInvocationId: lease.spawnInvocationId, memo: watch.memo, startedAt: lease.updatedAt },
      memory.exits,
    );
    watch.memo = verdict.memo;
    const since = verdict.memo.firstAbsentAt;
    if (verdict.state !== "gone" || verdict.reason !== "absent" || since === null) return verdict;
    if (!(await this.#loggedSince(teamId, lease.profileId, lease.agentName, since))) return verdict;
    ctx.log.warn("relay lists the worker as gone but its log is still changing; keeping it", { teamId, leaseId: lease.id });
    watch.memo = initialReconcileMemo();
    return { ...verdict, state: "unknown", reason: "absent_unconfirmed", memo: watch.memo };
  }

  /** True when the worker's log on its VM changed at or after `since`. No VM, no log or a failed read: false. */
  async #loggedSince(teamId: string, profileId: string, agentName: string, since: number): Promise<boolean> {
    const ctx = this.#ctx;
    const profile = ctx.memory.team(teamId).view?.profiles[profileId] ?? (await ctx.wf.getProfile(teamId, profileId));
    if (!profile) return false;
    const vm = await vmTarget(ctx, teamId, profile.envId);
    if (!vm.ok) return false;
    try {
      const tail = await ctx.ports.vm.readLogTail({ ...vm.target, agentName });
      // The VM reports mtime in whole seconds.
      return !!tail && Date.parse(tail.modifiedAt) >= since - 1_000;
    } catch (error) {
      ctx.log.warn("worker log unavailable", { teamId, agentName, error });
      return false;
    }
  }

  /** What the worker's log tail says: a limit/auth/crash signal, the latest usage reading and test summary it printed. */
  async #readSignal(
    teamId: string,
    envId: string,
    agentName: string,
    now: number,
  ): Promise<{ signal: Signal; usage: WorkerUsage | null; modifiedAt: number | null; tests: TestSummary | null }> {
    const none = { signal: { kind: "none", patternId: null, version: 0, resetAt: null, match: "" } satisfies Signal, usage: null, modifiedAt: null, tests: null };
    const vm = await vmTarget(this.#ctx, teamId, envId);
    if (!vm.ok) return none;
    try {
      const tail = await this.#ctx.ports.vm.readLogTail({ ...vm.target, agentName });
      // A copy for the ended-worker log view, in case the VM is gone by the time someone reads it.
      if (tail) this.#ctx.runtime.rememberWorkerLog?.(teamId, agentName, tail);
      return tail
        ? { signal: classify(tail.text, now), usage: parseWorkerUsage(tail.text, now), modifiedAt: Date.parse(tail.modifiedAt), tests: parseTestSummary(tail.text) }
        : none;
    } catch (error) {
      this.#ctx.log.warn("worker log unavailable", { teamId, agentName, error });
      return none;
    }
  }
}
