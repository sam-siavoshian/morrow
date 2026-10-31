"use client";

import type { BranchDiffFile, CliKind, PullFileStatus } from "@morrow/contracts";
import { ChevronRight, ExternalLink, FileDiff, GitBranch } from "lucide-react";
import { useId, useState } from "react";
import { GithubMark } from "@/components/auth/github-button";
import { FreshnessNote, GithubProblem } from "@/components/github/github-states";
import { HarnessIcon } from "@/components/harness/harness-icon";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { parsePatch, shortCount, type DiffLine } from "./diff";
import type { DiffState } from "./use-workstream-diffs";

export type DiffWorkstream = {
  id: string;
  title: string;
  branch: string;
  /** The harnesses that worked on it, oldest first (a handoff chain). */
  clis: readonly (CliKind | null)[];
  /** GitHub's compare page for its branch, when the project is known. */
  compareHref: string | null;
};

/** Lines drawn per file before "Show all"; very long files stay cheap to open. */
const LINES_SHOWN = 400;

type DiffTabProps = {
  workstreams: readonly DiffWorkstream[];
  diffs: ReadonlyMap<string, DiffState>;
  selected: string | null;
  onSelect: (workstreamId: string) => void;
};

/** What each workstream's branch changed against the task base: a picker, totals, and every file as a unified diff. */
export function DiffTab({ workstreams, diffs, selected, onSelect }: DiffTabProps) {
  if (workstreams.length === 0)
    return <EmptyState icon={<FileDiff />} title="No changes yet" description="Each workstream's changes show here once its agent pushes a checkpoint." />;
  const current = workstreams.find((w) => w.id === selected) ?? workstreams[0]!;
  const state = diffs.get(current.id);
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Workstream" className="flex flex-wrap gap-1.5">
        {workstreams.map((w) => {
          const d = diffs.get(w.id)?.data;
          const on = w.id === current.id;
          return (
            <button
              key={w.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onSelect(w.id)}
              className={cn(
                "flex min-w-0 max-w-full items-center gap-1.5 rounded-capsule px-2.5 py-1 text-[12.5px] font-[550] transition-colors duration-150",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring pointer-coarse:min-h-9",
                on ? "bg-surface text-text shadow-raised" : "text-muted hover:bg-fill-hover hover:text-text",
              )}
            >
              <ChainIcons clis={w.clis} />
              <span className="min-w-0 truncate">{w.title}</span>
              {d?.exists && !d.tooLarge ? <DiffCounts additions={d.additions} deletions={d.deletions} /> : null}
            </button>
          );
        })}
      </div>
      <WorkstreamDiff workstream={current} state={state} />
    </div>
  );
}

export function ChainIcons({ clis, size = 14 }: { clis: readonly (CliKind | null)[]; size?: number }) {
  const shown = clis.slice(-3);
  return (
    <span className="flex shrink-0 items-center">
      {shown.map((cli, i) => (
        <span key={i} className={cn("flex items-center", i > 0 && "-ml-1")}>
          {cli ? <HarnessIcon cli={cli} size={size} stacked decorative /> : <span className="block rounded-[28%] bg-fill-strong" style={{ width: size, height: size }} />}
        </span>
      ))}
    </span>
  );
}

/** "+120 −30", green and red, tabular. */
export function DiffCounts({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={cn("shrink-0 font-mono text-[11px] tabular-nums", className)} aria-label={`${additions} lines added, ${deletions} removed`}>
      <span className="text-success">+{shortCount(additions)}</span> <span className="text-danger">−{shortCount(deletions)}</span>
    </span>
  );
}

