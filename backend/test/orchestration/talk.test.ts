// Keeping workers talking (activity.ts, architecture 9.8): the talk protocol in briefs, the nudge schedule, test
// results read from a worker's log, and the monitor's nudge loop with a controlled clock and a stub workforce
// (no Terse). The trace-driven thread lines run on a real Terse in comms.test.ts.
import { describe, expect, test } from "bun:test";
import type { GithubClient } from "../../src/integrations/github/client.ts";
import type { Keys } from "../../src/http/context.ts";
import { MAX_TASK_BRIEF_BYTES } from "../../src/integrations/relay/index.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import type { EnvironmentView, ProfileView } from "@morrow/contracts";
import { afterNudge, nextNudge, NUDGES_PER_LEASE, nudgesDue, parseTestSummary } from "../../src/orchestration/activity.ts";
import { addPartners, crewTarget, fallbackPlan, PARTNER_ROLES } from "../../src/orchestration/planner/shape.ts";
import { choosePicks, freeSlots, taskCliUse } from "../../src/orchestration/scoring.ts";
import { fullBrief, handoffSpawnText, relayTool, spawnBrief, utf8Bytes, type BriefInput } from "../../src/orchestration/brief.ts";
import { nudgeText } from "../../src/orchestration/comms.ts";
import { createOrchestration, type Orchestration } from "../../src/orchestration/index.ts";
import { Memory } from "../../src/orchestration/memory.ts";
import { waitingOnPerson } from "../../src/orchestration/monitor.ts";
import type { WorkforceApi } from "../../src/orchestration/workforce.ts";
import { RuntimeBus } from "../../src/runtime/bus.ts";
import { testEnv } from "../support/env.ts";
import { ENVS, FakeGit, FakeRelay, FakeRuntime, FakeVm, message, teamGateway } from "./fakes.ts";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

// ---------- the talk protocol in briefs ----------

