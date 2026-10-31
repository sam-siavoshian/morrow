"use client";

import { projectChannel, type RelayMessageView, type TaskView, type TeamView, type WorkforceView } from "@morrow/contracts";
import { ChevronDown, MessagesSquare, SearchX } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { TaskPullPanel } from "@/components/github/pull-request";
import { BackHomeLink } from "@/components/shell/back-home-link";
import { ShellDrawer } from "@/components/shell/shell-context";
import { buildDirectory, ownership, type Directory } from "@/components/timeline/directory";
import { ALL_MESSAGES, isFiltered, type TimelineFilter } from "@/components/timeline/classify";
import { RelayTimeline } from "@/components/timeline/relay-timeline";
import { TimelineFilters, type AgentOption } from "@/components/timeline/timeline-filters";
import { canManageTask, canManageTeam } from "@/components/settings/permissions";
import { useDeletingTask } from "@/components/sidebar/delete-task";
import { settingsPath } from "@/components/settings/sections";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useMinuteClock } from "@/components/ui/timer";
import { useGithubVersion, useRelayEvents, useRelayHistory, useRelayThread, useTask, useTaskWorkers, useTeam, useTeamStore, useWorkforce } from "@/lib/store";
import type { TaskWorker } from "@/lib/store/selectors";
import { cn } from "@/lib/cn";
import { AttemptsBar } from "./attempts-bar";
import { AgentStrip, WorkingNow, type StripMember } from "./agent-strip";
import { CrewList, type CrewGroup } from "./crew-list";
import { DiffTab, type DiffWorkstream } from "./diff-tab";
import { compareUrl } from "./links";
import { BranchesTab } from "./branches-tab";
import { LogTab, type LogWorker } from "./log-tab";
import { deriveLanes } from "./lanes";
import { buildAtMenu } from "./at-menu";
import { MessageBar } from "./message-bar";
import { isTerminal, MissionHeader } from "./mission-header";
import { usePersistentFlag } from "./resize";
import { SidePanel, useNarrowPanel, type PanelTab } from "./side-panel";
import { TestsTab } from "./tests-tab";
import { TraceDrawer, useDrawerOpen, type DrawerTab } from "./trace-drawer";
import { useArtifacts } from "./use-artifacts";
import { useTaskDetail } from "./use-task-detail";
import { useWorkstreamDiffs } from "./use-workstream-diffs";
import type { WorkerRowData } from "./worker-list";
import { latestLeaseIds, orderWorkers, splitSubagents, waitingWorkstreams, workerState, type SubagentItem } from "./workers";

type MissionControlProps = { teamId: string; taskId: string; githubWebUrl: string };

/** `/t/[teamId]/tasks/[taskId]`: waits for the live workforce, then shows the task or says it is gone. */
export function MissionControl({ teamId, taskId, githubWebUrl }: MissionControlProps) {
  const workforce = useWorkforce();
  const team = useTeam();
  const task = useTask(taskId);
  // This viewer is deleting it: the live view can drop it before the request answers and the page moves on.
  const deleting = useDeletingTask() === taskId;
  if (!workforce || !team || (!task && deleting)) return <MissionSkeleton />;
  if (!task)
    return (
      <div className="grid h-full min-h-80 place-items-center px-4">
        <EmptyState
          icon={<SearchX />}
          title="Task not found"
          description="This task doesn't exist in this team, or it was removed."
          action={<BackHomeLink />}
        />
      </div>
    );
  return <Mission teamId={teamId} task={task} team={team} workforce={workforce} githubWebUrl={githubWebUrl} />;
}

function MissionSkeleton() {
  return (
    <div className="flex h-full min-h-0" aria-busy="true" aria-label="Loading the task">
      <div className="hidden w-72 shrink-0 flex-col gap-3 border-r border-border p-4 lg:flex">
        <Skeleton className="h-44 w-full rounded-card" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="mx-auto flex w-full max-w-[72rem] flex-1 flex-col gap-4 px-6 pt-6">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-10 w-1/2" />
        <Skeleton className="h-16 w-3/4" />
      </div>
    </div>
  );
}

type MissionProps = { teamId: string; task: TaskView; team: TeamView; workforce: WorkforceView; githubWebUrl: string };


