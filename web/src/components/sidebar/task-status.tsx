"use client";

import { CircleAlert, CircleCheck, CircleDotDashed, GitCompareArrows, GitMerge, Hand, LifeBuoy, MessageCircleQuestion } from "lucide-react";
import type { ReactNode } from "react";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { ElapsedTime, useMinuteClock } from "@/components/ui/timer";
import { cn } from "@/lib/cn";
import type { RowStatus, RowStatusKind } from "./task-meta";

const TONE: Record<RowStatusKind, string> = {
  approval: "text-warning",
  choosing: "text-warning",
  input: "text-soft-lilac-ink",
  recovering: "text-warning",
  resolving: "text-warning",
  planning: "text-info",
  working: "text-info",
  verifying: "text-info",
  waiting: "text-muted",
  failed: "text-danger",
  done: "text-success",
  cancelled: "text-faint",
};

const ICON: Record<RowStatusKind, ReactNode> = {
  approval: <Hand />,
  choosing: <GitCompareArrows />,
  input: <MessageCircleQuestion />,
  recovering: <LifeBuoy />,
  resolving: <GitMerge />,
  planning: <RadarSpinner />,
  working: <RadarSpinner />,
  verifying: <RadarSpinner />,
  waiting: <CircleDotDashed />,
  failed: <CircleAlert />,
  done: <CircleCheck />,
  cancelled: <CircleDotDashed />,
};

/** The row's top-right status: icon, word, and a live timer for live work ("Working 42s"). */
export function TaskStatus({ status, compact = false, className }: { status: RowStatus; compact?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11.5px] leading-4 font-[550] tracking-[-0.003em] whitespace-nowrap tabular-nums",
        "[&_svg]:size-3 [&_svg]:shrink-0",
        TONE[status.kind],
        className,
      )}
    >
      {ICON[status.kind]}
      {compact ? <span className="sr-only">{status.label}</span> : <span>{status.label}</span>}
      {status.since !== null && !compact ? <ElapsedTime since={status.since} className="font-[500] opacity-75" /> : null}
    </span>
  );
}

/** `now`, `4m`, `3h`, `2d`, `5w`: how long ago, for the quiet rows. Nothing until the client knows the time. */
export function formatAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

export function TimeAgo({ at, className }: { at: number; className?: string }) {
  // Minutes are all `formatAgo` shows, so every row in the sidebar wakes once a minute, not every second.
  const now = useMinuteClock();
  if (!now) return null;
  return (
    <time dateTime={new Date(at).toISOString()} className={cn("shrink-0 text-[11.5px] text-faint tabular-nums", className)}>
      {formatAgo(now - at)}
    </time>
  );
}