describe("briefs: talk protocol", () => {
  const input = (over: Partial<BriefInput> = {}): BriefInput => ({
    task: { title: "Team settings", prompt: "Add a team settings page.", acceptance: [] },
    workstream: { id: "ws-web", role: "web", title: "Web", brief: "Build the page.", branch: "morrow/abc/web", ownership: ["web/**"] },
    leaseId: "ls-9",
    channel: "proj-abc",
    others: [{ role: "api", title: "API", branch: "morrow/abc/api", ownership: ["src/api/**"], status: "active", agent: "w-api-e1", cli: "codex", machine: "linus" }],
    testCommand: "bun test",
    creator: "h-ada",
    humans: ["h-ada"],
    threadId: "m-root",
    self: { agent: "w-web-e1", cli: "claude", machine: "ada" },
    ...over,
  });

  test("says when a worker must post, how, and to ask before touching a peer's area", () => {
    const brief = fullBrief(input());
    for (const text of [
      "- Talk protocol (required: peers and people know only what you post). Post in the task thread (the replies to message m-root in #proj-abc) with mcp__agent-relay__reply_to_thread (message_id m-root), 1 to 3 lines each time:",
      "  - when you start: your plan in 2 or 3 lines and the files or areas you will touch",
      "  - when you claim a piece of the work, and when you finish one",
      "  - when you change something a peer uses: post a new CONTRACT (below) and say what changed",
      "  - test results: what you ran, how many passed and failed, what failed",
      "  - when you are blocked: what you need and from whom (@<name>)",
      "  - right before DONE, or before you stop: what you finished and what is left for your peers",
      "- Address a peer with @<its agent name>. Reply to a peer within a minute, stay in the conversation and react to what they say. Answer every question that @mentions you, in the thread, before you go on.",
      "- Before you change a file or area a peer claimed, ask that peer first with @<its agent name> and wait for its answer.",
      "- If @dispatcher says your peers have not heard from you, or that a peer is waiting on your answer, reply right away.",
      // Who runs which harness.
      "This is you: w-web-e1, Claude Code on ada's machine.",
      "Worker w-api-e1 (Codex on linus's machine), active.",
      // First actions, help-seeking, Slack tone with the real peer name.
      "- First actions, in your first 2 minutes: read the thread; post your plan in 2 or 3 lines and @mention each peer with how you will work together; if you are a review or research partner, greet the builder and ask it one concrete question about its approach; answer every question addressed to you.",
      "- Ask your peers for help. They run other coding CLIs and catch what you miss. Ask for: a second opinion before a non-trivial design choice, a review of your diff before DONE (post the changed files and the key hunks, or the commit), a quick lookup you would otherwise do yourself, or help when you are stuck.",
      "- Write like teammates in Slack: short and casual, one thought per message, back-and-forth in the thread. No headings, no essays, no code over 5 lines in chat",
      '"@w-api-e1 quick q: PATCH returns 404 or 403 for non-members?" / "404, same as every team route 👍"',
      "Read it with mcp__agent-relay__get_message_thread (message_id m-root) when you start",
      "add a reaction (mcp__agent-relay__add_reaction)",
    ])
      expect(brief).toContain(text);
    // Without a known peer the examples use a placeholder.
    expect(fullBrief(input({ others: [] }))).toContain('"@<peer> quick q: PATCH returns 404');
    // Claude Code's names are exact, so no hint about finding them.
    expect(brief).not.toContain("in your tool list their names end in");
    expect(brief).not.toContain("—");
  });

  test("names each CLI's Relay tools: exact for Claude Code and opencode, the bare name and a hint for the rest", () => {
    expect(relayTool("claude", "reply_to_thread")).toBe("mcp__agent-relay__reply_to_thread");
    expect(relayTool("opencode", "post_message")).toBe("agent-relay_post_message");
    for (const cli of ["codex", "cursor", "gemini", "grok", null, undefined]) expect(relayTool(cli, "add_reaction")).toBe("add_reaction");
    const opencode = fullBrief(input({ self: { agent: "w-web-e1", cli: "opencode", machine: null } }));
    expect(opencode).toContain("with agent-relay_reply_to_thread (message_id m-root)");
    const codex = fullBrief(input({ self: { agent: "w-web-e1", cli: "codex", machine: null } }));
    expect(codex).toContain("with reply_to_thread (message_id m-root), 1 to 3 lines each time: These are tools of the agent-relay MCP server");
    // An explicit `cli` wins over `self` (the handoff path has no `self`).
    expect(fullBrief(input({ cli: "opencode" }))).toContain("agent-relay_get_message_thread");
    // Without a thread, the channel and post_message.
    expect(fullBrief(input({ threadId: null }))).toContain("Post in #proj-abc with mcp__agent-relay__post_message (channel proj-abc)");
  });

  test("compare attempts post progress but never coordinate; the protocol survives the short spawn text", () => {
    const compare = fullBrief(input({ strategy: "compare" }));
    expect(compare).toContain("  - when you start: your approach in 2 or 3 lines");
    expect(compare).toContain("  - test results: what you ran, how many passed and failed, what failed");
    expect(compare).not.toContain("ask that peer first");
    expect(compare).not.toContain("CONTRACT");
    const big = spawnBrief(input({ task: { title: "T", prompt: "x".repeat(20_000), acceptance: [] } }));
    expect(big.note).not.toBeNull();
    expect(utf8Bytes(big.text)).toBeLessThanOrEqual(MAX_TASK_BRIEF_BYTES);
    expect(big.text).toContain("- Talk protocol (required");
  });

  test("a replacement is told to announce itself in the thread after its ACK", () => {
    const text = handoffSpawnText({ ...input(), cli: "claude", taskTitle: "Team settings" });
    expect(text).toContain("Then call mcp__agent-relay__get_message_thread (message_id m-root) to read the task thread");
    expect(text).toContain("Then tell your peers you took over, with mcp__agent-relay__reply_to_thread (message_id m-root): one line on where the work stands and what you do next.");
    expect(text).toContain("- Talk protocol (required");
    expect(text.indexOf("ACK ls-9")).toBeLessThan(text.indexOf("Then tell your peers you took over"));
  });
});

// ---------- nudge schedule, test summaries, nudge text ----------

