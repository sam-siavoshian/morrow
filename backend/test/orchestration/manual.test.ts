// Manual mode end to end (docs/multi-harness.md, "Manual mode") against a real local Terse: only the profiles a person
// picked ever take the task's work, at create, start, scheduler placement, handoff and subagents, and a task with no
// free pin waits and says why instead of falling back. Relay, the VMs and GitHub are the fakes from ./fakes.ts; loops
// are driven by hand (tickMs 0).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ReplanBody, StartTaskBody, TaskDetail, type CliKind, type CreateTaskBody } from "@morrow/contracts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Keys } from "../../src/http/context.ts";
import type { GithubClient } from "../../src/integrations/github/client.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { createOrchestration, type Orchestration } from "../../src/orchestration/index.ts";
import { createWorkforceClient, type TaskRecord, type WorkforceApi } from "../../src/orchestration/workforce.ts";
import { RuntimeBus } from "../../src/runtime/bus.ts";
import { testEnv } from "../support/env.ts";
import { ENVS, FakeGit, FakeRelay, FakeRuntime, FakeVm, message, PROJECT, teamGateway } from "./fakes.ts";

const TEST_SERVER = resolve(import.meta.dir, "../../../actors/scripts/test-server.ts");
const ready = existsSync(TEST_SERVER) && existsSync(resolve(import.meta.dir, "../../src/generated/index.d.ts"));
if (!ready) console.warn("SKIP manual mode: Terse test server or generated client missing");

type TerseServer = { url: string; secret: string; stop(): Promise<void> };
let terse: TerseServer;
let env: ReturnType<typeof testEnv>;
let wf: WorkforceApi;

beforeAll(async () => {
  if (!ready) return;
  const { startTestServer } = (await import(TEST_SERVER)) as { startTestServer: () => Promise<TerseServer> };
  terse = await startTestServer();
  env = testEnv({ DURABLE_ACTORS_CONTROL_PLANE_URL: terse.url, DURABLE_ACTORS_SECRET: terse.secret });
  wf = createWorkforceClient(env.terse, silentLogger);
}, 90_000);
afterAll(async () => {
  await terse?.stop();
}, 30_000);

interface World {
  teamId: string;
  relay: FakeRelay;
  vm: FakeVm;
  orch: Orchestration;
}

let teamSeq = 0;
function world(): World {
  const teamId = `t-man${Date.now().toString(36)}${++teamSeq}`;
  const shas = new Set<string>();
  const relay = new FakeRelay();
  const vm = new FakeVm(shas);
  const git = new FakeGit(shas);
  const orch = createOrchestration({
    deps: { env, log: silentLogger, actors: teamGateway(), github: {} as GithubClient, keys: {} as Keys, now: Date.now },
    runtime: new FakeRuntime(),
    bus: new RuntimeBus(silentLogger),
    options: { ports: { vm, relay, git, githubToken: async () => "gho_testtoken" }, workforce: wf, tickMs: 0, partners: false, listTeams: async () => [] },
  });
  return { teamId, relay, vm, orch };
}

async function settle(orch: Orchestration, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let idle = 0;
  while (idle < 3) {
    if (Date.now() > deadline) throw new Error(`lanes still busy: ${orch.ctx.lanes.size}`);
    idle = orch.ctx.lanes.size === 0 ? idle + 1 : 0;
    await Bun.sleep(10);
  }
}

async function pump(orch: Orchestration, teamId: string, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const started = await orch.dispatcher.claim(teamId);
    await settle(orch);
    if (started === 0) return;
  }
}

async function addProfile(teamId: string, id: string, envIndex: number, cli: CliKind, maxConcurrent = 2) {
  const e = ENVS[envIndex]!;
  const registered = await wf.registerProfile(teamId, { id, envId: e.id, ownerUserId: e.ownerUserId, nodeName: e.nodeName!, cli, label: id, scopes: "all", maxConcurrent });
  expect(registered.ok).toBe(true);
  await wf.updateProfileHealth(teamId, id, { auth: "ok", online: true, observedAt: Date.now() }, `h-${id}-${Date.now()}`);
}

