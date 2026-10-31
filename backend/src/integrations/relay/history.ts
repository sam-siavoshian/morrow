import type { RelayMessage } from "@agent-relay/sdk";
import type { RelayMessageView } from "@morrow/contracts";
import { readerClient } from "./clients.ts";
import type { RelayConfig } from "./config.ts";
import { assertChannelName, assertMessageId } from "./names.ts";
import { messageToView, storedMessageContext, validateView } from "./normalize.ts";
import type { SenderKindResolver } from "./senderKind.ts";

export const MAX_HISTORY_PAGE = 100;

export interface HistoryPage {
  /** Oldest first, ready to render. */
  events: RelayMessageView[];
  /** Pass as `before` for the next older page; null when this page reached the start. */
  nextBefore: string | null;
}

/** One page of a channel, newest page first (engine order), returned oldest first. Observer token only. */
export async function channelHistory(input: {
  config: RelayConfig;
  observerToken: string;
  senderKinds: SenderKindResolver;
  channel: string;
  before?: string | null;
  limit?: number;
}): Promise<HistoryPage> {
  const channel = assertChannelName(input.channel);
  const limit = clampLimit(input.limit);
  const before = input.before ? assertMessageId(input.before, "before") : undefined;
  const messages = await readerClient(input.config, input.observerToken).messages.list(channel, { limit, ...(before ? { before } : {}) });
  const ordered = [...messages].sort(byId);
  return {
    events: await toViews(ordered, channel, input.senderKinds),
    nextBefore: messages.length === limit && ordered[0] ? ordered[0].id : null,
  };
}

/** The root and its replies, oldest first. */
export async function threadHistory(input: {
  config: RelayConfig;
  observerToken: string;
  senderKinds: SenderKindResolver;
  channel: string | null;
  messageId: string;
  limit?: number;
}): Promise<RelayMessageView[]> {
  const messageId = assertMessageId(input.messageId);
  const channel = input.channel ? assertChannelName(input.channel) : null;
  const thread = await readerClient(input.config, input.observerToken).threads.get(messageId, { limit: clampLimit(input.limit) });
  const replies = [...thread.replies].sort(byId).map((r) => ({ ...r, parentId: r.parentId || messageId, threadId: r.threadId || messageId }));
  return toViews([thread.parent, ...replies], channel, input.senderKinds);
}

async function toViews(messages: RelayMessage[], channel: string | null, kinds: SenderKindResolver): Promise<RelayMessageView[]> {
  const now = Date.now();
  const out: RelayMessageView[] = [];
  for (const message of messages) {
    const name = message.from.name || message.from.id || "unknown";
    const view = validateView(messageToView(message, storedMessageContext(message, channel), await kinds.kindOf(name), now));
    if (view?.type === "message") out.push(view);
  }
  return out;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(MAX_HISTORY_PAGE, Math.max(1, Math.trunc(limit)));
}

/** Relay ids are snowflakes: numeric strings that sort by creation. Compare by length, then lexically. */
function byId(a: RelayMessage, b: RelayMessage): number {
  return a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
