"use client";

import type { WorkerLogResponse } from "@morrow/contracts";
import { CircleAlert, GitCommitHorizontal, RotateCw, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { clockTime, fullTime } from "@/components/timeline/time";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";
import { leaseWhy, plainWhy, UNAVAILABLE_TEXT, type EndWhy } from "./end-reason";

const STATE_WORD: Record<WorkerLogResponse["state"], string> = {
  failed: "Failed",
  expired: "Stopped",
  released: "Ended",
  reserved: "Ended",
  spawning: "Ended",
  running: "Ended",
};

/** Why it ended: the lease's recorded reason, else the trace entry that ended it. */
export function endedWhy(data: WorkerLogResponse): EndWhy | null {
  if (data.end.reason) return plainWhy(data.end.reason);
  if (data.end.trace) return leaseWhy([{ ...data.end.trace, leaseId: data.leaseId, profileId: null, epoch: null }], data.leaseId);
  return null;
}

type EndedLogViewProps = {
  data: WorkerLogResponse;
  /** The log body (a static terminal); only rendered when there is a log. */
  terminal: ReactNode;
  onRetry?: () => void;
};

/**
 * An ended worker, read only: "Ended · last output", why it ended, what it left, then its last output. When the log
 * cannot be read, the reason in plain words instead of the terminal; the header still says what happened.
 */
export function EndedLogView({ data, terminal, onRetry }: EndedLogViewProps) {
  const why = endedWhy(data);
  const failed = data.state === "failed" || data.state === "expired";
  const c = data.contribution;
  const unavailable = data.unavailable ? UNAVAILABLE_TEXT[data.unavailable] : null;
  return (
    <div className="flex size-full min-h-0 flex-col gap-2">
      <header className="flex flex-col gap-1 rounded-row bg-fill px-3 py-2 text-[12.5px]" aria-label="How this worker ended">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={cn("font-[650]", failed ? "text-danger" : "text-label-secondary")}>{STATE_WORD[data.state]}</span>
          <span aria-hidden className="text-faint">·</span>
          <span className="text-muted">last output</span>
          {data.end.at ? (
            <time className="ml-auto text-[11.5px] text-faint tabular-nums" dateTime={new Date(data.end.at).toISOString()} title={fullTime(data.end.at)}>
              {clockTime(data.end.at)}
            </time>
          ) : null}
        </div>
        {why ? (
          <p className={cn("flex min-w-0 items-start gap-1.5 leading-[1.4]", failed ? "text-danger" : "text-label-secondary")}>
            <CircleAlert aria-hidden className="mt-[2px] size-3.5 shrink-0" />
            <span className="min-w-0">
              <span className="font-[600]">Why: {why.text}.</span>
              {why.detail && why.detail !== why.text ? <span className="text-muted"> Recorded: {why.detail}</span> : null}
            </span>
          </p>
        ) : (
          <p className="text-muted">No reason was recorded for how it ended.</p>
        )}
        {c ? (
          <p className="flex min-w-0 items-center gap-1.5 text-muted">
            <GitCommitHorizontal aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {c.completed ? "Finished its workstream. " : null}
              {c.checkpoints > 0 ? `${c.checkpoints} ${c.checkpoints === 1 ? "checkpoint" : "checkpoints"}` : "No checkpoints"}
              {c.lastCheckpoint ? (
                <>
                  , last <span className="font-mono text-[11.5px] text-label-secondary">{c.lastCheckpoint.sha.slice(0, 7)}</span>
                </>
              ) : null}
              {c.branch ? (
                <>
                  {" "}
                  on <span className="font-mono text-[11.5px]">{c.branch}</span>
                </>
              ) : null}
              {c.lastCheckpoint?.summary ? <span title={c.lastCheckpoint.summary}>: {c.lastCheckpoint.summary}</span> : null}
            </span>
          </p>
        ) : null}
        {data.log?.source === "archive" ? <p className="text-[11.5px] text-faint">The VM isn't readable now; this is the copy kept from its last read.</p> : null}
        {data.log?.truncated ? <p className="text-[11.5px] text-faint">Older output was cut; this is the end of the log.</p> : null}
      </header>
      <div className="relative min-h-0 flex-1">
        {data.log ? (
          data.log.text.trim() ? (
            terminal
          ) : (
            <EmptyState icon={<SquareTerminal />} title="The log is empty" description="The worker wrote nothing before it ended." />
          )
        ) : (
          <EmptyState
            icon={<SquareTerminal />}
            title={unavailable?.title ?? "Log unavailable"}
            description={unavailable?.description}
            action={
              onRetry && (data.unavailable === "vm_unreachable" || data.unavailable === "environment_unavailable") ? (
                <Button size="xs" variant="ghost" onClick={onRetry}>
                  <RotateCw /> Try again
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
