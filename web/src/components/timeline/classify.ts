import type { RelayEventView, RelayNotice } from "@morrow/contracts";
import { relayEventKey, relayEventTime } from "@/lib/store/relay";

export type MessageEvent = Extract<RelayEventView, { type: "message" }>;
export type StatusEvent = Exclude<RelayEventView, { type: "message" }>;

export type LifecycleTone = "neutral" | "success" | "warning" | "danger";
export type LifecycleIcon = "ack" | "done" | "limit" | "handoff" | "online" | "offline" | "exit" | "system" | "subagent";

/** A line that marks a change in the work rather than a conversation turn. */
export type Lifecycle = {
  icon: LifecycleIcon;
  tone: LifecycleTone;
  /** Who it is about (agent, node or sender name), shown before the label. Null for system lines. */
  actor: string | null;
  label: string;
  detail: string | null;
};

export type TimelineRow =
  | { kind: "agent"; key: string; at: number; event: MessageEvent; showHeader: boolean }
  | { kind: "human"; key: string; at: number; event: MessageEvent }
  | { kind: "dm"; key: string; at: number; event: MessageEvent }
  /** A Morrow system update to a worker: what it was told, shown as such rather than as a raw protocol line. */
  | { kind: "notice"; key: string; at: number; event: MessageEvent; notice: RelayNotice }
  /** A worker's interface contract (`CONTRACT <leaseId> <summary>`, details below): shown as a card, all as text. */
  | { kind: "contract"; key: string; at: number; event: MessageEvent; contract: ContractLine }
  | { kind: "lifecycle"; key: string; at: number; lifecycle: Lifecycle }
  /** A run of short updates from one agent, folded so multi-agent noise does not drown the screen. */
  | { kind: "work"; key: string; at: number; actor: string; events: MessageEvent[] }
  /** A run of status changes (agents joining, nodes dropping) folded into one line. */
  | { kind: "status-run"; key: string; at: number; items: Lifecycle[] };

/** What a CONTRACT message says. `body` is the lines below the first, as sent. */
export type ContractLine = { leaseId: string; summary: string; body: string };

export type TimelineScope = "all" | "channel" | "dms" | "threads";
export type TimelineFilter = { scope: TimelineScope; agent: string | null };

/** Every message from everyone: the filter the views start with and "Clear filter" goes back to. */
export const ALL_MESSAGES: TimelineFilter = { scope: "all", agent: null };

/** True when the filter hides something, compared by value (picking "All" again is not a filter). */
export const isFiltered = (filter: TimelineFilter) => filter.scope !== "all" || filter.agent !== null;

/** `CONTRACT <leaseId> <summary>` on the first line, the same tokens the backend records (peers.ts). */
const CONTRACT = /^CONTRACT\s+([A-Za-z0-9._-]{1,128})\s+(\S.*)$/;
/** `ACK <leaseId>` / `DONE <leaseId> <summary>` on the first line, the same tokens the backend acts on. */
const CONTROL = /^(ACK|DONE)\s+([A-Za-z0-9._-]{1,128})(?:\s+(.*))?$/;
const LIMIT = /\b(?:usage|rate) limit|\bquota\b|\blimit (?:reached|detected|hit)\b/i;
const HANDOFF = /\bhand(?:ing)? ?off\b|\bhandoff\b|\breplacement\b/i;
/** A worker asking Morrow for the task's state (architecture 9.8). */
const STATUS_REQUEST = /^(?:@dispatcher\s+)?STATUS\??$/;
/** A worker or subagent talking to Morrow about subagents (docs/subagents.md, wire protocol). */
const SUBAGENT_VERB = /^(?:@dispatcher\s+)?(SUBAGENT_OPTIONS|DELEGATE|TASK_STATUS|TASK_CANCEL|RESULT)\s+[A-Za-z0-9._-]{1,64}(?:\s+(.*))?$/;
/** The machine-readable last line of a dispatcher answer: `[morrow task=ls-7 status=completed ...]`. */
const MORROW_TAG = /\n?[ \t]*\[morrow(?:\s+[a-z]+=[^\s\]]*)*\][ \t]*$/;
/** Subagents are named `w-<task>-<role>-sub-e<epoch>`; only they report results, only workers delegate. */
const SUBAGENT_NAME = /^w-[a-z0-9-]+-sub-e[1-9][0-9]{0,15}$/;
/** Format characters (direction overrides, zero-width, tag characters) and Unicode line breaks can reorder or hide text. */
const HIDDEN = /[\p{Cf}\u2028\u2029]/gu;
const TARGET_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "opencode", cursor: "Cursor Agent", gemini: "Gemini CLI", grok: "Grok" };
const ROLE_NOUN: Record<string, string> = { review: "a review", research: "research", implementation: "an implementation", test: "a test pass", general: "a task" };

/** Updates this short, on one line, fold into a work group when an agent posts several in a row. */
export const UPDATE_MAX_CHARS = 160;
/** Fewer than this many updates in a row stay as separate rows. */
export const WORK_GROUP_MIN = 3;
export const STATUS_GROUP_MIN = 3;
/** Rows from the same sender closer than this share one header. */
const SAME_TURN_MS = 5 * 60_000;

