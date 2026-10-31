import { describe, expect, test } from "bun:test";
import {
  agentCardState,
  canEnter,
  COUNTED_STEPS,
  initialOnboarding,
  neighbour,
  onboardingQuery,
  position,
  reduceOnboarding,
  STEPS,
  type OnboardingEvent,
  type OnboardingState,
} from "./machine";

const intro: OnboardingState = { step: "intro", teamId: null, envId: null };
const fresh: OnboardingState = { step: "team", teamId: null, envId: null };
const run = (state: OnboardingState, ...events: OnboardingEvent[]) => events.reduce(reduceOnboarding, state);
const withEnv = run(intro, { type: "begin" }, { type: "team.chosen", teamId: "t1" }, { type: "env.attached", envId: "e1" });

describe("onboarding machine", () => {
  test("walks intro, team, repos, environment, agents, finish", () => {
    expect(STEPS).toEqual(["intro", "team", "repos", "environment", "agents", "finish"]);
    const s = run(intro, { type: "begin" }, { type: "team.chosen", teamId: "t1" });
    expect(s).toEqual({ step: "repos", teamId: "t1", envId: null });
    const e = run(s, { type: "next" }, { type: "env.attached", envId: "e1" }, { type: "next" });
    expect(e).toEqual({ step: "agents", teamId: "t1", envId: "e1" });
    expect(run(e, { type: "next" }).step).toBe("finish");
  });

  test("begin only leaves the intro", () => {
    expect(run(intro, { type: "begin" })).toEqual(fresh);
    const s = run(fresh, { type: "team.chosen", teamId: "t1" });
    expect(run(s, { type: "begin" })).toBe(s);
  });

  test("cannot move past the team step without a team", () => {
    expect(run(fresh, { type: "next" })).toBe(fresh);
    for (const step of ["repos", "environment", "agents", "finish"] as const) expect(run(fresh, { type: "goto", step })).toBe(fresh);
    expect(run(fresh, { type: "env.attached", envId: "e1" })).toBe(fresh);
  });

  test("without an environment, Continue passes over agents to finish", () => {
    const s = run(fresh, { type: "team.chosen", teamId: "t1" }, { type: "next" });
    expect(s.step).toBe("environment");
    expect(run(s, { type: "next" }).step).toBe("finish");
    expect(run(s, { type: "goto", step: "agents" })).toBe(s);
  });

  test("back never returns to the intro and passes over agents with no environment", () => {
    expect(run(fresh, { type: "back" })).toBe(fresh);
    const finish = run(fresh, { type: "team.chosen", teamId: "t1" }, { type: "goto", step: "finish" });
    expect(run(finish, { type: "back" }).step).toBe("environment");
    const withAgents = run(withEnv, { type: "goto", step: "finish" });
    expect(run(withAgents, { type: "back" }).step).toBe("agents");
    expect(run(withAgents, { type: "back" }, { type: "back" }, { type: "back" }, { type: "back" }, { type: "back" }).step).toBe("team");
  });

  test("goto never targets the intro", () => {
    expect(run(withEnv, { type: "goto", step: "intro" })).toBe(withEnv);
  });

  test("losing the environment on agents drops back to environment", () => {
    const s = run(withEnv, { type: "goto", step: "agents" });
    expect(run(s, { type: "env.lost" })).toEqual({ step: "environment", teamId: "t1", envId: null });
  });

  test("losing the environment elsewhere keeps the step", () => {
    expect(run(withEnv, { type: "env.lost" })).toEqual({ step: "repos", teamId: "t1", envId: null });
    expect(run(fresh, { type: "env.lost" })).toBe(fresh);
  });

  test("switching team resets env and lands on its repos", () => {
    expect(run(withEnv, { type: "team.chosen", teamId: "t2" })).toEqual({ step: "repos", teamId: "t2", envId: null });
    expect(run(withEnv, { type: "team.cleared" })).toEqual(fresh);
  });

  test("re-choosing the same team from its step moves on and keeps the environment", () => {
    const back = run(withEnv, { type: "goto", step: "team" });
    expect(run(back, { type: "team.chosen", teamId: "t1" })).toEqual({ step: "repos", teamId: "t1", envId: "e1" });
    const env = run(withEnv, { type: "next" });
    expect(run(env, { type: "team.chosen", teamId: "t1" })).toBe(env);
  });

  test("canEnter guards", () => {
    expect(canEnter({ teamId: null, envId: null }, "intro")).toBe(true);
    expect(canEnter({ teamId: null, envId: null }, "team")).toBe(true);
    expect(canEnter({ teamId: null, envId: null }, "repos")).toBe(false);
    expect(canEnter({ teamId: "t", envId: null }, "environment")).toBe(true);
    expect(canEnter({ teamId: "t", envId: null }, "agents")).toBe(false);
    expect(canEnter({ teamId: "t", envId: "e" }, "agents")).toBe(true);
    expect(canEnter({ teamId: "t", envId: null }, "finish")).toBe(true);
  });

  test("neighbour is undefined at both ends", () => {
    expect(neighbour(fresh, -1)).toBeUndefined();
    expect(neighbour({ ...withEnv, step: "finish" }, 1)).toBeUndefined();
    expect(neighbour(intro, -1)).toBeUndefined();
  });

  test("position counts from the first real step", () => {
    expect(COUNTED_STEPS).not.toContain("intro");
    expect(position("team")).toEqual({ at: 1, of: 5 });
    expect(position("finish")).toEqual({ at: 5, of: 5 });
    expect(position("intro")).toEqual({ at: 0, of: 5 });
  });
});