const claudePlan = (workstreams: object[]) => () => ({
  exitCode: 0,
  timedOut: false,
  stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ rationale: "Split by layer.", workstreams }) }),
});
const API = { role: "api", title: "API", brief: "Add member endpoints.", why: "Server files.", ownership: ["src/api/**"], dependsOn: [] };
const WEB = { role: "web", title: "Web", brief: "Add the settings page.", why: "Client files.", ownership: ["web/**"], dependsOn: [] };
const PROMPT = `Add a team settings page with an API. ${"Members can be listed, invited and removed, with validation and audit logging. ".repeat(5)}`;
const NO_PINS = "Manual needs at least one picked profile. Pick one, or switch to Auto.";
const busyNote = (title: string) => `Waiting for a pinned profile: none of them is free. "${title}" starts when one is.`;
const goneNote = (title: string) =>
  `Waiting for a pinned profile: all of them were removed from the team. "${title}" cannot start until the task is cancelled and started again with other profiles.`;

async function task(teamId: string, taskId: string): Promise<TaskRecord> {
  const t = await wf.getTask(teamId, taskId);
  expect(t).not.toBeNull();
  return t!;
}

function create(w: World, body: Partial<CreateTaskBody>) {
  return w.orch.service.create(w.teamId, "u-owner", { projectId: PROJECT.id, prompt: PROMPT, acceptance: [], maxAgents: 3, mode: "auto", pins: [], strategy: "split", harnesses: [], ...body });
}

async function planned(w: World, body: Partial<CreateTaskBody>): Promise<TaskRecord> {
  const { taskId } = await create(w, body);
  await settle(w.orch);
  const t = await task(w.teamId, taskId);
  expect(t.status).toBe("planned");
  return t;
}

async function liveLease(teamId: string, taskId: string, workstreamId: string) {
  const t = await task(teamId, taskId);
  const leaseId = t.workstreams.find((x) => x.id === workstreamId)!.leaseId!;
  return (await wf.getLease(teamId, leaseId))!;
}

/** Profiles that hold a live lease of this task. */
async function leasedOn(teamId: string, taskId: string): Promise<string[]> {
  const view = await wf.getView(teamId);
  return Object.values(view.leases)
    .filter((l) => l.taskId === taskId && ["reserved", "starting", "running", "handoff_pending"].includes(l.state))
    .map((l) => l.profileId)
    .sort();
}

const waits = (t: TaskRecord) => t.trace.filter((e) => e.kind === "worker.waiting");

function say(w: World, from: string, text: string) {
  w.orch.monitor.handle({ kind: "message", teamId: w.teamId, message: message(from, text, null), seq: null });
}

const replies = (w: World, to: string) => w.relay.posts.filter((p) => p.to === to && p.notice?.kind === "subagent");
const tag = (text: string) => Object.fromEntries((/\[morrow ([^\]]*)\]$/.exec(text)?.[1] ?? "").split(" ").filter(Boolean).map((kv) => kv.split("=") as [string, string]));

