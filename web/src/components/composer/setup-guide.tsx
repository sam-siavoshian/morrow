import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { GithubMark } from "@/components/auth/github-button";
import { HARNESSES, HarnessStack } from "@/components/harness/harness-icon";
import { settingsPath } from "@/components/settings/sections";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export type SetupState = {
  hasProject: boolean;
  hasEnvironment: boolean;
  /** Some CLI is signed in on a running VM (busy is fine: that is not a setup problem). */
  hasSignedInProfile: boolean;
  canManageProjects: boolean;
};

/** The vendor a step is about, shown by its real logo next to the title. */
export type StepMark = "github" | "clis";

type Step = { done: boolean; title: string; detail: string; href: string; cta: string; mark?: StepMark };

export function setupSteps(teamId: string, s: SetupState): Step[] {
  const t = `/t/${encodeURIComponent(teamId)}`;
  return [
    {
      done: s.hasProject,
      title: "Link a repository",
      detail: s.canManageProjects ? "Pick a GitHub repo for the team to work in." : "Ask a team admin to link a GitHub repo.",
      href: settingsPath(teamId, "projects"),
      cta: "Settings",
      mark: "github",
    },
    {
      done: s.hasEnvironment,
      title: "Add a coding environment",
      detail: "A cloud VM under your name where your CLIs live.",
      href: `${t}/workforce`,
      cta: "Workforce",
    },
    {
      done: s.hasSignedInProfile,
      title: "Log in a coding CLI",
      detail: "Claude Code, Codex, Cursor, Gemini CLI, Grok or opencode, signed in on that VM. Planning needs Claude Code or Codex.",
      href: `${t}/workforce`,
      cta: "Workforce",
      mark: "clis",
    },
  ];
}

/** Shown under the composer until the team can actually run a task. Honest about what's missing. */
export function SetupGuide({ teamId, state }: { teamId: string; state: SetupState }) {
  const steps = setupSteps(teamId, state);
  if (steps.every((s) => s.done)) return null;
  const next = steps.findIndex((s) => !s.done);
  return (
    <section aria-labelledby="setup-title" className="rounded-2xl bg-card px-4 py-3.5 shadow-hairline sm:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="setup-title" className="text-[14.5px] font-[600] tracking-[-0.012em] text-text">
          {state.hasProject ? "Workers can't start yet" : "Before your first task"}
        </h2>
        <Link
          href="/onboarding"
          className="shrink-0 rounded-[6px] text-[13px] font-[500] text-muted underline-offset-4 outline-none hover:text-text hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Guided setup
        </Link>
      </div>
      <ol className="mt-2.5 flex flex-col gap-0.5">
        {steps.map((step, i) => (
          <li key={step.title} className="flex items-start gap-3 py-1.5">
            <span
              aria-hidden="true"
              className={cn(
                "mt-px grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-[600] tabular-nums",
                step.done ? "bg-soft-mint-wash text-soft-mint-ink" : i === next ? "bg-lit text-on-lit" : "bg-fill text-faint",
              )}
            >
              {step.done ? <Check className="size-3" strokeWidth={2.6} /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("flex items-center gap-2 text-[14px] font-[550] tracking-[-0.006em]", step.done ? "text-muted line-through decoration-faint" : "text-text")}>
                {step.title}
                <span className="sr-only">{step.done ? " (done)" : ""}</span>
                {step.mark && !step.done ? <StepLogo mark={step.mark} /> : null}
              </p>
              {!step.done ? <p className="text-[13px] leading-[1.5] text-muted">{step.detail}</p> : null}
            </div>
            {!step.done && i === next ? (
              <Button size="sm" variant="secondary" render={<Link href={step.href} />}>
                {step.cta}
                <ArrowRight aria-hidden="true" />
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function StepLogo({ mark }: { mark: StepMark }) {
  return mark === "github" ? <GithubMark className="size-3.5 text-muted" /> : <HarnessStack clis={[...HARNESSES]} size={15} max={HARNESSES.length} />;
}
