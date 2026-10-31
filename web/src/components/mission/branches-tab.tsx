"use client";

import type { ArtifactsView, ProjectView, TaskView, WorkstreamView } from "@morrow/contracts";
import { ExternalLink, GitBranch, GitPullRequest, Globe } from "lucide-react";
import { GithubMark } from "@/components/auth/github-button";
import type { ReactNode } from "react";
import { safeHref } from "@/components/timeline/linkify";
import { clockTime } from "@/components/timeline/time";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { WorkstreamGit } from "@/components/github/workstream-git";
import { CopyButton } from "./copy-button";
import { DetailStatus } from "./detail-status";
import { commitUrl, compareUrl } from "./links";
import type { TaskDetailState } from "./use-task-detail";

const STATUS: Record<WorkstreamView["status"], { tone: BadgeTone; label: string }> = {
  pending: { tone: "neutral", label: "Pending" },
  active: { tone: "sky", label: "Active" },
  handoff: { tone: "peach", label: "Handoff" },
  done: { tone: "mint", label: "Done" },
  failed: { tone: "rose", label: "Failed" },
};

function OutLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        className ??
        "inline-flex items-center gap-1 rounded-[6px] text-[12.5px] font-[550] text-soft-sky-ink underline-offset-[3px] hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      }
    >
      {children}
    </a>
  );
}

type BranchesTabProps = {
  /** The live task: which workstreams exist and where each stands. */
  task: TaskView;
  /** Workstream titles and checkpoints. */
  detail: TaskDetailState;
  project: ProjectView | null;
  artifacts: ArtifactsView | null;
  error: string | null;
  /** `me.features.githubWebUrl`: where compare and commit links point. */
  githubWebUrl: string;
  teamId: string;
  /** Task creator, owner or admin: may commit and push a workstream's worktree. */
  canCommit: boolean;
};

/** One card per workstream: its branch, last checkpoint (copyable) and the compare view on GitHub. */
export function BranchesTab({ task, detail, project, artifacts, error, githubWebUrl, teamId, canCommit }: BranchesTabProps) {
  const pr = artifacts?.pullRequest ?? null;
  const prHref = pr ? safeHref(pr.url) : null;
  const previewHref = artifacts?.previewUrl ? safeHref(artifacts.previewUrl) : null;

  if (task.workstreams.length === 0)
    return <EmptyState icon={<GitBranch />} title="No branches yet" description="Each workstream gets its own branch once the plan is ready." />;

  return (
    <div className="flex flex-col gap-3">
      <DetailStatus detail={detail} what="the branches" className="px-0" />
      {prHref || previewHref ? (
        <div className="flex flex-wrap gap-2">
          {pr && prHref ? (
            <OutLink href={prHref} className="inline-flex items-center gap-2 rounded-row bg-surface px-3 py-2 text-[13px] font-[550] text-text shadow-raised transition-colors hover:bg-control-hover">
              <GitPullRequest className="size-4 text-success" />
              Pull request #{pr.number}
              <span className="text-muted">{pr.state}</span>
              <ExternalLink className="size-3.5 text-faint" />
            </OutLink>
          ) : null}
          {previewHref ? (
            <OutLink href={previewHref} className="inline-flex items-center gap-2 rounded-row bg-surface px-3 py-2 text-[13px] font-[550] text-text shadow-raised transition-colors hover:bg-control-hover">
              <Globe className="size-4 text-soft-sky" />
              Preview
              <ExternalLink className="size-3.5 text-faint" />
            </OutLink>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
      <ul className="flex flex-col gap-2">
        {(detail.data?.workstreams ?? []).map((ws) => {
          const remote = artifacts?.branches.find((b) => b.workstreamId === ws.id);
          const sha = ws.lastCheckpoint?.sha ?? remote?.headSha ?? null;
          const compare = project ? compareUrl(githubWebUrl, project.repoFullName, project.defaultBranch, ws.branch) : null;
          const commit = project && sha ? commitUrl(githubWebUrl, project.repoFullName, sha) : null;
          // The live view is fresher than the last detail fetch.
          const status = STATUS[task.workstreams.find((w) => w.id === ws.id)?.status ?? ws.status];
          return (
            <li key={ws.id} className="rounded-card bg-surface p-3 shadow-raised">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-[600] tracking-[-0.01em]">{ws.title}</span>
                <Badge tone={status.tone} size="sm">
                  {status.label}
                </Badge>
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[12.5px]">
                <GitBranch className="size-3.5 shrink-0 text-faint" />
                <span className="min-w-0 truncate font-mono text-label-secondary">{ws.branch}</span>
                <CopyButton value={ws.branch} label="Copy branch name" />
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12.5px]">
                <span className="grid size-3.5 shrink-0 place-items-center">
                  <span className="size-1.5 rounded-full bg-current text-faint" />
                </span>
                {sha ? (
                  <>
                    {commit ? (
                      <OutLink href={commit} className="font-mono text-label-secondary underline-offset-[3px] hover:underline">
                        {sha.slice(0, 7)}
                      </OutLink>
                    ) : (
                      <span className="font-mono text-label-secondary">{sha.slice(0, 7)}</span>
                    )}
                    <CopyButton value={sha} label="Copy commit SHA" />
                    {ws.lastCheckpoint ? (
                      <span className="min-w-0 truncate text-muted">
                        {ws.lastCheckpoint.summary} · {clockTime(ws.lastCheckpoint.at)}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-faint">No checkpoint yet</span>
                )}
              </div>
              {compare ? (
                <div className="mt-2.5 border-t border-border pt-2">
                  <OutLink href={compare}>
                    <GithubMark className="size-3.5" />
                    Compare with {project!.defaultBranch} on GitHub
                    <ExternalLink className="size-3 opacity-70" />
                  </OutLink>
                </div>
              ) : null}
              <WorkstreamGit teamId={teamId} taskId={task.id} projectId={task.projectId} workstreamId={ws.id} checkpointSha={ws.lastCheckpoint?.sha ?? null} canCommit={canCommit} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
