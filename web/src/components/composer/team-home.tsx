"use client";

import type { MeView } from "@morrow/contracts";
import { ArrowRight, CircleAlert, CircleCheck, Info } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { PlanCard } from "@/components/plan/plan-card";
import { PlanningStatus } from "@/components/plan/planning-status";
import { previewPlacement } from "@/components/plan/placement";
import { RecentTasks } from "@/components/plan/recent-tasks";
import { useTaskFlow } from "@/components/plan/use-task-flow";
import { BakedSky } from "@/components/sky/static-sky";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { useMinuteClock } from "@/components/ui/timer";
import { cn } from "@/lib/cn";
import { useConnection, useTeam, useTeamId, useTeamStore, useWorkforce } from "@/lib/store";
import { Composer, type WorkforceSettings } from "./composer";
import styles from "./composer.module.css";
import { canManageTeam } from "@/components/settings/permissions";
import { profileState } from "./profile-status";
import { repoNameParts } from "./repo-name";
import { SetupGuide } from "./setup-guide";
import { type Draft } from "./drafts";
import { useDraft } from "./use-draft";

/** The team home: a calm hero on the sky, the composer where it dissolves, then recent tasks. */
export function TeamHome({ me }: { me: Pick<MeView, "user" | "features"> | null }) {
  const teamId = useTeamId();
  const team = useTeam();
  const workforce = useWorkforce();
  const connection = useConnection();
  const viewerId = useTeamStore((s) => s.viewerId) ?? me?.user.id ?? null;
  const now = useMinuteClock();

  const flow = useTaskFlow(teamId, viewerId);

  const projects = useMemo(() => team?.projects ?? [], [team]);
  const [chosenProject, setChosenProject] = useState<string | null>(null);
  // A shown task fixes the project; otherwise the user's pick, else the first one.
  const projectId = flow.task?.projectId ?? (projects.some((p) => p.id === chosenProject) ? chosenProject : (projects[0]?.id ?? null));
  const project = projects.find((p) => p.id === projectId) ?? null;
  const [draft, setDraft] = useDraft(teamId, projectId);

  // Feedback on a shown plan is its own buffer, never the saved draft: an unsent prompt must not
  // turn into "Refine" feedback on a plan it has nothing to do with. It is not saved either.
  const shownTaskId = flow.phase.kind === "planned" || flow.phase.kind === "planning" ? flow.activeTaskId : null;
  const [feedback, setFeedback] = useState<{ taskId: string; text: string } | null>(null);
  const feedbackText = shownTaskId && feedback?.taskId === shownTaskId ? feedback.text : "";
  const feedbackDraft = useMemo<Draft>(() => ({ text: feedbackText, criteria: [] }), [feedbackText]);
  const updateFeedback = (next: Draft | ((current: Draft) => Draft)) => {
    if (!shownTaskId) return;
    setFeedback((prev) => {
      const current: Draft = { text: prev?.taskId === shownTaskId ? prev.text : "", criteria: [] };
      return { taskId: shownTaskId, text: (typeof next === "function" ? next(current) : next).text };
    });
  };

  const cap = team?.policy.maxParallelPerTask ?? 5;
  const [settings, setSettings] = useState<WorkforceSettings>({
    mode: "auto",
    pins: [],
    strategy: "split",
    harnesses: [],
  });
  const profiles = useMemo(() => Object.values(workforce?.profiles ?? {}), [workforce]);
  // A pin whose profile was removed since is dropped: the backend refuses ids that are not the team's profiles.
  const livePins = useMemo(() => (workforce ? settings.pins.filter((id) => id in workforce.profiles) : settings.pins), [workforce, settings.pins]);
  const effective = { ...settings, pins: livePins };
  const environments = useMemo(() => team?.environments ?? [], [team]);

  // Who would take each workstream right now; recomputed on every workforce change. Only from the plan's
  // current detail, so Start never sends picks for an older plan's workstreams.
  const plannedTask = flow.phase.kind === "planned" && flow.detail.current ? flow.detail.data : null;
  // Profiles the person chose per workstream in the plan card, for the plan on screen only.
  const [chosen, setChosen] = useState<{ taskId: string; byWorkstream: Record<string, string> } | null>(null);
  const chosenHere = useMemo(() => (plannedTask && chosen?.taskId === plannedTask.id ? chosen.byWorkstream : {}), [plannedTask, chosen]);
  const choose = (workstreamId: string, profileId: string | null) => {
    if (!plannedTask) return;
    const next = { ...chosenHere };
    if (profileId) next[workstreamId] = profileId;
    else delete next[workstreamId];
    setChosen({ taskId: plannedTask.id, byWorkstream: next });
  };
  const placement = useMemo(
    () =>
      plannedTask && workforce
        ? previewPlacement({
            task: plannedTask,
            profiles,
            environments,
            pins: livePins,
            mode: settings.mode,
            chosen: chosenHere,
            cap,
          })
        : null,
    [plannedTask, workforce, profiles, environments, livePins, settings.mode, chosenHere, cap],
  );

  // "Start with fewer agents": the smaller plan landed, so start it with its own placement.
  const { autoStartDue, runAutoStart } = flow;
  const autoPicks = placement?.picks ?? null;
  const autoMode = settings.mode;
  useEffect(() => {
    if (autoStartDue) runAutoStart(autoPicks, { mode: autoMode, pins: livePins });
  }, [autoStartDue, runAutoStart, autoPicks, autoMode, livePins]);

  // A cancelled task's prompt goes back into the draft (ahead of any feedback typed since).
  const cancelAndRestore = async () => {
    const cancelled = await flow.cancel();
    if (!cancelled) return;
    const note = feedbackText.trim();
    if (!cancelled.text) toast.warning("Couldn't bring the cancelled prompt back", { description: "The task is cancelled. Your feedback and draft are kept." });
    setDraft((current) => {
      // Nothing typed is lost: the cancelled prompt, then any feedback, then an unsent draft.
      const parts = [cancelled.text?.prompt ?? "", note, current.text.trim()].filter((part, i, all) => part && all.indexOf(part) === i);
      return { text: parts.join("\n\n"), criteria: current.criteria.length > 0 ? current.criteria : (cancelled.text?.acceptance ?? []) };
    });
  };

  if (!team) return <HomeSkeleton />;

  const signedIn = profiles.some((p) => {
    const kind = profileState(p, environments.find((e) => e.id === p.envId), now).kind;
    return kind !== "auth" && kind !== "offline";
  });
  const setup = {
    hasProject: projects.length > 0,
    hasEnvironment: environments.some((e) => e.phase !== "disconnected"),
    hasSignedInProfile: signedIn,
    canManageProjects: team.viewerRole !== "member",
  };
  const phase = flow.phase;
  const repoName = project?.repoFullName.split("/")[1] ?? null;

  return (
    <div className="relative isolate flex min-h-full flex-col">
      {phase.kind === "compose" || phase.kind === "ended" || phase.kind === "started" ? (
        <div aria-hidden="true" className={styles.skyBand}>
          <BakedSky horizon={80} arrive />
        </div>
      ) : null}
      <div
        className={cn(
          "mx-auto flex w-full max-w-[calc(var(--chat-content-max-width)+2rem)] flex-1 flex-col gap-6 px-4 pb-[calc(env(safe-area-inset-bottom)+2.5rem)]",
          // The hero sits low and calm; a plan starts near the top so more of it fits.
          // Clear of the floating sidebar toggle at the top left.
          phase.kind === "planned" ? "pt-14 sm:pt-12" : "pt-[max(3.5rem,min(16vh,9rem))]",
        )}
      >
        {phase.kind === "planning" ? (
          <PlanningStatus
            task={phase.task}
            since={flow.planningSince}
            autoStart={flow.autoStarting}
            cancelling={flow.busy === "cancel"}
            onCancel={cancelAndRestore}
          />
        ) : phase.kind === "planned" && !placement ? (
          <PlanLoading error={flow.detail.error} retry={flow.detail.retry} onDiscard={cancelAndRestore} discarding={flow.busy === "cancel"} />
        ) : phase.kind === "planned" && placement && plannedTask ? (
          <div className="flex flex-col gap-2">
            <PlanCard
              task={plannedTask}
              placement={placement}
              profiles={workforce?.profiles ?? {}}
              environments={environments}
              members={team.members}
              chosen={chosenHere}
              onChoose={choose}
            />
            <div className="flex items-center justify-end gap-1">
              <Button size="xs" variant="quiet" onClick={flow.dismiss}>
                Not now
              </Button>
              <Button size="xs" variant="quiet" loading={flow.busy === "cancel"} onClick={cancelAndRestore}>
                Discard plan
              </Button>
            </div>
          </div>
        ) : (
          <>
            {phase.kind === "started" || phase.kind === "ended" ? (
              <FlowNotice teamId={teamId} phase={phase} onClose={flow.dismiss} />
            ) : null}
            <Hero repoName={repoName} hasProject={projects.length > 0} />
          </>
        )}

        {/* A tall plan scrolls under the composer, so Start and Refine stay in reach. */}
        <div
          className={
            phase.kind === "planned"
              ? "sticky bottom-0 z-10 -mx-4 bg-linear-to-t from-ground from-70% to-transparent px-4 pt-8 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]"
              : undefined
          }
        >
          <Composer
            projects={projects}
            projectId={projectId}
            onProjectChange={setChosenProject}
            linkRepos={canManageTeam(team.viewerRole) ? { teamId: team.id } : undefined}
            profiles={profiles}
            environments={environments}
            members={team.members}
            maxAgentsCap={cap}
            settings={effective}
            onSettingsChange={setSettings}
            flow={flow}
            placement={placement}
            connection={connection}
            draft={shownTaskId ? feedbackDraft : draft}
            onDraftChange={shownTaskId ? updateFeedback : setDraft}
          />
        </div>

        <SetupGuide teamId={teamId} state={setup} />
        <RecentTasks teamId={teamId} workforce={workforce} projects={projects} />
      </div>
    </div>
  );
}

