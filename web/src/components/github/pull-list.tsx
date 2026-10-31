"use client";

import type { PullStateFilter, PullSummary } from "@morrow/contracts";
import { ArrowLeft, ExternalLink, FolderGit2, GitPullRequest, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { pullsUrl } from "@/components/mission/links";
import { settingsPath } from "@/components/settings/sections";
import { canManageTeam } from "@/components/settings/permissions";
import { ShellTitle } from "@/components/shell/shell-context";
import { ProjectIcon } from "@/components/sidebar/project-icon";
import { parseRepoFullName } from "@/components/sidebar/project-identity";
import { taskPath } from "@/components/sidebar/sidebar-model";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useMinuteClock } from "@/components/ui/timer";
import { listPulls } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useGithubVersion, useTeam } from "@/lib/store";
import { FreshnessNote, GithubProblem } from "./github-states";
import { PULL_ICON, PullPanel } from "./pull-request";
import { relativeAge } from "./pull-state";
import { useGithubResource } from "./use-github";

const STATE_OPTIONS: { value: PullStateFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
const PULL_NUMBER = /^[1-9]\d{0,9}$/;

/** Reads `?project=&state=&pr=` and keeps only values that make sense for this team. */
function useSelection(projectIds: readonly string[]) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawProject = params.get("project");
  const projectId = rawProject && projectIds.includes(rawProject) ? rawProject : (projectIds[0] ?? null);
  const rawState = params.get("state");
  const state: PullStateFilter = rawState === "closed" || rawState === "all" ? rawState : "open";
  const rawPr = params.get("pr");
  const number = rawPr && PULL_NUMBER.test(rawPr) && Number(rawPr) <= 2 ** 31 - 1 ? Number(rawPr) : null;

  const set = useCallback(
    (next: { project?: string; state?: PullStateFilter; pr?: number | null }) => {
      const query = new URLSearchParams();
      const p = next.project ?? projectId;
      if (p) query.set("project", p);
      const s = next.state ?? state;
      if (s !== "open") query.set("state", s);
      const n = next.pr === undefined ? number : next.pr;
      if (n !== null) query.set("pr", String(n));
      router.replace(`${pathname}?${query.toString()}`, { scroll: false });
    },
    [router, pathname, projectId, state, number],
  );
  return { projectId, state, number, set };
}

