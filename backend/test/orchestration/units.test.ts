import { describe, expect, test } from "bun:test";
import type { EnvironmentView, ProfileView, TaskDetail } from "@morrow/contracts";
import { MAX_TASK_BRIEF_BYTES } from "../../src/integrations/relay/index.ts";
import { FreestyleIntegrationError } from "../../src/integrations/freestyle/errors.ts";
import { RelayIntegrationError } from "../../src/integrations/relay/index.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { clipBytes, conflictBrief, conflictFileList, handoffNote, handoffSpawnText, MAX_NOTE_BYTES, spawnBrief, utf8Bytes, type BriefInput } from "../../src/orchestration/brief.ts";
import { normalizeRole } from "../../src/orchestration/planner/shape.ts";
import { resolverPins } from "../../src/orchestration/scheduler.ts";
import { DEFAULT_TIMING, describeFailure, type Ctx } from "../../src/orchestration/context.ts";
import { GithubError } from "../../src/integrations/github/client.ts";
import { AppError } from "../../src/lib/errors.ts";
import { completionKey, Dispatcher, failureResult } from "../../src/orchestration/dispatcher.ts";
import { Lanes } from "../../src/orchestration/lanes.ts";
import { Memory } from "../../src/orchestration/memory.ts";
import type { OutboxClaim, OutboxResult } from "../../src/orchestration/workforce.ts";
import { parseControl } from "../../src/orchestration/monitor.ts";
import { choosePicks, chooseReplacement, eligible, placementPool, plannerCandidates } from "../../src/orchestration/scoring.ts";
import { attemptId, comparePlan, harnessOf, isCompare, shippedWorkstreams, strategyOf } from "../../src/orchestration/compare.ts";
import { CreateTaskBody, PickAttemptBody } from "@morrow/contracts";

const profile = (id: string, over: Partial<ProfileView> = {}): ProfileView => ({
  id,
  envId: "e-a",
  ownerUserId: "u-1",
  cli: "claude",
  label: id,
  auth: "ok",
  availability: "ready",
  cooldownUntil: null,
  limitedReason: null,
  limitedSource: null,
  maxConcurrent: 2,
  activeLeases: 0,
  scopes: "all",
  lastSeenAt: null,
  ...over,
});
const env = (id: string, over: Partial<EnvironmentView> = {}): EnvironmentView => ({
  id,
  ownerUserId: "u-1",
  name: id,
  linuxUser: "u1",
  nodeName: `n-${id}`,
  phase: "ready",
  vmState: "running",
  nodeOnline: true,
  lastError: null,
  createdAt: 0,
  ...over,
});
const envs = new Map([
  ["e-a", env("e-a")],
  ["e-b", env("e-b")],
  ["e-c", env("e-c", { phase: "awaiting_login" })],
]);

