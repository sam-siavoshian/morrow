"use client";

import type { ProjectView, TaskView, WorkforceView } from "@morrow/contracts";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { HarnessStack } from "@/components/harness/harness-icon";
import { useAskedTasks } from "@/components/sidebar/sidebar-model";
import { liveHarnesses } from "@/components/sidebar/task-meta";
import { formatAgo } from "@/components/sidebar/task-status";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { ElapsedTime, useMinuteClock } from "@/components/ui/timer";
import { selectTaskWorkers, taskRowStatus, type TaskRowStatus } from "@/lib/store";

export const RECENT_LIMIT = 8;

const STATUS: Record<TaskRowStatus, { label: string; tone: StatusTone }> = {
  approval: { label: "Plan ready", tone: "attention" },
  choosing: { label: "Pick an attempt", tone: "attention" },
  input: { label: "Needs you", tone: "attention" },
  recovering: { label: "Recovering", tone: "attention" },
  resolving: { label: "Resolving conflict", tone: "attention" },
  planning: { label: "Planning", tone: "live" },
  running: { label: "Working", tone: "live" },
  verifying: { label: "Verifying", tone: "live" },
  failed: { label: "Failed", tone: "danger" },
  done: { label: "Done", tone: "success" },
  cancelled: { label: "Cancelled", tone: "idle" },
};

const LIVE: ReadonlySet<TaskRowStatus> = new Set(["planning", "running", "verifying"]);

/** When workers got the task: the current run's first reservation (older views: the trace's), else its last update. */
const runningSince = (task: TaskView) =>
  (task.runStartedAt === undefined ? task.trace.find((e) => e.kind === "worker.reserved")?.at : task.runStartedAt) ?? task.updatedAt;

export function recentTasks(workforce: WorkforceView | null, limit = RECENT_LIMIT): TaskView[] {
  return Object.values(workforce?.tasks ?? {})
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}

/** Compact rows for the newest tasks, each a link into mission control. */
export function RecentTasks({
  teamId,
  workforce,
  projects,
}: {
  teamId: string;
  workforce: WorkforceView | null;
  projects: readonly ProjectView[];
}) {
  // `formatAgo` counts minutes; the running counters tick on their own.
  const now = useMinuteClock();
  const asked = useAskedTasks();
  const tasks = useMemo(() => recentTasks(workforce), [workforce]);

  if (!workforce) {
    return (
      <section aria-label="Recent tasks" aria-busy="true" className="flex flex-col gap-1">
        <h2 className="px-1 pb-1 text-[12px] font-[550] tracking-[0.01em] text-faint">Recent tasks</h2>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-11 rounded-row" />
        ))}
      </section>
    );
  }
  if (tasks.length === 0) return null;

  return (
    <section aria-labelledby="recent-title" className="flex flex-col">
      <h2 id="recent-title" className="px-1 pb-1.5 text-[12px] font-[550] tracking-[0.01em] text-faint">
        Recent tasks
      </h2>
      <ul className="flex flex-col">
        {tasks.map((task) => {
          const status = taskRowStatus(task, asked.has(task.id));
          const meta = STATUS[status];
          const project = projects.find((p) => p.id === task.projectId);
          const live = liveHarnesses(selectTaskWorkers(workforce, task.id));
          return (
            <li key={task.id}>
              <Link
                href={`/t/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(task.id)}`}
                className="group flex min-h-11 items-center gap-3 rounded-row px-2.5 py-2 outline-none transition-colors duration-150 hover:bg-row-hover focus-visible:bg-row-active focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {LIVE.has(status) ? (
                    <RadarSpinner className="size-3.5 text-soft-sky" />
                  ) : (
                    <StatusDot tone={meta.tone} ping={meta.tone === "attention"} />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                  <span className="truncate text-[14px] font-[500] tracking-[-0.006em] text-text">{task.title}</span>
                  {project ? (
                    <span className="truncate text-[12.5px] text-faint">{project.repoFullName.split("/")[1]}</span>
                  ) : null}
                </span>
                {live.length > 0 ? <HarnessStack clis={live} size={14} max={3} /> : null}
                <span className="shrink-0 text-[12.5px] text-muted tabular-nums">
                  {status === "running" ? (
                    <>
                      {meta.label} <ElapsedTime since={runningSince(task)} />
                    </>
                  ) : (
                    <>
                      {meta.label}
                      {now ? <span className="text-faint"> · {formatAgo(now - task.updatedAt)}</span> : null}
                    </>
                  )}
                </span>
                <ChevronRight
                  className="size-3.5 shrink-0 text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 max-sm:hidden"
                  aria-hidden="true"
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