describe("nudge schedule", () => {
  test("90 s, then 3 more minutes, then every 6, at most five", () => {
    const s = 1_000;
    expect([0, 89_999, 90_000, 269_999, 270_000, 629_999, 630_000, 990_000, 1_350_000, 1_000 * 60 * 60 * 24].map(nudgesDue)).toEqual([0, 0, 1, 1, 2, 2, 3, 4, 5, 5]);
    expect(nudgesDue(Number.NaN)).toBe(0);
    expect(nudgesDue(-5 * s)).toBe(0);
    expect(NUDGES_PER_LEASE).toBe(5);
  });

  test("one nudge per step of a quiet stretch; a post starts over; the lease cap holds across stretches", () => {
    expect(nextNudge(null, 0, 60_000)).toBeNull();
    const first = nextNudge(null, 0, 100_000)!;
    expect(first).toEqual({ index: 1, quietMs: 100_000 });
    let state = afterNudge(null, 0, first.index);
    expect(nextNudge(state, 0, 200_000)).toBeNull();
    expect(nextNudge(state, 0, 280_000)).toEqual({ index: 2, quietMs: 280_000 });
    // Down for a while: only the newest due nudge goes out, not every missed one.
    expect(nextNudge(state, 0, 1_000_000)).toEqual({ index: 4, quietMs: 1_000_000 });
    // The worker posted at 300 s: a new stretch, nothing until 90 s after it.
    expect(nextNudge(state, 300_000, 380_000)).toBeNull();
    expect(nextNudge(state, 300_000, 390_000)!.index).toBe(1);
    for (let i = 0; i < NUDGES_PER_LEASE; i++) state = afterNudge(state, i * 1_000_000, 1);
    expect(nextNudge(state, 99_000_000, 99_000_000 + 600_000)).toBeNull();
  });
});

describe("test results from a worker's log", () => {
  test("bun, jest, vitest, pytest and cargo summaries; escapes and UI glyphs do not matter", () => {
    const bun = "\u001b[32m(pass) a > b\u001b[0m\n\n 12 pass\n 1 fail\n 30 expect() calls\nRan 13 tests across 3 files. [1.20s]\n";
    expect(parseTestSummary(bun)).toMatchObject({ runner: "bun", passed: 12, failed: 1 });
    expect(parseTestSummary("⎿ 7 pass\n⎿ 0 fail\n⎿ Ran 7 tests across 1 file. [5ms]")).toMatchObject({ runner: "bun", passed: 7, failed: 0 });
    expect(parseTestSummary("Tests:       1 failed, 12 passed, 13 total\nTime: 2s")).toMatchObject({ runner: "jest", passed: 12, failed: 1 });
    expect(parseTestSummary("      Tests  2 failed | 11 passed (13)\n   Start at 10:00")).toMatchObject({ runner: "vitest", passed: 11, failed: 2 });
    expect(parseTestSummary("Tests  11 passed (11)")).toMatchObject({ runner: "vitest", passed: 11, failed: 0 });
    expect(parseTestSummary("===== 2 failed, 10 passed, 1 warning in 1.23s =====")).toMatchObject({ runner: "pytest", passed: 10, failed: 2 });
    expect(parseTestSummary("============ 1 error in 0.10s ============")).toBeNull();
    expect(parseTestSummary("============ 4 passed, 1 error in 0.10s ============")).toMatchObject({ runner: "pytest", passed: 4, failed: 1 });
    expect(parseTestSummary("test result: FAILED. 8 passed; 2 failed; 0 ignored; 0 measured")).toMatchObject({ runner: "cargo", passed: 8, failed: 2 });
  });

  test("the newest summary wins; prose and partial lines are not results", () => {
    const two = "Tests: 3 failed, 9 passed, 12 total\n...\nTests: 12 passed, 12 total\n";
    expect(parseTestSummary(two)).toMatchObject({ passed: 12, failed: 0 });
    for (const prose of ["I ran the tests and 12 pass now", "Ran 13 tests across 3 files.", "We expect Tests: to show 3 passed", "", "test result: ok"])
      expect(parseTestSummary(prose)).toBeNull();
  });
});

