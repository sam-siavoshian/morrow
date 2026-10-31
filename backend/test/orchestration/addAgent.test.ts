// Adding an agent to a running task from its @ menu, end to end against a real local Terse: the request body's
// target forms, which profile or VM can take the worker and why not, the caps, idempotency per caller, and that the
// new worker starts with the message plus the task context as its brief. Relay, the VMs and GitHub are the fakes from
// ./fakes.ts; loops are driven by hand (tickMs 0).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TaskMessageBody, TaskMessageResponse, type CliKind, type CreateTaskBody, type TeamPolicy } from "@morrow/contracts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Keys } from "../../src/http/context.ts";
import type { GithubClient } from "../../src/integrations/github/client.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { addedBrief, addedTitle } from "../../src/orchestration/addAgent.ts";
import { createOrchestration, type Orchestration } from "../../src/orchestration/index.ts";
import { createWorkforceClient, type TaskRecord, type WorkforceApi } from "../../src/orchestration/workforce.ts";
import { RuntimeBus } from "../../src/runtime/bus.ts";
import { testEnv } from "../support/env.ts";
import { ENVS, FakeGit, FakeRelay, FakeRuntime, FakeVm, PROJECT, teamGateway } from "./fakes.ts";

const TEST_SERVER = resolve(import.meta.dir, "../../../actors/scripts/test-server.ts");
const ready = existsSync(TEST_SERVER) && existsSync(resolve(import.meta.dir, "../../src/generated/index.d.ts"));
if (!ready) console.warn("SKIP add agent: Terse test server or generated client missing");

const KEY = "k-0123456789abcdef";

describe("message body", () => {
  test("keeps the string forms and adds typed targets; adding an agent needs a key", () => {
    expect(TaskMessageBody.safeParse({ to: "team", text: "hi" }).success).toBe(true);
    expect(TaskMessageBody.safeParse({ to: "w-abc-api-e1", text: "hi" }).success).toBe(true);
    expect(TaskMessageBody.safeParse({ to: { kind: "worker", name: "w-abc-api-e1" }, text: "hi" }).success).toBe(true);
    expect(TaskMessageBody.safeParse({ to: { kind: "profile", id: "cp-a" }, text: "hi", key: KEY }).success).toBe(true);
    expect(TaskMessageBody.safeParse({ to: { kind: "env", id: "e-a" }, text: "hi", key: KEY }).success).toBe(true);
    expect(TaskMessageBody.safeParse({ to: { kind: "profile", id: "cp-a" }, text: "hi" }).success).toBe(false);
    expect(TaskMessageBody.safeParse({ to: { kind: "env", id: "e-a" }, text: "hi", key: "short" }).success).toBe(false);
    // DMs never reach arbitrary names: the name pattern is the same in both forms.
    expect(TaskMessageBody.safeParse({ to: "H-Admin", text: "hi" }).success).toBe(false);
    expect(TaskMessageBody.safeParse({ to: { kind: "worker", name: "../x" }, text: "hi" }).success).toBe(false);
    expect(TaskMessageBody.safeParse({ to: { kind: "profile", id: "__proto__ x" }, text: "hi", key: KEY }).success).toBe(false);
    expect(TaskMessageBody.safeParse({ to: { kind: "vm", id: "e-a" }, text: "hi", key: KEY }).success).toBe(false);
    expect(TaskMessageResponse.safeParse({ message: null, lease: undefined }).success).toBe(true);
  });
});

