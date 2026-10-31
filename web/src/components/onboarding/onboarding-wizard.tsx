"use client";

import type { MeView } from "@morrow/contracts";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { RememberTeam } from "@/components/auth/remember-team";
import { prefersReducedMotion } from "@/lib/motion";
import { TeamProvider } from "@/lib/store";
import { AgentsStep } from "./agents-step";
import { EnvironmentStep, useMyEnvironment } from "./environment-step";
import { FinishStep } from "./finish-step";
import { IntroStep } from "./intro-step";
import { flowKey } from "./keys";
import { initialOnboarding, neighbour, onboardingQuery, reduceOnboarding, type Step } from "./machine";
import { ReposStep } from "./repos-step";
import { ActionSlotProvider, StepBar, StepFrame } from "./step-chrome";
import { TeamSeed } from "./team-seed";
import { TeamStep } from "./team-step";

const STEP_COPY: Record<Exclude<Step, "intro">, { title: string; description: string }> = {
  team: {
    title: "Set up your team",
    description: "Teammates pool their Claude Code, Codex, Cursor, Gemini CLI, Grok and opencode logins in one place.",
  },
  repos: {
    title: "Link your repos",
    description: "Agents open branches and pull requests on the repos you link.",
  },
  environment: {
    title: "Add your cloud VM",
    description: "A VM of your own, where your coding CLIs stay signed in.",
  },
  agents: {
    title: "Sign in your agents",
    description: "Each CLI you sign in becomes a worker the team can route tasks to.",
  },
  finish: {
    title: "You're set up",
    description: "Here is what your team has. Anything left can wait; it all lives in Settings and Workforce.",
  },
};

/** How long the words take to go before the team opens (Zephium leaves quicker than it arrives). Matches duration-[360ms] below. */
const LEAVE_MS = 360;

/** Zephium's first run on our sky: the intro, then one step at a time, steered from one bar. */
export function OnboardingWizard({ me }: { me: MeView }) {
  const router = useRouter();
  const params = useSearchParams();
  const wanted = useRef(params.get("step"));
  const [state, dispatch] = useReducer(reduceOnboarding, undefined, () =>
    initialOnboarding({ team: params.get("team"), step: params.get("step") }, me.teams.map((t) => t.id)),
  );
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [leaving, setLeaving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);

  // Keep the URL in step so a reload resumes where you were.
  useEffect(() => {
    router.replace(`/onboarding${onboardingQuery(state)}`, { scroll: false });
  }, [router, state]);

  // A new step takes focus at its heading, so Enter and a screen reader both start from the top.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [state.step]);

  // Enter presses the step's primary action; Escape or Backspace presses Back.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const key = flowKey(event);
      if (!key) return;
      const target = document.querySelector<HTMLButtonElement>(key === "next" ? "[data-step-primary]" : "[data-step-back]");
      if (!target || target.disabled || target.getAttribute("aria-disabled") === "true") return;
      event.preventDefault();
      target.click();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onAttached = useCallback((envId: string) => {
    dispatch({ type: "env.attached", envId });
    // Arrived with ?step=agents: move on once the environment is known.
    if (wanted.current === "agents") {
      wanted.current = null;
      dispatch({ type: "goto", step: "agents" });
    }
  }, []);
  const onLost = useCallback(() => dispatch({ type: "env.lost" }), []);

  function open() {
    if (!state.teamId || leaving) return;
    setLeaving(true);
    const to = `/t/${encodeURIComponent(state.teamId)}`;
    window.setTimeout(() => router.push(to), prefersReducedMotion() ? 0 : LEAVE_MS);
  }

  if (state.step === "intro") return <IntroStep onContinue={() => dispatch({ type: "begin" })} />;

  const next = () => dispatch({ type: "next" });
  const goto = (step: Step) => dispatch({ type: "goto", step });
  const copy = STEP_COPY[state.step];

  const body: ReactNode =
    state.step === "team" ? (
      <TeamStep
        me={me}
        teamId={state.teamId}
        onChosen={(teamId) => dispatch({ type: "team.chosen", teamId })}
        onChangeTeam={() => dispatch({ type: "team.cleared" })}
      />
    ) : !state.teamId ? null : state.step === "repos" ? (
      <ReposStep me={me} teamId={state.teamId} onDone={next} />
    ) : state.step === "environment" ? (
      <EnvironmentStep me={me} onContinue={next} onLater={() => goto("finish")} />
    ) : state.step === "agents" ? (
      <AgentsStep me={me} onContinue={next} />
    ) : (
      <FinishStep me={me} leaving={leaving} onOpen={open} onEdit={goto} />
    );

  const frame = (
    <StepFrame key={state.step} step={state.step} title={copy.title} description={copy.description} headingRef={heading}>
      {body}
    </StepFrame>
  );

  return (
    <ActionSlotProvider value={slot}>
      <div
        data-leaving={leaving || undefined}
        className="flex min-h-[calc(100svh-var(--nav-height)-2.5rem)] w-full max-w-[600px] flex-col gap-8 transition-opacity duration-[360ms] ease-exit data-leaving:opacity-0"
      >
        {state.teamId ? (
          <TeamProvider key={state.teamId} teamId={state.teamId}>
            <RememberTeam teamId={state.teamId} />
            <TeamSeed />
            <EnvWatcher userId={me.user.id} envId={state.envId} onAttached={onAttached} onLost={onLost} />
            {frame}
          </TeamProvider>
        ) : (
          frame
        )}
        <StepBar step={state.step} onBack={neighbour(state, -1) ? () => dispatch({ type: "back" }) : undefined} slotRef={setSlot} />
      </div>
    </ActionSlotProvider>
  );
}

/** Tracks the user's environment on every step, so the flow knows when Agents is reachable. */
function EnvWatcher({ userId, envId, onAttached, onLost }: { userId: string; envId: string | null; onAttached: (id: string) => void; onLost: () => void }) {
  const mine = useMyEnvironment(userId);
  const env = mine === undefined ? undefined : (mine?.id ?? null);
  useEffect(() => {
    if (env === undefined) return;
    if (env && env !== envId) onAttached(env);
    if (!env && envId) onLost();
  }, [env, envId, onAttached, onLost]);
  return null;
}
