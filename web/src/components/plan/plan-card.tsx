import type { EnvironmentView, MemberView, ProfileView, TaskDetail } from "@morrow/contracts";
import { ChevronDown, CircleAlert, GitBranch, Hourglass, Info, Sparkles } from "lucide-react";
import { HarnessIcon, HARNESS_LABEL } from "@/components/harness/harness-icon";
import { profileState } from "@/components/composer/profile-status";
import { Menu, MenuItem, MenuSection, MenuSeparator } from "@/components/ui/menu";
import { useMinuteClock } from "@/components/ui/timer";
import { cn } from "@/lib/cn";
import type { PlacementResult } from "./placement";

type PlanCardProps = {
  task: TaskDetail;
  placement: PlacementResult;
  profiles: Record<string, ProfileView>;
  environments: readonly EnvironmentView[];
  members: readonly MemberView[];
  /** Profiles the person chose per starting workstream; the rest are placed automatically. */
  chosen?: Readonly<Record<string, string>>;
  /** Choose the profile (and with it the harness) for one starting workstream; null goes back to Auto. */
  onChoose?: (workstreamId: string, profileId: string | null) => void;
};

/** A starting workstream past the free slots: the scheduler gives it the next one. */
const QUEUED = "Starts when a slot frees up";

/** "Planner fallback: <why>" is how the backend records why the CLI planner did not run. */
export function fallbackReason(plan: NonNullable<TaskDetail["plan"]>): string {
  for (const w of plan.warnings) {
    const match = /^Planner fallback:\s*(.+)$/.exec(w);
    if (match) return match[1]!.replace(/\.$/, "");
  }
  return "the planner did not run";
}

function whoRuns(profile: ProfileView | undefined, envs: readonly EnvironmentView[], members: readonly MemberView[]) {
  if (!profile) return null;
  const owner = members.find((m) => m.userId === profile.ownerUserId)?.login ?? "a teammate";
  const name = envs.find((e) => e.id === profile.envId)?.name ?? null;
  // VM names often carry the owner already ("ada's workbox"); never print "ada's ada's workbox".
  const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = name !== null && new RegExp(`\\b${escaped}\\b`, "i").test(name);
  return { where: named ? name : `${owner}'s ${name ?? "VM"}` };
}

/**
 * The planner's proposal, shown before anything runs: one row per workstream with its branch, the
 * worker it would get, and why. A fallback plan says so in plain words.
 */
