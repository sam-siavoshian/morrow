// One task, several harnesses at once (docs/multi-harness.md): the composer's controls, placement with harness
// binding and per-workstream choices, the plan card, the status rows, and the attempts bar in mission control.
import { describe, expect, test } from "bun:test";
import type { EnvironmentView, LeaseView, MemberView, ProfileView, TaskDetail, TaskView, WorkforceView, WorkstreamDetail } from "@morrow/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { compareMax, harnessReadiness } from "@/components/composer/workforce-controls";
import { AttemptsBar, attemptCards } from "@/components/mission/attempts-bar";
import { rowStatus } from "@/components/sidebar/task-meta";
import { selectInbox, taskRowStatus } from "@/lib/store/selectors";
import { PlanCard } from "./plan-card";
import { canReplan, fewerAgents, flowPhase } from "./plan-flow";
import { previewPlacement } from "./placement";

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

const attempt = (cli: "claude" | "codex" | "opencode", over: Partial<WorkstreamDetail> = {}) =>
  ws(`ws-${cli}`, { role: cli, harness: cli, title: `${cli} attempt`, branch: `morrow/abc/${cli}`, ...over });

const task = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  id: "tk-1",
  projectId: "p-1",
  title: "Add billing page",
  prompt: "Add a billing page",
  acceptance: [],
  createdBy: "u-1",
  status: "planned",
  maxAgents: 2,
  strategy: "compare",
  pickedWorkstreamId: null,
  plan: { source: "compare", profileId: null, rationale: "Compare: Claude Code, Codex each attempt the whole task.", warnings: [] },
  workstreams: [attempt("claude"), attempt("codex")],
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

const envs = [env("e-a"), env("e-b", { ownerUserId: "u-2" })];
const pool = [
  profile("pa", { cli: "claude" }),
  profile("pb", { cli: "codex", envId: "e-b", ownerUserId: "u-2" }),
  profile("pc", { cli: "codex", maxConcurrent: 3 }),
];

describe("placement: harness binding and chosen profiles", () => {
  test("a compare attempt only lands on a profile of its harness, whatever scores higher", () => {
    // pc (codex, three free slots) outscores pa for anything unbound; the Claude attempt still gets pa.
    const result = previewPlacement({ task: task(), profiles: pool, environments: envs, pins: ["pc"], mode: "auto" });
    expect(result.byWorkstream["ws-claude"]).toEqual({ kind: "placed", profileId: "pa" });
    expect(result.byWorkstream["ws-codex"]).toEqual({ kind: "placed", profileId: "pc" });
    expect(result.blocked).toBeNull();
  });

  test("with no free profile of a harness, that attempt says which and Start is blocked", () => {
    const result = previewPlacement({ task: task(), profiles: [pool[1]!], environments: envs, pins: [], mode: "auto" });
    expect(result.byWorkstream["ws-claude"]).toEqual({ kind: "none", reason: "No Claude Code profile is free" });
    expect(result.picks).toBeNull();
    expect(result.blocked).toBe("Not every harness in this compare has a free profile. Connect one, or wait for a slot.");
  });

  test("Split: a chosen profile wins its workstream, so the person sets the harness mix", () => {
    const split = task({ strategy: "split", workstreams: [ws("api"), ws("ui")] });
    // Without a choice both would go to the best scorer; with one, the API runs on Claude Code and the UI on Codex.
    const result = previewPlacement({ task: split, profiles: pool, environments: envs, pins: [], mode: "auto", chosen: { api: "pa", ui: "pb" } });
    expect(result.picks).toEqual([
      { workstreamId: "api", profileId: "pa" },
      { workstreamId: "ui", profileId: "pb" },
    ]);
  });

  test("a chosen profile that cannot take the work blocks Start with a reason instead of silently moving", () => {
    const split = task({ strategy: "split", workstreams: [ws("api")] });
    const busy = previewPlacement({
      task: split,
      profiles: [profile("pa", { activeLeases: 1 }), pool[1]!],
      environments: envs,
      pins: [],
      mode: "auto",
      chosen: { api: "pa" },
    });
    expect(busy.byWorkstream.api).toEqual({ kind: "none", reason: "Profile pa can't take it right now" });
    expect(busy.blocked).toBe("A profile you chose can't take its workstream right now. Choose another, or set it back to Auto.");
    const gone = previewPlacement({ task: split, profiles: pool, environments: envs, pins: [], mode: "auto", chosen: { api: "p-gone" } });
    expect(gone.byWorkstream.api).toEqual({ kind: "none", reason: "The profile you chose is gone" });
    // A compare attempt cannot be pointed at a profile of another harness.
    const wrong = previewPlacement({ task: task(), profiles: pool, environments: envs, pins: [], mode: "auto", chosen: { "ws-claude": "pb" } });
    expect(wrong.byWorkstream["ws-claude"]?.kind).toBe("none");
  });

  test("two workstreams cannot both take a profile's one slot by choice", () => {
    const split = task({ strategy: "split", workstreams: [ws("api"), ws("ui")] });
    const result = previewPlacement({ task: split, profiles: pool, environments: envs, pins: [], mode: "auto", chosen: { api: "pa", ui: "pa" } });
    expect(result.byWorkstream.api).toEqual({ kind: "placed", profileId: "pa" });
    expect(result.byWorkstream.ui?.kind).toBe("none");
    expect(result.picks).toBeNull();
  });
});

