"use client";

import type { CliKind, WorkstreamView } from "@morrow/contracts";
import { Fragment } from "react";
import { HARNESS_LABEL, HarnessIcon } from "@/components/harness/harness-icon";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { agentTone, StatusPip, TONE_TILE } from "./agent-status";
import { DiffCounts } from "./diff-tab";
import { WorkerList, type SubagentDetailState, type WorkerRowData } from "./worker-list";

export type CrewGroup = {
  /** The workstream id. */
  id: string;
  title: string;
  status: WorkstreamView["status"] | null;
  /** Its workers, oldest first: each later one replaced the one before (a handoff). */
  rows: readonly WorkerRowData[];
  /** What its branch changed against the task base, once known. */
  diff: { additions: number; deletions: number; files: number } | null;
};

type CrewListProps = {
  groups: readonly CrewGroup[];
  selected: string | null;
  onSelect: (agentName: string) => void;
  subagentDetail: SubagentDetailState;
  /** Opens the Diff tab on this workstream. */
  onOpenDiff: (workstreamId: string) => void;
};

/**
 * The workers grouped by workstream: a header with the handoff chain (Claude, then Codex, then Claude) and the
 * branch's diff, then one row per worker with its subagents nested under it.
 */
export function CrewList({ groups, selected, onSelect, subagentDetail, onOpenDiff }: CrewListProps) {
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <section key={group.id} aria-label={`Workstream ${group.title}`} className="flex flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2 px-2">
            <span className="min-w-0 truncate text-[12px] font-[650] tracking-[0.01em] text-label-secondary">{group.title}</span>
            {group.rows.length > 1 ? <Chain rows={group.rows} /> : null}
            {group.diff ? (
              <Tooltip content={`${group.diff.files} ${group.diff.files === 1 ? "file" : "files"} changed. Open the diff`}>
                <button
                  type="button"
                  onClick={() => onOpenDiff(group.id)}
                  className="ml-auto shrink-0 rounded-capsule px-1.5 py-0.5 transition-colors duration-150 hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Diff of ${group.title}: ${group.diff.files} files, ${group.diff.additions} lines added, ${group.diff.deletions} removed`}
                >
                  <DiffCounts additions={group.diff.additions} deletions={group.diff.deletions} />
                </button>
              </Tooltip>
            ) : null}
          </div>
          <WorkerList rows={group.rows} selected={selected} onSelect={onSelect} subagentDetail={subagentDetail} />
        </section>
      ))}
    </div>
  );
}

/** The workstream's workers as small harness tiles with arrows between them: who handed off to whom. */
function Chain({ rows }: { rows: readonly WorkerRowData[] }) {
  const names = rows.map((r) => `${r.label} (${r.cli ? HARNESS_LABEL[r.cli] : "agent"})`).join(", then ");
  return (
    <span role="img" aria-label={`Handoffs: ${names}`} className="flex shrink-0 items-center gap-0.5">
      {rows.map((row, i) => (
        <Fragment key={row.key}>
          {i > 0 ? <span aria-hidden className="text-[10px] text-faint">→</span> : null}
          <ChainTile cli={row.cli} kind={row.state.kind} />
        </Fragment>
      ))}
    </span>
  );
}

function ChainTile({ cli, kind }: { cli: CliKind | null; kind: WorkerRowData["state"]["kind"] }) {
  return (
    <span className="relative">
      {cli ? (
        <HarnessIcon cli={cli} size={14} decorative className={TONE_TILE[agentTone(kind)]} />
      ) : (
        <span className={cn("block size-3.5 rounded-[28%] bg-fill-strong", TONE_TILE[agentTone(kind)])} />
      )}
      <StatusPip kind={kind} size={8} className="-right-0.5 -bottom-0.5" />
    </span>
  );
}
