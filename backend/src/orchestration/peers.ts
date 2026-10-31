// Peer coordination over Relay (architecture 9.8): the task thread workers talk in, the interface contracts they
// publish there, and the conversations a replacement worker inherits.
//  - Task thread: one kickoff post per task in the project channel, from the dispatcher. Its replies are the task
//    thread. The root id is stored on the task in the actor (first write wins), so every worker of the task, and
//    every replacement, gets the same thread.
//  - Contracts: `CONTRACT <leaseId> <summary>` with the details on the lines below. The actor keeps the newest
//    summary per workstream (fenced to the live lease); the full text stays in Relay and is read back for briefs.
//  - Talk: messages that @mention someone, kept in memory and read back from the thread, so a handoff note can say
//    what peers asked the stopped worker and what it never answered.
// Everything here quotes agent text: control characters gone, credentials masked, clipped, under a fixed header.
import { APP_NAME, type RelayMessageView } from "@morrow/contracts";
import { redactSecrets } from "../runtime/inspect.ts";
import type { TeamRelayAccess } from "../runtime/types.ts";
import type { Ctx } from "./context.ts";
import type { Talk } from "./memory.ts";
import { digest, taskShort } from "./names.ts";
import { cleanLine, cleanText } from "./planner/shape.ts";
import { dispatcherSpeaker } from "./ports.ts";
import type { TaskRecord } from "./workforce.ts";

export const CONTRACT_SUMMARY_CHARS = 300;
export const CONTRACT_BODY_CHARS = 2_000;
/** Most messages a handoff note quotes per section. */
export const HANDOFF_TALK = 10;

/** The engine's mention rule (`@name` after the start or whitespace). Thread reply events carry no mention list. */
const MENTION = /(?:^|\s)@([\w-]{1,64})/g;
const PEER_NAME = /^[wh]-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CONTRACT_LINE = /^CONTRACT\s+([A-Za-z0-9._-]{1,128})\s+(\S.*)$/;

/** A worker's (`w-`) or a person's (`h-`) Relay name. */
export function isPeerName(name: string): boolean {
  return PEER_NAME.test(name);
}

/** Who a message @mentions among workers and people: the engine's list plus what the text says. */
export function mentionsOf(message: Pick<RelayMessageView, "mentions" | "text">): string[] {
  const names = new Set<string>();
  for (const m of message.mentions) names.add(m.replace(/^@/, ""));
  for (const match of message.text.matchAll(MENTION)) names.add(match[1]!);
  return [...names].filter((n) => PEER_NAME.test(n));
}

/** A message from a worker or a person that mentions someone else, as the talk log keeps it. */
export function talkOf(message: RelayMessageView): Talk | null {
  const from = message.from.name;
  if (message.type !== "message" || !PEER_NAME.test(from)) return null;
  const to = mentionsOf(message).filter((n) => n !== from);
  if (to.length === 0) return null;
  return { id: message.id, from, to, text: message.text, at: message.createdAt, threadId: message.threadId };
}

/** `CONTRACT <leaseId> <summary>` on the first line, the details below. Summary and body are masked and clipped. */
export function parseContract(text: string): { leaseId: string; summary: string; body: string } | null {
  const [first = "", ...rest] = text.trim().split("\n");
  const match = CONTRACT_LINE.exec(first.trim());
  if (!match) return null;
  const summary = cleanLine(redactSecrets(match[2]!), CONTRACT_SUMMARY_CHARS);
  if (!summary) return null;
  return { leaseId: match[1]!, summary, body: cleanText(redactSecrets(rest.join("\n")), CONTRACT_BODY_CHARS) };
}

export function kickoffText(task: Pick<TaskRecord, "id" | "title">): string {
  return `Task thread for "${cleanLine(redactSecrets(task.title), 120)}" (${taskShort(task.id)}). ${APP_NAME} workers on this task reply here: interface contracts (CONTRACT lines), questions to a peer (@name) and their answers.`;
}

/**
 * The task thread's root id: the stored one, or a new kickoff post. Spawns racing in this process share one start;
 * across processes the post's Relay idempotency key (per task) makes one message within the engine's 24 h key
 * window, and the actor keeps the first id stored either way. Null when Relay or the actor fails: the worker then
 * coordinates in the channel instead, and the next spawn tries again.
 */
