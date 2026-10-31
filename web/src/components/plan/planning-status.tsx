"use client";

import type { TaskView } from "@morrow/contracts";
import { Button } from "@/components/ui/button";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { ElapsedTime } from "@/components/ui/timer";
import { planningLine } from "./plan-flow";

type PlanningStatusProps = {
  task: TaskView | null;
  /** When the planner started on it (ms). */
  since: number;
  /** "Start with fewer agents" is re-planning and will start on its own. */
  autoStart: boolean;
  cancelling: boolean;
  onCancel: () => void;
};

/** Live words while the planner works: what it is doing and for how long. Never a bare spinner. */
export function PlanningStatus({ task, since, autoStart, cancelling, onCancel }: PlanningStatusProps) {
  const line = planningLine(task);
  return (
    <section aria-label="Planning" className="flex flex-col gap-2 rounded-2xl bg-card px-4 py-3.5 shadow-hairline sm:px-5">
      {task ? <p className="truncate text-[12px] font-[550] tracking-[0.01em] text-faint">{task.title}</p> : null}
      <div role="status" className="flex items-center gap-2.5">
        <RadarSpinner className="size-4 text-soft-sky" />
        <span className="min-w-0 flex-1 truncate text-[14.5px] font-[550] tracking-[-0.01em] text-text">
          <ShimmerText>{`${line}…`}</ShimmerText>
        </span>
        <ElapsedTime since={since} className="text-[13px] text-muted" />
      </div>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-[1.5] text-muted">
          {autoStart
            ? "Planning with fewer agents. Workers start as soon as the plan is in."
            : "One headless Claude Code or Codex call on a ready VM splits the work. If none is free, you get a safe one-workstream plan."}
        </p>
        <Button size="xs" variant="quiet" loading={cancelling} onClick={onCancel} disabled={!task}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
