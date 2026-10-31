import { describe, expect, test } from "bun:test";
import type { EnvironmentView, MemberView, ProfileView, TaskDetail, WorkstreamDetail } from "@morrow/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { fallbackReason, PlanCard } from "./plan-card";
import { fewerAgents, flowPhase, planningLine, primaryAction, refinedPrompt } from "./plan-flow";
import { previewPlacement } from "./placement";
import { lastPlannedAt, REPLAN_START_TIMEOUT_MS, replanProgress, waitingTaskOf } from "./use-task-flow";

const ws = (id: string, over: Partial<WorkstreamDetail> = {}): WorkstreamDetail => ({
  id,
  role: id,
  title: `Build ${id}`,
  why: `Because ${id}`,
  branch: `morrow/abc/${id}`,
  dependsOn: [],
  status: "pending",
  leaseId: null,
  lastCheckpoint: null,
  ...over,
});

const task = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  id: "tk-1",
  projectId: "p-1",
  title: "Add billing page",
  prompt: "Add a billing page",
  acceptance: [],
  createdBy: "u-1",
  status: "planned",
  maxAgents: 3,
  plan: { source: "cli", profileId: "pf-a", rationale: "Split UI and API.", warnings: [] },
  workstreams: [ws("api"), ws("ui")],
  verification: null,
  trace: [],
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

const profile = (id: string, over: Partial<ProfileView> = {}): ProfileView => ({
  id,
  envId: "e-a",
  ownerUserId: "u-1",
  cli: "claude",
  label: `Profile ${id}`,
  auth: "ok",
  availability: "ready",
  cooldownUntil: null,
  limitedReason: null,
  limitedSource: null,
  maxConcurrent: 1,
  activeLeases: 0,
  scopes: "all",
  lastSeenAt: null,
  ...over,
});

const env = (id: string, over: Partial<EnvironmentView> = {}): EnvironmentView => ({
  id,
  ownerUserId: "u-1",
  name: `${id}-vm`,
  linuxUser: null,
  nodeName: null,
  phase: "ready",
  vmState: "running",
  nodeOnline: true,
  lastError: null,
  createdAt: 0,
  ...over,
});

const members: MemberView[] = [
  { userId: "u-1", login: "ada", name: null, avatarUrl: null, role: "owner" },
  { userId: "u-2", login: "linus", name: null, avatarUrl: null, role: "member" },
];

describe("flowPhase and primaryAction (Start / Refine transitions)", () => {
  test("compose -> planning -> planned", () => {
    expect(flowPhase(null, null)).toEqual({ kind: "compose" });
    expect(flowPhase("tk-1", null).kind).toBe("planning");
    expect(flowPhase("tk-1", task({ status: "draft", workstreams: [] })).kind).toBe("planning");
    expect(flowPhase("tk-1", task({ status: "planning" })).kind).toBe("planning");
    expect(flowPhase("tk-1", task()).kind).toBe("planned");
  });

  test("a planned task with no workstreams yet still reads as planning", () => {
    expect(flowPhase("tk-1", task({ workstreams: [] })).kind).toBe("planning");
  });

  test("started and ended", () => {
    for (const status of ["starting", "running", "handoff", "verifying", "completed"] as const)
      expect(flowPhase("tk-1", task({ status })).kind).toBe("started");
    expect(flowPhase("tk-1", task({ status: "cancelled" }))).toMatchObject({ kind: "ended", reason: "This task was cancelled." });
    expect(flowPhase("tk-1", task({ status: "failed" })).kind).toBe("ended");
  });

  test("the button: send, planning, Start, Refine", () => {
    expect(primaryAction({ kind: "compose" }, false)).toBe("send");
    expect(primaryAction({ kind: "compose" }, true)).toBe("send");
    expect(primaryAction({ kind: "planning", task: null }, true)).toBe("planning");
    expect(primaryAction({ kind: "planned", task: task() }, false)).toBe("start");
    expect(primaryAction({ kind: "planned", task: task() }, true)).toBe("refine");
    expect(primaryAction({ kind: "ended", task: null, reason: "x" }, true)).toBe("send");
  });

  test("Start with fewer agents goes one below the plan, never below one", () => {
    expect(fewerAgents(task())).toBe(1);
    expect(fewerAgents(task({ workstreams: [ws("a"), ws("b"), ws("c")] }))).toBe(2);
    expect(fewerAgents(task({ workstreams: [ws("a")] }))).toBeNull();
    // A plan can never exceed the task's cap, but the cap still bounds it.
    expect(fewerAgents(task({ maxAgents: 2, workstreams: [ws("a"), ws("b"), ws("c")] }))).toBe(1);
  });

  test("Refine carries the feedback in the prompt and refuses to overflow", () => {
    expect(refinedPrompt("Add billing", "  use Stripe  ")).toBe("Add billing\n\nFeedback on the previous plan:\nuse Stripe");
    expect(refinedPrompt("Add billing", "   ")).toBeNull();
    expect(refinedPrompt("x".repeat(7990), "more words here")).toBeNull();
  });

  test("planning line uses the trace only when it says something new", () => {
    expect(planningLine(null)).toBe("Planning the task");
    expect(planningLine(task({ trace: [{ at: 1, kind: "task.created", message: "Task created", leaseId: null, profileId: null, epoch: null }] }))).toBe(
      "Planning the task",
    );
  });
});

