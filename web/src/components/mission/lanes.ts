import type { CliKind, TaskDetail, TaskView, TraceKind, WorkforceView } from "@morrow/contracts";

export type LaneSegment = {
  leaseId: string;
  agentName: string;
  cli: CliKind | null;
  start: number;
  /** Null while the lease is live. */
  end: number | null;
  ending: "limit" | "offline" | "done" | "failed" | "released" | null;
};

export type LaneMarker = { at: number; kind: "checkpoint" | "ack" | "limit" | "offline" | "verified" | "failed"; label: string };

export type Lane = { workstreamId: string; title: string; segments: LaneSegment[]; markers: LaneMarker[] };

const LIVE = new Set(["reserved", "spawning", "running"]);
const ENDING: Partial<Record<TraceKind, LaneSegment["ending"]>> = {
  "worker.quota_limited": "limit",
  "worker.offline": "offline",
  "worker.blocked": "failed",
};
const MARKER: Partial<Record<TraceKind, LaneMarker["kind"]>> = {
  "task.checkpointed": "checkpoint",
  "task.handoff_acked": "ack",
  "worker.quota_limited": "limit",
  "worker.offline": "offline",
};

/**
 * One swimlane per workstream: each lease is a segment from its start to whatever ended it (a limit,
 * going offline, the next lease taking over, or the task ending), with trace events as markers.
 */
export function deriveLanes(task: TaskDetail, workforce: WorkforceView | null): Lane[] {
  // A subagent shares its parent's workstream but never holds it, so it gets no segment of its own.
  const leases = Object.values(workforce?.leases ?? {})
    .filter((l) => l.taskId === task.id && !l.parentLeaseId)
    .sort((a, b) => a.createdAt - b.createdAt || a.epoch - b.epoch);
  const terminal = task.status === "completed" || task.status === "failed" || task.status === "cancelled";

  return task.workstreams.map((ws) => {
    const own = leases.filter((l) => l.workstreamId === ws.id);
    const segments = own.map((lease, i): LaneSegment => {
      const ender = task.trace.find((e) => e.leaseId === lease.id && ENDING[e.kind] !== undefined);
      const next = own[i + 1];
      const live = LIVE.has(lease.state);
      let end: number | null = null;
      let ending: LaneSegment["ending"] = null;
      if (ender) {
        end = ender.at;
        ending = ENDING[ender.kind]!;
      } else if (next) {
        end = next.createdAt;
        ending = "released";
      } else if (!live) {
        // An ended lease stops at the last thing the trace says about it (its DONE checkpoint, usually).
        const last = task.trace.findLast((e) => e.leaseId === lease.id);
        end = last?.at ?? (terminal ? task.updatedAt : lease.createdAt);
        ending = lease.state === "failed" ? "failed" : ws.status === "done" ? "done" : "released";
      } else if (terminal) {
        end = task.updatedAt;
        ending = ws.status === "done" ? "done" : "released";
      }
      return {
        leaseId: lease.id,
        agentName: lease.agentName,
        cli: workforce?.profiles[lease.profileId]?.cli ?? null,
        start: lease.createdAt,
        end: end === null ? null : Math.max(end, lease.createdAt),
        ending: end === null ? null : ending,
      };
    });
    const ids = new Set(own.map((l) => l.id));
    const markers: LaneMarker[] = task.trace
      .filter((e) => e.leaseId !== null && ids.has(e.leaseId) && MARKER[e.kind] !== undefined)
      .map((e) => ({ at: e.at, kind: MARKER[e.kind]!, label: e.message }));
    return { workstreamId: ws.id, title: ws.title, segments, markers };
  });
}

/** The time span a lane chart covers: task start to its end, or to now while it runs. */
export function laneDomain(task: TaskView, lanes: readonly Lane[], now: number): [number, number] {
  const terminal = task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  const end = terminal ? task.updatedAt : Math.max(now, task.updatedAt);
  const starts = lanes.flatMap((l) => l.segments.map((s) => s.start));
  const start = Math.min(task.createdAt, ...starts);
  return [start, Math.max(end, start + 1000)];
}