describe("nudge text", () => {
  test("names the worker, the quiet time and the exact call; names only peers that wait on it", () => {
    const text = nudgeText({
      agent: "w-web-e1",
      quietMs: 95_000,
      where: "in the task thread with mcp__agent-relay__reply_to_thread (message_id m-root)",
      waitingOn: ["w-api-e1", "w-api-e1", "w-web-e1", "evil person", "dispatcher", "h-ada"],
    });
    expect(text).toBe(
      "@w-web-e1 Your peers have not heard from you in 2 min. Post a one-line update in the task thread with mcp__agent-relay__reply_to_thread (message_id m-root): what you are doing and what you need. w-api-e1, h-ada asked you something there and are waiting on your answer.",
    );
    expect(nudgeText({ agent: "w-a-e1", quietMs: 10, where: "x", waitingOn: [] })).toBe("@w-a-e1 Your peers have not heard from you in 1 min. Post a one-line update x: what you are doing and what you need.");
  });

  test("waiting on a person: the worker's newest post asked an h- name who has not posted since", () => {
    const memory = new Memory().team("t");
    memory.noteTalk({ id: "m1", from: "w-a-e1", to: ["h-ada"], text: "@h-ada which color?", at: 100, threadId: null });
    memory.notePost("w-a-e1", 100);
    expect(waitingOnPerson(memory, "w-a-e1", 100)).toBe(true);
    memory.notePost("h-ada", 150);
    expect(waitingOnPerson(memory, "w-a-e1", 100)).toBe(false);
    // A later post that asks no one ends the wait; so does asking only a peer.
    memory.noteTalk({ id: "m2", from: "w-a-e1", to: ["h-linus"], text: "@h-linus ok?", at: 200, threadId: null });
    expect(waitingOnPerson(memory, "w-a-e1", 300)).toBe(false);
    memory.noteTalk({ id: "m3", from: "w-a-e1", to: ["w-b-e1"], text: "@w-b-e1 ?", at: 400, threadId: null });
    expect(waitingOnPerson(memory, "w-a-e1", 400)).toBe(false);
    expect(waitingOnPerson(memory, "w-a-e1", undefined)).toBe(false);
  });
});

// ---------- the monitor's nudge loop ----------

const TEAM = "t-talk00001";
const NOW = 1_900_000_000_000;
const THREAD = "m-root-talk";
const API = "w-abc12345-api-e1";
const WEB = "w-abc12345-web-e1";

interface Setup {
  orch: Orchestration;
  relay: FakeRelay;
  vm: FakeVm;
  clock: { offset: number; now: () => number };
  leases: Record<string, Record<string, unknown>>;
  /** Log tails by agent: the text and when it last changed (null: the worker is idle). */
  logs: Map<string, { text: string; changedAgo: number | null }>;
  make(): Orchestration;
}

function setup(opts: { peers?: boolean; threadId?: string | null } = {}): Setup {
  const env = ENVS[0]!;
  const lease = (id: string, agent: string, ws: string, extra: object = {}) => ({
    id,
    taskId: "k-1",
    workstreamId: ws,
    profileId: "cp-a",
    epoch: 1,
    agentName: agent,
    nodeName: env.nodeName!,
    state: "running",
    spawnInvocationId: `inv-${id}`,
    parentLeaseId: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    expiresAt: null,
    ...extra,
  });
  const leases: Record<string, Record<string, unknown>> = { "ls-api": lease("ls-api", API, "ws-api") };
  if (opts.peers !== false) leases["ls-web"] = lease("ls-web", WEB, "ws-web");
  const threadId = opts.threadId === undefined ? THREAD : opts.threadId;
  const task = { id: "k-1", projectId: "p-proj0000demo", threadId, title: "T", workstreams: [], trace: [] };
  const stub: Partial<WorkforceApi> = {
    getView: (async () => ({ profiles: {}, tasks: {}, leases })) as unknown as WorkforceApi["getView"],
    getLease: (async (_t: string, id: string) => leases[id] ?? null) as unknown as WorkforceApi["getLease"],
    getProfile: (async () => ({ id: "cp-a", envId: env.id, cli: "claude", ownerUserId: env.ownerUserId })) as unknown as WorkforceApi["getProfile"],
    getTask: (async (_t: string, id: string) => ({ ...task, id })) as unknown as WorkforceApi["getTask"],
  };
  const wf = new Proxy(stub, {
    get(target, key) {
      if (typeof key === "string" && !(key in target)) return async () => Promise.reject(new Error(`unexpected workforce call: ${key}`));
      return target[key as keyof typeof target];
    },
  }) as WorkforceApi;
  const shas = new Set<string>();
  const relay = new FakeRelay();
  for (const l of Object.values(leases)) relay.agents.set(l.agentName as string, { invocationId: l.spawnInvocationId as string, node: env.nodeName!, task: "", cwd: "/" });
  relay.keep({ ...message("dispatcher", "Task thread"), id: THREAD });
  const vm = new FakeVm(shas);
  const clock = { offset: 0, now: () => NOW + clock.offset };
  const logs = new Map<string, { text: string; changedAgo: number | null }>();
  vm.readLogTail = async (input: { agentName: string }) => {
    const log = logs.get(input.agentName) ?? { text: "working\n", changedAgo: 1_000 };
    const modifiedAt = new Date(log.changedAgo === null ? NOW - 3_600_000 : clock.now() - log.changedAgo).toISOString();
    return { text: log.text, truncated: false, size: log.text.length, modifiedAt };
  };
  const runtime = new FakeRuntime();
  const make = () =>
    createOrchestration({
      deps: { env: testEnv(), log: silentLogger, actors: teamGateway(), github: {} as GithubClient, keys: {} as Keys, now: clock.now },
      runtime,
      bus: new RuntimeBus(silentLogger),
      options: { ports: { vm, relay, git: new FakeGit(shas), githubToken: async () => "gho_test" }, workforce: wf, tickMs: 0, listTeams: async () => [] },
    });
  return { orch: make(), relay, vm, clock, leases, logs, make };
}

