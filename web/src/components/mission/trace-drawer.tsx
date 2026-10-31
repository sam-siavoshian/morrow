"use client";

import type { TaskView, TraceEntry, TraceKind } from "@morrow/contracts";
import {
  ArrowLeftRight,
  Ban,
  CheckCheck,
  ChevronUp,
  CircleAlert,
  CircleDashed,
  CirclePause,
  FilePlus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestClosed,
  Merge,
  Hourglass,
  ListChecks,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  WifiOff,
  CircleX,
  Compass,
  FileCode,
  TriangleAlert,
  Trophy,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { HarnessIcon } from "@/components/harness/harness-icon";
import { readableNames } from "@/components/timeline/directory";
import { clockTime, fullTime } from "@/components/timeline/time";
import { Segmented } from "@/components/ui/segmented";
import { formatElapsed, useSecondClock } from "@/components/ui/timer";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { laneDomain, type Lane, type LaneMarker, type LaneSegment } from "./lanes";
import { stripSourceTag } from "./recovery";
import { ResizeHandle, usePersistentFlag, usePersistentSize, type SizeRule } from "./resize";
import { DetailStatus } from "./detail-status";
import type { TaskDetailState } from "./use-task-detail";

export type DrawerTab = "trace" | "timeline";

type KindMeta = { label: string; icon: LucideIcon; tone: string };

const KIND: Record<TraceKind, KindMeta> = {
  "task.created": { label: "Created", icon: FilePlus, tone: "text-muted" },
  "task.planning": { label: "Planning", icon: Compass, tone: "text-muted" },
  "task.planner_fallback": { label: "Fallback plan", icon: TriangleAlert, tone: "text-warning" },
  "task.planned": { label: "Planned", icon: ListChecks, tone: "text-muted" },
  "worker.reserved": { label: "Worker reserved", icon: CircleDashed, tone: "text-info" },
  "worker.ready": { label: "Worker ready", icon: Play, tone: "text-info" },
  "worker.blocked": { label: "Worker blocked", icon: Ban, tone: "text-danger" },
  "worker.quota_limited": { label: "Usage limit", icon: Hourglass, tone: "text-warning" },
  "worker.offline": { label: "Worker offline", icon: WifiOff, tone: "text-warning" },
  "task.checkpointed": { label: "Checkpoint", icon: GitCommitHorizontal, tone: "text-label-secondary" },
  "task.handoff_requested": { label: "Handoff", icon: ArrowLeftRight, tone: "text-warning" },
  "task.handoff_acked": { label: "ACK", icon: CheckCheck, tone: "text-success" },
  "task.verified": { label: "Verified", icon: ShieldCheck, tone: "text-success" },
  "task.failed": { label: "Failed", icon: CircleAlert, tone: "text-danger" },
  "task.cancelled": { label: "Cancelled", icon: CircleX, tone: "text-faint" },
  "worker.capacity_restored": { label: "Capacity back", icon: RotateCcw, tone: "text-success" },
  "task.retried": { label: "Retried", icon: RefreshCw, tone: "text-info" },
  "task.conflict_detected": { label: "Merge conflict", icon: Merge, tone: "text-warning" },
  "task.resolver_reserved": { label: "Resolver reserved", icon: CircleDashed, tone: "text-info" },
  "task.conflict_resolved": { label: "Conflict resolved", icon: GitMerge, tone: "text-success" },
  "task.conflict_gave_up": { label: "Gave up on conflict", icon: GitPullRequestClosed, tone: "text-danger" },
  "subagent.started": { label: "Subagent started", icon: Workflow, tone: "text-info" },
  "subagent.finished": { label: "Subagent finished", icon: Workflow, tone: "text-label-secondary" },
  "task.attempt_picked": { label: "Attempt picked", icon: Trophy, tone: "text-success" },
  "worker.waiting": { label: "Waiting for a profile", icon: CirclePause, tone: "text-warning" },
  "contract.published": { label: "Contract published", icon: FileCode, tone: "text-label-secondary" },
};

// ---------- decision trace ----------

type TraceListProps = {
  trace: readonly TraceEntry[];
  /** "ada's Claude Code" for a profile id. */
  describeProfile: (profileId: string) => string | null;
  /** Display name of the member who created the task, shown on the "Created" row. */
  creator: string | null;
  /** Older entries the task no longer stores. */
  dropped: number;
  /** "core e1" for a worker name: trace messages never show raw `w-…` names. */
  displayName: (agentName: string) => string;
};

function TraceList({ trace, describeProfile, creator, dropped, displayName }: TraceListProps) {
  if (trace.length === 0) return <p className="px-4 py-6 text-center text-[13px] text-muted">Nothing has happened yet.</p>;
  return (
    <>
      {dropped > 0 ? (
        <p className="flex min-h-10 items-center border-b border-border px-4 py-2 text-[12.5px] text-faint">
          {dropped === 1 ? "1 older entry is" : `${dropped} older entries are`} no longer stored.
        </p>
      ) : null}
      <ol aria-label="Decision trace" className="flex flex-col">
        {trace.map((entry, i) => {
          const meta = KIND[entry.kind];
          const Icon = meta.icon;
          const created = entry.kind === "task.created";
          // The "Created" label already says it all; the row only adds who.
          const text = created ? "" : readableNames(stripSourceTag(entry.message).text, displayName);
          const who = created ? creator : entry.profileId ? describeProfile(entry.profileId) : null;
          return (
            <li
              key={i}
              className="grid grid-cols-[4.5rem_1rem_minmax(0,1fr)] items-start gap-x-2.5 border-b border-border px-4 py-2 text-[12.5px] last:border-b-0"
            >
              <time dateTime={new Date(entry.at).toISOString()} title={fullTime(entry.at)} className="pt-px text-[11.5px] text-faint tabular-nums">
                {clockTime(entry.at)}
              </time>
              <Icon aria-hidden className={cn("mt-0.5 size-3.5", meta.tone)} />
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className={cn("font-[600]", meta.tone === "text-muted" ? "text-label-secondary" : meta.tone)}>{meta.label}</span>
                  {who ? <span className="truncate text-muted">{who}</span> : null}
                  {entry.epoch !== null ? <span className="text-faint tabular-nums">epoch {entry.epoch}</span> : null}
                </div>
                {text ? <p className="mt-0.5 break-words whitespace-pre-wrap text-muted">{text}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// ---------- timeline (swimlanes) ----------

const SEGMENT_TONE: Record<NonNullable<LaneSegment["ending"]> | "live", string> = {
  live: "bg-soft-sky-wash text-soft-sky-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-sky-edge)]",
  done: "bg-soft-mint-wash text-soft-mint-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-mint-edge)]",
  limit: "bg-soft-peach-wash text-soft-peach-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-peach-edge)]",
  offline: "bg-soft-peach-wash text-soft-peach-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-peach-edge)]",
  failed: "bg-soft-rose-wash text-soft-rose-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-rose-edge)]",
  released: "bg-fill text-label-secondary shadow-hairline",
};

const ENDING_LABEL: Record<NonNullable<LaneSegment["ending"]>, string> = {
  done: "finished",
  limit: "hit a usage limit",
  offline: "went offline",
  failed: "failed",
  released: "handed off",
};

const MARKER_TONE: Record<LaneMarker["kind"], string> = {
  checkpoint: "bg-label-secondary",
  ack: "bg-success",
  limit: "bg-warning",
  offline: "bg-warning",
  verified: "bg-success",
  failed: "bg-danger",
};

type LaneChartProps = {
  task: TaskView;
  lanes: readonly Lane[];
  /** Readable worker name, like "api e2". */
  displayName: (agentName: string) => string;
};

function LaneChart({ task, lanes, displayName }: LaneChartProps) {
  const clock = useSecondClock();
  const now = clock || task.updatedAt;
  const [start, end] = laneDomain(task, lanes, now);
  const span = end - start;
  const pct = (at: number) => `${Math.min(100, Math.max(0, ((at - start) / span) * 100))}%`;

  if (lanes.length === 0) return <p className="px-4 py-6 text-center text-[13px] text-muted">Lanes show once the plan has workstreams.</p>;
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3" role="list" aria-label="Workstream timeline">
      <div className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] gap-3 text-[11px] text-faint tabular-nums" aria-hidden>
        <span />
        <div className="flex justify-between">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f}>{f === 0 ? "0s" : formatElapsed(span * f)}</span>
          ))}
        </div>
      </div>
      {lanes.map((lane) => (
        <div key={lane.workstreamId} role="listitem" className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] items-center gap-3">
          <span className="truncate text-[12.5px] font-[600] tracking-[-0.01em] text-label-secondary" title={lane.title}>
            {lane.title}
          </span>
          <div className="relative h-7 rounded-[8px] bg-[repeating-linear-gradient(90deg,var(--color-border)_0_1px,transparent_1px_25%)] bg-fill/40">
            {lane.segments.length === 0 ? <span className="absolute inset-y-0 left-2 flex items-center text-[11.5px] text-faint">Waiting</span> : null}
            {lane.segments.map((segment) => {
              const segEnd = segment.end ?? now;
              const tone = segment.end === null ? "live" : (segment.ending ?? "released");
              const name = displayName(segment.agentName);
              const summary =
                segment.end === null
                  ? `${name}, working for ${formatElapsed(now - segment.start)}`
                  : `${name}, ${formatElapsed(segEnd - segment.start)}, ${ENDING_LABEL[segment.ending ?? "released"]}`;
              return (
                <Tooltip key={segment.leaseId} content={summary}>
                  <span
                    role="img"
                    aria-label={summary}
                    className={cn(
                      "absolute inset-y-1 flex min-w-1.5 items-center gap-1 overflow-hidden rounded-[6px] px-1.5 text-[11px] font-[600] whitespace-nowrap",
                      SEGMENT_TONE[tone],
                    )}
                    style={{ left: pct(segment.start), width: `max(6px, calc(${pct(segEnd)} - ${pct(segment.start)}))` }}
                  >
                    {segment.cli ? <HarnessIcon cli={segment.cli} size={12} decorative /> : null}
                    <span className="truncate">{name}</span>
                    {segment.end === null ? <span aria-hidden className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-current" /> : null}
                  </span>
                </Tooltip>
              );
            })}
            {lane.markers.map((marker, i) => (
              <Tooltip key={`${marker.at}-${i}`} content={stripSourceTag(marker.label).text}>
                <span
                  role="img"
                  aria-label={stripSourceTag(marker.label).text}
                  className={cn("absolute top-0 z-10 size-2 -translate-x-1/2 rounded-full ring-2 ring-canvas", MARKER_TONE[marker.kind])}
                  style={{ left: pct(marker.at) }}
                />
              </Tooltip>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- the drawer ----------

const DRAWER_MIN = 180;
const drawerRule: SizeRule = {
  storageKey: "morrow:mission-drawer-height",
  initial: 280,
  min: DRAWER_MIN,
  // Phones keep most of the screen for the conversation.
  max: ({ width, height }) => Math.floor(height * (width < 768 ? 0.4 : 0.75)),
};
const wideEnough = () => window.innerWidth >= 980 && window.innerHeight >= 720;

/** Open or closed, remembered across tasks. Open by default only on a roomy window. */
export const useDrawerOpen = () => usePersistentFlag("morrow:mission-drawer-open", wideEnough);

type TraceDrawerProps = {
  /** The live task: the entry count shows before the detail arrives. */
  task: TaskView;
  /** The full task (whole trace, workstream titles), fetched apart from the live view. */
  detail: TaskDetailState;
  lanes: readonly Lane[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  describeProfile: (profileId: string) => string | null;
  creator: string | null;
  displayName: (agentName: string) => string;
};

/** The decision trace and the per-workstream timeline, in a resizable drawer under the main column. */
export function TraceDrawer({ task, detail, lanes, open, onOpenChange, tab, onTabChange, describeProfile, creator, displayName }: TraceDrawerProps) {
  const { size, setSize, reset } = usePersistentSize(drawerRule);
  const max = typeof window === "undefined" ? 600 : drawerRule.max({ width: window.innerWidth, height: window.innerHeight });

  return (
    <section aria-label="Decision trace and timeline" className="relative flex shrink-0 flex-col border-t border-border bg-canvas" style={open ? { height: size } : undefined}>
      {open ? <ResizeHandle axis="y" size={size} min={DRAWER_MIN} max={Math.max(DRAWER_MIN, max)} onResize={setSize} onReset={reset} label="Resize trace drawer" /> : null}
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <Segmented
          aria-label="Drawer view"
          size="sm"
          value={tab}
          onValueChange={(value) => {
            onTabChange(value);
            if (!open) onOpenChange(true);
          }}
          options={[
            { value: "trace", label: `Decision trace · ${task.traceTotal ?? task.trace.length}` },
            { value: "timeline", label: "Timeline" },
          ]}
        />
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-label={open ? "Collapse drawer" : "Expand drawer"}
          className="ml-auto grid size-8 place-items-center rounded-[8px] text-muted transition-colors hover:bg-control-hover hover:text-text focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring pointer-coarse:size-11"
        >
          <ChevronUp className={cn("size-4 transition-transform duration-200 ease-out", open && "rotate-180")} />
        </button>
      </div>
      {open ? (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          <DetailStatus detail={detail} what={tab === "trace" ? "the decision trace" : "the timeline"} className="border-b border-border" />
          {!detail.data ? null : tab === "trace" ? (
            <TraceList
              trace={detail.data.trace}
              describeProfile={describeProfile}
              creator={creator}
              dropped={(detail.data.traceTotal ?? detail.data.trace.length) - detail.data.trace.length}
              displayName={displayName}
            />
          ) : (
            <LaneChart task={detail.data} lanes={lanes} displayName={displayName} />
          )}
        </div>
      ) : null}
    </section>
  );
}