function Hero({ repoName, hasProject }: { repoName: string | null; hasProject: boolean }) {
  return (
    // Stands on the sky like the landing hero: sky ink, its shadow, and a veil behind for the bright days.
    <div className="relative flex flex-col items-center gap-2 pb-2 text-center text-sky-ink before:absolute before:-inset-x-[10%] before:-inset-y-[30%] before:-z-10 before:bg-[radial-gradient(closest-side,var(--sky-veil),transparent)]">
      <h1 className="max-w-full text-[clamp(1.75rem,1.2rem+2vw,2.5rem)] leading-[1.08] font-[600] tracking-[-0.035em] text-balance sky-text">
        {hasProject && repoName ? (
          <>
            What should we build in{" "}
            <span className={styles.repo}>
              {repoNameParts(repoName).map((part, i) => (
                <Fragment key={i}>
                  {i > 0 ? <wbr /> : null}
                  {part}
                </Fragment>
              ))}
            </span>
            ?
          </>
        ) : (
          "What should we build?"
        )}
      </h1>
      <p className="max-w-md text-[14.5px] leading-[1.5] text-pretty opacity-85 sky-text">
        Describe it once. A planner splits the work, and your team&apos;s agents build it in parallel.
      </p>
    </div>
  );
}

function FlowNotice({
  teamId,
  phase,
  onClose,
}: {
  teamId: string;
  phase: Extract<ReturnType<typeof useTaskFlow>["phase"], { kind: "started" | "ended" }>;
  onClose: () => void;
}) {
  const started = phase.kind === "started";
  const href = phase.task ? `/t/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(phase.task.id)}` : null;
  return (
    <div role="status" className="flex items-center gap-2.5 rounded-row bg-card px-3 py-2.5 text-[13.5px] shadow-hairline">
      {started ? (
        <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <Info className="size-4 shrink-0 text-muted" aria-hidden="true" />
      )}
      <p className="min-w-0 flex-1 truncate text-label-secondary">{started ? `${phase.task.title} started.` : phase.reason}</p>
      {started && href ? (
        <Link
          href={href}
          className="inline-flex shrink-0 items-center gap-1 rounded-[6px] font-[550] text-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      ) : null}
      <Button size="xs" variant="quiet" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

/** The plan landed but its text is still on the way, or failed to load. Discard stays in reach either way. */
function PlanLoading({ error, retry, onDiscard, discarding }: { error: string | null; retry: () => void; onDiscard: () => void; discarding: boolean }) {
  if (error)
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-2xl bg-card px-4 py-3.5 shadow-hairline sm:px-5">
        <p className="flex items-start gap-2 text-[13.5px] text-label-secondary">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          <span>
            <span className="font-[600] text-text">Couldn&apos;t load the plan.</span> {error}
          </span>
        </p>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button size="xs" variant="quiet" loading={discarding} onClick={onDiscard}>
            Discard plan
          </Button>
          <Button size="xs" variant="secondary" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  return (
    <div role="status" aria-label="Loading the plan" className="flex flex-col gap-3 rounded-2xl bg-card px-4 py-4 shadow-hairline sm:px-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col items-center gap-6 px-4 pt-[min(16vh,9rem)]"
    >
      <Skeleton className="h-9 w-3/4 max-w-md rounded-full" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-11 w-full rounded-row" />
    </div>
  );
}