const nudges = (s: Setup, agent?: string) => s.relay.posts.filter((p) => p.notice?.kind === "nudge" && (!agent || p.to === agent));
const lines = (s: Setup) => s.relay.posts.filter((p) => p.notice?.kind === "activity");

/** One watch pass at `seconds` after NOW. Passes run at least 20 s apart (the log poll). */
async function at(s: Setup, seconds: number, orch: Orchestration = s.orch): Promise<void> {
  s.clock.offset = seconds * 1_000;
  await orch.monitor.watch(TEAM);
}

function post(s: Setup, from: string, text: string, seconds: number, orch: Orchestration = s.orch) {
  const m = s.relay.keep({ ...message(from, text), threadId: THREAD, parentId: THREAD, createdAt: NOW + seconds * 1_000 });
  orch.monitor.handle({ kind: "message", teamId: TEAM, message: m, seq: null });
  return m;
}

describe("monitor: nudging quiet workers", () => {
  test("a working worker quiet for 90 s gets one DM from the dispatcher, then 3 min later another; a post starts over", async () => {
    const s = setup();
    s.logs.set(WEB, { text: "idle\n", changedAgo: null });
    await at(s, 0);
    await at(s, 60);
    expect(nudges(s)).toEqual([]);
    await at(s, 95);
    const [first] = nudges(s);
    expect(nudges(s)).toHaveLength(1);
    expect(first!.to).toBe(API);
    expect(first!.speaker.kind).toBe("system");
    expect(first!.notice).toEqual({ kind: "nudge", taskId: "k-1", to: [API] });
    expect(first!.key).toMatch(/^ndg-[0-9a-f]{24}$/);
    expect(first!.text).toBe(
      `@${API} Your peers have not heard from you in 2 min. Post a one-line update in the task thread with mcp__agent-relay__reply_to_thread (message_id ${THREAD}): what you are doing and what you need.`,
    );
    // The idle peer is never nudged: it is not working.
    expect(nudges(s, WEB)).toEqual([]);
    await at(s, 120);
    await at(s, 250);
    expect(nudges(s)).toHaveLength(1);
    await at(s, 275);
    expect(nudges(s)).toHaveLength(2);
    expect(nudges(s)[1]!.key).not.toBe(first!.key);

    // It posts: nothing until 90 s after that post.
    post(s, API, "Working on the members endpoint, 2 files left.", 300);
    await at(s, 320);
    await at(s, 370);
    expect(nudges(s)).toHaveLength(2);
    await at(s, 395);
    expect(nudges(s)).toHaveLength(3);
  });

  test("a peer's question unanswered for a minute gets one reminder, working or idle; a DM is not an answer", async () => {
    const s = setup();
    s.logs.set(API, { text: "idle\n", changedAgo: null });
    s.logs.set(WEB, { text: "idle\n", changedAgo: null });
    const asked = post(s, WEB, `@${API} quick q: does GET /members page?`, 10);
    // A direct message to the dispatcher (STATUS) does not count as talking to peers.
    s.orch.monitor.handle({ kind: "message", teamId: TEAM, message: { ...message(API, "STATUS", null), createdAt: NOW + 20_000 }, seq: null });
    await at(s, 50);
    expect(nudges(s)).toEqual([]);
    await at(s, 75);
    expect(nudges(s, API)).toHaveLength(1);
    const [reminder] = nudges(s, API);
    expect(reminder!.text).toBe(
      `@${API} ${WEB} asked you something 1 min ago and is waiting on your answer. Reply in the task thread with mcp__agent-relay__reply_to_thread (message_id ${THREAD}): a short answer, or when you will know.`,
    );
    expect(reminder!.key).toMatch(/^ndq-[0-9a-f]{24}$/);
    expect(reminder!.text).not.toContain("does GET");
    await at(s, 100);
    await at(s, 200);
    expect(nudges(s, API)).toHaveLength(1);
    // A restart re-derives the same key for the same question.
    const after = s.make();
    after.monitor.handle({ kind: "message", teamId: TEAM, message: asked, seq: null });
    await at(s, 230, after);
    expect(nudges(s, API).map((n) => n.key)).toEqual([reminder!.key, reminder!.key]);
    // Answered: no reminder for the next question until a minute passes.
    post(s, API, `@${WEB} yes, 50 a page`, 240, after);
    post(s, WEB, `@${API} thanks, and sorted by login?`, 250, after);
    await at(s, 280, after);
    expect(nudges(s, API)).toHaveLength(2);
    await at(s, 311, after);
    expect(nudges(s, API)).toHaveLength(3);
  });

  test("the quiet nudge names peers waiting on the worker", async () => {
    const s = setup();
    s.logs.set(WEB, { text: "idle\n", changedAgo: null });
    post(s, WEB, `@${API} ping`, 50);
    await at(s, 95);
    expect(nudges(s, API)).toHaveLength(1);
    expect(nudges(s, API)[0]!.text).toEndWith(`${WEB} asked you something there and is waiting on your answer.`);
  });

  test("never while waiting on a person, never without peers, never for a subagent or an idle worker", async () => {
    const waiting = setup();
    post(waiting, API, "@h-owner should members be paginated?", 0);
    for (const t of [95, 300, 700]) await at(waiting, t);
    expect(nudges(waiting, API)).toEqual([]);
    // The person answers: the stretch since the worker's question counts again.
    post(waiting, "h-owner", "yes, 50 a page", 710);
    await at(waiting, 730);
    expect(nudges(waiting, API)).toHaveLength(1);

    const alone = setup({ peers: false });
    for (const t of [95, 300, 700]) await at(alone, t);
    expect(nudges(alone)).toEqual([]);

    const sub = setup();
    sub.leases["ls-api"]!.parentLeaseId = "ls-web";
    sub.logs.set(WEB, { text: "idle\n", changedAgo: null });
    for (const t of [95, 300]) await at(sub, t);
    expect(nudges(sub)).toEqual([]);

    const idle = setup();
    idle.logs.set(API, { text: "idle\n", changedAgo: null });
    idle.logs.set(WEB, { text: "idle\n", changedAgo: null });
    for (const t of [95, 300]) await at(idle, t);
    expect(nudges(idle)).toEqual([]);
  });

  test("at most five nudges per lease", async () => {
    const s = setup();
    s.logs.set(WEB, { text: "idle\n", changedAgo: null });
    for (let t = 0; t <= 4 * 3600; t += 30) await at(s, t);
    expect(nudges(s, API)).toHaveLength(NUDGES_PER_LEASE);
  });

  test("a restarted backend that sees the same silence sends the same Relay message, not a second one", async () => {
    const s = setup();
    s.logs.set(WEB, { text: "idle\n", changedAgo: null });
    post(s, API, "Plan: endpoints in src/api/members.ts.", 5);
    await at(s, 100);
    expect(nudges(s)).toHaveLength(1);
    const before = nudges(s)[0]!;

    // A new process: empty memory. It reads the thread to learn when the worker last posted.
    const after = s.make();
    await at(s, 101, after);
    const again = nudges(s);
    expect(again).toHaveLength(2);
    expect(again[1]!.key).toBe(before.key);
    expect(again[1]!.text).toBe(before.text);
    // And it does not repeat it.
    await at(s, 125, after);
    expect(nudges(s)).toHaveLength(2);
  });

  test("an unreadable thread after a restart holds the nudge instead of guessing", async () => {
    const s = setup();
    s.logs.set(WEB, { text: "idle\n", changedAgo: null });
    s.relay.threadFails = true;
    await at(s, 100);
    expect(nudges(s)).toEqual([]);
    s.relay.threadFails = false;
    await at(s, 125);
    expect(nudges(s)).toHaveLength(1);
  });

  test("a replacement (a new epoch) gets its own nudges; the old lease's keys never repeat", async () => {
    const s = setup();
    s.logs.set(WEB, { text: "idle\n", changedAgo: null });
    await at(s, 95);
    const old = nudges(s)[0]!.key;
    Object.assign(s.leases["ls-api"]!, { epoch: 2, updatedAt: NOW });
    const fresh = s.make();
    await at(s, 96, fresh);
    expect(nudges(s)).toHaveLength(2);
    expect(nudges(s)[1]!.key).not.toBe(old);
  });

  test("without a task thread the nudge points at the channel", async () => {
    const s = setup({ threadId: null });
    s.logs.set(WEB, { text: "idle\n", changedAgo: null });
    await at(s, 95);
    expect(nudges(s, API)[0]!.text).toContain("Post a one-line update in #proj-proj0000demo with mcp__agent-relay__post_message (channel proj-proj0000demo)");
  });
});

