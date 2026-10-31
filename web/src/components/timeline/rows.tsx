"use client";

import {
  ArrowRightLeft,
  CheckCheck,
  ChevronRight,
  CircleCheck,
  Cpu,
  FileCode,
  GitPullRequest,
  Hourglass,
  Info,
  LogOut,
  MessagesSquare,
  UserPlus,
  Wifi,
  WifiOff,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { APP_NAME, type RelayNoticeKind, type RelayReactionGroupView } from "@morrow/contracts";
import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import { relativeAge } from "@/components/github/pull-state";
import { HarnessIcon } from "@/components/harness/harness-icon";
import { Avatar } from "@/components/ui/avatar";
import { useMinuteClock } from "@/components/ui/timer";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { RelayMarks } from "@/lib/store/team-store";
import { noticeBody, stripMorrowTag, type Lifecycle, type LifecycleIcon, type TimelineRow } from "./classify";
import { agentColor } from "./agent-color";
import { readableText, type ConversationIndex, type MessageMeta, type MessageTag } from "./conversation";
import { ownership, readableNames, type Directory } from "./directory";
import { mergeReactions, reactedBy } from "./reactions";
import styles from "./reactions.module.css";
import { RichText } from "./rich-text";
import { clockTime, fullTime } from "./time";

const ICONS: Record<LifecycleIcon, LucideIcon> = {
  ack: CheckCheck,
  done: CircleCheck,
  limit: Hourglass,
  handoff: ArrowRightLeft,
  online: Wifi,
  offline: WifiOff,
  exit: LogOut,
  system: Cpu,
  subagent: Workflow,
};

const TONE = {
  neutral: "text-muted",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
} as const;

/** Hover-revealed timestamp, always shown where there is no hover (t3code meta). */
function Stamp({ at, className }: { at: number; className?: string }) {
  return (
    <Tooltip content={fullTime(at)}>
      <time
        dateTime={new Date(at).toISOString()}
        className={cn(
          "shrink-0 text-[11.5px] text-faint tabular-nums opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100",
          className,
        )}
      >
        {clockTime(at)}
      </time>
    </Tooltip>
  );
}

/** Icon for a sender: the harness tile for agents, an avatar for members, a chip for the system. */
function SenderMark({ name, directory, size = 18, human = false }: { name: string; directory: Directory; size?: number; human?: boolean }) {
  const agent = directory.agent(name);
  if (agent?.cli) return <HarnessIcon cli={agent.cli} size={size} decorative />;
  const member = directory.human(name);
  if (member) return <Avatar name={member.name || member.login} src={member.avatarUrl} login={member.login} size={size} />;
  if (human) return <Avatar name={directory.displayName(name)} size={size} />;
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[28%] bg-fill text-faint shadow-hairline"
      style={{ width: size, height: size }}
    >
      <Cpu className="size-[62%]" />
    </span>
  );
}

const TAG: Record<MessageTag | "dm", { label: string; className: string }> = {
  question: { label: "Question", className: "bg-soft-sky-wash text-soft-sky-ink" },
  answer: { label: "Answer", className: "bg-soft-mint-wash text-soft-mint-ink" },
  contract: { label: "Interface contract", className: "bg-soft-lilac-wash text-soft-lilac-ink" },
  blocked: { label: "Blocked", className: "bg-soft-rose-wash text-soft-rose-ink" },
  dm: { label: "DM", className: "bg-fill text-muted" },
};

function Tags({ tags }: { tags: readonly (MessageTag | "dm")[] }) {
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((tag) => (
        <span key={tag} className={cn("shrink-0 rounded-capsule px-1.5 py-px text-[10.5px] font-[650] tracking-[0.01em]", TAG[tag].className)}>
          {TAG[tag].label}
        </span>
      ))}
    </>
  );
}

/** "2m ago", kept current by the shared minute clock; the exact time on hover. */
function Ago({ at, className }: { at: number; className?: string }) {
  const now = useMinuteClock() || at;
  return (
    <Tooltip content={fullTime(at)}>
      <time dateTime={new Date(at).toISOString()} className={cn("shrink-0 text-[11.5px] text-faint tabular-nums", className)}>
        {relativeAge(at, now)}
      </time>
    </Tooltip>
  );
}