describe("scoring", () => {
  test("hard rules: availability, auth, scope, capacity, environment phase", () => {
    expect(eligible(profile("p"), envs.get("e-a"), "p-1")).toBe(true);
    expect(eligible(profile("p", { availability: "limited" }), envs.get("e-a"), "p-1")).toBe(false);
    expect(eligible(profile("p", { availability: "offline" }), envs.get("e-a"), "p-1")).toBe(false);
    expect(eligible(profile("p", { auth: "auth_required" }), envs.get("e-a"), "p-1")).toBe(false);
    expect(eligible(profile("p", { scopes: ["p-2"] }), envs.get("e-a"), "p-1")).toBe(false);
    expect(eligible(profile("p", { activeLeases: 2 }), envs.get("e-a"), "p-1")).toBe(false);
    expect(eligible(profile("p", { activeLeases: 1 }), envs.get("e-a"), "p-1", 1)).toBe(false);
    expect(eligible(profile("p", { envId: "e-c" }), envs.get("e-c"), "p-1")).toBe(false);
    expect(eligible(profile("p"), undefined, "p-1")).toBe(false);
  });

  test("choosePicks spreads a task over machines and respects capacity in the batch", () => {
    const profiles = [profile("pa", { envId: "e-a" }), profile("pb", { envId: "e-b" })];
    const picks = choosePicks(["ws-api", "ws-web"], profiles, envs, "p-1")!;
    expect(new Set(picks.map((p) => p.profileId))).toEqual(new Set(["pa", "pb"]));
    const one = [profile("pa", { maxConcurrent: 1 })];
    expect(choosePicks(["ws-api", "ws-web"], one, envs, "p-1")).toBeNull();
    expect(choosePicks(["ws-api"], [], envs, "p-1")).toBeNull();
  });

  test("pins win", () => {
    const profiles = [profile("pa", { envId: "e-a" }), profile("pb", { envId: "e-b", auth: "unknown" })];
    expect(choosePicks(["ws"], profiles, envs, "p-1", { pins: ["pb"] })).toEqual([{ workstreamId: "ws", profileId: "pb" }]);
  });

  test("manual: the pool is the pins only; auto offers every profile", () => {
    const profiles = [profile("pa"), profile("pb"), profile("pc")];
    expect(placementPool(profiles, { mode: "manual", pins: ["pc", "pa"] }).map((p) => p.id)).toEqual(["pa", "pc"]);
    expect(placementPool(profiles, { mode: "manual", pins: ["gone"] })).toEqual([]);
    expect(placementPool(profiles, { mode: "auto", pins: ["pa"] }).map((p) => p.id)).toEqual(["pa", "pb", "pc"]);
  });

  test("partial picks place what fits and skip the rest; null only when nothing fits", () => {
    const one = [profile("pa", { maxConcurrent: 1 })];
    expect(choosePicks(["ws-api", "ws-web"], one, envs, "p-1", {}, { partial: true })).toEqual([{ workstreamId: "ws-api", profileId: "pa" }]);
    expect(choosePicks(["ws-api"], [], envs, "p-1", {}, { partial: true })).toBeNull();
    expect(choosePicks([], one, envs, "p-1", {}, { partial: true })).toBeNull();
    // Without it, an empty list is still an empty batch, as before.
    expect(choosePicks([], one, envs, "p-1")).toEqual([]);
  });

  test("allowSame: a manual task's only pin takes its worker back once it is eligible again", () => {
    const from = profile("pa", { envId: "e-a" });
    expect(chooseReplacement(from, [from], envs, "p-1", null, true)?.id).toBe("pa");
    expect(chooseReplacement(from, [{ ...from, availability: "limited" }], envs, "p-1", null, true)).toBeNull();
    // Another pin still wins over the same one.
    expect(chooseReplacement(from, [from, profile("pb", { envId: "e-b" })], envs, "p-1", null, true)?.id).toBe("pb");
  });

  test("replacement: never the same profile, same CLI preferred, another machine preferred", () => {
    const from = profile("pa", { envId: "e-a", cli: "claude" });
    const sameEnvSameCli = profile("pa2", { envId: "e-a", cli: "claude" });
    const otherEnvSameCli = profile("pb", { envId: "e-b", cli: "claude" });
    const otherEnvOtherCli = profile("pc", { envId: "e-b", cli: "codex" });
    expect(chooseReplacement(from, [from, sameEnvSameCli, otherEnvSameCli, otherEnvOtherCli], envs, "p-1")?.id).toBe("pb");
    expect(chooseReplacement(from, [from, otherEnvOtherCli], envs, "p-1")?.id).toBe("pc");
    expect(chooseReplacement(from, [from], envs, "p-1")).toBeNull();
    expect(chooseReplacement(undefined, [otherEnvOtherCli], envs, "p-1")?.id).toBe("pc");
  });

  test("a harness-bound workstream only takes a profile of that CLI, for picks and for replacements", () => {
    const claude = profile("pa", { envId: "e-a", cli: "claude" });
    const codex = profile("pb", { envId: "e-b", cli: "codex" });
    const harnessOf = new Map([["ws-codex", "codex" as const]]);
    expect(choosePicks(["ws-codex"], [claude, codex], envs, "p-1", { harnessOf })).toEqual([{ workstreamId: "ws-codex", profileId: "pb" }]);
    expect(choosePicks(["ws-codex"], [claude], envs, "p-1", { harnessOf })).toBeNull();
    // Unbound workstreams in the same batch still take any CLI.
    expect(choosePicks(["ws-codex", "ws-api"], [claude, codex], envs, "p-1", { harnessOf })).toEqual(
      expect.arrayContaining([
        { workstreamId: "ws-codex", profileId: "pb" },
        { workstreamId: "ws-api", profileId: "pa" },
      ]),
    );
    const from = profile("pb1", { envId: "e-a", cli: "codex" });
    expect(chooseReplacement(from, [from, claude], envs, "p-1", "codex")).toBeNull();
    expect(chooseReplacement(from, [from, claude, codex], envs, "p-1", "codex")?.id).toBe("pb");
    expect(chooseReplacement(from, [from, claude], envs, "p-1")?.id).toBe("pa");
  });

  test("planner candidates: Claude and Codex only", () => {
    const list = plannerCandidates([profile("po", { cli: "opencode" }), profile("pc", { cli: "codex" })], envs, "p-1");
    expect(list.map((p) => p.id)).toEqual(["pc"]);
  });
});