describe("composer controls", () => {
  test("compare picks at most three harnesses and never more than the team's per-task cap", () => {
    expect(compareMax(5)).toBe(3);
    expect(compareMax(2)).toBe(2);
    expect(compareMax(1)).toBe(1);
  });

  test("readiness counts each harness's profiles and the ones free for this project", () => {
    const now = 1_000;
    const counts = harnessReadiness(
      [
        ...pool,
        profile("pd", { cli: "codex", availability: "limited", cooldownUntil: now + 60_000 }),
        profile("pe", { cli: "claude", scopes: ["p-other"] }),
        profile("pf", { cli: "gemini" }),
        profile("pg", { cli: "grok", availability: "limited", cooldownUntil: now + 60_000 }),
      ],
      envs,
      "p-1",
      now,
    );
    expect(counts).toEqual({
      claude: { total: 2, ready: 1 },
      codex: { total: 3, ready: 2 },
      opencode: { total: 0, ready: 0 },
      cursor: { total: 0, ready: 0 },
      gemini: { total: 1, ready: 1 },
      grok: { total: 1, ready: 0 },
    });
  });
});

describe("flow and status", () => {
  test("a compare task has no re-plan and no fewer-agents start; choosing counts as started", () => {
    expect(canReplan(task())).toBe(false);
    expect(fewerAgents(task())).toBeNull();
    expect(canReplan(task({ strategy: "split" }))).toBe(true);
    expect(canReplan(task({ strategy: undefined }))).toBe(true);
    expect(flowPhase("tk-1", task({ status: "choosing" })).kind).toBe("started");
  });

  test("choosing is a Needs you row that says to pick an attempt", () => {
    const view: TaskView = { ...task({ status: "choosing" }), workstreams: [] };
    expect(taskRowStatus(view)).toBe("choosing");
    expect(rowStatus(view, 0, false)).toEqual({ kind: "choosing", label: "Pick an attempt", since: null });
    const workforce = { tasks: { [view.id]: view }, profiles: {}, leases: {} } as unknown as WorkforceView;
    expect(selectInbox(workforce)["needs-you"].map((t) => t.id)).toEqual([view.id]);
  });
});