describe("previewPlacement", () => {
  const environments = [env("e-a"), env("e-b")];

  test("spreads roots across machines and leaves dependents waiting", () => {
    const t = task({ workstreams: [ws("api"), ws("ui"), ws("tests", { dependsOn: ["api", "ui"] })] });
    const result = previewPlacement({
      task: t,
      profiles: [profile("pf-a", { maxConcurrent: 2 }), profile("pf-b", { envId: "e-b", maxConcurrent: 2 })],
      environments,
      pins: [],
      mode: "auto",
    });
    const placedEnvs = ["api", "ui"].map((id) => (result.byWorkstream[id] as { profileId: string }).profileId);
    expect(new Set(placedEnvs).size).toBe(2);
    expect(result.byWorkstream.tests).toEqual({ kind: "waits", on: ["api", "ui"] });
    expect(result.picks).toHaveLength(2);
    expect(result.blocked).toBeNull();
  });

  test("pins win in auto mode", () => {
    const result = previewPlacement({
      task: task({ workstreams: [ws("api")] }),
      profiles: [profile("pf-a"), profile("pf-b", { envId: "e-b" })],
      environments,
      pins: ["pf-b"],
      mode: "auto",
    });
    expect(result.picks).toEqual([{ workstreamId: "api", profileId: "pf-b" }]);
  });

  test("manual mode only uses picked profiles: what they can't take now is queued, and none free blocks Start", () => {
    const result = previewPlacement({
      task: task(),
      profiles: [profile("pf-a"), profile("pf-b", { envId: "e-b" })],
      environments,
      pins: ["pf-a"],
      mode: "manual",
    });
    expect(result.picks).toEqual([{ workstreamId: "api", profileId: "pf-a" }]);
    expect(result.byWorkstream.ui).toEqual({ kind: "queued" });
    expect(result.blocked).toBeNull();

    const full = previewPlacement({
      task: task(),
      profiles: [profile("pf-a", { activeLeases: 1 }), profile("pf-b", { envId: "e-b" })],
      environments,
      pins: ["pf-a"],
      mode: "manual",
    });
    expect(full.picks).toBeNull();
    expect(full.blocked).toBe("None of your picked profiles has a free slot. Wait for one to free up, or pick more.");
    // Nothing can start, so no row reads as queued.
    expect(full.byWorkstream.api).toEqual({ kind: "none", reason: "None of your picked profiles is free" });
    expect(full.byWorkstream.ui).toEqual({ kind: "none", reason: "None of your picked profiles is free" });
  });

  test("a split starts with what fits: one login with free slots takes several roots, the rest queue", () => {
    const t = task({ workstreams: [ws("api"), ws("ui"), ws("db"), ws("docs"), ws("e2e", { dependsOn: ["api"] })] });
    const result = previewPlacement({ task: t, profiles: [profile("pf-a", { maxConcurrent: 3, activeLeases: 1 })], environments, pins: [], mode: "auto" });
    expect(result.picks).toEqual([
      { workstreamId: "api", profileId: "pf-a" },
      { workstreamId: "ui", profileId: "pf-a" },
    ]);
    expect(result.byWorkstream.db).toEqual({ kind: "queued" });
    expect(result.byWorkstream.docs).toEqual({ kind: "queued" });
    expect(result.byWorkstream.e2e).toEqual({ kind: "waits", on: ["api"] });
    expect(result.blocked).toBeNull();
  });

  test("the team's per-task cap: never more picks than it, the rest queue, and a chosen root past it says why", () => {
    const t = task({ workstreams: [ws("api"), ws("ui"), ws("db")] });
    const profiles = [profile("pf-a", { maxConcurrent: 8 }), profile("pf-b", { envId: "e-b", maxConcurrent: 8 })];
    const capped = previewPlacement({ task: t, profiles, environments, pins: [], mode: "auto", cap: 2 });
    expect(capped.picks?.map((p) => p.workstreamId)).toEqual(["api", "ui"]);
    expect(capped.byWorkstream.db).toEqual({ kind: "queued" });
    expect(capped.blocked).toBeNull();
    // Chosen ones claim the slots first.
    const chosen = previewPlacement({ task: t, profiles, environments, pins: [], mode: "auto", cap: 1, chosen: { db: "pf-b" } });
    expect(chosen.picks).toEqual([{ workstreamId: "db", profileId: "pf-b" }]);
    expect(chosen.byWorkstream.api).toEqual({ kind: "queued" });
    const over = previewPlacement({ task: t, profiles, environments, pins: [], mode: "auto", cap: 1, chosen: { api: "pf-a", ui: "pf-b" } });
    expect(over.byWorkstream.ui).toEqual({ kind: "none", reason: "This team starts 1 at once. Set it back to Auto to queue it." });
    expect(over.picks).toBeNull();
    expect(over.blocked).toContain("A profile you chose");
  });

  test("a compare starts every attempt or none, past free slots or past the cap", () => {
    const t = task({ strategy: "compare", workstreams: [ws("claude", { harness: "claude" }), ws("codex", { harness: "codex" })] });
    const both = [profile("pf-a"), profile("pf-b", { envId: "e-b", cli: "codex" })];
    expect(previewPlacement({ task: t, profiles: both, environments, pins: [], mode: "auto" }).picks).toHaveLength(2);
    const busy = previewPlacement({ task: t, profiles: [both[0]!, { ...both[1]!, activeLeases: 1 }], environments, pins: [], mode: "auto" });
    expect(busy.byWorkstream.codex).toEqual({ kind: "none", reason: "No Codex profile is free" });
    expect(busy.picks).toBeNull();
    const capped = previewPlacement({ task: t, profiles: both, environments, pins: [], mode: "auto", cap: 1 });
    expect(capped.byWorkstream.codex).toEqual({ kind: "none", reason: "This team runs 1 at once" });
    expect(capped.picks).toBeNull();
    expect(capped.blocked).toContain("Not every harness");
  });

  test("manual mode: a chosen profile that isn't picked blocks Start with a reason, since the backend refuses it", () => {
    const result = previewPlacement({
      task: task({ workstreams: [ws("api")] }),
      profiles: [profile("pf-a"), profile("pf-b", { envId: "e-b", label: "Grace's Codex" })],
      environments,
      pins: ["pf-a"],
      mode: "manual",
      chosen: { api: "pf-b" },
    });
    expect(result.byWorkstream.api).toEqual({ kind: "none", reason: "Grace's Codex isn't one of your picked profiles" });
    expect(result.picks).toBeNull();
    expect(result.blocked).toContain("A profile you chose");
    // The same choice in auto is fine.
    const auto = previewPlacement({
      task: task({ workstreams: [ws("api")] }),
      profiles: [profile("pf-a"), profile("pf-b", { envId: "e-b" })],
      environments,
      pins: ["pf-a"],
      mode: "auto",
      chosen: { api: "pf-b" },
    });
    expect(auto.picks).toEqual([{ workstreamId: "api", profileId: "pf-b" }]);
  });

  test("never places on limited, auth-needed, offline-VM or out-of-scope profiles", () => {
    const result = previewPlacement({
      task: task({ workstreams: [ws("api")] }),
      profiles: [
        profile("pf-limited", { availability: "limited" }),
        profile("pf-auth", { auth: "auth_required" }),
        profile("pf-vm", { envId: "e-down" }),
        profile("pf-scope", { scopes: ["p-other"] }),
      ],
      environments: [...environments, env("e-down", { phase: "paused" })],
      pins: [],
      mode: "auto",
    });
    expect(result.picks).toBeNull();
    expect(result.blocked).toContain("No ready CLI profile");
  });
});

