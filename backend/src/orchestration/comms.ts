// The agent communication layer (architecture 9.8): what workers know about each other, and what they are told as the
// task moves.
//  - Who is who: the roster that briefs, handoff notes and STATUS answers are built from.
//  - Updates: the task's trace is the event log. A pass turns entries past the task's watermark into short direct
//    messages from the Morrow system identity (`dispatcher`) to the running workers they concern, then moves the
//    watermark in the actor, so a restart resumes where it stopped. Relay idempotency keys (one per entry and
//    recipient) cover a crash between a send and the mark.
//  - STATUS: a worker asks by message, gets the current picture by direct message.
//  - Review comments on the task's pull request, routed to the workers whose files they are about.
//  - Subagents (docs/subagents.md): a worker's DELEGATE, TASK_STATUS, TASK_CANCEL and SUBAGENT_OPTIONS, a subagent's
//    RESULT, and the message a worker gets when its subagent ends.
//  - Peers (peers.ts): a worker's CONTRACT is recorded on its workstream, and the other workers hear about it and
//    about a worker that joins the task later (and are asked to greet it).
//  - Activity (activity.ts): short system lines in the task thread about what Morrow saw a worker do (finished and
//    pushed, stopped, ran tests), so its peers react; and nudges to a worker that went quiet while working.
// Every send is rate limited per worker. Agent and reviewer text is untrusted: it is flattened, clipped and masked
// with `redactSecrets` before it is quoted, and it never decides anything.
import { APP_NAME, CLI_LABEL, humanRelayName, type RelayNotice, type RelayNoticeKind, type TraceEntry } from "@morrow/contracts";
import { z } from "zod";
import { isRelayNotFound } from "../integrations/relay/errors.ts";
import { DISPATCHER_NAME } from "../integrations/relay/index.ts";
import { RateLimiter, type RateGroup } from "../http/rateLimit.ts";
import { redactSecrets } from "../runtime/inspect.ts";
import type { TeamRelayAccess } from "../runtime/types.ts";
import { postCall, type OtherWorkstream } from "./brief.ts";
import { isCompare } from "./compare.ts";
import { findProject, ownerGithubToken, vmTarget, type Ctx } from "./context.ts";
import { digest, isResolver, taskShort } from "./names.ts";
import { cleanLine } from "./planner/shape.ts";
import { SUBAGENTS_PER_WORKER } from "./brief.ts";
import { answer, delegateRefusal, doneText, optionsText, parseSubagentRequest, recordText, roleNoun, subagentOptions, withNote, type SubagentRequest } from "./subagents.ts";
import { isPeerName, parseContract } from "./peers.ts";
import { PARTNER_ROLES } from "./planner/shape.ts";
import { dispatcherSpeaker } from "./ports.ts";
import type { TaskRecord, WorkforceSnapshot } from "./workforce.ts";

type LeaseView = WorkforceSnapshot["leases"][string];

const LIVE = new Set(["reserved", "spawning", "running"]);
/**
 * Trace kinds that can produce an update; everything else only moves the watermark. Plans change only before any
 * worker runs, and verification, conflicts and retries happen after every worker of the task has ended, so those
 * reach workers through the brief of the next spawn (the last failure, the resolver's brief), not as updates.
 */
const TOLD = new Set<TraceEntry["kind"]>([
  "task.checkpointed",
  "task.handoff_acked",
  "subagent.finished",
  "contract.published",
  "worker.ready",
  "worker.quota_limited",
  "worker.offline",
]);
const RECENT_ENTRIES = 3;
const SKIPPED_NOTE = `(Some earlier updates were skipped to save your plan. Send STATUS to @${DISPATCHER_NAME} for the full picture.)`;

/** One line of quoted untrusted text: control characters gone, credentials masked, clipped. */
export function quote(text: string, max: number): string {
  return cleanLine(redactSecrets(text), max);
}

/** Who works on what, from the actor's view and the team's members. */
export interface Roster {
  /** Every member's Relay name. */
  humans: string[];
  creator: string | null;
  /** GitHub login by user id, for naming whose machine a worker runs on. */
  logins: Map<string, string>;
  /** By workstream id: its current worker, when it has a live lease. */
  workers: Map<string, { agent: string; leaseId: string; state: string; cli: string | null; machine: string | null }>;
}

export async function taskRoster(ctx: Ctx, teamId: string, task: Pick<TaskRecord, "createdBy" | "workstreams">, view?: WorkforceSnapshot): Promise<Roster> {
  const [team, snapshot] = await Promise.all([ctx.teams.getTeam(teamId), view ? Promise.resolve(view) : ctx.wf.getView(teamId)]);
  const login = new Map((team?.members ?? []).map((m) => [m.userId, m.login]));
  const creatorLogin = login.get(task.createdBy);
  const workers: Roster["workers"] = new Map();
  for (const ws of task.workstreams) {
    const lease = ws.leaseId ? snapshot.leases[ws.leaseId] : undefined;
    if (!lease || !LIVE.has(lease.state)) continue;
    const profile = snapshot.profiles[lease.profileId];
    workers.set(ws.id, {
      agent: lease.agentName,
      leaseId: lease.id,
      state: lease.state,
      cli: profile?.cli ?? null,
      machine: profile ? (login.get(profile.ownerUserId) ?? null) : null,
    });
  }
  return {
    humans: [...login.values()].map(humanRelayName),
    creator: creatorLogin ? humanRelayName(creatorLogin) : null,
    logins: login,
    workers,
  };
}

