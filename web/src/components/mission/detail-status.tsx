"use client";

import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/cn";
import type { TaskDetailState } from "./use-task-detail";

/**
 * Where the task detail stands, for a section that needs it: loading, or failed with a retry. `what` names the
 * section's content ("the trace"). Renders nothing once the detail is in and the last fetch went fine.
 */
export function DetailStatus({ detail, what, className }: { detail: Pick<TaskDetailState, "data" | "error" | "retry">; what: string; className?: string }) {
  const row = cn("flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-[12.5px] text-muted", className);
  if (detail.error)
    return (
      <div role="alert" className={row}>
        <CircleAlert aria-hidden className="size-3.5 shrink-0 text-danger" />
        <span className="min-w-0 flex-1">
          {detail.data ? `Showing an older copy of ${what}. ` : ""}
          {detail.error}
        </span>
        <Button size="xs" variant="secondary" onClick={detail.retry}>
          Try again
        </Button>
      </div>
    );
  if (detail.data) return null;
  return (
    <p role="status" className={row}>
      <Loader className="size-3.5" /> Loading {what}
    </p>
  );
}
