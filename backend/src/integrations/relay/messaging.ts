import type { RelayMessage } from "@agent-relay/sdk";
import type { RelayMessageView } from "@morrow/contracts";
import { identityClient } from "./clients.ts";
import type { RelayConfig } from "./config.ts";
import { isRelayNameConflict } from "./errors.ts";
import {
  assertAgentName,
  assertChannelName,
  assertIdempotencyKey,
  assertMessageId,
  assertMessageText,
  projectChannelName,
} from "./names.ts";
import { messageToView, senderName, storedMessageContext, type SenderKind } from "./normalize.ts";
import { conventionKind } from "./senderKind.ts";

/** Who is speaking: the dispatcher (system) or a member's `h-<login>` identity (human). */
export interface Speaker {
  token: string;
  kind: Extract<SenderKind, "human" | "system">;
}

/**
 * One channel per project, created and joined by the dispatcher. Safe to call repeatedly: an existing channel
 * (409) is joined, and joining twice is a no-op on the engine.
 */
export async function ensureProjectChannel(input: {
  config: RelayConfig;
  dispatcherToken: string;
  projectShort: string;
  topic?: string;
}): Promise<{ channel: string; created: boolean }> {
  const channel = projectChannelName(input.projectShort);
  const relay = identityClient(input.config, input.dispatcherToken);
  let created = true;
  try {
    await relay.channels.create({ name: channel, ...(input.topic ? { topic: input.topic.slice(0, 250) } : {}) });
  } catch (error) {
    if (!isRelayNameConflict(error)) throw error;
    created = false;
  }
  await relay.channels.join(channel);
  return { channel, created };
}

/** Members join lazily the first time they speak in a project channel. */
export async function joinChannel(input: { config: RelayConfig; token: string; channel: string }): Promise<void> {
  await identityClient(input.config, input.token).channels.join(assertChannelName(input.channel));
}

// Every send carries the caller's idempotency key (our message row / outbox id): a retry of the same logical
// send returns the original message instead of posting twice. Text is validated for size only; it is stored
// and rendered as plain text, never interpreted.

export async function postToChannel(input: {
  config: RelayConfig;
  speaker: Speaker;
  channel: string;
  text: string;
  idempotencyKey: string;
  /** Relay message metadata (Morrow system updates carry their notice here). */
  metadata?: Record<string, unknown>;
}): Promise<RelayMessageView> {
  const channel = assertChannelName(input.channel);
  const message = await identityClient(input.config, input.speaker.token).messaging.messages.send({
    channel,
    text: assertMessageText(input.text),
    idempotencyKey: assertIdempotencyKey(input.idempotencyKey),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return sentView(message, channel, input.speaker.kind);
}

export async function sendDirectMessage(input: {
  config: RelayConfig;
  speaker: Speaker;
  to: string;
  text: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}): Promise<RelayMessageView> {
  const to = assertAgentName(input.to.startsWith("@") ? input.to.slice(1) : input.to, "to");
  const message = await identityClient(input.config, input.speaker.token).messaging.messages.direct({
    to,
    text: assertMessageText(input.text),
    idempotencyKey: assertIdempotencyKey(input.idempotencyKey),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return sentView(message, null, input.speaker.kind);
}

/** Replies in the thread rooted at `messageId` (task threads are rooted at the task's kickoff post). */
export async function replyInThread(input: {
  config: RelayConfig;
  speaker: Speaker;
  messageId: string;
  text: string;
  idempotencyKey: string;
  /** The root's channel, when known, so the returned view is fully placed. */
  channel?: string | null;
  /** Relay message metadata. Workers' deliveries keep it; the observer's `thread.reply` event drops it. */
  metadata?: Record<string, unknown>;
}): Promise<RelayMessageView> {
  const messageId = assertMessageId(input.messageId);
  const message = await identityClient(input.config, input.speaker.token).messaging.messages.reply({
    messageId,
    text: assertMessageText(input.text),
    idempotencyKey: assertIdempotencyKey(input.idempotencyKey),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  const channel = input.channel ? assertChannelName(input.channel) : null;
  return sentView({ ...message, parentId: message.parentId || messageId, threadId: message.threadId || messageId }, channel, input.speaker.kind);
}

/**
 * A thread's root and its newest replies (at most 100, the engine's cap), oldest first, read with an agent token
 * (the dispatcher's). Sender kinds come from the naming convention: this read feeds orchestration, not the UI.
 */
export async function readThread(input: { config: RelayConfig; token: string; messageId: string; limit?: number }): Promise<RelayMessageView[]> {
  const messageId = assertMessageId(input.messageId);
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 100)));
  const thread = await identityClient(input.config, input.token).messaging.threads.get(messageId, { limit });
  const now = Date.now();
  const replies = [...thread.replies]
    .map((r) => ({ ...r, parentId: r.parentId || messageId, threadId: r.threadId || messageId }))
    .sort((a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [thread.parent, ...replies].map((m) => messageToView(m, storedMessageContext(m, null), conventionKind(senderName(m)), now));
}

/** One message by id, read with an agent token (the dispatcher's). */
export async function readMessage(input: { config: RelayConfig; token: string; messageId: string }): Promise<RelayMessageView> {
  const message = await identityClient(input.config, input.token).messaging.messages.get(assertMessageId(input.messageId));
  return messageToView(message, storedMessageContext(message, null), conventionKind(senderName(message)), Date.now());
}

function sentView(message: RelayMessage, channel: string | null, kind: SenderKind): RelayMessageView {
  return messageToView(message, storedMessageContext(message, channel), kind, Date.now());
}