const briefInput = (over: Partial<BriefInput> = {}): BriefInput => ({
  task: { title: "Settings", prompt: "Build settings.", acceptance: ["Saves"] },
  workstream: { id: "ws-api", role: "api", title: "API", brief: "Add endpoints.", branch: "morrow/abc/api", ownership: ["src/api/**"] },
  leaseId: "ls-7",
  channel: "proj-abc",
  others: [{ role: "web", title: "Web", branch: "morrow/abc/web", ownership: ["web/**"] }],
  testCommand: "bun test",
  ...over,
});

describe("briefs", () => {
  test("a small brief goes inline with the DONE protocol", () => {
    const brief = spawnBrief(briefInput());
    expect(brief.note).toBeNull();
    expect(brief.text).toContain("DONE ls-7");
    expect(brief.text).toContain("Do not push");
    expect(brief.text).toContain("web: Web (branch morrow/abc/web");
  });

  test("workers are told who to mention when a person has to decide", () => {
    expect(spawnBrief(briefInput({ creator: "h-ada" })).text).toContain("mention @h-ada (who created this task) in #");
    expect(handoffSpawnText({ ...briefInput({ creator: "h-ada" }), taskTitle: "T" })).toContain("mention @h-ada");
    // Creator unknown (left the team): the generic naming rule instead.
    expect(spawnBrief(briefInput()).text).toContain("mention them by name (h-<github login>)");
  });

  test("a brief over the PTY limit becomes a note plus a pointer", () => {
    const brief = spawnBrief(briefInput({ task: { title: "T", prompt: "é".repeat(8_000), acceptance: [] } }));
    expect(brief.note?.relPath).toBe(".morrow/briefs/ws-api.md");
    expect(utf8Bytes(brief.text)).toBeLessThanOrEqual(MAX_TASK_BRIEF_BYTES);
    expect(brief.text).toContain(".morrow/briefs/ws-api.md");
    expect(utf8Bytes(brief.note!.content)).toBeLessThanOrEqual(MAX_NOTE_BYTES);
  });

  test("clipBytes never splits a character", () => {
    const clipped = clipBytes("😀".repeat(100), 50);
    expect(utf8Bytes(clipped)).toBeLessThanOrEqual(50);
    expect(clipped).not.toContain("�");
  });

  test("handoff note: sections, untrusted text flattened, bounded", () => {
    const note = handoffNote({
      task: { title: "T", prompt: "Do it.", acceptance: ["Works"] },
      workstream: { id: "ws-api", title: "API", brief: "Endpoints.", branch: "morrow/abc/api", ownership: ["src/**"] },
      fromAgent: "w-abc-api-e3",
      toAgent: "w-abc-api-e5",
      reason: "previous worker stopped: usage limit",
      checkpointSha: "a".repeat(40),
      decisions: ["Use zod.\n## Fake heading\u0007", "x".repeat(50_000)],
      changedFiles: Array.from({ length: 250 }, (_, i) => `f${i}.ts`),
      testCommand: "bun test",
      lastError: "You've hit your usage limit.",
    });
    expect(note).toContain("## Decisions so far");
    expect(note).toContain("- Use zod. ## Fake heading");
    expect(note).not.toContain("\u0007");
    expect(note).toContain("…and 50 more");
    expect(note).toContain("Make `bun test` pass.");
    expect(note).toContain("You've hit your usage limit.");
    expect(utf8Bytes(note)).toBeLessThanOrEqual(MAX_NOTE_BYTES);
  });
});

