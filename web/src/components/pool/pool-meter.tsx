"use client";

import { ArrowRight, Gauge } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { ComposerControl } from "@/components/composer/composer-control";
import { HARNESS_LABEL, HarnessIcon } from "@/components/harness/harness-icon";
import { teamPath } from "@/components/sidebar/sidebar-model";
import { Popover } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { useMinuteClock } from "@/components/ui/timer";
import { Tooltip } from "@/components/ui/tooltip";
import { formatResetTime } from "@/components/workforce/status";
import { cn } from "@/lib/cn";
import { useTeamId, useTeamStore } from "@/lib/store";
import { formatAgo, percentLabel, poolSummary, selectPool, type Pool, type PoolGroup, type PoolSegment, type PoolState } from "./pool-model";

/**
 * How each state draws. Healthy and low fill with the headroom left; an unmetered CLI is full; limited, signed-out
 * and offline CLIs have nothing to give right now, so only their tinted track shows. Colours are theme tokens.
 */
const FILL: Partial<Record<PoolState, string>> = { healthy: "bg-success", low: "bg-warning", unmetered: "bg-soft-sky-ink/45" };
const TRACK: Record<PoolState, string> = {
  healthy: "bg-fill-strong/70",
  low: "bg-fill-strong/70",
  limited: "bg-danger/35",
  auth: "bg-soft-peach-ink/35",
  offline: "bg-fill-strong",
  unknown: "bg-[repeating-linear-gradient(135deg,var(--color-fill-strong)_0_2px,transparent_2px_5px)]",
  unmetered: "bg-fill-strong/70",
};

function usePool(): { pool: Pool | null; now: number } {
  const workforce = useTeamStore((s) => s.workforce);
  const team = useTeamStore((s) => s.team);
  const envStatus = useTeamStore((s) => s.envStatus);
  const viewerId = useTeamStore((s) => s.viewerId);
  const now = useMinuteClock();
  const pool = useMemo(
    () => (workforce && now ? selectPool({ workforce, team, envStatus, viewerId, now }) : null),
    [workforce, team, envStatus, viewerId, now],
  );
  return { pool, now };
}

function Segment({ segment, compact }: { segment: PoolSegment; compact: boolean }) {
  const fill = FILL[segment.state];
  const width = segment.state === "unmetered" ? 100 : (segment.left ?? 0);
  return (
    <span className={cn("relative min-w-1 flex-1 overflow-hidden rounded-full", compact ? "h-1" : "h-1.5", TRACK[segment.state], segment.stale && "opacity-45")}>
      {fill ? (
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", fill)}
          style={{ width: `${width}%` }}
        />
      ) : null}
    </span>
  );
}

/** One bar for the whole pool: a segment per CLI, members separated by a wider gap. */
export function PoolBar({ pool, compact = false, className }: { pool: Pool; compact?: boolean; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex w-full items-center", compact ? "gap-1" : "gap-1.5", className)}>
      {pool.groups.map((group) => (
        <span key={group.userId} className="flex min-w-0 flex-1 items-center gap-0.5" style={{ flexGrow: group.segments.length }}>
          {group.segments.map((segment) => (
            <Segment key={segment.profileId} segment={segment} compact={compact} />
          ))}
        </span>
      ))}
    </span>
  );
}

/** Window by window, with resets, plus how old the reading is when that matters. Shown on hover, read out always. */
function segmentDetail(segment: PoolSegment, now: number): string[] {
  const lines =
    segment.state === "unmetered"
      ? ["Bills its own provider keys"]
      : segment.windows.map((w) => `${w.label} ${percentLabel(w.left)} left${w.resetsAt !== null ? `, resets ${formatResetTime(w.resetsAt, now)}` : ""}`);
  if (segment.stale && segment.observedAt !== null) lines.push(`Last reading ${formatAgo(segment.observedAt, now)}, not counted`);
  return lines;
}

/** What a CLI has to say at a glance: headroom when it can work, otherwise why not. */
export function SegmentValue({ segment, now }: { segment: PoolSegment; now: number }) {
  if (segment.state === "healthy" || segment.state === "low") {
    const left = segment.left ?? 0;
    return (
      <span className={cn("flex items-center gap-2.5", segment.stale && "opacity-50")}>
        <span className="relative h-1 w-12 overflow-hidden rounded-full bg-fill-strong/70">
          <span className={cn("absolute inset-y-0 left-0 rounded-full", FILL[segment.state])} style={{ width: `${left}%` }} />
        </span>
        <span className={cn("w-9 text-right text-[13.5px] font-[550] tabular-nums", segment.state === "low" ? "text-warning" : "text-text")}>
          {percentLabel(left)}
        </span>
      </span>
    );
  }
  const status: Record<Exclude<PoolState, "healthy" | "low">, { tone: StatusTone | null; text: string }> = {
    limited: { tone: "danger", text: segment.until !== null ? `Back ${formatResetTime(segment.until, now)}` : "Limited" },
    auth: { tone: "attention", text: "Needs sign-in" },
    offline: { tone: "idle", text: "Offline" },
    unknown: { tone: null, text: "No reading yet" },
    unmetered: { tone: null, text: "No plan limit" },
  };
  const { tone, text } = status[segment.state];
  return (
    <span className={cn("flex items-center gap-1.5 text-[13px] tabular-nums", tone ? "text-muted" : "text-faint")}>
      {tone ? <StatusDot tone={tone} /> : null}
      {text}
    </span>
  );
}