describe("monitor: test results go to the task thread", () => {
  test("a new summary in a worker's log is posted once, as counts only; a restart maps to the same Relay key", async () => {
    const s = setup();
    s.logs.set(API, { text: `npm test\nsecret ${TOKEN}\n 12 pass\n 1 fail\nRan 13 tests across 3 files. [1.2s]\n`, changedAgo: 1_000 });
    await at(s, 0);
    expect(lines(s)).toHaveLength(1);
    const [line] = lines(s);
    expect(line!.to).toBe(`thread:${THREAD}`);
    expect(line!.speaker.kind).toBe("system");
    expect(line!.notice).toEqual({ kind: "activity", taskId: "k-1", to: [] });
    expect(line!.text).toBe(`${API} ran the tests (bun): 12 passed, 1 failed.`);
    expect(line!.key).toMatch(/^ts-[0-9a-f]{24}$/);
    expect(line!.text).not.toContain(TOKEN);
    await at(s, 25);
    expect(lines(s)).toHaveLength(1);

    s.logs.set(API, { text: " 13 pass\n 0 fail\nRan 13 tests across 3 files. [1.1s]\n", changedAgo: 1_000 });
    await at(s, 50);
    expect(lines(s).map((l) => l.text)).toEqual([`${API} ran the tests (bun): 12 passed, 1 failed.`, `${API} ran the tests (bun): 13 passed, 0 failed.`]);

    const after = s.make();
    await at(s, 75, after);
    expect(lines(s)).toHaveLength(3);
    expect(lines(s)[2]!.key).toBe(lines(s)[1]!.key);
  });

  test("not for a worker without peers, and rate limited per task", async () => {
    const alone = setup({ peers: false });
    alone.logs.set(API, { text: "Tests: 3 passed, 3 total\n", changedAgo: 1_000 });
    await at(alone, 0);
    expect(lines(alone)).toEqual([]);

    // Eight at once per task, then one every 30 s.
    const s = setup();
    const sent: boolean[] = [];
    for (let i = 0; i < 10; i++) sent.push(await s.orch.comms.activity(TEAM, "k-1", `line ${i}`, `k-${i}`));
    expect(sent).toEqual([true, true, true, true, true, true, true, true, false, false]);
    s.clock.offset = 31_000;
    expect(await s.orch.comms.activity(TEAM, "k-1", "later", "k-later")).toBe(true);
    expect(await s.orch.comms.activity(TEAM, "k-other", "another task", "k-o")).toBe(true);
  });
});

