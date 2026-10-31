import type { RelayEventView } from "@morrow/contracts";
import { parseContractLine, stripMorrowTag, type MessageEvent } from "./classify";
import { readableNames } from "./directory";

// Who each chat message is for, and what kind of turn it is (a question, its answer, a contract), so the feed can
// read like a group chat: "api e2 → web e1 · Answer". Pure and computed once per event list.

export type MessageTag = "question" | "answer" | "contract" | "blocked";

export type MessageMeta = {
  /** Agent or person names it is addressed to; empty when it went to everyone. */
  to: string[];
  tags: MessageTag[];
};

export type ConversationIndex = ReadonlyMap<string, MessageMeta>;

/** How the backend reads mentions (peers.ts): `@name` at the start or after a space, worker and person names only. */
const MENTION = /(?:^|\s)@([\w-]{1,64})/g;
const ADDRESSABLE = /^(?:w-|h-)/;
/** Only the start of a message is scanned: a huge paste costs nothing. */
const SCAN_CHARS = 4_000;
const BLOCKED = /^\s*BLOCKED\b/;
const HIDDEN = /[\p{Cf}\u2028\u2029]/gu;

/** Who a message names: the engine's list plus `@name` in the text (thread replies carry no list). */
export function mentionsOf(event: MessageEvent): string[] {
  const out = new Set(event.mentions.filter((m) => ADDRESSABLE.test(m)));
  for (const match of event.text.slice(0, SCAN_CHARS).matchAll(MENTION)) if (ADDRESSABLE.test(match[1]!)) out.add(match[1]!);
  return [...out];
}

/** A message as one clipped line of plain text. Agent text: shown as text only. */
export function preview(text: string, max = 160): string {
  const flat = stripMorrowTag(text).replace(HIDDEN, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const isQuestion = (text: string) => text.slice(0, SCAN_CHARS).includes("?");

/**
 * Addressees and tags for every chat message, oldest first:
 * - to: who it names; else, in a DM, the others in that conversation; else, a thread reply goes to whoever wrote
 *   the message it answers (not Morrow's kickoff post, which is the whole team's thread); else everyone.
 * - question: it asks something ("?"). answer: it is addressed to someone who asked its sender a question that has
 *   not been answered yet. contract: a CONTRACT line. blocked: starts with BLOCKED.
 * Morrow's own messages are not chat and get no entry.
 */
export function conversationIndex(events: readonly RelayEventView[]): Map<string, MessageMeta> {
  const out = new Map<string, MessageMeta>();
  const authors = new Map<string, MessageEvent>();
  const peers = new Map<string, Set<string>>();
  /** `asker>asked`: questions still waiting for an answer. */
  const open = new Set<string>();
  for (const event of events) {
    if (event.type !== "message") continue;
    authors.set(event.id, event);
    const from = event.from.name;
    const named = mentionsOf(event);
    if (event.conversationId) {
      const set = peers.get(event.conversationId) ?? new Set<string>();
      if (event.from.kind !== "system") set.add(from);
      for (const n of named) set.add(n);
      peers.set(event.conversationId, set);
    }
    if (event.from.kind === "system") continue;

    let to = named.filter((n) => n !== from);
    if (to.length === 0 && event.conversationId) to = [...(peers.get(event.conversationId) ?? [])].filter((n) => n !== from);
    if (to.length === 0 && event.parentId) {
      const parent = authors.get(event.parentId);
      if (parent && parent.from.kind !== "system" && parent.from.name !== from) to = [parent.from.name];
    }

    const tags: MessageTag[] = [];
    const contract = parseContractLine(event) !== null;
    if (contract) tags.push("contract");
    if (BLOCKED.test(event.text)) tags.push("blocked");
    if (to.some((asker) => open.has(`${asker}>${from}`))) {
      tags.push("answer");
      for (const asker of to) open.delete(`${asker}>${from}`);
    }
    if (!contract && isQuestion(event.text)) {
      tags.push("question");
      for (const asked of to) open.add(`${from}>${asked}`);
    }
    out.set(event.id, { to: to.sort(), tags });
  }
  return out;
}

const LEADING_MENTION = /^\s*@([\w-]{1,64})[,:]?(?:\s+|$)/;

/**
 * The text as the chat shows it: the @names it opens with are dropped when the header already says who it is for
 * ("→ web e1"), and every other @name reads as its display name ("@api e2" instead of "@w-ab12-api-e2").
 * Text in, text out: rendered as text by the caller.
 */
export function readableText(text: string, to: readonly string[], displayName: (name: string) => string): string {
  let out = text;
  const addressed = new Set(to);
  for (let match = LEADING_MENTION.exec(out); match && addressed.has(match[1]!); match = LEADING_MENTION.exec(out)) out = out.slice(match[0].length);
  if (out.trim() === "") out = text;
  const mentioned = out.replace(MENTION, (whole, name: string) => {
    if (!ADDRESSABLE.test(name)) return whole;
    const label = displayName(name);
    return label === name ? whole : whole.replace(`@${name}`, `@${label}`);
  });
  // Bare worker names too ("handing core over from w-ab12-core-e1").
  return readableNames(mentioned, displayName);
}