describe("dispatcher helpers", () => {
  test("completion keys are stable per item, attempt and result", () => {
    const ok = { ok: true as const, invocationId: "inv", sha: null, detail: "started" };
    const a = completionKey({ id: "ob-ls-1-spawn", attempts: 1 }, ok);
    expect(completionKey({ id: "ob-ls-1-spawn", attempts: 1 }, ok)).toBe(a);
    expect(completionKey({ id: "ob-ls-1-spawn", attempts: 2 }, ok)).not.toBe(a);
    expect(completionKey({ id: "ob-ls-1-spawn", attempts: 1 }, { ...ok, detail: "x" })).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
  });

  test("failure mapping: retryable flags respected, bad input is final, text is one safe line", () => {
    const transient = failureResult("spawn", new FreestyleIntegrationError("exec_failed", "VM busy", { retryable: true }));
    expect(transient).toEqual({ ok: false, error: "Start worker: VM busy", retryable: true });
    expect(failureResult("checkpoint", new FreestyleIntegrationError("conflict", "rejected"))).toMatchObject({ retryable: false });
    expect(failureResult("spawn", new RelayIntegrationError("invalid_input", "name: bad"))).toMatchObject({ retryable: false });
    expect(failureResult("release", new Error("boom"))).toMatchObject({ retryable: true });
    expect(describeFailure("Step", new FreestyleIntegrationError("exec_failed", "line1\nline2\u0000"))).toBe("Step: line1 line2");
    expect(describeFailure("S", new FreestyleIntegrationError("exec_failed", "x".repeat(1000))).length).toBeLessThanOrEqual(300);
  });

  test("vendor and unknown error text never reaches outbox or trace fields", () => {
    const leaky = "connect ECONNREFUSED 10.0.0.7:443 https://internal.example/v1?token=rk_live_SECRET";
    expect(describeFailure("Start worker", new Error(leaky))).toBe("Start worker: failed unexpectedly");
    expect(describeFailure("Start worker", new RelayIntegrationError("relay_unavailable", leaky))).toBe("Start worker: Relay is unavailable");
    expect(describeFailure("Checkpoint", new GithubError("forbidden", leaky, 403))).toBe("Checkpoint: GitHub denied access");
    const vendor = Object.assign(new Error(leaky), { name: "RelayError", code: "agent_not_found", status: 404 });
    expect(describeFailure("Stop worker", vendor)).toBe("Stop worker: Relay returned an error (agent_not_found)");
    const odd = Object.assign(new Error(leaky), { name: "RelayError", code: "Weird Code!", status: 500 });
    expect(describeFailure("Stop worker", odd)).toBe("Stop worker: Relay returned an error");
    expect(describeFailure("Step", new AppError("conflict", "The branch moved."))).toBe("Step: The branch moved.");
    expect(describeFailure("Step", "a string")).toBe("Step: failed unexpectedly");
    for (const error of [new Error(leaky), new RelayIntegrationError("invalid_input", leaky), new GithubError("unavailable", leaky)]) {
      expect(failureResult("spawn", error).ok ? "" : failureResult("spawn", error)).not.toMatchObject({ error: expect.stringContaining("SECRET") });
    }
  });

  test("control messages need exact tokens on the first line", () => {
    const m = (text: string) => ({ type: "message" as const, text });
    expect(parseControl(m("DONE ls-4 Added the endpoints"))).toEqual({ verb: "DONE", leaseId: "ls-4", rest: "Added the endpoints" });
    expect(parseControl(m("  ACK ls-9  "))).toEqual({ verb: "ACK", leaseId: "ls-9", rest: "" });
    expect(parseControl(m("I will post DONE ls-4 later"))).toBeNull();
    expect(parseControl(m("done ls-4"))).toBeNull();
    expect(parseControl(m("ACK"))).toBeNull();
    expect(parseControl(m("ACK ls-4;rm -rf /"))).toBeNull();
  });
});