// ---------- crews: every task gets peers, on different harnesses when there are some ----------

describe("crew sizing and partners", () => {
  test("3 workers when 3+ slots are free, 2 when 2, else 1; never above the plan's ceiling", () => {
    expect([0, 1, 2, 3, 8].map((free) => crewTarget(free, 5))).toEqual([1, 1, 2, 3, 3]);
    expect(crewTarget(8, 2)).toBe(2);
    // "Start with fewer agents: 1" wins.
    expect(crewTarget(8, 1)).toBe(1);
  });

  test("a one-workstream plan (\"Improve the SEO\") gets a review partner, then a research partner, with real work", () => {
    const task = { id: "tk-0123456789abcdef", title: "Improve the SEO", prompt: "Improve the SEO", acceptance: [] };
    const plan = fallbackPlan(task, "no planner");
    const three = addPartners(plan, task.id, 3);
    expect(three.workstreams.map((w) => w.role)).toEqual(["dev", "review", "research"]);
    for (const ws of three.workstreams.slice(1)) {
      expect(ws.dependsOn).toEqual([]);
      expect(ws.branch).toBe(`morrow/0123456789ab/${ws.role}`.replace("0123456789ab", ws.branch.split("/")[1]!));
      expect(ws.ownership).toEqual([`.morrow/${ws.role}/**`]);
      expect(ws.brief).toContain("the dev worker");
      expect(ws.brief).toContain("post DONE");
    }
    expect(three.workstreams[1]!.brief).toContain("ask them for the changed files and the key hunks");
    expect(three.workstreams[2]!.brief).toContain("check their work against the acceptance criteria");
    expect(three.rationale).toContain("Added review and research partners");
    expect(addPartners(plan, task.id, 2).workstreams.map((w) => w.role)).toEqual(["dev", "review"]);
    // Nothing to add: one worker wanted, or the planner already split the work.
    expect(addPartners(plan, task.id, 1)).toBe(plan);
    const split = { ...plan, workstreams: [plan.workstreams[0]!, { ...plan.workstreams[0]!, id: "ws-web", role: "web" }] };
    expect(addPartners(split, task.id, 3)).toBe(split);
    expect(PARTNER_ROLES).toEqual(["review", "research"]);
    expect(JSON.stringify(three)).not.toContain("—");
  });
});

