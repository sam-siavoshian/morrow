"use client";

import type { CliKind } from "@morrow/contracts";
import { ChevronRight, CircleCheck, CircleDashed, CircleSlash, Hourglass, TriangleAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { HARNESS_LABEL, HarnessIcon } from "@/components/harness/harness-icon";
import { RichText } from "@/components/timeline/rich-text";
import { clockTime } from "@/components/timeline/time";
import { Avatar } from "@/components/ui/avatar";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { ElapsedTime } from "@/components/ui/timer";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { agentTone, StatusPip, TONE_TEXT, TONE_TILE } from "./agent-status";
import type { SubagentItem, WorkerState } from "./workers";

/** The live status slot: "Working 1m 03s", "Cooldown until 3:41 PM", never a token count. */
export function WorkerStatus({ state, className }: { state: WorkerState; className?: string }) {
  let body: ReactNode;
  switch (state.kind) {
    case "working":
      body = (
        <span className="inline-flex items-center gap-1 text-soft-sky-ink">
          <RadarSpinner className="size-3" />
          <ShimmerText>Working</ShimmerText>
          <ElapsedTime since={state.since} className="opacity-75" />
        </span>
      );
      break;
    case "starting":
      body = (
        <span className="inline-flex items-center gap-1 text-muted">
          <RadarSpinner className="size-3" />
          Starting
        </span>
      );
      break;
    case "waiting":
      body = (
        <span className="inline-flex items-center gap-1 text-muted">
          <CircleDashed className="size-3" />
          {state.on ? `Waits on ${state.on}` : "Waiting"}
        </span>
      );
      break;
    case "cooldown":
      body = (
        <span className="inline-flex items-center gap-1 text-warning">
          <Hourglass className="size-3" />
          <span title={state.until ? `Cooldown until ${clockTime(state.until)}` : undefined}>{state.until ? `Until ${clockTime(state.until)}` : "Cooldown"}</span>
        </span>
      );
      break;
    case "failed":
      body = (
        <span className="inline-flex items-center gap-1 text-danger">
          <TriangleAlert className="size-3" />
          Failed
        </span>
      );
      break;
    case "done":
      body = (
        <span className="inline-flex items-center gap-1 text-success">
          <CircleCheck className="size-3" />
          Done
        </span>
      );
      break;
    case "stopped":
      body = (
        <span className="inline-flex items-center gap-1 text-faint">
          <CircleSlash className="size-3" />
          {state.reason}
        </span>
      );
      break;
  }
  return <span className={cn("inline-flex shrink-0 text-[11.5px] font-[550] whitespace-nowrap tabular-nums", className)}>{body}</span>;
}

/** Why a failed or stopped worker ended, one line under its name; the recorded words on hover and for screen readers. */
export function EndReason({ state, className }: { state: WorkerState; className?: string }) {
  if ((state.kind !== "failed" && state.kind !== "stopped") || !state.why) return null;
  const { text, detail } = state.why;
  const extra = detail && detail !== text ? detail : null;
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1 text-[11.5px] leading-[1.35]", state.kind === "failed" ? "text-danger" : "text-label-secondary", className)}
      title={extra ?? undefined}
    >
      <span className="shrink-0 text-faint">Why:</span>
      <span className="truncate">{text}</span>
      {extra ? <span className="sr-only">. Recorded: {extra}</span> : null}
    </span>
  );
}

export type WorkerRowData = {
  key: string;
  agentName: string | null;
  label: string;
  cli: CliKind | null;
  owner: { name: string; login: string; avatarUrl: string | null } | null;
  /** "ada's Claude Code". */
  ownership: string;
  vm: string | null;
  state: WorkerState;
  /** The profile's own label ("ada / Claude Max"), for the tooltip. */
  profileLabel: string | null;
  /** Helpers this worker started on other CLIs, oldest first (docs/subagents.md). */
  subagents?: readonly SubagentItem[];
};

/** Whether the task detail, which holds what each subagent was asked and answered, has loaded. */
export type SubagentDetailState = "loading" | "error" | "ready";

type WorkerListProps = {
  rows: readonly WorkerRowData[];
  selected: string | null;
  onSelect: (agentName: string) => void;
  subagentDetail?: SubagentDetailState;
};