/** The other workstreams as a worker's brief lists them. */
export function otherWorkstreams(task: Pick<TaskRecord, "workstreams">, roster: Roster, selfId: string): OtherWorkstream[] {
  const needs = new Set(task.workstreams.find((w) => w.id === selfId)?.dependsOn ?? []);
  return task.workstreams
    .filter((w) => w.id !== selfId)
    .map((w) => {
      const worker = roster.workers.get(w.id);
      return {
        role: w.role,
        title: w.title,
        branch: w.branch,
        ownership: w.ownership,
        status: w.status,
        agent: worker?.agent ?? null,
        cli: worker?.cli ?? null,
        machine: worker?.machine ?? null,
        dependency: needs.has(w.id),
      };
    });
}

/** The failed checks of the task's last verification, one safe line each. Empty unless it failed. */
export function lastFailure(task: Pick<TaskRecord, "verification">): string[] {
  if (task.verification?.status !== "failed") return [];
  return task.verification.checks.filter((c) => c.status === "failed").map((c) => `${c.name}: ${quote(c.detail.split("\n", 1)[0] ?? "", 200) || "failed"}`);
}

/** A worker's STATUS answer: the task, every workstream and its worker, the newest decisions, who decides. */
export function statusText(input: { agent: string; task: TaskRecord; roster: Roster; selfWorkstreamId: string }): string {
  const { task, roster } = input;
  const lines = task.workstreams.map((w) => {
    const worker = roster.workers.get(w.id);
    const who = w.id === input.selfWorkstreamId ? "you" : worker ? `${worker.agent}${worker.cli ? ` (${worker.cli}${worker.machine ? ` on ${worker.machine}'s machine` : ""})` : ""}` : "no worker";
    const done = w.status === "done" && w.lastCheckpoint ? ` at ${w.lastCheckpoint.sha.slice(0, 12)}: "${quote(w.lastCheckpoint.summary, 160)}"` : "";
    return `- ${w.role} "${quote(w.title, 80)}": ${w.status}${done}. ${who}. Branch ${w.branch}.`;
  });
  const recent = task.trace.slice(-RECENT_ENTRIES).map((e) => `- ${quote(e.message, 160)}`);
  const failure = lastFailure(task);
  return [
    `@${input.agent} ${APP_NAME} status of "${quote(task.title, 120)}": ${task.status}.${roster.creator ? ` ${roster.creator} created it and decides when a person has to.` : ""}`,
    "Workstreams:",
    ...lines,
    ...(failure.length > 0 ? ["Last verification failed:", ...failure.map((f) => `- ${f}`)] : []),
    ...(recent.length > 0 ? ["Latest:", ...recent] : []),
    `People: ${roster.humans.join(", ") || "not known"}.`,
  ].join("\n");
}

const STATUS_LINE = new RegExp(`^(?:@${DISPATCHER_NAME}\\s+)?STATUS\\??$`);

/** `STATUS` (or `STATUS?`, optionally after `@dispatcher`) alone on the first line. */
export function isStatusRequest(text: string): boolean {
  return STATUS_LINE.test(text.trim().split("\n", 1)[0]?.trim() ?? "");
}

/**
 * A new review comment on a task's pull request. The GitHub layer emits one per comment it has not seen; the
 * comment id makes delivery idempotent per worker.
 */
export const ReviewCommentEvent = z.object({
  teamId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  taskId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  commentId: z.union([z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.number().int().nonnegative()]),
  /** The reviewer's GitHub login. */
  author: z.string().regex(/^[A-Za-z0-9-]{1,39}(\[bot\])?$/),
  /** The file it is on, when it is a line comment. */
  path: z.string().min(1).max(500).nullable(),
  line: z.number().int().positive().nullable(),
  body: z.string().max(65_536),
  /** Quoted to workers as text: https only. */
  url: z.string().max(2_000).url().refine((u) => u.startsWith("https://"), "https only").nullable(),
});
export type ReviewCommentEvent = z.infer<typeof ReviewCommentEvent>;