describe("placement spreads a task across harnesses", () => {
  const profile = (id: string, cli: ProfileView["cli"], over: Partial<ProfileView> = {}): ProfileView => ({
    id,
    envId: "e-a",
    ownerUserId: "u-1",
    cli,
    label: id,
    auth: "ok",
    availability: "ready",
    cooldownUntil: null,
    limitedReason: null,
    limitedSource: null,
    maxConcurrent: 4,
    activeLeases: 0,
    scopes: "all",
    lastSeenAt: null,
    ...over,
  });
  const env = (id: string): EnvironmentView => ({ id, ownerUserId: "u-1", name: id, linuxUser: "u1", nodeName: `n-${id}`, phase: "ready", vmState: "running", nodeOnline: true, lastError: null, createdAt: 0 });
  const envs = new Map([["e-a", env("e-a")], ["e-b", env("e-b")]]);
  const cliOf = (picks: { profileId: string }[] | null, profiles: ProfileView[]) => picks!.map((p) => profiles.find((x) => x.id === p.profileId)!.cli);

  test("Claude Code 4 free + Codex 4 free: three workers over both harnesses, not three of one", () => {
    const profiles = [profile("cc", "claude"), profile("cx", "codex", { envId: "e-b" })];
    expect(freeSlots(profiles, envs, "p-1")).toBe(8);
    const picks = choosePicks(["ws-dev", "ws-review", "ws-research"], profiles, envs, "p-1");
    expect(new Set(cliOf(picks, profiles))).toEqual(new Set(["claude", "codex"]));
    // Even when one harness has more free slots and sits on the same machine.
    const lopsided = [profile("cc", "claude", { maxConcurrent: 8 }), profile("cx", "codex", { maxConcurrent: 1 })];
    expect(cliOf(choosePicks(["a", "b"], lopsided, envs, "p-1"), lopsided).sort()).toEqual(["claude", "codex"]);
    // Three harnesses: one worker each.
    const three = [...profiles, profile("gm", "gemini")];
    expect(new Set(cliOf(choosePicks(["a", "b", "c"], three, envs, "p-1"), three)).size).toBe(3);
  });

  test("CLIs the task already runs count; one harness still staffs the whole crew; caps hold; pins win", () => {
    const profiles = [profile("cc", "claude"), profile("cx", "codex")];
    expect(cliOf(choosePicks(["late"], profiles, envs, "p-1", { cliUse: new Map([["codex", 1]]) }), profiles)).toEqual(["claude"]);
    const solo = [profile("cc", "claude", { maxConcurrent: 2 })];
    expect(cliOf(choosePicks(["a", "b", "c"], solo, envs, "p-1", {}, { partial: true }), solo)).toEqual(["claude", "claude"]);
    expect(freeSlots([profile("busy", "codex", { activeLeases: 4 }), profile("off", "codex", { availability: "offline" })], envs, "p-1")).toBe(0);
    expect(cliOf(choosePicks(["a", "b"], profiles, envs, "p-1", { pins: ["cc"] }), profiles)).toEqual(["claude", "claude"]);
    const view = {
      profiles: { cc: { cli: "claude" as const }, cx: { cli: "codex" as const } },
      leases: {
        l1: { taskId: "k", state: "running", profileId: "cx" },
        l2: { taskId: "k", state: "released", profileId: "cc" },
        l3: { taskId: "k", state: "running", profileId: "cc", parentLeaseId: "l1" },
        l4: { taskId: "other", state: "running", profileId: "cc" },
      },
    };
    expect(taskCliUse(view, "k")).toEqual(new Map([["codex", 1]]));
  });
});