/** "→ api e2, web e1". A plain post to the whole room shows nothing, like a channel message in Slack. */
function Recipients({ to, directory }: { to: readonly string[]; directory: Directory }) {
  if (to.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 text-[12px] text-muted">
      <span aria-hidden className="text-faint">→</span>
      <span className="sr-only">to</span>
      <span className="min-w-0 truncate font-[550]">{to.map(directory.displayName).join(", ")}</span>
    </span>
  );
}

/** Live reactions and read receipts by message id (the team store's `relayMarks`), from the timeline. */
export const RelayMarksContext = createContext<Readonly<Record<string, RelayMarks>> | null>(null);

/**
 * Slack-style reaction chips under a message: emoji and count, who reacted on hover. History's reactions with the
 * live marks laid over them; a group that drops to 0 disappears. Agent-chosen emoji is shown as plain text.
 */
function Reactions({ messageId, base, directory }: { messageId: string; base: readonly RelayReactionGroupView[] | undefined; directory: Directory }) {
  const live = useContext(RelayMarksContext)?.[messageId]?.reactions;
  const chips = useMemo(() => mergeReactions(base, live), [base, live]);
  if (chips.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {chips.map((chip) => {
        const who = reactedBy(chip, directory.displayName);
        return (
          <Tooltip key={chip.emoji} content={`${who} reacted with ${chip.emoji}`}>
            <span
              aria-label={`${chip.emoji} ${chip.count}, from ${who}`}
              className={cn(
                styles.chip,
                "inline-flex h-6 items-center gap-1 rounded-capsule bg-fill px-2 text-[12.5px] leading-none text-label-secondary shadow-hairline transition-colors duration-150 hover:bg-fill-hover",
              )}
            >
              <span aria-hidden className="text-[13.5px]">
                {chip.emoji}
              </span>
              <span aria-hidden className="font-[600] tabular-nums">
                {chip.count}
              </span>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** The avatar gutter, in px. Rows that are not messages (updates, notices) indent their text to line up with it. */
const AVATAR = 32;

/**
 * One message in the chat, Slack style: the sender's avatar, name, time, who it went to and its tags (Question,
 * Answer, Contract) on the first message of a run; a follow-up from the same sender is just its text, with the time
 * showing in the gutter on hover. The whole row lights up softly on hover. Text wraps inside the column, never clips.
 */
function ChatTurn({
  name,
  directory,
  at,
  to,
  tags,
  showHeader = true,
  human = false,
  messageId,
  reactions,
  children,
}: {
  messageId: string;
  reactions: readonly RelayReactionGroupView[] | undefined;
  name: string;
  directory: Directory;
  at: number;
  to: readonly string[];
  tags: readonly (MessageTag | "dm")[];
  showHeader?: boolean;
  human?: boolean;
  children: ReactNode;
}) {
  const agent = directory.agent(name);
  const color = agentColor(name);
  return (
    <div className={cn("min-w-0", showHeader ? "pt-2" : null)}>
      <div
        className={cn(
          "group/row relative flex min-w-0 gap-2.5 rounded-[10px] px-2 transition-colors duration-150 hover:bg-fill",
          showHeader ? "py-1" : "py-0.5",
        )}
      >
        <span className="relative shrink-0" style={{ width: AVATAR }}>
          {showHeader ? (
            <span className="mt-0.5 block w-fit">
              <SenderMark name={name} directory={directory} size={AVATAR} human={human} />
            </span>
          ) : (
            <Stamp at={at} className="absolute top-[4px] right-0 text-[10.5px] whitespace-nowrap" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          {showHeader ? (
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <Tooltip content={agent ? `${name} · ${ownership(agent.owner, agent.cli)}${agent.vm ? ` on ${agent.vm}` : ""}` : name}>
                <span className={cn("min-w-0 truncate text-[14px] font-[650] tracking-[-0.01em]", human ? "text-text" : color.text)}>{directory.displayName(name)}</span>
              </Tooltip>
              <Ago at={at} />
              <Recipients to={to} directory={directory} />
              <Tags tags={tags} />
            </div>
          ) : to.length > 0 || tags.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Recipients to={to} directory={directory} />
              <Tags tags={tags} />
            </div>
          ) : null}
          <div className="min-w-0 text-[14.5px] leading-[1.55] text-text [overflow-wrap:anywhere]">{children}</div>
          <Reactions messageId={messageId} base={reactions} directory={directory} />
        </div>
      </div>
    </div>
  );
}

function AgentRow({ row, directory, meta }: { row: Extract<TimelineRow, { kind: "agent" }>; directory: Directory; meta: MessageMeta | undefined }) {
  const to = meta?.to ?? [];
  return (
    <ChatTurn messageId={row.event.id} reactions={row.event.reactions} name={row.event.from.name} directory={directory} at={row.event.createdAt} to={to} tags={meta?.tags ?? []} showHeader={row.showHeader}>
      <RichText text={readableText(row.event.text, to, directory.displayName)} />
    </ChatTurn>
  );
}

function HumanRow({ row, directory, meta }: { row: Extract<TimelineRow, { kind: "human" }>; directory: Directory; meta: MessageMeta | undefined }) {
  const { event } = row;
  const to = meta?.to ?? event.mentions.filter((m) => m !== event.from.name);
  return (
    <ChatTurn messageId={event.id} reactions={event.reactions} name={event.from.name} directory={directory} at={event.createdAt} to={to} tags={meta?.tags ?? []} human>
      <RichText text={readableText(event.text, meta?.to ?? [], directory.displayName)} />
    </ChatTurn>
  );
}

/** A DM between agents: the same chat turn, tagged DM. */
function DmRow({ row, directory, meta }: { row: Extract<TimelineRow, { kind: "dm" }>; directory: Directory; meta: MessageMeta | undefined }) {
  return (
    <ChatTurn messageId={row.event.id} reactions={row.event.reactions} name={row.event.from.name} directory={directory} at={row.event.createdAt} to={meta?.to ?? []} tags={["dm", ...(meta?.tags ?? [])]}>
      <RichText text={readableText(stripMorrowTag(row.event.text), meta?.to ?? [], directory.displayName)} />
    </ChatTurn>
  );
}

const NOTICE: Record<RelayNoticeKind, { icon: LucideIcon; label: string; tone: string }> = {
  workstream_done: { icon: CircleCheck, label: "Workstream done", tone: "text-success" },
  handoff: { icon: ArrowRightLeft, label: "Worker replaced", tone: "text-muted" },
  review_comment: { icon: GitPullRequest, label: "Review comment", tone: "text-soft-sky-ink" },
  status: { icon: Info, label: "Status reply", tone: "text-muted" },
  subagent: { icon: Workflow, label: "Subagent update", tone: "text-muted" },
  subagent_done: { icon: Workflow, label: "Subagent finished", tone: "text-soft-sky-ink" },
  kickoff: { icon: MessagesSquare, label: "Task thread", tone: "text-soft-lilac" },
  contract: { icon: FileCode, label: "Contract shared", tone: "text-soft-sky-ink" },
  peer_joined: { icon: UserPlus, label: "Peer joined", tone: "text-muted" },
  nudge: { icon: Hourglass, label: "Check-in", tone: "text-muted" },
  activity: { icon: Info, label: "Update", tone: "text-muted" },
};

/** A notice longer than this (or on more than one line) folds behind "Show all". */
const NOTICE_PREVIEW_CHARS = 160;

/**
 * A Morrow update to workers, set apart from conversation as one quiet line: icon, what it is, who was told, the
 * first line of the text and the time. Longer ones open in place. The text is untrusted and shown as text.
 */
function NoticeRow({
  row,
  directory,
  expanded,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "notice" }>;
  directory: Directory;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { icon: Icon, label, tone } = NOTICE[row.notice.kind];
  const body = readableNames(noticeBody(row.event.text, row.notice), directory.displayName);
  const lines = body.split("\n");
  const long = lines.length > 1 || body.length > NOTICE_PREVIEW_CHARS;
  const to = row.notice.to.map(directory.displayName).join(", ");
  return (
    <div className="pt-1.5">
      <div className="group/row flex min-w-0 items-start gap-2.5 rounded-[10px] px-2 py-1 text-[12.5px] leading-[1.5] transition-colors duration-150 hover:bg-fill">
        <span className="flex shrink-0 justify-end pt-[2px]" style={{ width: AVATAR }}>
          <Icon aria-hidden className={cn("size-3.5", tone)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 flex-1 truncate text-muted">
              <span className="font-[600] text-label-secondary">{label}</span>
              {to ? <span> · {APP_NAME} told {to}</span> : null}
              {!expanded ? (
                <span className="text-faint">
                  {" · "}
                  <RichText text={lines[0] ?? ""} className="whitespace-nowrap" />
                </span>
              ) : null}
            </span>
            {long ? (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={onToggle}
                className="shrink-0 rounded-[6px] text-[12px] font-[550] text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {expanded ? "Show less" : lines.length > 1 ? `Show all ${lines.length} lines` : "Show more"}
              </button>
            ) : null}
            <Stamp at={row.at} />
          </div>
          {expanded ? <RichText text={body} className="mt-1 block text-[13px] leading-[1.55] text-label-secondary" /> : null}
        </div>
      </div>
    </div>
  );
}

/** Lines of a contract's details shown before "Show all". */
const CONTRACT_PREVIEW_LINES = 6;

/** A worker's interface contract: who published it, the one-line summary, then the details. Agent text, shown as text. */
function ContractRow({
  row,
  directory,
  meta,
  expanded,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "contract" }>;
  directory: Directory;
  meta: MessageMeta | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { event, contract } = row;
  const contractBody = contract.body ? readableNames(contract.body, directory.displayName) : contract.body;
  const lines = contractBody ? contractBody.split("\n") : [];
  const long = lines.length > CONTRACT_PREVIEW_LINES;
  const shown = long && !expanded ? lines.slice(0, CONTRACT_PREVIEW_LINES).join("\n") : contractBody;
  return (
    <ChatTurn messageId={event.id} reactions={event.reactions} name={event.from.name} directory={directory} at={event.createdAt} to={meta?.to ?? []} tags={meta?.tags ?? ["contract"]}>
      <span className="flex items-start gap-1.5">
        <FileCode aria-hidden className="mt-[3px] size-3.5 shrink-0 text-soft-lilac-ink" />
        <RichText text={readableNames(contract.summary, directory.displayName)} className="font-[600]" />
      </span>
      {shown ? <RichText text={shown} className="mt-1 block font-mono text-[12.5px] leading-[1.6] text-label-secondary" /> : null}
      {long ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="mt-1 rounded-[6px] text-[12px] font-[550] text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {expanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </ChatTurn>
  );
}

/**
 * A lifecycle line: icon, who, what, then the detail, as one run of text that wraps to at most two lines (the whole
 * line on hover). Raw worker names in the text read as display names.
 */
function LifecycleLabel({ item, directory }: { item: Lifecycle; directory: Directory }) {
  const Icon = ICONS[item.icon];
  const actor = item.actor ? directory.displayName(item.actor) : null;
  const label = readableNames(item.label, directory.displayName);
  const detail = item.detail ? readableNames(item.detail, directory.displayName) : null;
  return (
    <span className="flex min-w-0 items-start gap-1.5" title={[actor, label, detail && `· ${detail}`].filter(Boolean).join(" ")}>
      <Icon className={cn("mt-[2.5px] size-3 shrink-0", TONE[item.tone])} />
      <span className="line-clamp-2 min-w-0 leading-[1.45] [overflow-wrap:anywhere]">
        {actor ? <span className="font-[600] text-label-secondary">{actor} </span> : null}
        <span className={cn("font-[550]", item.tone === "neutral" ? "text-muted" : TONE[item.tone])}>{label}</span>
        {detail ? <span className="text-faint"> · {detail}</span> : null}
      </span>
    </span>
  );
}

/** t3code's system divider: hairlines either side of a small centred label. */
export function Divider({ children, at, className }: { children: ReactNode; at?: number; className?: string }) {
  return (
    <div className={cn("group/row flex min-w-0 items-center gap-2 px-2 py-1.5 text-[11.5px]", className)}>
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex min-w-0 max-w-[88%] items-center justify-center gap-1.5 px-1">{children}</span>
      {at !== undefined ? <Stamp at={at} /> : null}
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

function WorkRow({
  row,
  directory,
  expanded,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "work" }>;
  directory: Directory;
  expanded: boolean;
  onToggle: () => void;
}) {
  const last = row.events.at(-1)!;
  return (
    <div className="group/row min-w-0 px-2 pt-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-2 rounded-[8px] py-1 pl-[20px] text-left text-[13px] text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform duration-150", expanded && "rotate-90")} />
        <span className="shrink-0 font-[550] text-label-secondary">
          {directory.displayName(row.actor)} posted {row.events.length} updates
        </span>
        {expanded ? null : <span className="min-w-0 truncate text-faint">· {readableNames(last.text, directory.displayName)}</span>}
        <Stamp at={row.at} className="ml-auto" />
      </button>
      {expanded ? (
        <ol className="mt-0.5 ml-[42px] border-l border-border pl-3">
          {row.events.map((event) => (
            <li key={event.id} className="group/row flex min-w-0 items-baseline gap-2 py-0.5 text-[13px] leading-[1.55] text-label-secondary">
              <RichText text={readableNames(event.text, directory.displayName)} className="min-w-0 flex-1" />
              <Stamp at={event.createdAt} />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function StatusRunRow({
  row,
  directory,
  expanded,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "status-run" }>;
  directory: Directory;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="min-w-0">
      <Divider at={row.at}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex items-center gap-1 rounded-capsule px-2 py-0.5 font-[550] text-muted shadow-hairline transition-colors hover:bg-fill-hover hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronRight className={cn("size-3 transition-transform duration-150", expanded && "rotate-90")} />
          {row.items.length} status changes
        </button>
      </Divider>
      {expanded ? (
        <ul className="pb-1">
          {row.items.map((item, i) => (
            <li key={i} className="flex items-center justify-center gap-1.5 py-0.5 text-[11.5px]">
              <LifecycleLabel item={item} directory={directory} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type RowProps = {
  row: TimelineRow;
  directory: Directory;
  expanded: boolean;
  onToggle: (key: string) => void;
  /** Who each message went to and its tags (conversation.ts). */
  conversation?: ConversationIndex;
};

/** One timeline row, routed by kind. */
export const TimelineRowView = memo(function TimelineRowView({ row, directory, expanded, onToggle, conversation }: RowProps) {
  const meta = "event" in row ? conversation?.get(row.event.id) : undefined;
  switch (row.kind) {
    case "agent":
      return <AgentRow row={row} directory={directory} meta={meta} />;
    case "human":
      return <HumanRow row={row} directory={directory} meta={meta} />;
    case "dm":
      return <DmRow row={row} directory={directory} meta={meta} />;
    case "notice":
      return <NoticeRow row={row} directory={directory} expanded={expanded} onToggle={() => onToggle(row.key)} />;
    case "contract":
      return <ContractRow row={row} directory={directory} meta={meta} expanded={expanded} onToggle={() => onToggle(row.key)} />;
    case "lifecycle":
      return (
        <Divider at={row.at} className="pt-2.5">
          <LifecycleLabel item={row.lifecycle} directory={directory} />
        </Divider>
      );
    case "work":
      return <WorkRow row={row} directory={directory} expanded={expanded} onToggle={() => onToggle(row.key)} />;
    case "status-run":
      return <StatusRunRow row={row} directory={directory} expanded={expanded} onToggle={() => onToggle(row.key)} />;
  }
});