/** Workstreams whose file ownership covers `path`. Planner globs are untrusted: a bad one matches nothing. */
export function owningWorkstreams<W extends { ownership: readonly string[] }>(workstreams: readonly W[], path: string): W[] {
  const clean = path.replace(/^\.?\//, "");
  return workstreams.filter((w) =>
    w.ownership.some((glob) => {
      try {
        return new Bun.Glob(glob).match(clean);
      } catch {
        return false;
      }
    }),
  );
}

/** Most peers a nudge names as waiting on the worker's answer. */
const NUDGE_NAMES = 3;

/**
 * The direct message to a worker that went quiet while working. `where` says how to post (the exact tool call);
 * `waitingOn` are peers whose questions to it came after its last post (engine-stamped names, never text).
 */
export function nudgeText(input: { agent: string; quietMs: number; where: string; waitingOn: readonly string[] }): string {
  const minutes = Math.max(1, Math.round(input.quietMs / 60_000));
  const names = [...new Set(input.waitingOn.filter((n) => isPeerName(n) && n !== input.agent))].slice(0, NUDGE_NAMES);
  const waiting = names.length > 0 ? ` ${names.join(", ")} asked you something there and ${names.length > 1 ? "are" : "is"} waiting on your answer.` : "";
  return `@${input.agent} Your peers have not heard from you in ${minutes} min. Post a one-line update ${input.where}: what you are doing and what you need.${waiting}`;
}

/** The direct message to a worker a peer is waiting on: named by the engine-stamped asker, never the question's text. */
export function answerText(input: { agent: string; asker: string; waitedMs: number; where: string }): string {
  const minutes = Math.max(1, Math.round(input.waitedMs / 60_000));
  return `@${input.agent} ${input.asker} asked you something ${minutes} min ago and is waiting on your answer. Reply ${input.where}: a short answer, or when you will know.`;
}

/** A quiet worker to nudge, as the monitor found it (activity.ts). */
export interface NudgeInput {
  leaseId: string;
  epoch: number;
  agent: string;
  taskId: string;
  cli: string | null;
  /** Which nudge of the quiet stretch this is, the stretch's start and how long it has lasted. */
  index: number;
  anchor: number;
  quietMs: number;
  waitingOn: readonly string[];
  /** Set for an answer nudge: the peer's question (Relay id, engine-stamped asker, when) it has not answered. */
  question?: { id: string; from: string; at: number } | null;
}

interface Update {
  /** The trace entry number, or another stable id, for the idempotency key. */
  id: string;
  kind: RelayNoticeKind;
  taskId: string;
  to: LeaseView[];
  text(agent: string, lease: LeaseView): string;
  /** Rate group for the send; null for messages bounded some other way (a subagent's end, one per delegation). */
  group?: RateGroup | null;
}

type SendResult = "sent" | "limited" | "gone";

export class Comms {
  readonly #ctx: Ctx;
  readonly #limits: RateLimiter;
  readonly #bootAt: number;
  /** Called after a change that creates outbox work (a subagent to start or stop). */
  readonly #onWork: ((teamId: string) => void) | null;

  constructor(ctx: Ctx, onWork?: (teamId: string) => void) {
    this.#ctx = ctx;
    this.#onWork = onWork ?? null;
    this.#bootAt = ctx.now();
    this.#limits = new RateLimiter({ now: ctx.now, maxKeys: 10_000 });
  }

  // ---------- pushed updates ----------

  /**
   * Tells running workers about what happened since each task's watermark, then moves it. Returns the messages
   * sent. A task without a watermark that is older than this process starts at its current end, so a deploy never
   * sends a backlog; a newer one starts at its first entry.
   */
  async pass(teamId: string): Promise<number> {
    const ctx = this.#ctx;
    const access = await ctx.runtime.relay(teamId);
    if (!access) return 0;
    const [view, marks] = await Promise.all([ctx.wf.getView(teamId), ctx.wf.getNotified(teamId)]);
    let sent = 0;
    for (const summary of Object.values(view.tasks)) {
      const total = summary.traceTotal ?? summary.trace.length;
      let mark = marks[summary.id];
      if (mark === undefined) {
        // A task from before this process started (and so before this layer) starts at its end: no backlog.
        if (summary.createdAt < this.#bootAt) {
          await ctx.wf.markNotified(teamId, summary.id, total);
          continue;
        }
        mark = 0;
      }
      if (mark >= total) continue;
      const tailFrom = total - summary.trace.length;
      const tail = tailFrom <= mark ? summary.trace.slice(mark - tailFrom) : null;
      if (tail && !tail.some((e) => TOLD.has(e.kind))) {
        await ctx.wf.markNotified(teamId, summary.id, total);
        continue;
      }
      const task = await ctx.wf.getTask(teamId, summary.id);
      if (!task) continue;
      const storedFrom = (task.traceTotal ?? task.trace.length) - task.trace.length;
      const entries = task.trace.map((entry, i) => ({ no: storedFrom + i, entry })).filter((e) => e.no >= mark && e.no < total);
      for (const { no, entry } of entries) {
        const line = this.#activityFor(task, view, entry);
        if (line) await this.#post(teamId, access, task, line, `ev-${taskShort(task.id)}-${no}`);
        for (const update of await this.#updatesFor(teamId, task, view, no, entry)) sent += await this.#deliver(teamId, access, update);
      }
      await ctx.wf.markNotified(teamId, task.id, total);
    }
    return sent;
  }

  async #updatesFor(teamId: string, task: TaskRecord, view: WorkforceSnapshot, no: number, entry: TraceEntry): Promise<Update[]> {
    // Subagents hear only from their own parent, never task-wide updates.
    const running = Object.values(view.leases).filter((l) => l.taskId === task.id && l.state === "running" && !l.parentLeaseId);
    const base = { id: `${taskShort(task.id)}-${no}`, taskId: task.id };
    const subject = entry.leaseId ? view.leases[entry.leaseId] : undefined;
    const ws = subject ? task.workstreams.find((w) => w.id === subject.workstreamId) : undefined;
    const others = running.filter((l) => l.id !== entry.leaseId);
    switch (entry.kind) {
      case "task.checkpointed": {
        // A completion is the finishing lease's last checkpoint of a workstream that lease completed.
        if (!subject || !ws || ws.status !== "done" || ws.leaseId !== subject.id || isResolver(ws) || others.length === 0) return [];
        const later = task.trace.some((e, i) => i > task.trace.indexOf(entry) && e.kind === "task.checkpointed" && e.leaseId === subject.id);
        if (later) return [];
        const sha = ws.lastCheckpoint?.sha.slice(0, 12) ?? "its last commit";
        const said = ws.lastCheckpoint?.summary ? ` ${subject.agentName} said: "${quote(ws.lastCheckpoint.summary, 300)}".` : "";
        if (isCompare(task)) {
          // Compare attempts are independent: say who finished, never how to merge it (docs/multi-harness.md).
          const who = ws.harness ? CLI_LABEL[ws.harness] : ws.role;
          return [
            {
              ...base,
              kind: "workstream_done",
              to: others,
              text: (agent) => `@${agent} The ${who} attempt finished on branch ${ws.branch} at ${sha}.${said} Keep going with your own attempt.`,
            },
          ];
        }
        // Workstreams that build on this one start only after it is done (their brief says to merge it), so the
        // workers still running are its peers: refresh their machine's mirror in case they want its changes.
        const synced = await this.#syncMirrors(teamId, task, others);
        // Partners (review, research) wrap up once every workstream they help is done.
        const buildersDone = task.workstreams.filter((w) => !PARTNER_ROLES.includes(w.role)).every((w) => w.status === "done");
        const roleOf = new Map(task.workstreams.map((w) => [w.id, w.role]));
        return [
          {
            ...base,
            kind: "workstream_done",
            to: others,
            text: (agent, lease) => {
              const merge = synced.has(lease.id) ? ` If you need its changes: git fetch origin && git merge origin/${ws.branch}.` : "";
              const partner = buildersDone && PARTNER_ROLES.includes(roleOf.get(lease.workstreamId) ?? "")
                ? ` The work you partner on is done: post your final note in the thread in one or two lines, then post DONE ${lease.id} <one-line summary>.`
                : "";
              return `@${agent} "${quote(ws.title, 120)}" (${ws.role}) is done on branch ${ws.branch} at ${sha}.${said}${merge}${partner}`;
            },
          },
        ];
      }
      case "task.handoff_acked": {
        if (!subject || !ws || others.length === 0) return [];
        const previous = Object.values(view.leases)
          .filter((l) => l.workstreamId === ws.id && l.taskId === task.id && l.epoch < subject.epoch && !l.parentLeaseId)
          .sort((a, b) => b.epoch - a.epoch)[0];
        const stop = previous ? task.trace.findLast((e) => e.leaseId === previous.id && (e.kind === "worker.quota_limited" || e.kind === "worker.offline")) : undefined;
        const why = stop?.kind === "worker.quota_limited" ? "hit its plan's usage limit" : "stopped";
        return [
          {
            ...base,
            kind: "handoff",
            to: others,
            text: (agent) =>
              `@${agent} ${subject.agentName} took over "${quote(ws.title, 120)}" (${ws.role}) on branch ${ws.branch}${previous ? ` from ${previous.agentName}, which ${why}` : ""}. Talk to ${subject.agentName} about that workstream from now on.${previous ? ` If you asked ${previous.agentName} something it never answered, ask ${subject.agentName} again in the task thread.` : ""} Send @${subject.agentName} one line in the ${task.threadId ? "task thread" : "channel"} on where your work meets its.`,
          },
        ];
      }
      case "contract.published": {
        // Only the newest contract of a lease is worth a message; compare attempts build nothing on each other.
        const contract = ws?.contract;
        if (!subject || !ws || !contract || contract.leaseId !== subject.id || isCompare(task) || others.length === 0) return [];
        const later = task.trace.some((e, i) => i > task.trace.indexOf(entry) && e.kind === "contract.published" && e.leaseId === subject.id);
        if (later) return [];
        return [
          {
            ...base,
            kind: "contract",
            to: others,
            text: (agent) =>
              `@${agent} ${subject.agentName} published the interface of "${quote(ws.title, 120)}" (${ws.role}): "${quote(contract.summary, 300)}". The full contract is message ${contract.messageId} in the task thread${task.threadId ? ` (get_message_thread with message_id ${task.threadId})` : ""}. Build against it; if it does not work for you, say so to @${subject.agentName} in the thread.`,
          },
        ];
      }
      case "worker.ready": {
        // A worker that starts after the others: their briefs did not name it. Workers reserved together already
        // know each other, a replacement is announced by its handoff, and a subagent talks only to its parent.
        if (!subject || !ws || subject.parentLeaseId || isResolver(ws) || isCompare(task)) return [];
        const replaced = Object.values(view.leases).some((l) => l.workstreamId === ws.id && l.taskId === task.id && l.epoch < subject.epoch && !l.parentLeaseId);
        const earlier = others.filter((l) => l.createdAt < subject.createdAt);
        if (replaced || earlier.length === 0) return [];
        const profile = view.profiles[subject.profileId];
        const cli = profile ? CLI_LABEL[profile.cli] : null;
        const owns = ws.ownership.length > 0 ? ` It owns ${ws.ownership.slice(0, 6).map((g) => quote(g, 80)).join(", ")}.` : "";
        return [
          {
            ...base,
            kind: "peer_joined",
            to: earlier,
            text: (agent) =>
              `@${agent} ${subject.agentName}${cli ? ` (${cli})` : ""} started on "${quote(ws.title, 120)}" (${ws.role}) on branch ${ws.branch}.${owns} Greet it in the ${task.threadId ? "task thread" : "channel"} now: @${subject.agentName} and one or two lines on what you are working on, the files you own and any CONTRACT it should build on. Then keep going.`,
          },
        ];
      }
      case "subagent.finished": {
        // The parent hears when its subagent ends on its own: a result, or it died. A cancel was its own doing, and
        // a parent that ended stopped its subagents itself.
        const record = task.subagents?.find((r) => r.leaseId === entry.leaseId);
        const parent = record ? view.leases[record.parentLeaseId] : undefined;
        if (!record || (record.status !== "completed" && record.status !== "failed") || !parent || !LIVE.has(parent.state)) return [];
        return [{ ...base, kind: "subagent_done", to: [parent], group: null, text: (agent) => doneText(agent, record) }];
      }
      default:
        return [];
    }
  }

  /**
   * The system line for the task thread about one trace entry, or null. Only for what peers should react to and the
   * dispatcher's direct messages do not already carry alone: a workstream finished and pushed, a worker stopped. Only
   * when another worker of the task is running to read it: every line reaches every worker in the channel.
   */
  #activityFor(task: TaskRecord, view: WorkforceSnapshot, entry: TraceEntry): string | null {
    const subject = entry.leaseId ? view.leases[entry.leaseId] : undefined;
    if (!subject || subject.parentLeaseId || isCompare(task)) return null;
    const ws = task.workstreams.find((w) => w.id === subject.workstreamId);
    if (!ws || isResolver(ws)) return null;
    const others = Object.values(view.leases).some((l) => l.taskId === task.id && l.state === "running" && !l.parentLeaseId && l.id !== subject.id);
    if (!others) return null;
    const title = `"${quote(ws.title, 120)}" (${ws.role})`;
    switch (entry.kind) {
      case "task.checkpointed": {
        // A completion: the finishing lease's last checkpoint of the workstream it completed. A stopped worker's
        // checkpoint is covered by its stop line.
        if (ws.status !== "done" || ws.leaseId !== subject.id) return null;
        if (task.trace.some((e, i) => i > task.trace.indexOf(entry) && e.kind === "task.checkpointed" && e.leaseId === subject.id)) return null;
        return `${subject.agentName} finished ${title} and pushed ${ws.lastCheckpoint?.sha.slice(0, 12) ?? "its last commit"} on ${ws.branch}.`;
      }
      case "worker.quota_limited":
      case "worker.offline": {
        if (ws.status === "done") return null;
        const why = entry.kind === "worker.quota_limited" ? "hit its plan's usage limit and stopped" : "stopped before finishing";
        return `${subject.agentName} ${why}. ${APP_NAME} is moving ${title} to a new worker from its last checkpoint: do not wait on ${subject.agentName}.`;
      }
      default:
        return null;
    }
  }

  /**
   * One system line in the task thread (the channel when the task has none), rate limited per task. Best effort: a
   * failure is logged and never holds up the updates. The Relay key makes a resend after a crash the same message.
   */
  async #post(teamId: string, access: TeamRelayAccess, task: Pick<TaskRecord, "id" | "projectId" | "threadId">, text: string, key: string): Promise<boolean> {
    const ctx = this.#ctx;
    if (!this.#limits.take("agentActivity", `${teamId}/${task.id}`).ok) {
      ctx.log.info("activity line skipped: rate limited", { teamId, taskId: task.id });
      return false;
    }
    const notice: RelayNotice = { kind: "activity", taskId: task.id, to: [] };
    try {
      if (task.threadId) await ctx.ports.relay.reply(access, dispatcherSpeaker(access), task.threadId, text, key, notice);
      else await ctx.ports.relay.post(access, dispatcherSpeaker(access), await ctx.ports.relay.ensureChannel(access, task.projectId), text, key, notice);
      return true;
    } catch (error) {
      ctx.log.warn("activity line not posted", { teamId, taskId: task.id, error });
      return false;
    }
  }

  /** A system line about a task, from the monitor (a worker's test results). Rate limited per task, best effort. */
  async activity(teamId: string, taskId: string, text: string, key: string): Promise<boolean> {
    const ctx = this.#ctx;
    const access = await ctx.runtime.relay(teamId);
    if (!access) return false;
    const task = await ctx.wf.getTask(teamId, taskId);
    if (!task) return false;
    return this.#post(teamId, access, task, text, key);
  }

  /**
   * Nudges a quiet worker by direct message (activity.ts). Bounded by the schedule, not a rate limit. The key comes
   * from the lease, its epoch, the quiet stretch and the nudge's number, so a replay or a restarted process that
   * sees the same silence maps to the same Relay message. Throws on a Relay error other than an unknown recipient.
   */
  async nudge(teamId: string, input: NudgeInput): Promise<"sent" | "gone" | "skipped"> {
    const ctx = this.#ctx;
    const access = await ctx.runtime.relay(teamId);
    if (!access) return "skipped";
    const task = await ctx.wf.getTask(teamId, input.taskId);
    if (!task) return "skipped";
    const channel = task.threadId ? null : await ctx.ports.relay.ensureChannel(access, task.projectId);
    const where = task.threadId
      ? `in the task thread with ${postCall({ channel: "", threadId: task.threadId, cli: input.cli })}`
      : `in #${channel} with ${postCall({ channel: channel!, threadId: null, cli: input.cli })}`;
    const q = input.question;
    const text =
      q && isPeerName(q.from)
        ? answerText({ agent: input.agent, asker: q.from, waitedMs: ctx.now() - q.at, where })
        : nudgeText({ agent: input.agent, quietMs: input.quietMs, where, waitingOn: input.waitingOn });
    // One answer nudge per question; one quiet nudge per step of a quiet stretch.
    const key = q ? `ndq-${digest(`${input.leaseId}|e${input.epoch}|${q.id}`, 24)}` : `ndg-${digest(`${input.leaseId}|e${input.epoch}|${input.anchor}|${input.index}`, 24)}`;
    const result = await this.#send(teamId, access, input.agent, text, key, { kind: "nudge", taskId: task.id, to: [input.agent] }, null);
    ctx.log.info("worker nudged", { teamId, leaseId: input.leaseId, nudge: input.index, quietMs: input.quietMs, result });
    return result === "sent" ? "sent" : "gone";
  }

  /**
   * Refreshes the mirror on each running worker's machine (once per machine) so `git fetch origin` there sees a
   * finished branch. Best effort: returns the leases whose machine was refreshed.
   */
  async #syncMirrors(teamId: string, task: TaskRecord, leases: LeaseView[]): Promise<Set<string>> {
    const ctx = this.#ctx;
    const synced = new Set<string>();
    if (leases.length === 0) return synced;
    const project = await findProject(ctx, teamId, task.projectId);
    if (!project) return synced;
    const byEnv = new Map<string, LeaseView[]>();
    for (const lease of leases) {
      const profile = await ctx.wf.getProfile(teamId, lease.profileId);
      if (profile) byEnv.set(profile.envId, [...(byEnv.get(profile.envId) ?? []), lease]);
    }
    for (const [envId, onEnv] of byEnv) {
      try {
        const vm = await vmTarget(ctx, teamId, envId);
        if (!vm.ok) continue;
        await ctx.ports.vm.syncMirror({ ...vm.target, repoFullName: project.repoFullName, githubToken: await ownerGithubToken(ctx, vm.env) });
        for (const lease of onEnv) synced.add(lease.id);
      } catch (error) {
        ctx.log.warn("could not refresh a worker machine's mirror", { teamId, envId, error });
      }
    }
    return synced;
  }

  async #deliver(teamId: string, access: TeamRelayAccess, update: Update): Promise<number> {
    let sent = 0;
    const to = update.to.map((l) => l.agentName);
    for (const lease of update.to) {
      const notice: RelayNotice = { kind: update.kind, taskId: update.taskId, to: [lease.agentName] };
      const key = `nt-${update.id}-${digest(lease.agentName, 10)}`;
      const result = await this.#send(teamId, access, lease.agentName, update.text(lease.agentName, lease), key, notice, update.group === undefined ? "agentUpdate" : update.group);
      if (result === "sent") sent++;
    }
    this.#ctx.log.info("worker update", { teamId, taskId: update.taskId, kind: update.kind, recipients: to.length, sent });
    return sent;
  }

  /**
   * One rate-limited direct message from the Morrow system identity. A worker over its budget misses this one and
   * is told so with its next. A worker Relay no longer knows is skipped; anything else throws, so the pass stops
   * before the watermark moves and the next pass resends under the same key.
   */
  async #send(teamId: string, access: TeamRelayAccess, agent: string, text: string, key: string, notice: RelayNotice, group: RateGroup | null = "agentUpdate"): Promise<SendResult> {
    const ctx = this.#ctx;
    const skipped = ctx.memory.team(teamId).skippedUpdates;
    if (group !== null && !this.#limits.take(group, `${teamId}/${agent}`).ok) {
      if (group === "agentUpdate") skipped.add(agent);
      ctx.log.info("worker update skipped: rate limited", { teamId, agent, kind: notice.kind });
      return "limited";
    }
    // The note goes above the tag line: morrow-agent reads the tag from the end of the message.
    const body = skipped.has(agent) ? withNote(text, SKIPPED_NOTE) : text;
    try {
      await ctx.ports.relay.direct(access, dispatcherSpeaker(access), agent, body, key, notice);
    } catch (error) {
      if (isRelayNotFound(error)) return "gone";
      throw error;
    }
    skipped.delete(agent);
    return "sent";
  }

  // ---------- peers (peers.ts) ----------

  /**
   * A worker's `CONTRACT <leaseId> <summary>`: recorded on the workstream when `agent` (the engine-stamped sender) is
   * that live lease's own worker, never a subagent's. The actor's trace entry is what tells the other workers. Rate
   * limited on intake; keyed by the message id, so a replay records nothing new. Returns whether it was recorded.
   */
  async contract(teamId: string, agent: string, messageId: string, text: string): Promise<boolean> {
    const ctx = this.#ctx;
    const parsed = parseContract(text);
    if (!parsed) return false;
    if (!this.#limits.take("agentPeer", `${teamId}/${agent}`).ok) {
      ctx.log.info("contract dropped: rate limited", { teamId, agent });
      return false;
    }
    const lease = await ctx.wf.getLease(teamId, parsed.leaseId);
    // Anyone with the workspace key can post this text; only the lease's own agent counts (architecture 10).
    if (!lease || lease.agentName !== agent || !LIVE.has(lease.state) || lease.parentLeaseId) {
      ctx.log.warn("contract ignored: sender is not the lease's live worker", { teamId, leaseId: parsed.leaseId });
      return false;
    }
    const result = await ctx.wf.recordContract(teamId, lease.id, lease.epoch, parsed.summary, messageId, `ct-${digest(messageId, 24)}`);
    ctx.log.info("contract", { teamId, leaseId: lease.id, recorded: result.ok, reason: result.ok ? null : result.reason });
    if (!result.ok) return false;
    const memory = ctx.memory.team(teamId);
    memory.rememberContract(messageId, parsed.body);
    memory.hotUntil = ctx.now() + ctx.timing.hotWindowMs;
    return true;
  }

  // ---------- STATUS ----------

  /**
   * Answers a worker's STATUS by direct message. Only a live lease's own agent gets an answer (the engine stamps the
   * sender); the answer covers that lease's task only. Keyed by the request's message id, so a replayed request
   * never answers twice.
   */
  async status(teamId: string, agent: string, requestId: string): Promise<boolean> {
    const ctx = this.#ctx;
    const access = await ctx.runtime.relay(teamId);
    if (!access) return false;
    const view = await ctx.wf.getView(teamId);
    const lease = Object.values(view.leases).find((l) => l.agentName === agent && LIVE.has(l.state));
    if (!lease) return false;
    const task = await ctx.wf.getTask(teamId, lease.taskId);
    if (!task) return false;
    const roster = await taskRoster(ctx, teamId, task, view);
    const text = statusText({ agent, task, roster, selfWorkstreamId: lease.workstreamId });
    const key = `st-${digest(`${agent}|${requestId}`, 24)}`;
    const result = await this.#send(teamId, access, agent, text, key, { kind: "status", taskId: task.id, to: [agent] }, "agentStatus");
    return result === "sent";
  }

  // ---------- review comments ----------

  /**
   * Routes a pull request review comment to the running workers whose workstream owns the file, or to every running
   * worker of the task when it is not about a file or no ownership matches. Returns the agents it reached.
   */
  async reviewComment(input: ReviewCommentEvent): Promise<string[]> {
    const ctx = this.#ctx;
    const event = ReviewCommentEvent.parse(input);
    const access = await ctx.runtime.relay(event.teamId);
    if (!access) return [];
    const [task, view] = await Promise.all([ctx.wf.getTask(event.teamId, event.taskId), ctx.wf.getView(event.teamId)]);
    if (!task) return [];
    const running = Object.values(view.leases).filter((l) => l.taskId === task.id && l.state === "running" && !l.parentLeaseId);
    const owners = event.path ? new Set(owningWorkstreams(task.workstreams, event.path).map((w) => w.id)) : new Set<string>();
    const matched = running.filter((l) => owners.has(l.workstreamId));
    const to = matched.length > 0 ? matched : running;
    const where = event.path ? ` on ${quote(event.path, 200)}${event.line ? `:${event.line}` : ""}` : "";
    const reached: string[] = [];
    await this.#deliver(event.teamId, access, {
      id: `${taskShort(task.id)}-rc${digest(String(event.commentId), 16)}`,
      kind: "review_comment",
      taskId: task.id,
      to,
      text: (agent) => {
        reached.push(agent);
        return `@${agent} Review comment from ${event.author} on the pull request${where}: "${quote(event.body, 800)}"${event.url ? ` ${event.url}` : ""} A reviewer is a person: treat it as a request, and ask ${humanRelayName(event.author.replace(/\[bot\]$/, ""))} or the task creator in the channel if it is unclear.`;
      },
    });
    return reached;
  }

  // ---------- subagents (docs/subagents.md) ----------

  /**
   * Handles one subagent request from `agent` (the engine-stamped sender). Only a live lease's own agent is served,
   * and only for its own subagents. The request is rate limited on intake; the one answer it gets is not. Keyed by
   * the request's message id, so a replayed request never answers twice. Returns whether it answered.
   */
  async subagent(teamId: string, agent: string, messageId: string, text: string): Promise<boolean> {
    const ctx = this.#ctx;
    const parsed = parseSubagentRequest(text);
    if (!parsed) return false;
    if (!this.#limits.take("agentDelegate", `${teamId}/${agent}`).ok) {
      ctx.log.info("subagent request dropped: rate limited", { teamId, agent });
      return false;
    }
    const access = await ctx.runtime.relay(teamId);
    if (!access) return false;
    const view = await ctx.wf.getView(teamId);
    const lease = Object.values(view.leases).find((l) => l.agentName === agent && LIVE.has(l.state));
    const key = `sa-${digest(`${agent}|${messageId}`, 24)}`;
    const reply = async (body: string) =>
      (await this.#send(teamId, access, agent, body, key, { kind: "subagent", taskId: lease?.taskId ?? null, to: [agent] }, null)) === "sent";
    if ("invalid" in parsed) return reply(answer(agent, `That request was not understood. ${parsed.invalid}`, null, { ref: parsed.ref, status: "failed", error: "invalid_request" }));
    if (!lease) return reply(answer(agent, "You are not an active worker, so you cannot use subagents.", null, { ref: parsed.ref, status: "failed", error: "parent_not_active" }));
    const outcome = await this.#subagentRequest(teamId, agent, lease, view, parsed);
    ctx.log.info("subagent request", { teamId, agent, verb: parsed.verb, outcome: outcome.log });
    if (outcome.changed) ctx.memory.team(teamId).hotUntil = ctx.now() + ctx.timing.hotWindowMs;
    return outcome.text ? reply(outcome.text) : false;
  }

  async #subagentRequest(
    teamId: string,
    agent: string,
    lease: LeaseView,
    view: WorkforceSnapshot,
    request: SubagentRequest,
  ): Promise<{ text: string | null; log: string; changed: boolean }> {
    const ctx = this.#ctx;
    const ref = request.ref;
    const refuse = (error: "invalid_request" | "task_not_found", why: string) => ({
      text: answer(agent, why, null, { ref, status: "failed", error }),
      log: error,
      changed: false,
    });
    const isChild = Boolean(lease.parentLeaseId);
    if (request.verb === "RESULT") {
      if (!isChild) return refuse("invalid_request", "RESULT is for subagents. Workers finish with DONE.");
      const result = await ctx.wf.recordSubagentResult(teamId, lease.id, lease.epoch, request.status, request.result, `sr-${lease.id}-e${lease.epoch}`);
      if (!result.ok) return refuse("invalid_request", "Your result could not be recorded.");
      const recorded = result.subagent;
      return {
        text: answer(agent, result.recorded ? "Result recorded. You are done: stop now." : "Your result was already recorded. Stop now.", null, { ref, task: recorded.leaseId, status: recorded.status === "running" ? null : recorded.status }),
        log: result.recorded ? "recorded" : "duplicate",
        changed: result.recorded,
      };
    }
    if (isChild) return refuse("invalid_request", "A subagent cannot start or manage subagents. Report your result with RESULT.");

    const own = view.profiles[lease.profileId];
    if (request.verb === "SUBAGENT_OPTIONS") {
      const running = Object.values(view.leases).filter((l) => l.parentLeaseId === lease.id && LIVE.has(l.state)).length;
      // A manual task's subagents may only run on its pins (the actor refuses others): offer only those as ready.
      const task = await ctx.wf.getTask(teamId, lease.taskId);
      const pinned = task?.mode === "manual" ? new Set(task.pins) : null;
      return { text: optionsText(agent, ref, own ? subagentOptions(view, own, pinned) : [], running, SUBAGENTS_PER_WORKER), log: "options", changed: false };
    }
    if (request.verb === "DELEGATE") {
      const result = await ctx.wf.delegate(teamId, { parentLeaseId: lease.id, target: request.target, role: request.role, task: request.task, clientRequestId: request.ref });
      if (!result.ok) {
        const why = delegateRefusal(result.reason, request.target);
        return { text: answer(agent, `Could not start a subagent. ${why.text}`, null, { ref, status: "failed", error: why.error, target: request.target, role: request.role }), log: result.reason, changed: false };
      }
      const sub = result.subagent;
      if (!result.created) return { text: recordText(agent, ref, sub), log: "retry", changed: false };
      this.#onWork?.(teamId);
      return {
        text: answer(
          agent,
          `Started ${sub.agentName} for the ${roleNoun(request.role)} (task ${sub.leaseId}). Its result comes to you as a message from @${DISPATCHER_NAME}: keep working or end your turn, and do not poll.`,
          null,
          { ref, task: sub.leaseId, status: "starting", agent: sub.agentName, target: sub.cli, role: sub.role },
        ),
        log: "started",
        changed: true,
      };
    }
    // TASK_STATUS and TASK_CANCEL: only this worker's own subagents, from the task record.
    const task = await ctx.wf.getTask(teamId, lease.taskId);
    const record = task?.subagents?.find((r) => r.leaseId === request.taskId && r.parentLeaseId === lease.id);
    if (!record) return refuse("task_not_found", `You have no subagent task ${request.taskId}.`);
    if (request.verb === "TASK_STATUS") return { text: recordText(agent, ref, record), log: "status", changed: false };
    const result = await ctx.wf.cancelSubagent(teamId, lease.id, record.leaseId, request.reason);
    if (!result.ok) return refuse("task_not_found", `You have no subagent task ${request.taskId}.`);
    if (result.cancelled) this.#onWork?.(teamId);
    return { text: recordText(agent, ref, result.subagent, result.cancelled ? `Stopped ${result.subagent.agentName} (task ${result.subagent.leaseId}).` : undefined), log: result.cancelled ? "cancelled" : "already_ended", changed: result.cancelled };
  }
}
