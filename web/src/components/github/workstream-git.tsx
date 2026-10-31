"use client";

import { COMMIT_MESSAGE_MAX, type BranchView, type WorktreeChanges } from "@morrow/contracts";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitCommitHorizontal, RefreshCw, Upload } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { safeHref } from "@/components/timeline/linkify";
import { clockTime } from "@/components/timeline/time";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useMinuteClock } from "@/components/ui/timer";
import { toast } from "@/components/ui/toast";
import { commitWorkstream, getWorkstreamBranch, getWorkstreamChanges } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useGithubVersion } from "@/lib/store";
import { FreshnessNote, GithubProblem } from "./github-states";
import { commitMessageError, relativeAge, WORKTREE_STATUS } from "./pull-state";
import { useGithubResource } from "./use-github";

const COMMITS_SHOWN = 5;

type WorkstreamGitProps = {
  teamId: string;
  taskId: string;
  projectId: string;
  workstreamId: string;
  /** The workstream's newest checkpoint, so a push by the agent refreshes the branch. */
  checkpointSha: string | null;
  /** Task creator, owner or admin: the same people who can cancel or retry. */
  canCommit: boolean;
};

/** The workstream's branch on GitHub (ahead and behind, latest commits) and, on demand, the agent's unpushed work with commit and push. */
export function WorkstreamGit({ teamId, taskId, projectId, workstreamId, checkpointSha, canCommit }: WorkstreamGitProps) {
  const listVersion = useGithubVersion(projectId);
  const [pushes, setPushes] = useState(0);
  const loadBranch = useCallback((signal: AbortSignal) => getWorkstreamBranch(teamId, taskId, workstreamId, { signal }), [teamId, taskId, workstreamId]);
  const branch = useGithubResource(`${teamId}/${taskId}/${workstreamId}`, loadBranch, `${listVersion}:${checkpointSha ?? ""}:${pushes}`);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="mt-2.5 flex flex-col gap-2 border-t border-border pt-2">
      {branch.data ? (
        <BranchSummary branch={branch.data} refreshing={branch.loading} onRefresh={branch.reload} />
      ) : branch.loading ? (
        <Skeleton className="h-4 w-2/3" />
      ) : (
        <GithubProblem error={branch.error} fallback="Couldn't load the branch from GitHub." onRetry={branch.reload} />
      )}
      {branch.data && branch.error ? <GithubProblem error={branch.error} fallback="Couldn't refresh the branch." onRetry={branch.reload} /> : null}

      <button
        type="button"
        aria-expanded={worktreeOpen}
        aria-controls={panelId}
        onClick={() => setWorktreeOpen((v) => !v)}
        className="inline-flex items-center gap-1 self-start rounded-[6px] text-[12.5px] font-[550] text-label-secondary hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
      >
        {worktreeOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Unpushed work on the agent&apos;s machine
      </button>
      {worktreeOpen ? (
        <div id={panelId}>
          <Worktree teamId={teamId} taskId={taskId} workstreamId={workstreamId} canCommit={canCommit} onPushed={() => setPushes((n) => n + 1)} />
        </div>
      ) : null}
    </div>
  );
}