describe("restoring from the URL", () => {
  const teams = ["t1", "t2"];
  test("no step is a fresh start on the intro", () => {
    expect(initialOnboarding({}, teams)).toEqual(intro);
    expect(initialOnboarding({ step: "intro", team: "t1" }, teams)).toEqual({ ...intro, teamId: "t1" });
  });
  test("a team the user is not in is ignored", () => {
    expect(initialOnboarding({ team: "evil", step: "environment" }, teams)).toEqual(fresh);
  });
  test("each step with a known team", () => {
    expect(initialOnboarding({ team: "t2", step: "repos" }, teams)).toEqual({ step: "repos", teamId: "t2", envId: null });
    expect(initialOnboarding({ team: "t2", step: "environment" }, teams)).toEqual({ step: "environment", teamId: "t2", envId: null });
    expect(initialOnboarding({ team: "t2", step: "finish" }, teams)).toEqual({ step: "finish", teamId: "t2", envId: null });
  });
  test("the old team step link still opens on that team", () => {
    expect(initialOnboarding({ team: "t1", step: "team" }, teams)).toEqual({ step: "team", teamId: "t1", envId: null });
  });
  test("agents clamps to environment until the env is known", () => {
    expect(initialOnboarding({ team: "t1", step: "agents" }, teams).step).toBe("environment");
  });
  test("a step past the team with no team clamps to the team step", () => {
    expect(initialOnboarding({ step: "finish" }, teams)).toEqual(fresh);
  });
  test("a bogus step falls back to the team step", () => {
    expect(initialOnboarding({ team: "t1", step: "<x>" }, teams)).toEqual({ step: "team", teamId: "t1", envId: null });
  });
  test("query round-trips", () => {
    const s: OnboardingState = { step: "environment", teamId: "t1", envId: "e1" };
    const q = new URLSearchParams(onboardingQuery(s));
    expect(initialOnboarding({ team: q.get("team"), step: q.get("step") }, teams)).toEqual({ ...s, envId: null });
    expect(onboardingQuery(intro)).toBe("");
    expect(onboardingQuery(fresh)).toBe("?step=team");
    const back = new URLSearchParams(onboardingQuery(fresh));
    expect(initialOnboarding({ team: back.get("team"), step: back.get("step") }, teams)).toEqual(fresh);
  });
  test("team ids are encoded in the query", () => {
    expect(onboardingQuery({ step: "repos", teamId: "a&b=c", envId: null })).toBe("?team=a%26b%3Dc&step=repos");
  });
});

describe("agent card state", () => {
  test("ready only when auth is ok", () => {
    expect(agentCardState({ auth: "ok" }, false)).toBe("ready");
    expect(agentCardState({ auth: "auth_required" }, false)).toBe("signin");
    expect(agentCardState({ auth: "unknown" }, false)).toBe("signin");
    expect(agentCardState(null, false)).toBe("signin");
  });
  test("checking wins", () => {
    expect(agentCardState({ auth: "ok" }, true)).toBe("checking");
    expect(agentCardState(null, true)).toBe("checking");
  });
});
