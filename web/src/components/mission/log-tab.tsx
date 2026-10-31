"use client";

import type { CliKind, WorkerLogResponse } from "@morrow/contracts";
import { Lock, RotateCw, SquareTerminal } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { HarnessIcon } from "@/components/harness/harness-icon";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Loader } from "@/components/ui/loader";
import { Select } from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import { errorMessage, getWorkerLog, isApiError } from "@/lib/api";
import { EndedLogView } from "./ended-log";
import type { LogStatus } from "./log-terminal";

const LogTerminal = dynamic(() => import("./log-terminal"), {
  ssr: false,
  loading: () => (
    <div className="grid size-full place-items-center text-[12.5px] text-muted">
      <Loader className="size-4" />
    </div>
  ),
});

export type LogWorker = { agentName: string; leaseId: string; label: string; cli: CliKind | null; live: boolean };

const ENDED: Record<string, string> = {
  lease_ended: "The worker's lease ended, so its log closed.",
  not_authorized: "You can't inspect this worker. Inspect is only open to team members while the worker holds a lease.",
  unavailable: "The log isn't reachable right now.",
  server_shutdown: "The server restarted. Reconnect to keep reading.",
  closed: "The log stream closed.",
};

type LogTabProps = {
  teamId: string;
  workers: readonly LogWorker[];
  selected: string | null;
  onSelect: (agentName: string) => void;
  /** Team policy: read-only inspect allowed. */
  allowInspect: boolean;
};

/** One ended worker's last output, fetched once per worker (and on Try again). */
function EndedLog({ teamId, leaseId }: { teamId: string; leaseId: string }) {
  const [state, setState] = useState<{ leaseId: string; data: WorkerLogResponse | null; error: { message: string; locked: boolean } | null } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    getWorkerLog(teamId, leaseId, { signal: abort.signal }).then(
      (data) => setState({ leaseId, data, error: null }),
      (error: unknown) => {
        if (abort.signal.aborted) return;
        const locked = isApiError(error) && (error.status === 403 || error.status === 404);
        setState({ leaseId, data: null, error: { message: errorMessage(error, "Couldn't load this worker's log."), locked } });
      },
    );
    return () => abort.abort();
  }, [teamId, leaseId, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const current = state?.leaseId === leaseId ? state : null;
  if (!current)
    return (
      <div className="grid size-full place-items-center text-[12.5px] text-muted" role="status" aria-label="Loading the worker's last output">
        <Loader className="size-4" />
      </div>
    );
  if (current.error)
    return (
      <EmptyState
        icon={current.error.locked ? <Lock /> : <SquareTerminal />}
        title={current.error.locked ? "You can't read this worker's log" : "Log unavailable"}
        description={current.error.message}
        action={
          current.error.locked ? undefined : (
            <Button size="xs" variant="ghost" onClick={retry}>
              <RotateCw /> Try again
            </Button>
          )
        }
      />
    );
  const data = current.data!;
  return <EndedLogView data={data} onRetry={retry} terminal={data.log ? <LogTerminal key={`${leaseId}:${attempt}`} text={data.log.text} /> : null} />;
}

/** Read-only inspect of one worker's log: live while it holds a lease, its last output after. Locked with a reason when policy says no. */
export function LogTab({ teamId, workers, selected, onSelect, allowInspect }: LogTabProps) {
  const [status, setStatus] = useState<LogStatus>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const onStatus = useCallback((next: LogStatus) => setStatus(next), []);

  if (!allowInspect)
    return (
      <EmptyState
        icon={<Lock />}
        title="Inspect is off for this team"
        description="Worker logs are hidden by team policy. An owner or admin can turn read-only inspect on in Settings."
      />
    );
  if (workers.length === 0)
    return <EmptyState icon={<SquareTerminal />} title="No workers yet" description="Logs show here once a worker starts on this task." />;

  const worker = workers.find((w) => w.agentName === selected) ?? workers.find((w) => w.live) ?? workers[0]!;
  const options = workers.map((w) => ({
    value: w.agentName,
    label: `${w.label}${w.live ? "" : " (ended)"}`,
    icon: w.cli ? <HarnessIcon cli={w.cli} size={14} decorative /> : undefined,
  }));

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Select aria-label="Worker" size="sm" options={options} value={worker.agentName} onValueChange={(v) => v && onSelect(v)} />
        </div>
        {worker.live ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
            {status.kind === "live" ? (
              <>
                <StatusDot tone="live" pulse /> Live, read only
              </>
            ) : status.kind === "connecting" ? (
              <>
                <Loader className="size-3" /> Connecting
              </>
            ) : (
              <Button size="xs" variant="ghost" onClick={() => setAttempt((a) => a + 1)}>
                <RotateCw /> Reconnect
              </Button>
            )}
          </span>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-card bg-surface p-2.5 shadow-raised">
        {worker.live ? (
          <>
            <LogTerminal key={worker.leaseId} teamId={teamId} leaseId={worker.leaseId} attempt={attempt} onStatus={onStatus} />
            {status.kind === "ended" && (status.reason === "unavailable" || status.reason === "not_authorized") ? (
              // Nothing was ever streamed: say why in the middle instead of under an empty terminal.
              <div className="absolute inset-0 grid place-items-center bg-surface p-4">
                <EmptyState
                  icon={status.reason === "not_authorized" ? <Lock /> : <SquareTerminal />}
                  title={status.reason === "not_authorized" ? "You can't inspect this worker" : "Log unavailable"}
                  description={status.message ?? ENDED[status.reason]}
                />
              </div>
            ) : status.kind === "ended" ? (
              <div className="absolute inset-x-2.5 bottom-2.5 rounded-row bg-fill px-3 py-2 text-[12.5px] text-muted backdrop-blur-sm">
                {status.message ?? ENDED[status.reason] ?? ENDED.closed}
              </div>
            ) : null}
          </>
        ) : (
          <EndedLog key={worker.leaseId} teamId={teamId} leaseId={worker.leaseId} />
        )}
      </div>
    </div>
  );
}