export async function ensureTaskThread(
  ctx: Ctx,
  teamId: string,
  access: TeamRelayAccess,
  task: Pick<TaskRecord, "id" | "title" | "threadId">,
  channel: string,
): Promise<string | null> {
  if (task.threadId) return task.threadId;
  const memory = ctx.memory.team(teamId);
  const pending = memory.threadStarts.get(task.id);
  if (pending) return pending;
  const start = startTaskThread(ctx, teamId, access, task, channel).then((threadId) => {
    if (threadId === null && memory.threadStarts.get(task.id) === start) memory.threadStarts.delete(task.id);
    return threadId;
  });
  memory.rememberThreadStart(task.id, start);
  return start;
}

async function startTaskThread(ctx: Ctx, teamId: string, access: TeamRelayAccess, task: Pick<TaskRecord, "id" | "title">, channel: string): Promise<string | null> {
  try {
    const posted = await ctx.ports.relay.post(access, dispatcherSpeaker(access), channel, kickoffText(task), `kick-${digest(task.id, 24)}`, {
      kind: "kickoff",
      taskId: task.id,
      to: [],
    });
    const stored = await ctx.wf.setTaskThread(teamId, task.id, posted.id);
    if (!stored.ok) return null;
    ctx.log.info("task thread started", { teamId, taskId: task.id, reused: stored.threadId !== posted.id });
    return stored.threadId;
  } catch (error) {
    ctx.log.warn("task thread not started; workers use the channel", { teamId, taskId: task.id, error });
    return null;
  }
}

/** A peer's published contract as briefs and handoff notes list it. `body` is null when Relay could not be read. */
export interface PeerContract {
  role: string;
  title: string;
  agent: string;
  summary: string;
  messageId: string;
  body: string | null;
}

/**
 * The newest contract of every workstream except `exceptWorkstreamId`, with its full text (cached per message, else
 * read from Relay as the dispatcher). Best effort: a failed read leaves the body out, never the contract.
 */
export async function peerContracts(
  ctx: Ctx,
  teamId: string,
  access: TeamRelayAccess | null,
  task: Pick<TaskRecord, "workstreams">,
  exceptWorkstreamId: string | null,
): Promise<PeerContract[]> {
  const memory = ctx.memory.team(teamId);
  const out: PeerContract[] = [];
  for (const ws of task.workstreams) {
    const contract = ws.contract;
    if (!contract || ws.id === exceptWorkstreamId) continue;
    let body = memory.contractBodies.get(contract.messageId) ?? null;
    if (body === null && access) {
      try {
        const message = await ctx.ports.relay.message(access, contract.messageId);
        // Only the publisher's own message counts, and only while it still is a contract.
        body = message.from.name === contract.agentName ? (parseContract(message.text)?.body ?? null) : null;
        if (body !== null) memory.rememberContract(contract.messageId, body);
      } catch (error) {
        ctx.log.warn("contract text unavailable", { teamId, messageId: contract.messageId, error });
      }
    }
    out.push({ role: ws.role, title: ws.title, agent: contract.agentName, summary: contract.summary, messageId: contract.messageId, body: body || null });
  }
  return out;
}

/**
 * What peers said to a stopped worker, from the task thread (when readable) and the talk log: every message that
 * mentions it, and the ones it never answered (no later message from it mentions the asker). Newest last, bounded.
 */
export async function handoffTalk(
  ctx: Ctx,
  teamId: string,
  access: TeamRelayAccess | null,
  task: Pick<TaskRecord, "threadId">,
  oldAgent: string,
): Promise<{ toOld: Talk[]; open: Talk[] }> {
  const all = new Map<string, Talk>();
  if (access && task.threadId) {
    try {
      for (const message of await ctx.ports.relay.thread(access, task.threadId)) {
        const talk = talkOf(message);
        if (talk) all.set(talk.id, talk);
      }
    } catch (error) {
      ctx.log.warn("task thread unavailable for a handoff note", { teamId, error });
    }
  }
  for (const talk of ctx.memory.team(teamId).talk()) all.set(talk.id, talk);
  const list = [...all.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const toOld = list.filter((t) => t.from !== oldAgent && t.to.includes(oldAgent));
  const open = toOld.filter((q) => !list.some((r) => r.from === oldAgent && r.at >= q.at && r.id !== q.id && r.to.includes(q.from)));
  return { toOld: toOld.slice(-HANDOFF_TALK), open: open.slice(-HANDOFF_TALK) };
}
