import type { RelayMessage, RelayMessagingEvent } from "@agent-relay/sdk";
import {
  RelayEventView,
  RelayMarkView,
  RelayNotice,
  type RelayAgentStatusView,
  type RelayAttachmentView,
  type RelayMessageView,
  type RelayNodeStatusView,
  type RelayReactionGroupView,
  type RELAY_SENDER_KINDS,
} from "@morrow/contracts";
import { z } from "zod";
import { DISPATCHER_NAME } from "./names.ts";

export type SenderKind = (typeof RELAY_SENDER_KINDS)[number];

/** Frames carry untrusted agent text; the UI renders it as text, and this caps what a single frame can carry. */
export const MAX_VIEW_TEXT_CHARS = 65_536;
const MAX_MENTIONS = 50;

export function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : null;
}

function capText(text: string): string {
  return text.length > MAX_VIEW_TEXT_CHARS ? `${text.slice(0, MAX_VIEW_TEXT_CHARS)}…` : text;
}

export function senderName(message: RelayMessage): string {
  return message.from.name || message.from.id || "unknown";
}

export interface MessageContext {
  channel: string | null;
  conversationId: string | null;
  threadId: string | null;
  parentId: string | null;
}

/** Placement of a message event, or null for events that are not messages. Edits are not surfaced. */
export function messageEventContext(event: RelayMessagingEvent): { message: RelayMessage; context: MessageContext } | null {
  switch (event.type) {
    case "messageCreated":
      return {
        message: event.message,
        context: { channel: event.channel || event.message.channel?.name || null, conversationId: null, threadId: null, parentId: null },
      };
    case "threadReply":
      return {
        message: event.message,
        context: {
          channel: event.channel || event.message.channel?.name || null,
          conversationId: null,
          threadId: event.message.threadId || event.parentId || null,
          parentId: event.parentId || event.message.parentId || null,
        },
      };
    case "dmReceived":
    case "groupDmReceived":
      return {
        message: event.message,
        context: { channel: null, conversationId: event.conversationId || event.message.conversationId || null, threadId: null, parentId: null },
      };
    default:
      return null;
  }
}

// ---------- Morrow system updates ----------

/** The metadata key a Morrow system update carries its notice under. */
const NOTICE_KEY = "morrow";
const MAX_SENT_NOTICES = 2_000;
/**
 * Notices this process is sending, by text. The engine's DM and thread-reply events carry no message metadata
 * (channel posts and history do), and the event can arrive before the send returns, so a notice is remembered
 * before the send. Every notice's text names its recipient, so texts are unique per message. Bounded; after a
 * restart such an update shows as a plain system message.
 */
const sentNotices = new Map<string, RelayNotice>();

const textKey = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

export function noticeMetadata(notice: RelayNotice): Record<string, unknown> {
  return { [NOTICE_KEY]: { v: 1, ...notice } };
}

export function rememberNotice(text: string, notice: RelayNotice): void {
  const key = textKey(text);
  sentNotices.delete(key);
  sentNotices.set(key, notice);
  while (sentNotices.size > MAX_SENT_NOTICES) sentNotices.delete(sentNotices.keys().next().value!);
}

/**
 * A notice only counts from the Morrow system identity. Within a workspace an agent could still post as it (the
 * workspace key is shared, architecture 10), so a notice is display only and never drives a decision.
 */
function noticeOf(message: RelayMessage): RelayNotice | undefined {
  if (senderName(message) !== DISPATCHER_NAME) return undefined;
  const raw = message.metadata && typeof message.metadata === "object" ? (message.metadata as Record<string, unknown>)[NOTICE_KEY] : undefined;
  const parsed = RelayNotice.safeParse(raw);
  if (parsed.success) return parsed.data;
  return typeof message.text === "string" ? sentNotices.get(textKey(message.text)) : undefined;
}

const MAX_ATTACHMENTS = 20;
const MAX_REACTIONS = 20;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const short = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.replace(CONTROL, "").trim() ? value.replace(CONTROL, "").trim().slice(0, max) : null;