function WorkstreamDiff({ workstream, state }: { workstream: DiffWorkstream; state: DiffState | undefined }) {
  const github = workstream.compareHref ? (
    <a
      href={workstream.compareHref}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-[6px] text-[12.5px] font-[550] text-soft-sky-ink underline-offset-[3px] hover:underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      <GithubMark className="size-3.5" />
      Compare on GitHub
      <ExternalLink className="size-3 opacity-70" />
    </a>
  ) : null;
  const branch = (
    <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted">
      <GitBranch className="size-3.5 shrink-0 text-faint" />
      <span className="min-w-0 truncate font-mono">{workstream.branch}</span>
    </span>
  );

  if (!state || (state.loading && !state.data)) {
    if (!state)
      return (
        <div className="flex flex-col gap-2">
          {branch}
          <p className="text-[12.5px] text-faint">Nothing pushed yet. The diff shows once its agent pushes a checkpoint.</p>
        </div>
      );
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {branch}
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  const d = state.data;
  if (!d) return <GithubProblem error={state.error} fallback="Couldn't load this diff from GitHub." />;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {branch}
        <span className="ml-auto">{github}</span>
      </div>
      {state.error ? <GithubProblem error={state.error} fallback="Couldn't refresh this diff." /> : null}
      <FreshnessNote freshness={d.freshness} />
      {!d.exists ? (
        <p className="text-[12.5px] text-faint">Not on GitHub yet. The diff shows once its agent pushes a checkpoint.</p>
      ) : d.tooLarge ? (
        <p className="text-[12.5px] text-muted">This branch changed too much to show here. Open it on GitHub instead.</p>
      ) : d.changedFiles === 0 ? (
        <p className="text-[12.5px] text-faint">No changes against {d.base} yet.</p>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted tabular-nums">
            <span className="font-[600] text-text">
              {d.changedFiles} {d.changedFiles === 1 ? "file" : "files"}
            </span>
            <DiffCounts additions={d.additions} deletions={d.deletions} className="text-[12px]" />
            <span>
              against {d.base} · {d.aheadBy} {d.aheadBy === 1 ? "commit" : "commits"}
            </span>
          </p>
          <ul className="flex flex-col gap-1.5" aria-label="Changed files">
            {d.files.map((file) => (
              <FileRow key={`${file.previousPath ?? ""}>${file.path}`} file={file} />
            ))}
          </ul>
          {d.filesTruncated ? <p className="text-[12px] text-faint">Showing {d.files.length} of {d.changedFiles} files. The rest are on GitHub.</p> : null}
        </>
      )}
    </div>
  );
}

const STATUS_MARK: Record<PullFileStatus, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "text-success", label: "added" },
  removed: { letter: "D", className: "text-danger", label: "deleted" },
  modified: { letter: "M", className: "text-warning", label: "modified" },
  renamed: { letter: "R", className: "text-soft-lilac-ink", label: "renamed" },
  copied: { letter: "C", className: "text-soft-sky-ink", label: "copied" },
  changed: { letter: "M", className: "text-warning", label: "changed" },
  unchanged: { letter: "=", className: "text-faint", label: "unchanged" },
};

function FileRow({ file }: { file: BranchDiffFile }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const mark = STATUS_MARK[file.status];
  const slash = file.path.lastIndexOf("/");
  return (
    <li className="overflow-hidden rounded-row bg-surface shadow-hairline">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left transition-colors duration-150 hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-faint transition-transform duration-150", open && "rotate-90")} />
        <span className={cn("w-3 shrink-0 text-center font-mono text-[11.5px] font-[700]", mark.className)} title={mark.label}>
          {mark.letter}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline font-mono text-[12.5px]" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>
          {slash >= 0 ? <span className="min-w-0 truncate text-faint">{file.path.slice(0, slash + 1)}</span> : null}
          <span className="shrink-0 text-text">{file.path.slice(slash + 1)}</span>
        </span>
        <DiffCounts additions={file.additions} deletions={file.deletions} />
      </button>
      <div id={panel} hidden={!open}>
        {open ? <Patch file={file} /> : null}
      </div>
    </li>
  );
}

const LINE_TONE: Record<DiffLine["kind"], string> = {
  add: "bg-soft-mint-wash text-text",
  del: "bg-soft-rose-wash text-text",
  hunk: "bg-fill text-faint",
  context: "text-label-secondary",
  note: "text-faint italic",
};

function Patch({ file }: { file: BranchDiffFile }) {
  const [all, setAll] = useState(false);
  if (file.patch === null)
    return (
      <p className="border-t border-border px-3 py-2 text-[12px] text-faint">
        {file.patchTruncated ? "This file's diff is too large to show here." : file.previousPath ? `Renamed from ${file.previousPath}, no line changes.` : "Binary file, or no line changes."}
      </p>
    );
  const { lines, rest } = parsePatch(file.patch, all ? Infinity : LINES_SHOWN);
  return (
    <div className="border-t border-border">
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className={LINE_TONE[line.kind]}>
                <td className="w-9 px-1.5 text-right align-top text-faint tabular-nums select-none">{line.oldNo ?? ""}</td>
                <td className="w-9 px-1.5 text-right align-top text-faint tabular-nums select-none">{line.newNo ?? ""}</td>
                <td className="w-4 text-center align-top text-faint select-none">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
                <td className="pr-3 whitespace-pre">{line.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rest > 0 ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full border-t border-border px-3 py-1.5 text-left text-[12px] font-[550] text-muted transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          Show {rest} more {rest === 1 ? "line" : "lines"}
        </button>
      ) : null}
      {file.patchTruncated ? <p className="border-t border-border px-3 py-1.5 text-[11.5px] text-faint">Cut short here. The full file diff is on GitHub.</p> : null}
    </div>
  );
}