describe("add agent helpers", () => {
  test("title and brief", () => {
    expect(addedTitle("\n  Add tests for the API  \nthen run them", "ada")).toBe("Add tests for the API");
    expect(addedTitle("\u0007\n", "ada")).toBe("Added by ada");
    expect(addedTitle("x".repeat(500), "ada")).toHaveLength(120);
    const brief = addedBrief("Ada", "h-ada", "Add tests.\n\u0000Then lint.");
    expect(brief).toContain("Ada (h-ada) added you to this task while it was running");
    expect(brief).toContain("Add tests.\nThen lint.");
    expect(brief).not.toContain("\u0000");
    expect(addedBrief("Ada", "h-ada", "y".repeat(4000)).length).toBeLessThanOrEqual(12_000);
  });
});

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
function world(policy?: TeamPolicy): World {
  const teamId = `t-add${Date.now().toString(36)}${++teamSeq}`;
  const shas = new Set<string>();
  const relay = new FakeRelay();
  const vm = new FakeVm(shas);
  const git = new FakeGit(shas);
  const orch = createOrchestration({
    deps: { env, log: silentLogger, actors: teamGateway(policy), github: {} as GithubClient, keys: {} as Keys, now: Date.now },
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

async function addProfile(teamId: string, id: string, envIndex: number, cli: CliKind, options: { maxConcurrent?: number; online?: boolean } = {}) {
  const e = ENVS[envIndex]!;
  const registered = await wf.registerProfile(teamId, {
    id,
    envId: e.id,
    ownerUserId: e.ownerUserId,
    nodeName: e.nodeName!,
    cli,
    label: id,
    scopes: "all",
    maxConcurrent: options.maxConcurrent ?? 1,
  });
  expect(registered.ok).toBe(true);
  await wf.updateProfileHealth(teamId, id, { auth: "ok", online: options.online ?? true, observedAt: Date.now() }, `h-${id}-${Date.now()}`);
}

const claudePlan = (workstreams: object[]) => () => ({
  exitCode: 0,
  timedOut: false,
  stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ rationale: "One stream.", workstreams }) }),
});
const API = { role: "api", title: "API", brief: "Add member endpoints.", why: "Server files.", ownership: ["src/api/**"], dependsOn: [] };
const PROMPT = `Add a team settings page with an API. ${"Members can be listed, invited and removed, with validation and audit logging. ".repeat(5)}`;

async function task(teamId: string, taskId: string): Promise<TaskRecord> {
  const t = await wf.getTask(teamId, taskId);
  expect(t).not.toBeNull();
  return t!;
}

/** A started split task with one worker (on `cp-alpha`). */
async function running(w: World, body: Partial<CreateTaskBody> = {}): Promise<TaskRecord> {
  w.vm.planner = claudePlan([API]);
  const { taskId } = await w.orch.service.create(w.teamId, "u-owner", {
    projectId: PROJECT.id,
    prompt: PROMPT,
    acceptance: ["members can be removed"],
    maxAgents: 3,
    mode: "auto",
    pins: [],
    strategy: "split",
    harnesses: [],
    ...body,
  });
  await settle(w.orch);
  expect((await task(w.teamId, taskId)).status).toBe("planned");
  // The planner may run on any profile; only a Claude one parses this fake's output, so read the plan's first stream.
  const first = (await task(w.teamId, taskId)).workstreams[0]!.id;
  await w.orch.service.start(w.teamId, taskId, { picks: [{ workstreamId: first, profileId: "cp-alpha" }] });
  return task(w.teamId, taskId);
}

// Every request gets its own key unless a test retries one on purpose, as the browser does.
let keySeq = 0;
const freshKey = () => `k-${Date.now().toString(36)}${(++keySeq).toString(36).padStart(8, "0")}`;
const toProfile = (id: string, text = "Add tests for the members API.", key = freshKey()) => ({ to: { kind: "profile" as const, id }, text, key });
const toEnv = (id: string, text = "Review the API as it lands.", key = freshKey()) => ({ to: { kind: "env" as const, id }, text, key });