/** `/t/[teamId]/pulls`: every pull request of the team's linked repositories, read and acted on as the signed-in member. */
export function PullsView({ teamId, githubWebUrl }: { teamId: string; githubWebUrl: string }) {
  const team = useTeam();
  const projects = useMemo(() => team?.projects ?? [], [team?.projects]);
  const { projectId, state, number, set } = useSelection(projects.map((p) => p.id));
  const project = projects.find((p) => p.id === projectId) ?? null;

  if (!team)
    return (
      <div className="mx-auto flex w-full max-w-[72rem] flex-col gap-3 px-4 pt-6 sm:px-6" aria-busy="true" aria-label="Loading pull requests">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );

  return (
    <>
      <ShellTitle>
        <h1 className="truncate text-[13.5px] font-[600] tracking-[-0.01em] text-text">Pull requests</h1>
      </ShellTitle>
      {!project ? (
        <div className="grid h-full min-h-80 place-items-center px-4">
          <EmptyState
            icon={<FolderGit2 />}
            title="No repositories linked"
            description="Pull requests show here once the team links a GitHub repository."
            action={
              canManageTeam(team.viewerRole) ? (
                <Button size="sm" variant="secondary" render={<Link href={settingsPath(teamId, "projects")} />}>
                  Link a repository
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col lg:grid lg:grid-cols-[minmax(20rem,26rem)_1fr]">
          <div className={cn("flex min-h-0 flex-col border-border lg:border-r", number !== null && "hidden lg:flex")}>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              {projects.length > 1 ? (
                <div className="max-w-56 min-w-32 flex-1">
                  <Select
                    aria-label="Repository"
                    size="sm"
                    className="min-w-0"
                    value={project.id}
                    onValueChange={(v) => v && set({ project: v, pr: null })}
                    options={projects.map((p) => ({
                      value: p.id,
                      label: parseRepoFullName(p.repoFullName).repo,
                      icon: <ProjectIcon repoFullName={p.repoFullName} className="size-3.5" />,
                    }))}
                  />
                </div>
              ) : (
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-[550] text-text">
                  <ProjectIcon repoFullName={project.repoFullName} className="size-3.5" />
                  <span className="truncate">{project.repoFullName}</span>
                </span>
              )}
              <Segmented size="sm" aria-label="Which pull requests" className="ml-auto" options={STATE_OPTIONS} value={state} onValueChange={(s) => set({ state: s, pr: null })} />
            </div>
            <PullList
              key={`${project.id}:${state}`}
              teamId={teamId}
              projectId={project.id}
              state={state}
              selected={number}
              onSelect={(n) => set({ pr: n })}
              moreHref={pullsUrl(githubWebUrl, project.repoFullName, state)}
            />
          </div>
          <div className={cn("min-h-0 overflow-y-auto", number === null && "hidden lg:block")}>
            {number !== null ? (
              <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-3 px-4 py-4 sm:px-6">
                <Button size="sm" variant="quiet" className="self-start lg:hidden" onClick={() => set({ pr: null })}>
                  <ArrowLeft />
                  All pull requests
                </Button>
                <PullPanel key={`${project.id}#${number}`} teamId={teamId} projectId={project.id} number={number} />
              </div>
            ) : (
              <div className="grid h-full min-h-80 place-items-center px-4">
                <EmptyState icon={<GitPullRequest />} title="Pick a pull request" description="Its checks, reviews and conversation open here, with merge and comment." />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

type PullListProps = {
  teamId: string;
  projectId: string;
  state: PullStateFilter;
  selected: number | null;
  onSelect: (number: number) => void;
  moreHref: string | null;
};

function PullList({ teamId, projectId, state, selected, onSelect, moreHref }: PullListProps) {
  const version = useGithubVersion(projectId);
  const load = useCallback((signal: AbortSignal) => listPulls(teamId, projectId, state, { signal }), [teamId, projectId, state]);
  const res = useGithubResource(`${teamId}/${projectId}/${state}`, load, version);
  const now = useMinuteClock();

  if (!res.data && res.loading)
    return (
      <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label="Loading pull requests">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  if (!res.data) return <GithubProblem className="m-4" error={res.error} fallback="Couldn't load pull requests from GitHub." onRetry={res.reload} />;

  const { pulls, freshness, truncated } = res.data;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {res.error ? <GithubProblem className="m-3" error={res.error} fallback="Couldn't refresh the list." onRetry={res.reload} /> : null}
      <FreshnessNote className="m-3" freshness={freshness} />
      {pulls.length === 0 ? (
        <div className="grid flex-1 place-items-center px-4 py-10">
          <EmptyState
            icon={<GitPullRequest />}
            title={state === "open" ? "No open pull requests" : state === "closed" ? "No closed pull requests" : "No pull requests yet"}
            description="Morrow opens one for each task once its work is verified."
          />
        </div>
      ) : (
        <ul className="flex flex-col p-2" aria-label="Pull requests">
          {pulls.map((pr) => (
            <PullRow key={pr.number} teamId={teamId} pr={pr} now={now} selected={pr.number === selected} onSelect={() => onSelect(pr.number)} />
          ))}
        </ul>
      )}
      {truncated && moreHref ? (
        <a
          href={moreHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mx-4 mb-4 inline-flex items-center gap-1 self-start rounded-[6px] text-[12.5px] font-[550] text-soft-sky-ink underline-offset-[3px] hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Older pull requests are on GitHub
          <ExternalLink className="size-3 opacity-70" />
        </a>
      ) : null}
    </div>
  );
}

function PullRow({ teamId, pr, now, selected, onSelect }: { teamId: string; pr: PullSummary; now: number; selected: boolean; onSelect: () => void }) {
  return (
    <li className={cn("flex min-w-0 items-start gap-1 rounded-row transition-colors", selected ? "bg-row-active shadow-row-rim" : "hover:bg-row-hover")}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 items-start gap-2.5 rounded-row px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="mt-0.5 shrink-0 [&_svg]:size-4" aria-label={pr.state} role="img">
          {PULL_ICON[pr.state]}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 text-[13px] font-[550] [overflow-wrap:anywhere] text-text">{pr.title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
            <span className="tabular-nums">#{pr.number}</span>
            {pr.author ? <Avatar name={pr.author.login} src={pr.author.avatarUrl} login={pr.author.login} size={14} /> : null}
            <span className="truncate">{pr.author?.login ?? "ghost"}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{relativeAge(pr.updatedAt, now)}</span>
          </span>
        </span>
      </button>
      {pr.taskId ? (
        <Link
          href={taskPath(teamId, pr.taskId)}
          className="mt-2 mr-2 shrink-0 rounded-capsule outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open the Morrow task for pull request #${pr.number}`}
        >
          <Badge tone="lilac" size="sm" className="[&_svg]:size-3">
            <Sparkles />
            Task
          </Badge>
        </Link>
      ) : null}
    </li>
  );
}