describe("lanes", () => {
  test("single flight per key, per-team cap, global cap, drain", async () => {
    const lanes = new Lanes({ perTeam: 2, global: 3 }, silentLogger);
    const gates: Array<() => void> = [];
    const job = () => new Promise<void>((r) => gates.push(r));
    expect(lanes.run("t1", "a", job)).toBe(true);
    expect(lanes.run("t1", "a", job)).toBe(false);
    expect(lanes.run("t1", "b", job)).toBe(true);
    expect(lanes.run("t1", "c", job)).toBe(false);
    expect(lanes.free("t1")).toBe(0);
    expect(lanes.run("t2", "a", job)).toBe(true);
    expect(lanes.run("t3", "a", job)).toBe(false);
    expect(lanes.busy("t1", "a")).toBe(true);
    for (const open of gates) open();
    expect(await lanes.drain(1_000)).toBe(0);
    expect(lanes.run("t1", "z", job)).toBe(false);
  });

  test("a throwing job frees its slot", async () => {
    const lanes = new Lanes({ perTeam: 1, global: 1 }, silentLogger);
    expect(lanes.run("t", "x", async () => Promise.reject(new Error("boom")))).toBe(true);
    await Bun.sleep(5);
    expect(lanes.run("t", "y", async () => {})).toBe(true);
  });
});

describe("dispatcher claim pass", () => {
  const item = (id: string, kind: OutboxClaim["kind"] = "spawn", attempts = 1) => ({ id, kind, leaseId: "ls-1", taskId: "tk-1", attempts, payload: {} }) as OutboxClaim;
  /** A dispatcher whose actor hands out `claims` once and records every completion. */
  const setup = (claims: OutboxClaim[], completeOutbox?: () => Promise<unknown>) => {
    const lanes = new Lanes({ perTeam: 4, global: 8 }, silentLogger);
    const completed: Array<{ id: string; result: OutboxResult; key: string }> = [];
    const wf = {
      claimOutbox: async () => claims,
      completeOutbox:
        completeOutbox ??
        (async (_teamId: string, id: string, result: OutboxResult, key: string) => {
          completed.push({ id, result, key });
          return { ok: true, state: "pending" };
        }),
    };
    const ctx = { wf, lanes, memory: new Memory(), log: silentLogger, now: () => 1_000, timing: DEFAULT_TIMING } as unknown as Ctx;
    return { dispatcher: new Dispatcher(ctx), lanes, completed };
  };

  test("a claim that lands after shutdown began is handed back as retryable, not left hidden", async () => {
    // The claim pass was already waiting on the actor when stop() closed the lanes.
    let releaseClaim!: () => void;
    const gate = new Promise<void>((r) => (releaseClaim = r));
    const { dispatcher, lanes, completed } = setup([item("ob-1"), item("ob-2", "checkpoint", 3)]);
    const pass = (async () => {
      await gate;
      return dispatcher.claim("t-1");
    })();
    await lanes.drain(0);
    releaseClaim();
    expect(await pass).toBe(0);
    expect(completed.map((c) => c.id)).toEqual(["ob-1", "ob-2"]);
    for (const c of completed) expect(c.result).toEqual({ ok: false, retryable: true, error: expect.stringContaining("did not start") });
    expect(completed[0]!.result).toMatchObject({ error: expect.stringMatching(/^Start worker did not start/) });
    // The same key a real completion of that attempt would use, so a replay is a no-op.
    expect(completed[1]!.key).toBe(completionKey(item("ob-2", "checkpoint", 3), completed[1]!.result));
  });

  test("an item still running under our own earlier claim is skipped, not handed back", async () => {
    const { dispatcher, lanes, completed } = setup([item("ob-slow"), item("ob-new", "release")]);
    let finish!: () => void;
    expect(lanes.run("t-1", "item:ob-slow", () => new Promise<void>((r) => (finish = r)))).toBe(true);
    await lanes.drain(0);
    expect(await dispatcher.claim("t-1")).toBe(0);
    expect(completed.map((c) => c.id)).toEqual(["ob-new"]);
    finish();
  });

  test("a failed hand-back is logged, never thrown: the visibility timeout still brings the item back", async () => {
    const { dispatcher, lanes } = setup([item("ob-1")], async () => {
      throw new Error("actor unreachable");
    });
    await lanes.drain(0);
    expect(await dispatcher.claim("t-1")).toBe(0);
  });
});