describe.skipIf(!ready)("add an agent (real Terse)", () => {
  test("on a profile: a new workstream and worker with the message as its brief, a notice, and a retry adds it once", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    await addProfile(w.teamId, "cp-beta", 1, "codex");
    const t = await running(w);

    const res = await w.orch.service.message(w.teamId, t.id, "u-mate", toProfile("cp-beta", undefined, KEY));
    expect(TaskMessageResponse.safeParse(res).success).toBe(true);
    expect(res.lease).toMatchObject({ profileId: "cp-beta", workstreamId: "ws-helper", state: "reserved" });
    const after = await task(w.teamId, t.id);
    expect(after.workstreams.map((x) => [x.id, x.status])).toEqual([
      [t.workstreams[0]!.id, "active"],
      ["ws-helper", "active"],
    ]);
    expect(after.workstreams[1]).toMatchObject({ title: "Add tests for the members API.", ownership: ["**"], dependsOn: [] });
    expect(after.workstreams[1]!.brief).toContain("mate (h-mate) added you to this task while it was running");
    // Everyone in the channel hears it, from Morrow, keyed by the lease.
    const notice = w.relay.posts.find((p) => p.key === `add-${res.lease!.id}`);
    expect(notice?.text).toBe(`mate added ${res.lease!.agentName} (Codex on e-beta) to this task: "Add tests for the members API."`);
    expect(notice?.speaker.kind).not.toBe("human");
    expect(res.message?.text).toBe(notice?.text);

    // Same caller, same key: the same worker comes back and nothing else is added.
    const again = await w.orch.service.message(w.teamId, t.id, "u-mate", toProfile("cp-beta", undefined, KEY));
    expect(again.lease).toEqual(res.lease);
    expect((await task(w.teamId, t.id)).workstreams).toHaveLength(2);

    // The dispatcher starts it with the message inside the task's full brief.
    await pump(w.orch, w.teamId);
    const spawn = w.relay.spawns.find((s) => s.name === res.lease!.agentName);
    expect(spawn).toBeDefined();
    expect(spawn!.cli).toBe("codex");
    expect(spawn!.task).toContain("## Your part");
    expect(spawn!.task).toContain("Add tests for the members API.");
    expect(spawn!.task).toContain("## The whole task");
    expect(spawn!.task).toContain(`DONE ${res.lease!.id}`);
  }, 60_000);

  test("one member's key never replays another's request", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    await addProfile(w.teamId, "cp-beta", 1, "codex", { maxConcurrent: 2 });
    const t = await running(w);
    const first = await w.orch.service.message(w.teamId, t.id, "u-mate", toProfile("cp-beta", undefined, KEY));
    const second = await w.orch.service.message(w.teamId, t.id, "u-third", toProfile("cp-beta", undefined, KEY));
    expect(second.lease!.id).not.toBe(first.lease!.id);
    expect((await task(w.teamId, t.id)).workstreams.map((x) => x.id)).toEqual([t.workstreams[0]!.id, "ws-helper", "ws-helper2"]);
  }, 60_000);

  test("on a VM: the best free profile there; a VM with none says why", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    await addProfile(w.teamId, "cp-beta", 1, "codex");
    await addProfile(w.teamId, "cp-beta2", 1, "claude", { online: false });
    const t = await running(w);
    // e-alpha's only profile already runs this task's worker: its own reason.
    await expect(w.orch.service.message(w.teamId, t.id, "u-owner", toEnv("e-alpha"))).rejects.toMatchObject({ status: 409, message: "cp-alpha has no free slot." });
    const res = await w.orch.service.message(w.teamId, t.id, "u-owner", toEnv("e-beta", "Review the API.", "k-fedcba9876543210"));
    expect(res.lease?.profileId).toBe("cp-beta");
    // A retry finds the VM full now, and still gets the worker it already added.
    const again = await w.orch.service.message(w.teamId, t.id, "u-owner", toEnv("e-beta", "Review the API.", "k-fedcba9876543210"));
    expect(again.lease).toEqual(res.lease);
    // A new request: cp-beta is full now and cp-beta2 is offline.
    await expect(w.orch.service.message(w.teamId, t.id, "u-owner", toEnv("e-beta"))).rejects.toMatchObject({
      status: 409,
      message: "No agent on e-beta can take this task's work right now. Each one is busy, offline, signed out or cooling down.",
    });
    await expect(w.orch.service.message(w.teamId, t.id, "u-owner", toEnv("e-ghost"))).rejects.toMatchObject({ status: 404, message: "That VM is not part of this team." });
  }, 60_000);

  test("refusals: unknown, offline, busy, the caps, a planned or compare task, a missing key", async () => {
    const w = world({ allowInspect: true, maxParallelPerTask: 2 });
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    await addProfile(w.teamId, "cp-beta", 1, "codex");
    await addProfile(w.teamId, "cp-gamma", 1, "claude", { online: false });
    await addProfile(w.teamId, "cp-delta", 1, "opencode", { maxConcurrent: 2 });
    const t = await running(w);
    const send = (body: Parameters<Orchestration["service"]["message"]>[3]) => w.orch.service.message(w.teamId, t.id, "u-mate", body);

    await expect(send(toProfile("cp-ghost"))).rejects.toMatchObject({ status: 404, message: "That agent is not part of this team." });
    await expect(send(toProfile("cp-gamma"))).rejects.toMatchObject({ status: 409, message: "cp-gamma is offline." });
    await expect(send(toProfile("cp-alpha"))).rejects.toMatchObject({ status: 409, message: "cp-alpha has no free slot." });
    await expect(send({ to: { kind: "profile", id: "cp-beta" }, text: "hi" })).rejects.toMatchObject({ status: 400 });

    // The team allows two at once: one worker plus one added, then no more.
    expect((await send(toProfile("cp-beta"))).lease?.profileId).toBe("cp-beta");
    await expect(send(toProfile("cp-delta", "More hands.", "k-aaaaaaaaaaaaaaaa"))).rejects.toMatchObject({
      status: 409,
      message: "This task already runs 2 agents, its limit. Wait for one to finish, then add another.",
    });
    expect((await task(w.teamId, t.id)).workstreams).toHaveLength(2);

    // A planned task is still up for review; a compare task runs one attempt per harness.
    w.vm.planner = claudePlan([API]);
    const planned = await w.orch.service.create(w.teamId, "u-owner", { projectId: PROJECT.id, prompt: PROMPT, acceptance: [], maxAgents: 3, mode: "auto", pins: [], strategy: "split", harnesses: [] });
    await settle(w.orch);
    await expect(w.orch.service.message(w.teamId, planned.taskId, "u-mate", toProfile("cp-delta"))).rejects.toMatchObject({
      status: 409,
      message: "Agents can only be added while the task is running.",
    });
    const compare = await w.orch.service.create(w.teamId, "u-owner", { projectId: PROJECT.id, prompt: PROMPT, acceptance: [], maxAgents: 2, mode: "auto", pins: [], strategy: "compare", harnesses: ["claude", "codex"] });
    await expect(w.orch.service.message(w.teamId, compare.taskId, "u-mate", toProfile("cp-delta"))).rejects.toMatchObject({
      status: 409,
      message: "A compare task runs one attempt per harness, so it can't take another agent. Start a new task instead.",
    });
  }, 60_000);

  test("a manual task only takes a pinned profile", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    await addProfile(w.teamId, "cp-beta", 1, "codex");
    await addProfile(w.teamId, "cp-beta2", 1, "claude");
    const t = await running(w, { mode: "manual", pins: ["cp-alpha"] });
    await expect(w.orch.service.message(w.teamId, t.id, "u-mate", toProfile("cp-beta"))).rejects.toMatchObject({
      status: 409,
      message: "cp-beta is not one of the profiles picked for this task.",
    });
    await expect(w.orch.service.message(w.teamId, t.id, "u-mate", toEnv("e-beta"))).rejects.toMatchObject({
      status: 409,
      message: "No agent on e-beta can take this task's work right now. Each one is busy, offline, signed out, cooling down or not picked for this task.",
    });
    // The pinned profile itself is full, so a VM with only it says why in its own words.
    await expect(w.orch.service.message(w.teamId, t.id, "u-mate", toEnv("e-alpha"))).rejects.toMatchObject({ status: 409, message: "cp-alpha has no free slot." });
  }, 60_000);

  test("direct messages still only reach a live worker of this task, in both forms", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-alpha", 0, "claude");
    const t = await running(w);
    const lease = (await wf.getLease(w.teamId, t.workstreams[0]!.leaseId!))!;
    const typed = await w.orch.service.message(w.teamId, t.id, "u-mate", { to: { kind: "worker", name: lease.agentName }, text: "status?" });
    expect(typed.message?.text).toBe("status?");
    expect(w.relay.posts.at(-1)?.to).toBe(lease.agentName);
    await expect(w.orch.service.message(w.teamId, t.id, "u-mate", { to: { kind: "worker", name: "w-other-api-e9" }, text: "hi" })).rejects.toMatchObject({ status: 404 });
    await expect(w.orch.service.message(w.teamId, t.id, "u-mate", { to: "h-owner", text: "hi" })).rejects.toMatchObject({ status: 404 });
  }, 60_000);
});