function BranchSummary({ branch, refreshing, onRefresh }: { branch: BranchView; refreshing: boolean; onRefresh: () => void }) {
  const [all, setAll] = useState(false);
  const now = useMinuteClock();
  if (!branch.exists)
    return (
      <p className="text-[12.5px] text-faint">
        Not on GitHub yet. The branch appears once an agent pushes its first checkpoint.
      </p>
    );
  const commits = all ? branch.commits : branch.commits.slice(0, COMMITS_SHOWN);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] tabular-nums">
        <span className="inline-flex items-center gap-1 text-label-secondary" title={`${branch.aheadBy} commits ${branch.base} doesn't have`}>
          <ArrowUp className="size-3.5 text-success" />
          {branch.aheadBy} ahead
        </span>
        <span className="inline-flex items-center gap-1 text-label-secondary" title={`${branch.behindBy} commits on ${branch.base} this branch doesn't have`}>
          <ArrowDown className={cn("size-3.5", branch.behindBy > 0 ? "text-warning" : "text-faint")} />
          {branch.behindBy} behind {branch.base}
        </span>
        <button
          type="button"
          aria-label="Refresh the branch from GitHub"
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-auto grid size-6 place-items-center rounded-[6px] text-faint hover:bg-control-hover hover:text-text focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </button>
      </div>
      <FreshnessNote freshness={branch.freshness} />
      {commits.length > 0 ? (
        <ol className="flex flex-col gap-1" aria-label="Latest commits">
          {commits.map((c) => {
            const href = c.url ? safeHref(c.url) : null;
            const who = c.author?.login ?? c.authorName ?? "unknown";
            return (
              <li key={c.sha} className="flex min-w-0 items-center gap-2 text-[12.5px]">
                <Avatar name={who} src={c.author?.avatarUrl} login={c.author?.login} size={16} />
                <span className="min-w-0 flex-1 truncate text-label-secondary" title={c.message}>
                  {c.message || "(no message)"}
                </span>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded-[5px] font-mono text-[11.5px] text-soft-sky-ink underline-offset-[3px] hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {c.sha.slice(0, 7)}
                  </a>
                ) : (
                  <span className="shrink-0 font-mono text-[11.5px] text-faint">{c.sha.slice(0, 7)}</span>
                )}
                {c.committedAt ? (
                  <span className="hidden shrink-0 text-faint sm:inline" title={clockTime(c.committedAt)}>
                    {relativeAge(c.committedAt, now)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {branch.commits.length > COMMITS_SHOWN ? (
        <Button size="xs" variant="quiet" className="self-start" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show ${branch.commits.length - COMMITS_SHOWN} more`}
        </Button>
      ) : null}
    </div>
  );
}

type WorktreeProps = { teamId: string; taskId: string; workstreamId: string; canCommit: boolean; onPushed: () => void };

function Worktree({ teamId, taskId, workstreamId, canCommit, onPushed }: WorktreeProps) {
  const [checks, setChecks] = useState(0);
  const load = useCallback((signal: AbortSignal) => getWorkstreamChanges(teamId, taskId, workstreamId, { signal }), [teamId, taskId, workstreamId]);
  const res = useGithubResource(`${teamId}/${taskId}/${workstreamId}/worktree`, load, checks);
  const recheck = () => setChecks((n) => n + 1);

  if (!res.data && res.loading)
    return (
      <div className="flex flex-col gap-1.5" aria-busy="true" aria-label="Checking the worktree">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  if (!res.data) return <GithubProblem error={res.error} fallback="Couldn't read the agent's worktree." onRetry={recheck} />;
  return (
    <div className="flex flex-col gap-2">
      {res.error ? <GithubProblem error={res.error} fallback="Couldn't check the worktree again." onRetry={recheck} /> : null}
      <WorktreeBody
        changes={res.data}
        checking={res.loading}
        onRecheck={recheck}
        teamId={teamId}
        taskId={taskId}
        workstreamId={workstreamId}
        canCommit={canCommit}
        onPushed={() => {
          recheck();
          onPushed();
        }}
      />
    </div>
  );
}

function WorktreeBody({ changes, checking, onRecheck, teamId, taskId, workstreamId, canCommit, onPushed }: WorktreeProps & { changes: WorktreeChanges; checking: boolean; onRecheck: () => void }) {
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const now = useMinuteClock();

  if (changes.state === "missing")
    return <p className="text-[12.5px] text-faint">This agent&apos;s machine has no worktree for the branch. It was never started there, or the machine was replaced.</p>;

  const conflicted = changes.files.filter((f) => f.status === "conflicted").length;
  const clean = changes.files.length === 0 && changes.unpushed === 0;
  const problem = message.trim() ? commitMessageError(message, COMMIT_MESSAGE_MAX) : null;
  const canSend = canCommit && !clean && conflicted === 0 && !!message.trim() && !problem && !busy;

  async function commit() {
    setBusy(true);
    try {
      const res = await commitWorkstream(teamId, taskId, workstreamId, message.trim());
      setMessage("");
      toast.success(res.committed ? `Committed and pushed ${res.sha.slice(0, 7)}` : `Pushed ${res.sha.slice(0, 7)}`);
      onPushed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
        <span>
          {changes.files.length === 0 ? "No uncommitted changes" : `${changes.files.length}${changes.truncated ? "+" : ""} changed ${changes.files.length === 1 ? "file" : "files"}`}
        </span>
        {changes.unpushed > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Upload className="size-3.5" />
            {changes.unpushed} {changes.unpushed === 1 ? "commit" : "commits"} not pushed
          </span>
        ) : null}
        <span className="text-faint" title={clockTime(changes.checkedAt)}>
          checked {relativeAge(changes.checkedAt, now)}
        </span>
        <button
          type="button"
          aria-label="Check the worktree again"
          onClick={onRecheck}
          disabled={checking}
          className="ml-auto grid size-6 place-items-center rounded-[6px] text-faint hover:bg-control-hover hover:text-text focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
        >
          <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
        </button>
      </div>

      {changes.files.length > 0 ? (
        <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto" aria-label="Changed files">
          {changes.files.map((f) => {
            const s = WORKTREE_STATUS[f.status];
            return (
              <li key={f.path} className="flex min-w-0 items-center gap-2 font-mono text-[12px]">
                <span aria-label={s.label} title={s.label} className={cn("w-3 shrink-0 text-center", s.className)}>
                  {s.letter}
                </span>
                <span className="min-w-0 flex-1 truncate text-label-secondary" title={f.path}>
                  {f.path}
                </span>
                {f.additions === null ? (
                  <span className="shrink-0 text-faint">binary</span>
                ) : (
                  <>
                    <span className="shrink-0 text-success tabular-nums">+{f.additions}</span>
                    <span className="shrink-0 text-danger tabular-nums">−{f.deletions ?? 0}</span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {changes.truncated ? <p className="text-[12px] text-faint">Only the first {changes.files.length} files are listed. A commit takes all of them.</p> : null}

      {conflicted > 0 ? (
        <Alert tone="warning">
          {conflicted} {conflicted === 1 ? "file has" : "files have"} merge conflicts. They need resolving before anything can be pushed.
        </Alert>
      ) : null}

      {clean ? null : canCommit ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) setConfirming(true);
          }}
        >
          <label htmlFor={inputId} className="text-[12.5px] font-[550] text-label-secondary">
            Commit message
          </label>
          <Textarea
            id={inputId}
            rows={1}
            maxRows={6}
            value={message}
            placeholder="What these changes do"
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (canSend) setConfirming(true);
              }
            }}
          />
          {problem ? <p className="text-[12px] text-danger">{problem}</p> : null}
          <Button type="submit" size="sm" variant="secondary" className="self-start" disabled={!canSend} loading={busy}>
            <GitCommitHorizontal />
            {changes.files.length > 0 ? "Commit and push" : "Push"}
          </Button>
        </form>
      ) : (
        <p className="text-[12px] text-faint">Only the task&apos;s creator or a team admin can commit and push this work.</p>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="primary"
        title={changes.files.length > 0 ? "Commit and push this work?" : "Push this branch?"}
        description={
          changes.agentLive
            ? "An agent is working in this worktree right now. The commit takes its work in progress as it is, half-written files included. The branch is pushed to GitHub as you."
            : "Everything in the worktree is committed and the branch is pushed to GitHub as you."
        }
        confirmLabel={changes.files.length > 0 ? "Commit and push" : "Push"}
        onConfirm={commit}
      />
    </div>
  );
}