describe("merge conflict helpers", () => {
  const brief = (over: Partial<Parameters<typeof conflictBrief>[0]> = {}) =>
    conflictBrief({
      integrationBranch: "morrow/abc/integration",
      branch: "morrow/abc/web",
      sha: "b".repeat(40),
      incoming: { title: "Web", brief: "Add the settings page.\nWith a form." },
      merged: [{ title: "API", branch: "morrow/abc/api", brief: "Add member endpoints." }],
      remaining: ["morrow/abc/tests"],
      files: ["src/shared.ts", "web/app.tsx"],
      testCommand: "bun test",
      ...over,
    });

  test("the resolver brief names the branches, the files, both sides' intent and the exact steps", () => {
    const text = brief();
    expect(text).toContain("Your working directory is the integration branch morrow/abc/integration.");
    expect(text).toContain(`Conflicting branch: morrow/abc/web (commit ${"b".repeat(12)})`);
    expect(text).toContain("- src/shared.ts\n- web/app.tsx");
    expect(text).toContain("- Web (morrow/abc/web, does not merge yet): Add the settings page. With a form.");
    expect(text).toContain("- API (morrow/abc/api, already merged): Add member endpoints.");
    expect(text).toContain("1. git merge origin/morrow/abc/integration");
    expect(text).toContain("2. git merge --no-ff origin/morrow/abc/web");
    expect(text).toContain("5. Merge these the same way, in order: origin/morrow/abc/tests");
    expect(text).toContain("6. Run the tests and fix what the merge broke: bun test");
    expect(text).toContain("Never rebase, reset or force anything");
  });

  test("the default branch case, no files, no test command, and a huge brief stays under the actor's limit", () => {
    const text = brief({ branch: "main", sha: null, incoming: null, remaining: [], files: [], testCommand: null });
    expect(text).toContain("- The default branch main moved on after this task's work started.");
    expect(text).toContain("Conflicting branch: main\n");
    expect(text).toContain("- Not known. `git merge` lists them.");
    expect(text).toContain("there is no test command");
    expect(text).not.toContain("in order:");
    const huge = brief({ merged: Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, branch: `b/${i}`, brief: "x".repeat(5_000) })), files: conflictFileList(Array.from({ length: 80 }, (_, i) => `${"d/".repeat(120)}${i}`)) });
    expect(utf8Bytes(huge)).toBeLessThanOrEqual(11_000);
    // Planner text is clipped per side, never passed whole.
    expect(huge).not.toContain("x".repeat(700));
  });

  test("file lists drop control characters and overlong names, dedupe, and cap the count", () => {
    expect(conflictFileList(["a.ts", "a.ts", "evil\nname", "tab\there", "x".repeat(301), "ok/b.ts"])).toEqual(["a.ts", "ok/b.ts"]);
    expect(conflictFileList(Array.from({ length: 80 }, (_, i) => `f${i}`))).toHaveLength(50);
  });

  test("resolver pins: profiles that last worked on either side; nothing for other tasks", () => {
    const ws = (id: string, role: string, leaseId: string | null, over: object = {}) => ({
      id, role, title: id, brief: "", why: "", branch: `b/${id}`, dependsOn: [] as string[], ownership: [], status: "done" as const, leaseId, lastCheckpoint: null, ...over,
    });
    const lease = (id: string, profileId: string) => ({ id, taskId: "tk", workstreamId: "w", profileId, epoch: 1, agentName: "a", nodeName: "n", state: "released" as const, createdAt: 0 });
    const leases = { "ls-1": lease("ls-1", "p-api"), "ls-2": lease("ls-2", "p-web"), "ls-3": lease("ls-3", "p-tests") };
    const task = {
      workstreams: [
        ws("ws-api", "api", "ls-1"),
        ws("ws-web", "web", "ls-2"),
        ws("ws-tests", "tests", "ls-3"),
        ws("ws-resolver", "resolver", null, { status: "pending", dependsOn: ["ws-web", "ws-api"] }),
      ],
    } as unknown as TaskDetail;
    expect(resolverPins(task, { leases }).sort()).toEqual(["p-api", "p-web"]);
    const running = { workstreams: task.workstreams.map((w) => (w.role === "resolver" ? { ...w, status: "active" } : w)) } as unknown as TaskDetail;
    expect(resolverPins(running, { leases })).toEqual([]);
    expect(resolverPins({ workstreams: task.workstreams.slice(0, 3) } as unknown as TaskDetail, { leases })).toEqual([]);
    // Pins put a profile that knows the conflict ahead of an idle one that sorts first.
    const picks = choosePicks(["ws-resolver"], [profile("p-aaa"), profile("p-web", { envId: "e-b" })], envs, "p-1", { pins: ["p-web"] });
    expect(picks).toEqual([{ workstreamId: "ws-resolver", profileId: "p-web" }]);
  });

  test("the planner never emits the roles the system owns", () => {
    expect(normalizeRole("integration")).toBe("integrationtests");
    expect(normalizeRole("Resolver")).toBe("resolve");
    expect(normalizeRole("api")).toBe("api");
  });
});