describe("PlanCard", () => {
  const profiles = { "pf-a": profile("pf-a"), "pf-b": profile("pf-b", { envId: "e-b", ownerUserId: "u-2", cli: "codex", label: "Linus Codex" }) };
  const environments = [env("e-a", { name: "ada-workbox" }), env("e-b", { name: "linus-box" })];

  test("cli plan: rationale, who planned it, and one row per workstream with its worker and why", () => {
    const t = task();
    const placement = previewPlacement({ task: t, profiles: Object.values(profiles), environments, pins: ["pf-b"], mode: "auto" });
    const html = renderToStaticMarkup(<PlanCard task={t} placement={placement} profiles={profiles} environments={environments} members={members} />);
    expect(html).toContain('data-plan-source="cli"');
    expect(html).toContain("Planned by Claude Code on ada-workbox");
    expect(html).not.toContain("ada&#x27;s ada-workbox");
    expect(html).toContain("Split UI and API.");
    expect(html).not.toContain("Fallback plan");
    expect(html.match(/data-workstream=/g)).toHaveLength(2);
    expect(html).toContain("morrow/abc/api");
    expect(html).toContain("Because ui");
    expect(html).toContain("Linus Codex");
    expect(html).toContain("linus-box");
    expect(html).not.toContain("linus · linus-box");
  });

  test("a queued workstream says it starts when a slot frees up", () => {
    const t = task();
    const placement = previewPlacement({ task: t, profiles: [profiles["pf-a"]], environments, pins: [], mode: "auto" });
    const html = renderToStaticMarkup(<PlanCard task={t} placement={placement} profiles={profiles} environments={environments} members={members} />);
    expect(placement.byWorkstream.ui).toEqual({ kind: "queued" });
    expect(html).toContain("Starts when a slot frees up");
    const choosing = renderToStaticMarkup(
      <PlanCard task={t} placement={placement} profiles={profiles} environments={environments} members={members} onChoose={() => {}} />,
    );
    expect(choosing).toContain("Starts when a slot frees up");
    expect(choosing).toContain("Worker for Build ui: queued. Change");
  });

  test("a VM name without the owner gets the owner in front", () => {
    const t = task();
    const envs = [env("e-a", { name: "workbox" }), env("e-b", { name: "alpha" })];
    const placement = previewPlacement({ task: t, profiles: Object.values(profiles), environments: envs, pins: [], mode: "auto" });
    const html = renderToStaticMarkup(<PlanCard task={t} placement={placement} profiles={profiles} environments={envs} members={members} />);
    expect(html).toContain("Planned by Claude Code on ada&#x27;s workbox");
  });

  test("fallback plan says so plainly with the reason", () => {
    const t = task({
      plan: {
        source: "fallback",
        profileId: null,
        rationale: "Planner fallback: Freestyle is not configured. One worker owns the whole change.",
        warnings: ["Planner fallback: Freestyle is not configured"],
      },
      workstreams: [ws("main")],
    });
    const placement = previewPlacement({ task: t, profiles: [], environments, pins: [], mode: "auto" });
    const html = renderToStaticMarkup(<PlanCard task={t} placement={placement} profiles={{}} environments={environments} members={members} />);
    expect(html).toContain('data-plan-source="fallback"');
    expect(html).toContain("Fallback plan.");
    expect(html).toContain("because Freestyle is not configured");
    expect(html).not.toContain("Planned by");
    // No worker anywhere: the reason shows on the row and in the footer.
    expect(html).toContain("No ready profile is free");
    expect(html).toContain("No ready CLI profile has a free slot");
  });

  test("agent text is rendered as text, never as HTML", () => {
    const t = task({ title: "<img src=x onerror=alert(1)>", workstreams: [ws("api", { why: "<script>alert(1)</script>" })] });
    const placement = previewPlacement({ task: t, profiles: [], environments, pins: [], mode: "auto" });
    const html = renderToStaticMarkup(<PlanCard task={t} placement={placement} profiles={{}} environments={environments} members={members} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  test("fallbackReason reads the backend's warning", () => {
    expect(fallbackReason({ source: "fallback", profileId: null, rationale: "", warnings: ["Planner fallback: the planner call failed."] })).toBe(
      "the planner call failed",
    );
    expect(fallbackReason({ source: "fallback", profileId: null, rationale: "", warnings: [] })).toBe("the planner did not run");
  });
});

describe("task flow resume and re-plan", () => {
  const planned = (at: number) => ({ at, kind: "task.planned", message: "Plan", leaseId: null, profileId: null, epoch: null }) as TaskDetail["trace"][number];

  test("resumes the viewer's newest waiting plan, never someone else's or one set aside", () => {
    const tasks = {
      a: task({ id: "a", updatedAt: 5 }),
      b: task({ id: "b", updatedAt: 9 }),
      c: task({ id: "c", updatedAt: 20, createdBy: "u-2" }),
      d: task({ id: "d", updatedAt: 30, status: "running" }),
    };
    const workforce = { tasks } as unknown as Parameters<typeof waitingTaskOf>[0];
    expect(waitingTaskOf(workforce, "u-1", new Set())).toBe("b");
    expect(waitingTaskOf(workforce, "u-1", new Set(["b"]))).toBe("a");
    expect(waitingTaskOf(workforce, "u-1", new Set(["a", "b"]))).toBeNull();
    expect(waitingTaskOf(workforce, null, new Set())).toBeNull();
    expect(waitingTaskOf(null, "u-1", new Set())).toBeNull();
  });

  test("re-plan: waiting, planning, landed on a newer plan, stalled when nothing moved", () => {
    const base = task({ trace: [planned(10)], updatedAt: 10 });
    const pending = { taskId: base.id, base: 10, baseUpdatedAt: 10, at: 1_000, autoStart: true };
    expect(replanProgress(null, base, 2_000)).toBe("none");
    expect(replanProgress({ ...pending, taskId: "other" }, base, 2_000)).toBe("none");
    expect(replanProgress(pending, base, 2_000)).toBe("waiting");
    expect(replanProgress(pending, task({ status: "planning", updatedAt: 11 }), 2_000)).toBe("planning");
    expect(replanProgress(pending, task({ trace: [planned(10), planned(12)], updatedAt: 12 }), 2_000)).toBe("landed");
    expect(replanProgress(pending, base, 1_000 + REPLAN_START_TIMEOUT_MS + 1)).toBe("stalled");
    // The task moved (the planner picked it up), so it is not stalled even after the timeout.
    expect(replanProgress(pending, task({ trace: [planned(10)], updatedAt: 11 }), 1_000 + REPLAN_START_TIMEOUT_MS + 1)).toBe("waiting");
  });

  test("the latest plan's time comes from the actor once the view carries only the newest entry", () => {
    expect(lastPlannedAt(null)).toBe(0);
    expect(lastPlannedAt(task({ trace: [planned(10), planned(12)] }))).toBe(12);
    // The newest entry is not the plan, but the actor still reports when it landed.
    expect(lastPlannedAt(task({ plannedAt: 12, trace: [{ ...planned(15), kind: "task.planning" }] }))).toBe(12);
    expect(lastPlannedAt(task({ plannedAt: null, trace: [planned(10)] }))).toBe(0);
  });
});