const firstLine = (text: string) => text.trim().split("\n", 1)[0] ?? "";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const visible = (text: string) => text.replace(HIDDEN, "");
const restOf = (text: string) => visible(text).trim().split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();

/** A dispatcher answer without its trailing `[morrow ...]` tag line, which is for the agent's tools, not people. */
export function stripMorrowTag(text: string): string {
  return text.replace(MORROW_TAG, "").trimEnd();
}

/** The subagent protocol line a worker or subagent sent, as a lifecycle line, or null. */
function subagentLifecycle(event: MessageEvent, line: string): Lifecycle | null {
  const match = SUBAGENT_VERB.exec(visible(line));
  if (!match) return null;
  const [, verb, rest = ""] = match;
  // A RESULT is a subagent's and the rest are a worker's; the same words from anyone else are just conversation.
  if ((verb === "RESULT") !== SUBAGENT_NAME.test(event.from.name)) return null;
  const args = visible(rest).trim().split(/\s+/).filter(Boolean);
  const body = restOf(event.text);
  const detail = body ? clip(body, 200) : null;
  const actor = event.from.name;
  switch (verb) {
    case "SUBAGENT_OPTIONS":
      return { icon: "subagent", tone: "neutral", actor, label: "asked which subagents it can start", detail: null };
    case "DELEGATE": {
      const target = TARGET_LABEL[args[0] ?? ""] ?? "a subagent";
      const noun = ROLE_NOUN[args[1] ?? ""] ?? "a task";
      return { icon: "subagent", tone: "neutral", actor, label: `asked ${target} for ${noun}`, detail };
    }
    case "TASK_STATUS":
      return { icon: "subagent", tone: "neutral", actor, label: "checked on a subagent", detail: args[0] ?? null };
    case "TASK_CANCEL":
      return { icon: "subagent", tone: "neutral", actor, label: "stopped a subagent", detail: clip([args[0], body].filter(Boolean).join(": "), 200) || null };
    default:
      return args[0] === "failed"
        ? { icon: "subagent", tone: "warning", actor, label: "reported it could not finish", detail }
        : { icon: "done", tone: "success", actor, label: "reported its result", detail };
  }
}

export const isDm = (event: MessageEvent) => event.conversationId !== null;
export const isThreaded = (event: MessageEvent) => event.threadId !== null || event.parentId !== null;

/** Lifecycle meaning of a message, or null when it is ordinary conversation. */
export function messageLifecycle(event: MessageEvent): Lifecycle | null {
  const line = firstLine(event.text);
  const control = CONTROL.exec(line);
  if (control) {
    const [, verb, , rest] = control;
    // The ACK names the replaced worker's lease id: meaningless to a person, so the row shows no detail.
    return verb === "ACK"
      ? { icon: "ack", tone: "success", actor: event.from.name, label: "acknowledged the handoff", detail: null }
      : { icon: "done", tone: "success", actor: event.from.name, label: "reported done", detail: rest?.trim() ? clip(rest.trim(), 200) : null };
  }
  if (event.from.kind === "agent" && STATUS_REQUEST.test(line)) return { icon: "system", tone: "neutral", actor: event.from.name, label: "asked for the task status", detail: null };
  if (event.from.kind === "agent") {
    const subagent = subagentLifecycle(event, line);
    if (subagent) return subagent;
  }
  // Only system senders become dividers on keywords; an agent writing about rate limits is still talking.
  if (event.from.kind !== "system") return null;
  const label = clip(line || "System message", 200);
  if (LIMIT.test(event.text)) return { icon: "limit", tone: "warning", actor: null, label, detail: null };
  if (HANDOFF.test(event.text)) return { icon: "handoff", tone: "neutral", actor: null, label, detail: null };
  return { icon: "system", tone: "neutral", actor: null, label, detail: null };
}

/** A worker's CONTRACT message, or null. Only agents publish contracts; hidden characters are removed. */
export function parseContractLine(event: MessageEvent): ContractLine | null {
  if (event.from.kind !== "agent") return null;
  const [first = "", ...rest] = visible(event.text).trim().split("\n");
  const match = CONTRACT.exec(first.trim());
  if (!match) return null;
  return { leaseId: match[1]!, summary: clip(match[2]!.trim(), 300), body: rest.join("\n").trim() };
}

/** What a notice says, without the leading `@<worker>` that addresses it on Relay. */
export function noticeBody(text: string, notice: RelayNotice): string {
  const body = stripMorrowTag(text.trim());
  for (const name of notice.to) if (body.startsWith(`@${name} `)) return body.slice(name.length + 2).trimStart();
  return body;
}

export function statusLifecycle(event: StatusEvent): Lifecycle {
  if (event.type === "node.status") {
    return event.status === "online"
      ? { icon: "online", tone: "neutral", actor: event.nodeName, label: "node online", detail: event.reason }
      : { icon: "offline", tone: "warning", actor: event.nodeName, label: "node offline", detail: event.reason };
  }
  if (event.status === "active") return { icon: "online", tone: "neutral", actor: event.agentName, label: "is online", detail: null };
  if (event.status === "offline") return { icon: "offline", tone: "warning", actor: event.agentName, label: "went offline", detail: event.reason };
  return { icon: "exit", tone: "neutral", actor: event.agentName, label: "exited", detail: event.reason };
}