describe("PlanCard for compare and split choices", () => {
  const placement = (t: TaskDetail, chosen: Record<string, string> = {}) =>
    previewPlacement({ task: t, profiles: pool, environments: envs, pins: [], mode: "auto", chosen });
  const render = (t: TaskDetail, chosen: Record<string, string> = {}, onChoose?: (id: string, p: string | null) => void) =>
    renderToStaticMarkup(
      <PlanCard
        task={t}
        placement={placement(t, chosen)}
        profiles={Object.fromEntries(pool.map((p) => [p.id, p]))}
        environments={envs}
        members={members}
        chosen={chosen}
        onChoose={onChoose}
      />,
    );

  test("compare: header counts attempts, rows name their harness, never a role chip", () => {
    const html = render(task());
    expect(html).toContain("Compare · 2 attempts");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(html).not.toContain("Plan · ");
  });

  test("with choices on, a starting workstream shows Auto or the chosen profile, and its menu trigger", () => {
    const split = task({ strategy: "split", plan: { source: "cli", profileId: "pa", rationale: "Split.", warnings: [] }, workstreams: [ws("api"), ws("ui", { dependsOn: ["api"] })] });
    const auto = render(split, {}, () => {});
    expect(auto).toContain("Auto · ");
    expect(auto).toContain("Worker for Build api");
    // A dependent workstream still waits; it is placed by the scheduler later.
    expect(auto).toContain("After api");
    const chosen = render(split, { api: "pb" }, () => {});
    expect(chosen).toContain("Profile pb");
    expect(chosen).not.toContain("Auto · ");
  });

  test("text from the plan is rendered as text", () => {
    const html = render(task({ title: "<img src=x onerror=alert(1)>", workstreams: [attempt("claude", { title: "<script>x</script>" }), attempt("codex")] }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("attempts bar", () => {
  const lease = (id: string, profileId: string, state: LeaseView["state"] = "running"): LeaseView => ({
    id,
    taskId: "tk-1",
    workstreamId: "x",
    profileId,
    epoch: 1,
    agentName: `w-abc-${id}`,
    nodeName: "n-1",
    state,
    createdAt: 500,
  });
  const workforce = {
    tasks: {},
    profiles: Object.fromEntries(pool.map((p) => [p.id, p])),
    leases: { "ls-1": lease("ls-1", "pa", "released"), "ls-2": lease("ls-2", "pb") },
  } as unknown as WorkforceView;
  const view = (over: Partial<TaskView> = {}): TaskView => ({
    ...task({ status: "running" }),
    workstreams: [
      { id: "ws-claude", branch: "morrow/abc/claude", status: "done", leaseId: "ls-1", harness: "claude" },
      { id: "ws-codex", branch: "morrow/abc/codex", status: "active", leaseId: "ls-2", harness: "codex" },
      { id: "ws-resolver", branch: "morrow/abc/integration", status: "pending", leaseId: null },
    ],
    ...over,
  });
  const detail = task({
    workstreams: [
      attempt("claude", { status: "done", lastCheckpoint: { sha: "abcdef1", summary: "  Found <b>three</b> bugs  ", epoch: 1, at: 900 } }),
      attempt("codex", { status: "active" }),
    ],
  });

  test("cards: one per attempt, owner from the live lease, summary only once finished, never the resolver", () => {
    const cards = attemptCards(view(), detail, workforce, members);
    expect(cards).toEqual([
      { workstreamId: "ws-claude", cli: "claude", branch: "morrow/abc/claude", status: "done", owner: "ada's machine", since: null, summary: "Found <b>three</b> bugs", picked: false },
      { workstreamId: "ws-codex", cli: "codex", branch: "morrow/abc/codex", status: "active", owner: "linus's machine", since: 500, summary: null, picked: false },
    ]);
    expect(attemptCards(view({ pickedWorkstreamId: "ws-claude" }), null, workforce, members)[0]).toMatchObject({ picked: true, summary: null });
  });

  const bar = (t: TaskView, canPick: boolean) =>
    renderToStaticMarkup(<AttemptsBar teamId="t-1" task={t} detail={detail} workforce={workforce} members={members} canPick={canPick} onViewChanges={() => {}} />);

  test("the creator or an admin can pick a finished attempt; unfinished ones cannot be picked yet", () => {
    const html = bar(view(), true);
    expect(html).toContain("Compare · 2 attempts");
    expect(html).toContain("An attempt is in. Pick it now, or wait for the others.");
    expect(html.match(/Pick this/g)).toHaveLength(2);
    // The Codex attempt's button is disabled; the finished Claude one is not.
    const codexCard = html.slice(html.indexOf('data-attempt="ws-codex"'));
    expect(codexCard.slice(0, codexCard.indexOf("Pick this"))).toContain("disabled");
    expect(html).toContain("Finish without shipping");
    // Agent text stays text.
    expect(html).toContain("Found &lt;b&gt;three&lt;/b&gt; bugs");
  });

  test("others see the attempts but no actions; after a pick it says which one", () => {
    expect(bar(view(), false)).not.toContain("Pick this");
    expect(bar(view(), false)).not.toContain("Finish without shipping");
    const picked = bar(view({ status: "verifying", pickedWorkstreamId: "ws-claude" }), true);
    expect(picked).toContain("Picked");
    expect(picked).not.toContain("Pick this");
    expect(bar(view({ status: "choosing" }), true)).toContain("Every attempt is in. Pick one to ship.");
  });

  test("a split task has no attempts bar", () => {
    expect(bar(view({ strategy: "split", workstreams: [{ id: "api", branch: "b", status: "active", leaseId: null }] }), true)).toBe("");
  });
});