/** One slim row per worker (t3code row vocabulary): harness, name, whose subscription, which VM, status. */
export function WorkerList({ rows, selected, onSelect, subagentDetail = "ready" }: WorkerListProps) {
  return (
    <ul className="flex flex-col gap-0.5" aria-label="Workers">
      {rows.map((row) => {
        const content = (
          <>
            <span className="relative shrink-0">
              {row.cli ? (
                <HarnessIcon cli={row.cli} size={22} className={TONE_TILE[agentTone(row.state.kind)]} />
              ) : (
                <span className="grid size-[22px] shrink-0 place-items-center rounded-[28%] text-faint shadow-hairline">
                  <CircleDashed className="size-3.5" />
                </span>
              )}
              <StatusPip kind={row.state.kind} size={12} />
            </span>
            <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", TONE_TEXT[agentTone(row.state.kind)])}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 truncate text-[13.5px] font-[600] tracking-[-0.01em] text-text">{row.label}</span>
                <WorkerStatus state={row.state} className="ml-auto" />
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
                {row.owner ? <Avatar name={row.owner.name} src={row.owner.avatarUrl} login={row.owner.login} size={14} /> : null}
                <span className="truncate">{row.ownership}</span>
                {row.vm ? (
                  <>
                    <span aria-hidden className="text-faint">·</span>
                    <span className="truncate font-mono text-[11px] text-faint">{row.vm}</span>
                  </>
                ) : null}
              </span>
              <EndReason state={row.state} />
            </span>
          </>
        );
        const base = "flex w-full min-w-0 items-center gap-2.5 rounded-row px-2 py-1.5 text-left";
        if (!row.agentName) {
          return (
            <li key={row.key} className={cn(base, "opacity-80")}>
              {content}
            </li>
          );
        }
        const name = row.agentName;
        const helpers = row.subagents?.length ? <SubagentList items={row.subagents} parent={row.label} detail={subagentDetail} /> : null;
        return (
          <li key={row.key}>
            <Tooltip content={row.profileLabel ? `${name} · ${row.profileLabel}` : name} side="right" delay={600}>
              <button
                type="button"
                onClick={() => onSelect(name)}
                aria-pressed={selected === name}
                className={cn(
                  base,
                  "transition-colors duration-150 hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  "pointer-coarse:min-h-11",
                  selected === name && "bg-row-active hover:bg-row-active",
                )}
              >
                {content}
              </button>
            </Tooltip>
            {helpers}
          </li>
        );
      })}
    </ul>
  );
}

const ROLE_LABEL: Record<NonNullable<SubagentItem["role"]>, string> = {
  review: "review",
  research: "research",
  implementation: "implementation",
  test: "tests",
  general: "task",
};

/** A subagent's status in the same vocabulary as its parent's. */
export function subagentWorkerState(item: Pick<SubagentItem, "status" | "startedAt">): WorkerState {
  switch (item.status) {
    case "starting":
      return { kind: "starting" };
    case "running":
      return { kind: "working", since: item.startedAt };
    case "completed":
      return { kind: "done" };
    case "failed":
      return { kind: "failed" };
    case "cancelled":
      return { kind: "stopped", reason: "Stopped" };
  }
}

/** A worker's subagents, indented under it. Each one opens to what it was asked and what it reported, as plain text. */
function SubagentList({ items, parent, detail }: { items: readonly SubagentItem[]; parent: string; detail: SubagentDetailState }) {
  return (
    <ul aria-label={`Subagents of ${parent}`} className="mt-0.5 ml-[21px] flex flex-col gap-0.5 border-l border-border pl-2">
      {items.map((item) => (
        <SubagentRow key={item.leaseId} item={item} detail={detail} />
      ))}
    </ul>
  );
}

function SubagentRow({ item, detail }: { item: SubagentItem; detail: SubagentDetailState }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const harness = item.cli ? HARNESS_LABEL[item.cli] : "Subagent";
  const role = item.role ? ROLE_LABEL[item.role] : null;
  const state = subagentWorkerState(item);
  const pending = item.task === null;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${harness} subagent${role ? ` for ${role}` : ""}. ${open ? "Hide" : "Show"} its task and result`}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-row px-1.5 py-1 text-left transition-colors duration-150 hover:bg-row-hover",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11",
        )}
      >
        <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-faint transition-transform duration-150", open && "rotate-90")} />
        <span className="relative shrink-0">
          {item.cli ? (
            <HarnessIcon cli={item.cli} size={16} decorative className={TONE_TILE[agentTone(state.kind)]} />
          ) : (
            <CircleDashed aria-hidden className="size-4 shrink-0 text-faint" />
          )}
          <StatusPip kind={state.kind} size={10} />
        </span>
        <span className="min-w-0 truncate text-[12.5px] font-[580] text-label-secondary">{harness}</span>
        {role ? <span className="min-w-0 truncate text-[12px] text-muted">{role}</span> : null}
        <WorkerStatus state={state} className="ml-auto" />
      </button>
      <div id={panelId} hidden={!open} className="mt-0.5 mb-1 ml-5 flex-col gap-2 rounded-row bg-fill px-2.5 py-2 text-[12.5px] [&:not([hidden])]:flex">
        {open ? (
          <>
          {pending ? (
            <p className="text-muted">{detail === "error" ? "Couldn't load what it was asked. Reload the page to try again." : "Loading what it was asked..."}</p>
          ) : (
            <>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-[600] tracking-[0.02em] text-faint uppercase">Asked</span>
                <div className="max-h-40 overflow-y-auto">
                  <RichText text={item.task ?? ""} className="leading-[1.5] text-label-secondary" />
                </div>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-[600] tracking-[0.02em] text-faint uppercase">Result</span>
                {item.summary ? (
                  <div className="max-h-56 overflow-y-auto">
                    <RichText text={item.summary} className="leading-[1.5] text-text" />
                  </div>
                ) : (
                  <p className="text-muted">{item.status === "running" || item.status === "starting" ? "Still working." : "No result."}</p>
                )}
              </div>
              <span className="truncate font-mono text-[11px] text-faint">{item.agentName}</span>
            </>
          )}
          </>
        ) : null}
      </div>
    </li>
  );
}