function Mission({ teamId, task, team, workforce, githubWebUrl }: MissionProps) {
  const viewerId = useTeamStore((s) => s.viewerId);
  const applyFrame = useTeamStore((s) => s.applyFrame);
  const workers = useTaskWorkers(task.id);
  const events = useRelayEvents({ taskId: task.id });
  const relayMarks = useTeamStore((s) => s.relayMarks);
  const history = useRelayHistory(projectChannel(task.projectId));
  const directory = useMemo(() => buildDirectory(workforce, team), [workforce, team]);
  const project = team.projects.find((p) => p.id === task.projectId) ?? null;
  const terminal = isTerminal(task);

  const [filter, setFilter] = useState<TimelineFilter>(ALL_MESSAGES);
  const [diffWorkstream, setDiffWorkstream] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("branches");
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("trace");
  const [drawerOpen, setDrawerOpen] = useDrawerOpen();
  const narrow = useNarrowPanel();
  const [dockedOpen, setDockedOpen] = usePersistentFlag("morrow:mission-panel-open", () => window.innerWidth >= 1680);
  const [sheetOpen, setSheetOpen] = useState(false);
  const panelOpen = narrow ? sheetOpen : dockedOpen;
  const setPanelOpen = narrow ? setSheetOpen : setDockedOpen;
  const [crewOpen, setCrewOpen] = useState(false);

  // ---------- who is who ----------

  const describeProfile = useCallback(
    (profileId: string) => {
      const profile = workforce.profiles[profileId];
      if (!profile) return null;
      const owner = team.members.find((m) => m.userId === profile.ownerUserId) ?? null;
      return ownership(owner, profile.cli);
    },
    [workforce, team],
  );
  const creator = useMemo(() => {
    const member = team.members.find((m) => m.userId === task.createdBy);
    return member ? (member.name ?? member.login) : null;
  }, [team, task.createdBy]);

  // The live view carries a summary; these read the full task (whole trace, workstream text, checks, subagents).
  const detail = useTaskDetail(teamId, task);
  const full = detail.data;
  // The task thread (kickoff and its replies) is where workers talk to each other: load its older replies too.
  useRelayThread(full?.id === task.id ? full.threadId : null);

  // Subagents never count as workers of their own: they nest under the worker that started them.
  const split = useMemo(() => splitSubagents(workers, full?.id === task.id ? full.subagents : undefined), [workers, full, task.id]);
  const ordered = useMemo(() => orderWorkers(split.workers, task), [split, task]);
  const live = useMemo(() => ordered.filter((w) => w.live), [ordered]);

  const rows = useMemo(() => {
    const latest = latestLeaseIds(ordered);
    return ordered.map((w) => workerRow(w, task, directory, latest.has(w.lease.id), split.subagents.get(w.lease.id) ?? []));
  }, [ordered, task, directory, split]);

  // ---------- diffs: each workstream's branch against the task base ----------

  const githubVersion = useGithubVersion(task.projectId);
  const diffTargets = useMemo(
    () =>
      task.workstreams.map((w) => {
        const checkpoint = full?.id === task.id ? (full.workstreams.find((d) => d.id === w.id)?.lastCheckpoint?.sha ?? "") : "";
        return { id: w.id, version: `${githubVersion}:${checkpoint}:${w.status}`, ready: w.status !== "pending" || checkpoint !== "" };
      }),
    [task, full, githubVersion],
  );
  const diffs = useWorkstreamDiffs(teamId, task.id, diffTargets);
  const diffOf = useCallback(
    (workstreamId: string) => {
      const d = diffs.get(workstreamId)?.data;
      return d && d.exists && !d.tooLarge && d.changedFiles > 0 ? { additions: d.additions, deletions: d.deletions, files: d.changedFiles } : null;
    },
    [diffs],
  );

  // ---------- the chat's cast: each workstream's current worker first, then earlier ones, then people ----------

  const stripMembers = useMemo<StripMember[]>(() => {
    const latest = latestLeaseIds(ordered);
    const workers = rows.flatMap((row, i): StripMember[] =>
      row.agentName
        ? [
            {
              name: row.agentName,
              label: row.label,
              cli: row.cli,
              detail: row.vm ? `${row.ownership} on ${row.vm}` : row.ownership,
              state: row.state.kind,
              latest: latest.has(ordered[i]!.lease.id),
            } as StripMember & { latest: boolean },
          ]
        : [],
    ) as (StripMember & { latest: boolean })[];
    const people = humansOf(task, events, team, directory).map((h) => ({ name: h.name, label: h.label, cli: null, detail: `${h.label}, a person on this task`, state: null, avatarUrl: h.avatarUrl, login: h.login }));
    return [...workers.filter((w) => w.latest), ...workers.filter((w) => !w.latest), ...people];
  }, [rows, ordered, task, events, team, directory]);

  const crewGroups = useMemo<CrewGroup[]>(() => {
    const titles = new Map((full?.id === task.id ? full.workstreams : []).map((w) => [w.id, w.title]));
    const groups = new Map<string, CrewGroup>();
    ordered.forEach((w, i) => {
      const row = rows[i]!;
      const id = w.lease.workstreamId;
      const group = groups.get(id) ?? {
        id,
        title: titles.get(id) ?? w.workstream?.branch.split("/").at(-1) ?? "Workstream",
        status: task.workstreams.find((ws) => ws.id === id)?.status ?? null,
        rows: [],
        diff: diffOf(id),
      };
      (group.rows as WorkerRowData[]).push(row);
      groups.set(id, group);
    });
    return [...groups.values()];
  }, [ordered, rows, full, task, diffOf]);

  const diffWorkstreams = useMemo<DiffWorkstream[]>(() => {
    const titles = new Map((full?.id === task.id ? full.workstreams : []).map((w) => [w.id, w.title]));
    return task.workstreams.map((w) => ({
      id: w.id,
      title: titles.get(w.id) ?? w.branch.split("/").at(-1) ?? w.branch,
      branch: w.branch,
      clis: ordered.filter((o) => o.lease.workstreamId === w.id).map((o) => o.profile?.cli ?? null),
      compareHref: project ? compareUrl(githubWebUrl, project.repoFullName, project.defaultBranch, w.branch) : null,
    }));
  }, [task, full, ordered, project, githubWebUrl]);

  const agentOptions = useMemo<AgentOption[]>(() => {
    const seen = new Set<string>();
    const options: AgentOption[] = [];
    for (const row of rows)
      if (row.agentName && !seen.has(row.agentName)) {
        seen.add(row.agentName);
        options.push({ name: row.agentName, label: row.label, cli: row.cli });
      }
    return options;
  }, [rows]);

  // The @ menu: every VM and CLI profile of the team, with this task's live workers under the profile they run on.
  const minute = useMinuteClock();
  const atMenu = useMemo(
    () =>
      buildAtMenu({
        task,
        profiles: Object.values(workforce.profiles),
        environments: team.environments,
        members: team.members,
        policy: team.policy,
        workers: live.map((w) => ({
          name: w.lease.agentName,
          label: directory.displayName(w.lease.agentName),
          cli: w.profile?.cli ?? directory.agent(w.lease.agentName)?.cli ?? null,
          profileId: w.lease.profileId,
        })),
        now: minute || Date.now(),
      }),
    [task, workforce.profiles, team, live, directory, minute],
  );

  // ---------- trace, lanes ----------

  const lanes = useMemo(() => (full ? deriveLanes(full, workforce) : []), [full, workforce]);
  const waiting = useMemo(() => (full ? waitingWorkstreams(full) : []), [full]);

  // ---------- permissions ----------

  const canManage = canManageTask(team.viewerRole, viewerId, task.createdBy);
  const canCancel = !terminal && canManage;
  // Same rule as cancel: a retry spends teammates' usage and verifies with the creator's GitHub access.
  const canRetry = task.status === "failed" && canManage;

  // ---------- panel content ----------

  const artifacts = useArtifacts(teamId, task.id, task.updatedAt);
  const logWorkers = useMemo<LogWorker[]>(
    () =>
      [...ordered]
        .sort((a, b) => Number(b.live) - Number(a.live))
        .map((w) => ({
          agentName: w.lease.agentName,
          leaseId: w.lease.id,
          label: directory.displayName(w.lease.agentName),
          cli: w.profile?.cli ?? null,
          live: w.live,
        })),
    [ordered, directory],
  );

  const selectWorker = useCallback(
    (agentName: string) => {
      setSelected(agentName);
      setPanelTab("log");
      setPanelOpen(true);
    },
    [setPanelOpen],
  );

  /** The graph narrows the feed to one agent or person; the same node again shows everyone. */
  const focusOn = useCallback((name: string) => setFilter((f) => ({ ...f, agent: f.agent === name ? null : name })), []);
  const openDiff = useCallback(
    (workstreamId: string) => {
      setDiffWorkstream(workstreamId);
      setPanelTab("diff");
      setPanelOpen(true);
    },
    [setPanelOpen],
  );

  const onSent = useCallback(
    (message: RelayMessageView) => applyFrame({ kind: "relay.event", teamId, seq: null, data: message }),
    [applyFrame, teamId],
  );

  const relayOff = team.relayReady ? null : "Relay isn't connected for this team, so messages can't be sent.";
  const failedChecks = full?.verification?.checks.filter((c) => c.status === "failed").length ?? 0;

  const footer = !terminal ? <WorkingNow members={stripMembers} /> : null;

  const crewCaption = useMemo(() => {
    const people = new Set(rows.map((r) => r.owner?.name).filter(Boolean)).size;
    const vms = new Set(rows.map((r) => r.vm).filter(Boolean)).size;
    const agents = rows.length;
    return `${agents} ${agents === 1 ? "agent" : "agents"} · ${people} ${people === 1 ? "person's subscription" : "people's subscriptions"} · ${vms} ${vms === 1 ? "VM" : "VMs"}`;
  }, [rows]);

  const crew = (
    <>
      <p className="px-1 text-[11.5px] text-faint">{crewCaption}</p>
      {rows.length > 0 ? (
        <CrewList
          groups={crewGroups}
          selected={selected}
          onSelect={selectWorker}
          onOpenDiff={openDiff}
          subagentDetail={full?.id === task.id ? "ready" : detail.error ? "error" : "loading"}
        />
      ) : (
        <p className="px-2 py-3 text-[12.5px] text-muted">{task.status === "planned" ? "Workers start once the plan is approved." : "No workers yet."}</p>
      )}
      {waiting.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-border pt-2" aria-label="Waiting workstreams">
          {waiting.map(({ workstream, on }) => (
            <li key={workstream.id} className="flex min-w-0 items-center gap-2 px-2 py-1 text-[12.5px]">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-faint" />
              <span className="min-w-0 truncate font-[550] text-label-secondary">{workstream.title}</span>
              <span className="ml-auto shrink-0 truncate text-[11.5px] text-faint">{on ? `waits on ${on}` : "queued"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );

  return (
    <>
      <MissionHeader
        teamId={teamId}
        task={task}
        project={project}
        liveWorkers={live.length}
        canCancel={canCancel}
        canRetry={canRetry}
        canDelete={canManage}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
      />

      {/* Sized by the main column, not the window: an open side panel squeezes it like a small screen. */}
      <div className="@container flex h-full min-h-0">
        {/* Left: who is on this task, as a constellation and as rows. */}
        <aside aria-label="Agents on this task" className="hidden w-72 shrink-0 flex-col gap-2 overflow-y-auto border-r border-border p-3 @min-[60rem]:flex @min-[80rem]:w-80">
          {crew}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Narrow screens: the crew folds into a summary row above the timeline. */}
          <div className="border-b border-border @min-[60rem]:hidden">
            <button
              type="button"
              onClick={() => setCrewOpen((v) => !v)}
              aria-expanded={crewOpen}
              className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <span className="font-[600] text-text">Agents</span>
              <span className="min-w-0 truncate text-muted">{crewCaption}</span>
              <ChevronDown className={cn("ml-auto size-4 shrink-0 text-muted transition-transform duration-200", crewOpen && "rotate-180")} />
            </button>
            {crewOpen ? <div className="flex max-h-[55dvh] flex-col gap-2 overflow-y-auto px-3 pb-3">{crew}</div> : null}
          </div>

          {task.strategy === "compare" ? (
            <div className="mx-auto w-full max-w-[72rem] px-3 pt-3 sm:px-6">
              <AttemptsBar
                teamId={teamId}
                task={task}
                detail={full?.id === task.id ? full : null}
                workforce={workforce}
                members={team.members}
                canPick={canManage}
                onViewChanges={() => {
                  setPanelTab("branches");
                  setPanelOpen(true);
                }}
              />
            </div>
          ) : null}

          <div className="mx-auto w-full max-w-[72rem] px-3 pt-3 sm:px-6">
            <AgentStrip members={stripMembers} events={events} focused={filter.agent} onFocus={focusOn} />
            <TimelineFilters filter={filter} onChange={setFilter} agents={agentOptions} />
          </div>

          <RelayTimeline
            className="min-h-0 flex-1"
            events={events}
            filter={filter}
            directory={directory}
            history={history}
            marks={relayMarks}
            live={!terminal}
            footer={footer}
            empty={
              <EmptyState
                icon={<MessagesSquare />}
                title={isFiltered(filter) ? "Nothing matches this filter" : "Agents will talk here as they work."}
                description={isFiltered(filter) ? "No message here fits this view and agent." : undefined}
                action={
                  isFiltered(filter) ? (
                    <Button size="sm" variant="secondary" onClick={() => setFilter(ALL_MESSAGES)}>
                      Clear filter
                    </Button>
                  ) : undefined
                }
              />
            }
          />

          <MessageBar teamId={teamId} taskId={task.id} menu={atMenu} disabledReason={relayOff} onSent={onSent} />
        </div>
      </div>

      <ShellDrawer>
        <TraceDrawer
          task={task}
          detail={detail}
          lanes={lanes}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          tab={drawerTab}
          onTabChange={setDrawerTab}
          describeProfile={describeProfile}
          creator={creator}
          displayName={directory.displayName}
        />
      </ShellDrawer>

      <SidePanel
        taskId={task.id}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        tab={panelTab}
        onTabChange={setPanelTab}
        badges={{
          tests: failedChecks > 0 ? <span className="rounded-capsule bg-soft-rose-wash px-1.5 text-[11px] text-soft-rose-ink tabular-nums">{failedChecks}</span> : undefined,
          log: live.length > 0 ? <span aria-hidden className="size-1.5 rounded-full bg-success" /> : undefined,
        }}
        pullRequest={<TaskPullPanel teamId={teamId} taskId={task.id} projectId={task.projectId} taskStatus={task.status} />}
        diff={<DiffTab workstreams={diffWorkstreams} diffs={diffs} selected={diffWorkstream} onSelect={setDiffWorkstream} />}
        branches={
          <BranchesTab
            teamId={teamId}
            canCommit={canManage}
            task={task}
            detail={detail}
            project={project}
            artifacts={artifacts.data}
            error={artifacts.error}
            githubWebUrl={githubWebUrl}
          />
        }
        tests={<TestsTab detail={detail} project={project} settingsHref={canManageTeam(team.viewerRole) ? settingsPath(teamId, "projects") : null} />}
        log={<LogTab teamId={teamId} workers={logWorkers} selected={selected} onSelect={setSelected} allowInspect={team.policy.allowInspect} />}
      />
    </>
  );
}

function workerRow(worker: TaskWorker, task: TaskView, directory: Directory, latest: boolean, subagents: readonly SubagentItem[]): WorkerRowData {
  const name = worker.lease.agentName;
  const info = directory.agent(name);
  const owner = info?.owner ?? null;
  return {
    key: worker.lease.id,
    agentName: name,
    label: directory.displayName(name),
    cli: worker.profile?.cli ?? null,
    owner: owner ? { name: owner.name || owner.login, login: owner.login, avatarUrl: owner.avatarUrl } : null,
    ownership: ownership(owner, worker.profile?.cli ?? null),
    vm: info?.vm ?? null,
    state: workerState(worker, task, latest),
    profileLabel: worker.profile?.label ?? null,
    subagents,
  };
}

/** The people in the conversation: the task's creator plus anyone who spoke in it. */
type Person = { name: string; label: string; login: string; avatarUrl: string | null };

function humansOf(task: TaskView, events: ReturnType<typeof useRelayEvents>, team: TeamView, directory: Directory): Person[] {
  const out = new Map<string, Person>();
  const creator = team.members.find((m) => m.userId === task.createdBy);
  if (creator) out.set(`h-${creator.login.toLowerCase()}`, { name: `h-${creator.login.toLowerCase()}`, label: creator.name || creator.login, login: creator.login, avatarUrl: creator.avatarUrl });
  for (const event of events) {
    if (event.type !== "message" || !event.from.name.startsWith("h-") || out.has(event.from.name)) continue;
    const member = directory.human(event.from.name);
    if (member) out.set(event.from.name, { name: event.from.name, label: member.name || member.login, login: member.login, avatarUrl: member.avatarUrl });
  }
  return [...out.values()];
}