/** Which events a filter keeps. Status changes only show in the unfiltered view or for their agent. */
export function matchesFilter(event: RelayEventView, filter: TimelineFilter): boolean {
  if (filter.agent) {
    const name = filter.agent;
    if (event.type === "node.status") return false;
    if (event.type === "agent.status" && event.agentName !== name) return false;
    if (event.type === "message" && event.from.name !== name && !event.mentions.includes(name) && !event.notice?.to.includes(name)) return false;
  }
  if (filter.scope === "all") return true;
  if (event.type !== "message") return false;
  switch (filter.scope) {
    case "channel":
      return !isDm(event) && !isThreaded(event);
    case "dms":
      return isDm(event);
    case "threads":
      return isThreaded(event);
  }
}

function isUpdate(event: MessageEvent): boolean {
  const text = event.text.trim();
  return text.length > 0 && text.length <= UPDATE_MAX_CHARS && !text.includes("\n");
}

type Single =
  | { kind: "agent" | "human" | "dm"; event: MessageEvent }
  | { kind: "notice"; event: MessageEvent; notice: RelayNotice }
  | { kind: "contract"; event: MessageEvent; contract: ContractLine }
  | { kind: "lifecycle"; event: RelayEventView; lifecycle: Lifecycle; status: boolean };

function single(event: RelayEventView): Single {
  if (event.type !== "message") return { kind: "lifecycle", event, lifecycle: statusLifecycle(event), status: true };
  if (event.notice && event.from.kind === "system") return { kind: "notice", event, notice: event.notice };
  const contract = parseContractLine(event);
  if (contract) return { kind: "contract", event, contract };
  const lifecycle = messageLifecycle(event);
  if (lifecycle) return { kind: "lifecycle", event, lifecycle, status: false };
  if (event.from.kind === "human") return { kind: "human", event };
  if (isDm(event)) return { kind: "dm", event };
  return { kind: "agent", event };
}

/**
 * Turns oldest-first Relay events into timeline rows: classifies each one (agent, human, DM,
 * lifecycle), folds runs of short agent updates and runs of status changes, and marks which
 * agent rows continue the previous turn so they skip the header.
 */
export function buildTimelineRows(events: readonly RelayEventView[], filter: TimelineFilter = { scope: "all", agent: null }): TimelineRow[] {
  const items = events.filter((e) => matchesFilter(e, filter)).map(single);
  const rows: TimelineRow[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;

    if (item.kind === "agent" && isUpdate(item.event)) {
      let j = i + 1;
      while (j < items.length) {
        const next = items[j]!;
        const prev = items[j - 1]!.event as MessageEvent;
        if (next.kind !== "agent" || next.event.from.name !== item.event.from.name || !isUpdate(next.event)) break;
        if (next.event.createdAt - prev.createdAt > SAME_TURN_MS) break;
        j++;
      }
      if (j - i >= WORK_GROUP_MIN) {
        const run = items.slice(i, j).map((x) => x.event as MessageEvent);
        rows.push({ kind: "work", key: `w:${relayEventKey(run[0]!)}`, at: run.at(-1)!.createdAt, actor: item.event.from.name, events: run });
        i = j;
        continue;
      }
    }

    if (item.kind === "lifecycle" && item.status) {
      let j = i + 1;
      while (j < items.length) {
        const next = items[j]!;
        if (next.kind !== "lifecycle" || !next.status) break;
        j++;
      }
      if (j - i >= STATUS_GROUP_MIN) {
        const run = items.slice(i, j) as Extract<Single, { kind: "lifecycle" }>[];
        rows.push({
          kind: "status-run",
          key: `g:${relayEventKey(run[0]!.event)}`,
          at: relayEventTime(run.at(-1)!.event),
          items: run.map((x) => x.lifecycle),
        });
        i = j;
        continue;
      }
    }

    const key = relayEventKey(item.event);
    const at = relayEventTime(item.event);
    if (item.kind === "lifecycle") rows.push({ kind: "lifecycle", key, at, lifecycle: item.lifecycle });
    else if (item.kind === "notice") rows.push({ kind: "notice", key, at, event: item.event, notice: item.notice });
    else if (item.kind === "contract") rows.push({ kind: "contract", key, at, event: item.event, contract: item.contract });
    else if (item.kind === "agent") {
      const prev = rows.at(-1);
      const prevActor = prev?.kind === "agent" ? prev.event.from.name : prev?.kind === "work" ? prev.actor : null;
      const showHeader = prevActor !== item.event.from.name || at - (prev?.at ?? 0) > SAME_TURN_MS;
      rows.push({ kind: "agent", key, at, event: item.event, showHeader });
    } else rows.push({ kind: item.kind, key, at, event: item.event });
    i++;
  }
  return rows;
}