function SegmentRow({ segment, name, now }: { segment: PoolSegment; name: string; now: number }) {
  const detail = segmentDetail(segment, now);
  const value = (
    <span className="ml-auto flex shrink-0 items-center">
      <SegmentValue segment={segment} now={now} />
    </span>
  );
  return (
    <li className="flex h-8 items-center gap-2.5">
      <HarnessIcon cli={segment.cli} size={18} className="shrink-0" />
      <span className="min-w-0 truncate text-[14px] text-text" title={segment.label}>
        {name}
      </span>
      {detail.length > 0 ? (
        <>
          <Tooltip
            side="left"
            delay={150}
            className="flex-col items-start gap-1 px-2 py-1.5 leading-4"
            content={detail.map((line) => (
              <span key={line}>{line}</span>
            ))}
          >
            {value}
          </Tooltip>
          <span className="sr-only">{detail.join(". ")}</span>
        </>
      ) : (
        value
      )}
    </li>
  );
}

/** A member's CLI by its harness name; by its own label only when the member has two of the same harness. */
function rowName(group: PoolGroup, segment: PoolSegment): string {
  const twins = group.segments.filter((s) => s.cli === segment.cli).length > 1;
  return twins ? segment.label : HARNESS_LABEL[segment.cli];
}

/** The one thing worth knowing beyond the number, or nothing. */
export function attention(pool: Pool, now: number): string | null {
  const parts: string[] = [];
  if (pool.limited > 0) {
    const what = `${pool.limited} limited`;
    parts.push(pool.nextReset !== null ? `${what} until ${formatResetTime(pool.nextReset, now)}` : what);
  }
  if (pool.needsSignIn > 0) parts.push(`${pool.needsSignIn} ${pool.needsSignIn === 1 ? "needs" : "need"} sign-in`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function PoolDetails({ pool, now, teamId }: { pool: Pool; now: number; teamId: string }) {
  return (
    <div className="mt-3">
      <PoolBar pool={pool} />
      <div className="-mx-1 mt-3 max-h-[min(28rem,55vh)] space-y-2.5 overflow-y-auto px-1">
        {pool.groups.map((group) => (
          <section key={group.userId} aria-label={group.name}>
            <h3 className="text-[12px] font-[550] tracking-[0.01em] text-faint">
              {group.name}
              {group.isViewer ? " (you)" : ""}
            </h3>
            <ul className="mt-0.5">
              {group.segments.map((segment) => (
                <SegmentRow key={segment.profileId} segment={segment} name={rowName(group, segment)} now={now} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="mt-2.5 border-t border-border pt-2.5">
        <Link
          href={teamPath(teamId, "/workforce")}
          className="group/link inline-flex items-center gap-1 rounded-[6px] text-[13px] font-[550] text-label-secondary outline-none transition-colors duration-200 hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open Workforce
          <ArrowRight className="size-3.5 transition-transform duration-200 group-hover/link:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

function EmptyPool({ teamId, compact }: { teamId: string; compact: boolean }) {
  return (
    <Link
      href={teamPath(teamId, "/workforce")}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-[var(--control-radius)] text-faint outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "h-7 px-1.5 text-[13px] sm:h-6" : "h-8 px-(--sidebar-row-content-inset) text-[12.5px]",
      )}
    >
      <Gauge className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">
        Connect a CLI<span className={compact ? "max-sm:hidden" : undefined}> to start the pool</span>
      </span>
    </Link>
  );
}

export const headline = (pool: Pool) => (pool.left === null ? "No data yet" : `${pool.left}% left`);

/**
 * The team's shared usage pool: one segment per CLI across every member, filled with the headroom left in its
 * binding window. Live from the workforce view on the socket; nothing is polled from the browser. The popover
 * lists each member's CLIs, one line each; window and reset details show on hover.
 */
export function PoolMeter({ variant, className }: { variant: "sidebar" | "composer"; className?: string }) {
  const teamId = useTeamId();
  const { pool, now } = usePool();
  const compact = variant === "composer";

  if (!pool) {
    return compact ? null : (
      <div className={cn("px-(--sidebar-row-content-inset) py-1.5", className)} aria-hidden="true">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
      </div>
    );
  }
  if (pool.total === 0) return <EmptyPool teamId={teamId} compact={compact} />;

  const summary = poolSummary(pool, now);
  const note = attention(pool, now);

  const trigger = compact ? (
    <ComposerControl aria-label={`${summary}. Show the pool`} className={cn("gap-1.5", className)}>
      <Gauge aria-hidden="true" />
      <span className="tabular-nums">
        <span className="max-sm:hidden">Pool </span>
        {pool.left === null ? "–" : `${pool.left}%`}
      </span>
      <PoolBar pool={pool} compact className="w-12 sm:w-16" />
    </ComposerControl>
  ) : (
    <button
      type="button"
      aria-label={`${summary}. Show the pool`}
      className={cn(
        "group flex w-full flex-col gap-1.5 rounded-[var(--control-radius)] px-(--sidebar-row-content-inset) py-1.5 text-left outline-none",
        "transition-colors duration-200 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-row-active",
        className,
      )}
    >
      <span className="flex w-full items-baseline gap-2 text-[12.5px]">
        <span className="font-[550] text-label-secondary">Team pool</span>
        <span className="ml-auto font-[550] text-text tabular-nums">{headline(pool)}</span>
      </span>
      <PoolBar pool={pool} />
      {note ? <span className="truncate text-[11.5px] text-faint tabular-nums">{note}</span> : null}
    </button>
  );

  return (
    <Popover
      trigger={trigger}
      title={
        <span className="flex items-baseline gap-2">
          Team pool
          <span className="ml-auto text-[18px] font-[600] tracking-[-0.02em] tabular-nums">{headline(pool)}</span>
        </span>
      }
      description={note ?? undefined}
      side={compact ? "top" : "right"}
      align="end"
      className="w-80 p-4"
    >
      <PoolDetails pool={pool} now={now} teamId={teamId} />
    </Popover>
  );
}