export function PlanCard({ task, placement, profiles, environments, members, chosen = {}, onChoose }: PlanCardProps) {
  const plan = task.plan;
  const compare = task.strategy === "compare";
  const planner = plan?.source === "cli" && plan.profileId ? profiles[plan.profileId] : undefined;
  const plannerWho = whoRuns(planner, environments, members);
  const otherWarnings = plan?.warnings.filter((w) => !w.startsWith("Planner fallback")) ?? [];

  return (
    <section
      aria-labelledby="plan-title"
      data-plan-source={plan?.source ?? "none"}
      className="overflow-hidden rounded-2xl bg-card shadow-hairline"
    >
      <header className="flex flex-col gap-1 px-4 pt-3.5 pb-3 sm:px-5">
        <p className="text-[12px] font-[550] tracking-[0.01em] text-faint">
          {compare
            ? `Compare · ${task.workstreams.length} attempts`
            : `Plan · ${task.workstreams.length} workstream${task.workstreams.length === 1 ? "" : "s"}`}
        </p>
        <h2 id="plan-title" className="text-[16px] font-[600] tracking-[-0.016em] text-pretty text-text">
          {task.title}
        </h2>
        {plan?.source === "cli" ? (
          <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
            {planner ? <HarnessIcon cli={planner.cli} size={14} decorative /> : null}
            <span>
              Planned by {planner ? HARNESS_LABEL[planner.cli] : "a CLI planner"}
              {plannerWho ? ` on ${plannerWho.where}` : ""}
            </span>
          </p>
        ) : null}
      </header>

      {plan?.source === "fallback" ? (
        <div role="note" className="mx-3 mb-3 flex gap-2 rounded-row bg-soft-lemon-wash px-3 py-2.5 text-[13px] leading-[1.5] text-soft-lemon-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-lemon-edge)] sm:mx-4">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <p>
            <span className="font-[600]">Fallback plan.</span> The CLI planner didn&apos;t run because {fallbackReason(plan)}. One
            worker takes the whole change on one branch, so nothing has to be merged.
          </p>
        </div>
      ) : plan?.rationale ? (
        <p className="px-4 pb-3 text-[13.5px] leading-[1.55] text-label-secondary sm:px-5">{plan.rationale}</p>
      ) : null}

      <ol className="flex flex-col border-t border-border">
        {task.workstreams.map((ws, index) => {
          const placed = placement.byWorkstream[ws.id];
          const profile = placed?.kind === "placed" ? profiles[placed.profileId] : undefined;
          const who = whoRuns(profile, environments, members);
          return (
            <li
              key={ws.id}
              data-workstream={ws.id}
              className={cn("flex flex-col gap-2 px-4 py-3 sm:flex-row sm:gap-4 sm:px-5", index > 0 && "border-t border-border")}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 items-baseline gap-2">
                  {ws.harness ? (
                    <span className="flex shrink-0 items-center gap-1 self-center rounded-[5px] bg-fill px-1.5 py-0.5 text-[11.5px] font-[550] text-label-secondary">
                      <HarnessIcon cli={ws.harness} size={12} decorative />
                      {HARNESS_LABEL[ws.harness]}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-[5px] bg-fill px-1.5 py-0.5 font-mono text-[11.5px] font-[500] text-label-secondary">
                      {ws.role}
                    </span>
                  )}
                  {/* A compare attempt's title starts with its harness, which the chip already shows. */}
                  <h3 className="min-w-0 text-[14.5px] font-[550] tracking-[-0.01em] text-text">
                    {ws.harness ? ws.title.replace(`${HARNESS_LABEL[ws.harness]} attempt: `, "") : ws.title}
                  </h3>
                </div>
                <p className="flex min-w-0 items-center gap-1 text-[12.5px] text-faint">
                  <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate font-mono">{ws.branch}</span>
                </p>
                {ws.why ? <p className="text-[13px] leading-[1.5] text-muted">{ws.why}</p> : null}
              </div>
              <div className="flex shrink-0 items-start sm:w-52 sm:justify-end">
                {onChoose && ws.dependsOn.length === 0 ? (
                  <WorkerChoice
                    workstream={ws}
                    placed={placed}
                    chosenId={chosen[ws.id] ?? null}
                    profiles={profiles}
                    environments={environments}
                    members={members}
                    projectId={task.projectId}
                    onChoose={(profileId) => onChoose(ws.id, profileId)}
                  />
                ) : profile && who ? (
                  <span className="flex min-w-0 items-center gap-2 sm:flex-row-reverse sm:text-right">
                    <HarnessIcon cli={profile.cli} size={20} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] font-[550] text-text">{profile.label}</span>
                      <span className="truncate text-[12px] text-muted">
                        {who.where}
                      </span>
                    </span>
                  </span>
                ) : placed?.kind === "waits" ? (
                  <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                    <Hourglass className="size-3.5 shrink-0" aria-hidden="true" />
                    After {placed.on.join(", ")}
                  </span>
                ) : placed?.kind === "queued" ? (
                  <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                    <Hourglass className="size-3.5 shrink-0" aria-hidden="true" />
                    {QUEUED}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-[12.5px] text-danger">
                    <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                    {placed?.kind === "none" ? placed.reason : "No worker yet"}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {task.acceptance.length > 0 ? (
        <div className="border-t border-border px-4 py-3 sm:px-5">
          <p className="mb-1.5 text-[12px] font-[550] text-faint">Done when</p>
          <ul className="flex flex-col gap-1">
            {task.acceptance.map((line, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] leading-[1.45] text-label-secondary">
                <span aria-hidden="true" className="mt-[3px] size-3 shrink-0 rounded-[3.5px] shadow-[inset_0_0_0_1.25px_var(--color-border-strong)]" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {otherWarnings.length > 0 || placement.blocked ? (
        <div className="flex flex-col gap-1 border-t border-border bg-fill px-4 py-2.5 text-[12.5px] leading-[1.45] text-muted sm:px-5">
          {placement.blocked ? (
            <p className="flex items-start gap-1.5 text-danger">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {placement.blocked}
            </p>
          ) : null}
          {otherWarnings.map((w, i) => (
            <p key={i} className="flex items-start gap-1.5">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {w}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Who takes one starting workstream, as a menu: Auto (the score picks) or a profile the person chooses. Choosing a
 * profile chooses its harness too, which is how a Split task runs Claude Code on one workstream and Codex on another.
 * A compare attempt only lists profiles of its own harness.
 */
function WorkerChoice({
  workstream,
  placed,
  chosenId,
  profiles,
  environments,
  members,
  projectId,
  onChoose,
}: {
  workstream: TaskDetail["workstreams"][number];
  placed: PlacementResult["byWorkstream"][string] | undefined;
  chosenId: string | null;
  profiles: Record<string, ProfileView>;
  environments: readonly EnvironmentView[];
  members: readonly MemberView[];
  projectId: string;
  onChoose: (profileId: string | null) => void;
}) {
  const now = useMinuteClock();
  const profile = placed?.kind === "placed" ? profiles[placed.profileId] : undefined;
  const who = whoRuns(profile, environments, members);
  const options = Object.values(profiles)
    .filter((p) => !workstream.harness || p.cli === workstream.harness)
    .sort((a, b) => a.cli.localeCompare(b.cli) || a.label.localeCompare(b.label));
  const trigger = (
    <button
      type="button"
      aria-label={`Worker for ${workstream.title}: ${profile ? `${profile.label}${chosenId ? "" : ", picked automatically"}` : placed?.kind === "queued" ? "queued" : "none"}. Change`}
      className={cn(
        "group flex min-w-0 max-w-full items-center gap-2 rounded-[8px] px-1.5 py-1 text-left outline-none sm:flex-row-reverse sm:text-right",
        "transition-colors duration-150 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-row-hover",
      )}
    >
      {placed?.kind === "queued" ? (
        <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
          <Hourglass className="size-3.5 shrink-0" aria-hidden="true" />
          {QUEUED}
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </span>
      ) : profile && who ? (
        <>
          <HarnessIcon cli={profile.cli} size={20} />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1 truncate text-[13px] font-[550] text-text sm:justify-end">
              {profile.label}
              <ChevronDown className="size-3 shrink-0 text-faint transition-colors duration-150 group-hover:text-muted" aria-hidden="true" />
            </span>
            <span className="truncate text-[12px] text-muted">{chosenId ? who.where : `Auto · ${who.where}`}</span>
          </span>
        </>
      ) : (
        <span className="flex items-center gap-1.5 text-[12.5px] text-danger">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {placed?.kind === "none" ? placed.reason : "No worker yet"}
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </span>
      )}
    </button>
  );
  return (
    <Menu side="bottom" align="end" trigger={trigger} className="w-[min(18rem,calc(100vw-1rem))]">
      <MenuSection label={workstream.harness ? `${HARNESS_LABEL[workstream.harness]} profiles` : "Who takes it"}>
        <MenuItem icon={<Sparkles aria-hidden="true" />} onClick={() => onChoose(null)} checked={chosenId === null}>
          Auto
        </MenuItem>
      </MenuSection>
      {options.length > 0 ? <MenuSeparator /> : null}
      {options.map((p) => {
        const state = profileState(p, environments.find((e) => e.id === p.envId), now, projectId);
        const where = whoRuns(p, environments, members)?.where ?? "";
        return (
          <MenuItem
            key={p.id}
            icon={<HarnessIcon cli={p.cli} size={16} decorative />}
            disabled={!state.pickable && chosenId !== p.id}
            onClick={() => onChoose(p.id)}
            checked={chosenId === p.id}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{p.label}</span>
              <span className="truncate text-[12px] text-muted">{state.kind === "ready" ? where : `${where} · ${state.label}`}</span>
            </span>
          </MenuItem>
        );
      })}
    </Menu>
  );
}