describe("manual mode bodies", () => {
  test("start and replan carry an optional mode and at most 5 pins", () => {
    expect(StartTaskBody.safeParse({ mode: "manual", pins: ["cp-a"] }).success).toBe(true);
    expect(StartTaskBody.safeParse({}).success).toBe(true);
    expect(StartTaskBody.safeParse({ mode: "manual", pins: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
    expect(StartTaskBody.safeParse({ mode: "pinned" }).success).toBe(false);
    expect(StartTaskBody.safeParse({ pins: ["../etc"] }).success).toBe(false);
    expect(ReplanBody.safeParse({ maxAgents: 2, pins: ["cp-a"], mode: "manual" }).success).toBe(true);
    expect(ReplanBody.safeParse({ maxAgents: 2, pins: [], mode: "both" }).success).toBe(false);
  });
});

describe.skipIf(!ready)("manual mode (real Terse)", () => {
  test("create: manual needs a pin, every pin must be a team profile, and a manual compare needs a pin of each harness", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    await addProfile(w.teamId, "cp-beta", 1, "codex");
    await expect(create(w, { mode: "manual", pins: [] })).rejects.toMatchObject({ status: 400, message: NO_PINS });
    await expect(create(w, { mode: "manual", pins: ["cp-ghost"] })).rejects.toMatchObject({
      status: 400,
      message: "A picked profile is no longer part of this team. Pick your profiles again.",
    });
    // A stale pin is refused in auto too: pins are always this team's profiles.
    await expect(create(w, { mode: "auto", pins: ["cp-ghost"] })).rejects.toMatchObject({ status: 400 });
    await expect(create(w, { mode: "manual", pins: ["cp-alpha"], strategy: "compare", harnesses: ["claude", "codex"] })).rejects.toMatchObject({
      status: 400,
      message: "None of the picked profiles runs Codex. Pick a Codex profile, drop it from the compare, or switch to Auto.",
    });
    await expect(create(w, { mode: "manual", pins: ["cp-alpha"], strategy: "compare", harnesses: ["claude", "codex", "opencode"] })).rejects.toMatchObject({
      status: 400,
      message: "None of the picked profiles runs Codex or opencode. Pick a profile for each, drop them from the compare, or switch to Auto.",
    });
    expect((await wf.getView(w.teamId)).tasks).toEqual({});

    w.vm.planner = claudePlan([API]);
    const t = await planned(w, { mode: "manual", pins: ["cp-alpha", "cp-alpha"] });
    expect(t).toMatchObject({ mode: "manual", pins: ["cp-alpha"] });
    const compare = await create(w, { mode: "manual", pins: ["cp-alpha", "cp-beta"], strategy: "compare", harnesses: ["claude", "codex"] });
    expect(await task(w.teamId, compare.taskId)).toMatchObject({ mode: "manual", pins: ["cp-alpha", "cp-beta"], strategy: "compare" });
    // The detail the browser reads parses with the shared contract and carries neither the mode nor the pins.
    const detail = await w.orch.service.detail(w.teamId, t.id);
    expect(TaskDetail.safeParse(detail).success).toBe(true);
    expect(TaskDetail.parse(detail)).not.toHaveProperty("pins");
  }, 60_000);

  test("start: an unpinned pick is refused, placement uses only the pins, the roots past them queue, and with no free pin it says so", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude", 2);
    await addProfile(w.teamId, "cp-beta", 1, "codex");
    w.vm.planner = claudePlan([API, WEB]);
    const t = await planned(w, { mode: "manual", pins: ["cp-alpha"] });
    const other = await planned(w, { mode: "manual", pins: ["cp-alpha"] });
    const third = await planned(w, { mode: "manual", pins: ["cp-alpha"] });
    expect(t.workstreams.map((x) => x.id)).toEqual(["ws-api", "ws-web"]);
    await expect(w.orch.service.start(w.teamId, t.id, { picks: [{ workstreamId: "ws-api", profileId: "cp-beta" }] })).rejects.toMatchObject({
      status: 409,
      message: "Could not start: Profile cp-beta is not one of the profiles picked for this task.",
    });
    expect(await leasedOn(w.teamId, t.id)).toEqual([]);
    const first = await w.orch.service.start(w.teamId, other.id, { picks: [{ workstreamId: "ws-api", profileId: "cp-alpha" }] });
    expect(first.leases.map((l) => l.profileId)).toEqual(["cp-alpha"]);
    // Two roots, one free pinned slot, a free unpinned profile next to it: one root starts on the pin and the other
    // waits for it, never on cp-beta.
    const { leases } = await w.orch.service.start(w.teamId, t.id, {});
    expect(leases.map((l) => l.profileId)).toEqual(["cp-alpha"]);
    const started = await task(w.teamId, t.id);
    expect(started.status).not.toBe("planned");
    expect(started.workstreams.filter((x) => x.leaseId).map((x) => x.id)).toHaveLength(1);
    expect(await leasedOn(w.teamId, t.id)).toEqual(["cp-alpha"]);
    // The pin is full now: a start with nothing to place says so.
    await expect(w.orch.service.start(w.teamId, third.id, {})).rejects.toMatchObject({
      status: 409,
      message: "None of the picked profiles has a free slot for this task. Wait for one to free up, or pick more profiles.",
    });
    expect(await leasedOn(w.teamId, third.id)).toEqual([]);
  }, 60_000);

  test("scheduler: a ready workstream waits for a pinned profile, says so once, and a dependent one only goes to a pin", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude", 3);
    await addProfile(w.teamId, "cp-beta", 1, "codex");
    // Another task holds two of the pin's three slots for the whole test.
    w.vm.planner = claudePlan([API, WEB]);
    const blocker = await planned(w, { mode: "manual", pins: ["cp-alpha"] });
    const TESTS = { role: "tests", title: "Tests", brief: "Test the members flow.", why: "Gated on both.", ownership: ["e2e/**"], dependsOn: ["api", "web"] };
    w.vm.planner = claudePlan([API, WEB, TESTS]);
    const t = await planned(w, { mode: "manual", pins: ["cp-alpha"] });
    expect((await w.orch.service.start(w.teamId, blocker.id, {})).leases.map((l) => l.profileId)).toEqual(["cp-alpha", "cp-alpha"]);
    expect(t.workstreams.map((x) => [x.id, x.dependsOn])).toEqual([
      ["ws-api", []],
      ["ws-web", []],
      ["ws-tests", ["ws-api", "ws-web"]],
    ]);
    await w.orch.service.start(w.teamId, t.id, { picks: [{ workstreamId: "ws-api", profileId: "cp-alpha" }] });
    await pump(w.orch, w.teamId);

    // ws-web is ready but the only pin is full, with cp-beta idle next to it: it waits, noted once however many passes run.
    for (let i = 0; i < 3; i++) await w.orch.scheduler.pass(w.teamId);
    let stored = await task(w.teamId, t.id);
    expect(waits(stored).map((e) => e.message)).toEqual([busyNote("Web")]);
    expect(await leasedOn(w.teamId, t.id)).toEqual(["cp-alpha"]);
    // The live trace the browser gets carries the note too.
    expect((await wf.getView(w.teamId)).tasks[t.id]!.trace.some((e) => e.kind === "worker.waiting")).toBe(true);

    const finish = async (workstreamId: string) => {
      const lease = await liveLease(w.teamId, t.id, workstreamId);
      say(w, lease.agentName, `DONE ${lease.id} Finished ${workstreamId}`);
      await settle(w.orch);
      await pump(w.orch, w.teamId);
      await w.orch.scheduler.pass(w.teamId);
      await pump(w.orch, w.teamId);
    };
    // The pin frees up: ws-web takes it. ws-tests still waits on its dependencies, so it is not "waiting for a profile".
    await finish("ws-api");
    expect((await liveLease(w.teamId, t.id, "ws-web")).profileId).toBe("cp-alpha");
    // Both dependencies done: the dependent workstream goes to the pin, never to cp-beta.
    await finish("ws-web");
    expect((await liveLease(w.teamId, t.id, "ws-tests")).profileId).toBe("cp-alpha");
    stored = await task(w.teamId, t.id);
    expect(waits(stored)).toHaveLength(1);
    const view = await wf.getView(w.teamId);
    expect(Object.values(view.leases).filter((l) => l.taskId === t.id).every((l) => l.profileId === "cp-alpha")).toBe(true);
  }, 90_000);
  test("handoff: only to a pinned profile, back to the same one when it is the only pin, and a wait while it cools down", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    await addProfile(w.teamId, "cp-beta", 1, "claude");
    w.vm.planner = claudePlan([API]);
    const t = await planned(w, { mode: "manual", pins: ["cp-alpha"] });
    await w.orch.service.start(w.teamId, t.id, {});
    await pump(w.orch, w.teamId);
    const first = await liveLease(w.teamId, t.id, "ws-api");
    expect(first.profileId).toBe("cp-alpha");

    const until = Date.now() + 1_500;
    expect((await wf.markProfileLimited(w.teamId, "cp-alpha", until, "usage limit", "detected", `lim-${Date.now()}`)).ok).toBe(true);
    expect((await task(w.teamId, t.id)).status).toBe("handoff");
    await pump(w.orch, w.teamId);
    // cp-beta is idle and runs the same CLI on another machine: auto would hand off to it, manual waits.
    await w.orch.scheduler.pass(w.teamId);
    await w.orch.scheduler.pass(w.teamId);
    let stored = await task(w.teamId, t.id);
    expect(stored.status).toBe("handoff");
    expect(waits(stored).map((e) => e.message)).toEqual([busyNote("API")]);
    expect(await leasedOn(w.teamId, t.id)).toEqual([]);

    await Bun.sleep(Math.max(0, until - Date.now()) + 100);
    await w.orch.scheduler.pass(w.teamId);
    await pump(w.orch, w.teamId);
    const second = await liveLease(w.teamId, t.id, "ws-api");
    expect(second.profileId).toBe("cp-alpha");
    expect(second.epoch).toBeGreaterThan(first.epoch);
    stored = await task(w.teamId, t.id);
    expect(waits(stored)).toHaveLength(1);
  }, 90_000);

  test("every pinned profile removed mid-run: the task does not crash, it waits and says the pins are gone", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    await addProfile(w.teamId, "cp-gamma", 1, "codex");
    await addProfile(w.teamId, "cp-beta", 1, "claude");
    w.vm.planner = claudePlan([API]);
    const t = await planned(w, { mode: "manual", pins: ["cp-alpha", "cp-gamma"] });
    await w.orch.service.start(w.teamId, t.id, {});
    await pump(w.orch, w.teamId);
    const first = await liveLease(w.teamId, t.id, "ws-api");
    expect(["cp-alpha", "cp-gamma"]).toContain(first.profileId);

    // Removing the worker's profile hands off to the other pin, never to cp-beta.
    await wf.removeProfile(w.teamId, first.profileId);
    await pump(w.orch, w.teamId);
    await w.orch.scheduler.pass(w.teamId);
    await pump(w.orch, w.teamId);
    const second = await liveLease(w.teamId, t.id, "ws-api");
    const other = first.profileId === "cp-alpha" ? "cp-gamma" : "cp-alpha";
    expect(second.profileId).toBe(other);

    await wf.removeProfile(w.teamId, other);
    await pump(w.orch, w.teamId);
    for (let i = 0; i < 3; i++) await w.orch.scheduler.pass(w.teamId);
    const stored = await task(w.teamId, t.id);
    expect(stored.status).toBe("handoff");
    expect(stored).toMatchObject({ mode: "manual", pins: ["cp-alpha", "cp-gamma"] });
    expect(waits(stored).map((e) => e.message)).toEqual([goneNote("API")]);
    expect(await leasedOn(w.teamId, t.id)).toEqual([]);
    // Cancel still works, so the person can start over with other profiles.
    await w.orch.service.cancel(w.teamId, t.id, "u-owner", "owner");
    await settle(w.orch);
    expect((await task(w.teamId, t.id)).status).toBe("cancelled");
  }, 90_000);

  test("start and replan carry the composer's choice before anything is placed; after start the pins are fixed", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    await addProfile(w.teamId, "cp-beta", 1, "claude");
    w.vm.planner = claudePlan([API, WEB]);
    const t = await planned(w, { mode: "auto", pins: [] });

    await w.orch.service.replan(w.teamId, t.id, { maxAgents: 3, pins: ["cp-beta"], mode: "manual" });
    await settle(w.orch);
    expect(await task(w.teamId, t.id)).toMatchObject({ status: "planned", mode: "manual", pins: ["cp-beta"] });
    await expect(w.orch.service.replan(w.teamId, t.id, { maxAgents: 3, pins: [], mode: "manual" })).rejects.toMatchObject({ status: 400, message: NO_PINS });
    await expect(w.orch.service.start(w.teamId, t.id, { mode: "manual", pins: [] })).rejects.toMatchObject({ status: 400, message: NO_PINS });
    await expect(w.orch.service.start(w.teamId, t.id, { mode: "manual", pins: ["cp-ghost"] })).rejects.toMatchObject({ status: 400 });

    // Start sends what the composer shows now: cp-alpha only, which replaces cp-beta before the reservation.
    const { leases } = await w.orch.service.start(w.teamId, t.id, { mode: "manual", pins: ["cp-alpha"] });
    expect(leases.map((l) => l.profileId)).toEqual(["cp-alpha", "cp-alpha"]);
    expect(await task(w.teamId, t.id)).toMatchObject({ mode: "manual", pins: ["cp-alpha"] });
    const widen = await wf.setTaskWorkforce(w.teamId, t.id, "auto", [], `tw-${Date.now()}`);
    expect(widen).toEqual({ ok: false, reason: "task_started" });
    await expect(w.orch.service.replan(w.teamId, t.id, { maxAgents: 3, pins: ["cp-beta"], mode: "auto" })).rejects.toMatchObject({ status: 409 });
  }, 90_000);

  test("subagents: options mark unpinned CLIs, DELEGATE to one is refused, and a pinned one starts", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    await addProfile(w.teamId, "cp-alpha-codex", 0, "codex");
    await addProfile(w.teamId, "cp-beta", 1, "codex");
    w.vm.planner = claudePlan([API, WEB]);
    const t = await planned(w, { mode: "manual", pins: ["cp-alpha", "cp-beta", "cp-alpha-codex"] });
    await w.orch.service.start(w.teamId, t.id, {
      picks: [
        { workstreamId: "ws-api", profileId: "cp-alpha" },
        { workstreamId: "ws-web", profileId: "cp-beta" },
      ],
    });
    await pump(w.orch, w.teamId);
    // Claude Code on the second machine joins after start; it was never picked.
    await addProfile(w.teamId, "cp-beta-claude", 1, "claude");
    const api = await liveLease(w.teamId, t.id, "ws-api");
    const web = await liveLease(w.teamId, t.id, "ws-web");

    say(w, web.agentName, "SUBAGENT_OPTIONS o1");
    await settle(w.orch);
    const options = replies(w, web.agentName).at(-1)!;
    expect(tag(options.text)).toMatchObject({ ref: "o1", status: "completed", ready: "codex" });
    expect(options.text).toContain("not one of the profiles picked for this task");

    say(w, web.agentName, "DELEGATE r1 claude review\nReview the page.");
    await settle(w.orch);
    const refused = replies(w, web.agentName).at(-1)!;
    expect(tag(refused.text)).toMatchObject({ ref: "r1", error: "provider_unavailable" });
    expect(refused.text).toContain("Claude Code on your machine is not one of the profiles picked for this task, so it cannot take work here.");
    expect(await leasedOn(w.teamId, t.id)).toEqual(["cp-alpha", "cp-beta"]);

    say(w, api.agentName, "DELEGATE r2 codex review\nReview the endpoints.");
    await settle(w.orch);
    const accepted = tag(replies(w, api.agentName).at(-1)!.text);
    expect(accepted).toMatchObject({ ref: "r2", status: "starting", target: "codex" });
    expect((await wf.getLease(w.teamId, accepted.task!))!.profileId).toBe("cp-alpha-codex");
  }, 90_000);
});