describe("compare", () => {
  const planTask = { id: "tk-0123456789abcdef", title: "Settings page", prompt: "Build the settings page.", acceptance: ["Saves", "Validates"] };

  test("the plan is one independent attempt per harness, on its own branch, owning everything", () => {
    const plan = comparePlan(planTask, ["codex", "claude"]);
    expect(plan).toMatchObject({ source: "compare", profileId: null, warnings: [] });
    expect(plan.rationale).toContain("Codex, Claude Code each attempt the whole task");
    expect(plan.workstreams.map((w) => [w.id, w.role, w.harness, w.dependsOn, w.ownership])).toEqual([
      ["ws-codex", "codex", "codex", [], ["**"]],
      ["ws-claude", "claude", "claude", [], ["**"]],
    ]);
    expect(new Set(plan.workstreams.map((w) => w.branch)).size).toBe(2);
    expect(plan.workstreams[0]!.title).toBe("Codex attempt: Settings page");
    expect(plan.workstreams[0]!.brief).toBe("Build the settings page.\n\nAcceptance criteria:\n- Saves\n- Validates");
    expect(attemptId("opencode")).toBe("ws-opencode");
  });

  test("titles and briefs are bounded and flattened", () => {
    const plan = comparePlan({ ...planTask, title: `x\n${"y".repeat(500)}`, prompt: "p".repeat(20_000), acceptance: [] }, ["claude", "codex"]);
    expect(plan.workstreams[0]!.title.length).toBeLessThanOrEqual(120);
    expect(plan.workstreams[0]!.title).not.toContain("\n");
    expect(plan.workstreams[0]!.brief.length).toBeLessThanOrEqual(12_000);
  });

  test("strategy defaults to split; only the pick and a resolver ship from a compare task", () => {
    const workstreams = [
      { id: "ws-claude", role: "claude", harness: "claude" as const },
      { id: "ws-codex", role: "codex", harness: "codex" as const },
      { id: "ws-resolver", role: "resolver" },
    ];
    expect(strategyOf({})).toBe("split");
    expect(isCompare({ strategy: "compare" })).toBe(true);
    expect(shippedWorkstreams({ workstreams })).toEqual(workstreams);
    expect(shippedWorkstreams({ strategy: "split", pickedWorkstreamId: null, workstreams })).toEqual(workstreams);
    expect(shippedWorkstreams({ strategy: "compare", pickedWorkstreamId: null, workstreams })).toEqual([]);
    expect(shippedWorkstreams({ strategy: "compare", pickedWorkstreamId: "ws-codex", workstreams }).map((w) => w.id)).toEqual(["ws-codex", "ws-resolver"]);
    expect([...harnessOf({ workstreams })]).toEqual([
      ["ws-claude", "claude"],
      ["ws-codex", "codex"],
    ]);
  });

  test("a compare brief forbids touching the other attempts' branches; a split brief keeps its merge line", () => {
    const compare = spawnBrief(briefInput({ strategy: "compare" })).text;
    expect(compare).toContain("## Compare");
    expect(compare).toContain("Never merge, copy or check out another attempt's branch.");
    expect(compare).not.toContain("git merge origin/");
    const split = spawnBrief(briefInput()).text;
    expect(split).not.toContain("## Compare");
    expect(split).not.toContain("another attempt's branch");
    expect(split).toContain("git fetch origin && git merge origin/<its branch>");
    // The handoff text a replacement worker gets follows the same rule.
    expect(handoffSpawnText({ ...briefInput({ strategy: "compare" }), taskTitle: "Settings" })).toContain("another attempt's branch");
  });

  test("the create body: split by default, compare needs 2 to 3 distinct known harnesses", () => {
    const base = { projectId: "proj0000demo", prompt: "Build it." };
    expect(CreateTaskBody.parse(base)).toMatchObject({ strategy: "split", harnesses: [] });
    expect(CreateTaskBody.safeParse({ ...base, strategy: "compare", harnesses: ["claude", "codex"] }).success).toBe(true);
    expect(CreateTaskBody.safeParse({ ...base, strategy: "compare", harnesses: ["claude", "codex", "opencode"] }).success).toBe(true);
    for (const bad of [
      { strategy: "compare", harnesses: ["claude"] },
      { strategy: "compare", harnesses: [] },
      { strategy: "compare", harnesses: ["claude", "claude"] },
      { strategy: "compare", harnesses: ["claude", "aider"] },
      { strategy: "compare", harnesses: ["claude", "codex", "opencode", "claude"] },
      { strategy: "split", harnesses: ["claude"] },
      { strategy: "pair", harnesses: [] },
    ])
      expect(CreateTaskBody.safeParse({ ...base, ...bad }).success).toBe(false);
    expect(PickAttemptBody.safeParse({ workstreamId: null }).success).toBe(true);
    expect(PickAttemptBody.safeParse({ workstreamId: "ws-codex" }).success).toBe(true);
    expect(PickAttemptBody.safeParse({}).success).toBe(false);
    expect(PickAttemptBody.safeParse({ workstreamId: "../x" }).success).toBe(false);
  });
});
