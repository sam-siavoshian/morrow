import type { ProfileView } from "@morrow/contracts";

/**
 * First-run setup as a small state machine: the intro, then a team (created, joined or picked),
 * its repos, the user's cloud environment, their agents, and a last look before landing in the
 * team. Pure, so the URL can restore it and tests can drive it.
 */

export const STEPS = ["intro", "team", "repos", "environment", "agents", "finish"] as const;
export type Step = (typeof STEPS)[number];

/** The steps the progress bar counts: the intro is the door, not a step. */
export const COUNTED_STEPS = STEPS.filter((step) => step !== "intro");

export type OnboardingState = {
  step: Step;
  /** The team being set up. Null until one is created, chosen or joined. */
  teamId: string | null;
  /** The signed-in user's environment in that team, once there is one. */
  envId: string | null;
};

export type OnboardingEvent =
  /** Past the intro. */
  | { type: "begin" }
  /** A team was created, joined or picked: on to its repos. */
  | { type: "team.chosen"; teamId: string }
  | { type: "team.cleared" }
  | { type: "env.attached"; envId: string }
  | { type: "env.lost" }
  /** Continue: the next step the guards allow. Agents is passed over while there is no environment. */
  | { type: "next" }
  /** Back: the previous step the guards allow, never back through the intro. */
  | { type: "back" }
  | { type: "goto"; step: Step };

export const stepIndex = (step: Step) => STEPS.indexOf(step);

export const isStep = (value: unknown): value is Step => typeof value === "string" && (STEPS as readonly string[]).includes(value);

/** What a step needs before it can show. */
export function canEnter(state: Pick<OnboardingState, "teamId" | "envId">, step: Step): boolean {
  if (step === "intro" || step === "team") return true;
  if (step === "agents") return state.teamId !== null && state.envId !== null;
  return state.teamId !== null;
}

/** The nearest step in one direction that the guards allow, if any. Back never returns to the intro. */
export function neighbour(state: OnboardingState, by: 1 | -1): Step | undefined {
  for (let at = stepIndex(state.step) + by; at >= 0 && at < STEPS.length; at += by) {
    const step = STEPS[at]!;
    if (step === "intro") return undefined;
    if (canEnter(state, step)) return step;
  }
  return undefined;
}

/** Where a step stands among the counted ones: 1-based, with the total. The intro is 0. */
export function position(step: Step): { at: number; of: number } {
  return { at: COUNTED_STEPS.indexOf(step as (typeof COUNTED_STEPS)[number]) + 1, of: COUNTED_STEPS.length };
}

export function reduceOnboarding(state: OnboardingState, event: OnboardingEvent): OnboardingState {
  switch (event.type) {
    case "begin":
      return state.step === "intro" ? { ...state, step: "team" } : state;
    case "team.chosen":
      if (event.teamId === state.teamId) return state.step === "team" ? { ...state, step: "repos" } : state;
      return { step: "repos", teamId: event.teamId, envId: null };
    case "team.cleared":
      return { step: "team", teamId: null, envId: null };
    case "env.attached":
      return state.teamId && state.envId !== event.envId ? { ...state, envId: event.envId } : state;
    case "env.lost":
      // The environment was disconnected elsewhere: the agents step has nothing to stand on.
      return state.envId === null ? state : { ...state, envId: null, step: state.step === "agents" ? "environment" : state.step };
    case "next": {
      const next = neighbour(state, 1);
      return next ? { ...state, step: next } : state;
    }
    case "back": {
      const previous = neighbour(state, -1);
      return previous ? { ...state, step: previous } : state;
    }
    case "goto":
      return event.step !== "intro" && canEnter(state, event.step) ? { ...state, step: event.step } : state;
  }
}

/**
 * Restores setup from `?team=&step=`. A team the user is not in is ignored, and a step is clamped
 * to the furthest one the guards allow (the environment is found again once the team loads). No
 * step at all is a fresh start, on the intro.
 */
export function initialOnboarding(params: { team?: string | null; step?: string | null }, teamIds: readonly string[]): OnboardingState {
  const teamId = params.team && teamIds.includes(params.team) ? params.team : null;
  const fresh = !params.step || params.step === "intro";
  const base: OnboardingState = { step: fresh ? "intro" : "team", teamId, envId: null };
  if (fresh || !isStep(params.step)) return base;
  // The agents step needs an environment we only learn about later; land on environment and let
  // the wizard move on by itself if one exists.
  const step = params.step === "agents" ? "environment" : params.step;
  return canEnter(base, step) ? { ...base, step } : base;
}

/** The query string that restores this state, or "" on the intro. */
export function onboardingQuery(state: OnboardingState): string {
  if (state.step === "intro") return "";
  const search = new URLSearchParams(state.teamId ? { team: state.teamId, step: state.step } : { step: state.step });
  return `?${search}`;
}

export type AgentCardState = "ready" | "checking" | "signin";

/** Ready only when the CLI itself says it is signed in; everything else asks the person to sign in. */
export function agentCardState(profile: Pick<ProfileView, "auth"> | null, checking: boolean): AgentCardState {
  if (checking) return "checking";
  return profile?.auth === "ok" ? "ready" : "signin";
}