/** Stored file attachments as metadata only (id, name, type, size). Inline text, links and images are left out. */
function attachmentsOf(message: RelayMessage): RelayAttachmentView[] {
  if (!Array.isArray(message.attachments)) return [];
  const out: RelayAttachmentView[] = [];
  for (const a of message.attachments) {
    if (!a || typeof a !== "object" || ("type" in a && a.type !== undefined && a.type !== "stored")) continue;
    const id = short((a as { id?: unknown }).id, 128);
    if (!id) continue;
    const stored = a as { filename?: unknown; contentType?: unknown; sizeBytes?: unknown };
    const size = typeof stored.sizeBytes === "number" && Number.isSafeInteger(stored.sizeBytes) && stored.sizeBytes >= 0 ? stored.sizeBytes : null;
    out.push({ id, filename: short(stored.filename, 255) ?? "file", contentType: short(stored.contentType, 255), sizeBytes: size });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

function reactionsOf(message: RelayMessage): RelayReactionGroupView[] {
  if (!Array.isArray(message.reactions)) return [];
  const out: RelayReactionGroupView[] = [];
  for (const r of message.reactions as unknown[]) {
    const group = r as { emoji?: unknown; count?: unknown; agents?: unknown };
    const emoji = short(group?.emoji, 64);
    if (!emoji) continue;
    const agents = Array.isArray(group.agents) ? group.agents.map((a) => short(a, 64)).filter((a): a is string => a !== null).slice(0, 50) : [];
    const count = typeof group.count === "number" && Number.isSafeInteger(group.count) && group.count >= 0 ? group.count : agents.length;
    out.push({ emoji, count, agents });
    if (out.length >= MAX_REACTIONS) break;
  }
  return out;
}

export function messageToView(message: RelayMessage, context: MessageContext, kind: SenderKind, fallbackAt: number): RelayMessageView {
  const mentions = Array.isArray(message.mentions)
    ? message.mentions.filter((m): m is string => typeof m === "string").slice(0, MAX_MENTIONS)
    : [];
  const notice = noticeOf(message);
  const attachments = attachmentsOf(message);
  const reactions = reactionsOf(message);
  const readByCount = typeof message.readByCount === "number" && Number.isSafeInteger(message.readByCount) && message.readByCount > 0 ? message.readByCount : 0;
  return {
    type: "message",
    id: message.id,
    channel: context.channel,
    conversationId: context.conversationId,
    threadId: context.threadId,
    parentId: context.parentId,
    from: { name: senderName(message), kind },
    text: capText(typeof message.text === "string" ? message.text : ""),
    mentions,
    createdAt: parseTime(message.createdAt) ?? fallbackAt,
    ...(notice ? { notice } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(reactions.length > 0 ? { reactions } : {}),
    ...(readByCount > 0 ? { readByCount } : {}),
  };
}

/**
 * A reaction or read receipt from the observer stream, or null for any other event. The engine sends no time with a
 * reaction, so `fallbackAt` (when it was seen) stands in.
 */
export function markFromEvent(event: RelayMessagingEvent, fallbackAt: number): RelayMarkView | null {
  switch (event.type) {
    case "reactionAdded":
    case "reactionRemoved": {
      const view = { type: "reaction", messageId: event.messageId, emoji: event.emoji, agentName: event.agentName, removed: event.type === "reactionRemoved", at: fallbackAt };
      const parsed = RelayMarkView.safeParse(view);
      return parsed.success && event.messageId && event.agentName ? parsed.data : null;
    }
    case "messageRead": {
      const view = { type: "read", messageId: event.messageId, agentName: event.agentName, at: parseTime(event.readAt) ?? fallbackAt };
      const parsed = RelayMarkView.safeParse(view);
      return parsed.success && event.messageId && event.agentName ? parsed.data : null;
    }
    default:
      return null;
  }
}

/** A message read back from history (or a send result), placed from its own fields. */
export function storedMessageContext(message: RelayMessage, channelName: string | null): MessageContext {
  const parentId = message.parentId || null;
  return {
    channel: message.conversationId ? null : channelName ?? message.channel?.name ?? null,
    conversationId: message.conversationId || null,
    threadId: parentId ? message.threadId || parentId : null,
    parentId,
  };
}

// Lifecycle frames reach us as `unknown` events carrying the raw wire frame. Shapes observed live on engine
// 11.1.0: `agent.status.*` carries the name in `agent_name` or `agent.name` and a time in `timestamp` or
// `created_at`; `agent.exited` and `node.status.*` follow `@relaycast/types`.
const Str = z.string().min(1).max(256);
const AgentStatusFrame = z.object({
  type: z.enum(["agent.status.active", "agent.status.offline", "agent.status.changed"]),
  agent_name: Str.optional(),
  agent: z.object({ name: Str.optional(), id: Str.optional() }).optional(),
  subject_agent_id: Str.optional(),
  status: z.string().optional(),
  timestamp: z.string().optional(),
  created_at: z.string().optional(),
});
const AgentExitedFrame = z.object({
  type: z.literal("agent.exited"),
  agent_id: Str,
  agent_name: Str,
  node_id: Str.nullable().optional(),
  invocation_id: Str.nullable().optional(),
  reason: z.string().max(64).optional(),
  created_at: z.string().optional(),
});
const NodeStatusFrame = z.object({
  type: z.enum(["node.status.online", "node.status.offline"]),
  node_id: Str,
  node_name: Str.nullable().optional(),
  reason: z.string().max(64).optional(),
  created_at: z.string().optional(),
});

export type Lifecycle =
  | { kind: "agent.status"; agentName: string; agentId: string | null; status: "active" | "offline"; at: number }
  | {
      kind: "agent.exited";
      agentName: string;
      agentId: string;
      nodeId: string | null;
      invocationId: string | null;
      reason: string | null;
      at: number;
    }
  | { kind: "node.status"; nodeId: string; nodeName: string | null; status: "online" | "offline"; reason: string | null; at: number };

export function parseLifecycle(raw: unknown, fallbackAt: number): Lifecycle | null {
  const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;
  if (type === "agent.exited") {
    const f = AgentExitedFrame.safeParse(raw);
    if (!f.success) return null;
    return {
      kind: "agent.exited",
      agentName: f.data.agent_name,
      agentId: f.data.agent_id,
      nodeId: f.data.node_id ?? null,
      invocationId: f.data.invocation_id ?? null,
      reason: f.data.reason ?? null,
      at: parseTime(f.data.created_at) ?? fallbackAt,
    };
  }
  if (type === "node.status.online" || type === "node.status.offline") {
    const f = NodeStatusFrame.safeParse(raw);
    if (!f.success) return null;
    return {
      kind: "node.status",
      nodeId: f.data.node_id,
      nodeName: f.data.node_name ?? null,
      status: f.data.type === "node.status.online" ? "online" : "offline",
      reason: f.data.reason ?? null,
      at: parseTime(f.data.created_at) ?? fallbackAt,
    };
  }
  if (type === "agent.status.active" || type === "agent.status.offline" || type === "agent.status.changed") {
    const f = AgentStatusFrame.safeParse(raw);
    if (!f.success) return null;
    const agentName = f.data.agent_name ?? f.data.agent?.name;
    if (!agentName) return null;
    const status = f.data.type === "agent.status.changed" ? f.data.status : f.data.type.slice("agent.status.".length);
    if (status !== "active" && status !== "offline") return null;
    return {
      kind: "agent.status",
      agentName,
      agentId: f.data.subject_agent_id ?? f.data.agent?.id ?? null,
      status,
      at: parseTime(f.data.timestamp) ?? parseTime(f.data.created_at) ?? fallbackAt,
    };
  }
  return null;
}

export function lifecycleToView(event: Lifecycle, nodeName: string | null): RelayAgentStatusView | RelayNodeStatusView | null {
  switch (event.kind) {
    case "agent.status":
      return { type: "agent.status", agentName: event.agentName, status: event.status, reason: null, nodeName: null, at: event.at };
    case "agent.exited":
      return { type: "agent.status", agentName: event.agentName, status: "exited", reason: event.reason, nodeName, at: event.at };
    case "node.status": {
      const name = event.nodeName ?? nodeName;
      if (!name) return null;
      return { type: "node.status", nodeName: name, status: event.status, reason: event.reason, at: event.at };
    }
  }
}

/** Last line of defence: nothing reaches the realtime hub unless it matches the contract exactly. */
export function validateView(view: unknown): RelayEventView | null {
  const parsed = RelayEventView.safeParse(view);
  return parsed.success ? parsed.data : null;
}
