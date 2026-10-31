// Compare tasks end to end (docs/multi-harness.md) against a real local Terse: one task, several harnesses at once,
// each on its own branch, and a person picks the attempt to ship. Relay, the VMs and GitHub are the fakes from
// ./fakes.ts; loops are driven by hand (tickMs 0).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TaskDetail, type CliKind, type Role } from "@morrow/contracts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ActorGateway, UserRecord } from "../../src/actors/types.ts";
import type { Keys } from "../../src/http/context.ts";
import { SESSION_COOKIE } from "../../src/http/session.ts";
import type { GithubClient } from "../../src/integrations/github/client.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { createOrchestration, type Orchestration } from "../../src/orchestration/index.ts";
import { taskShort } from "../../src/orchestration/names.ts";
import { createWorkforceClient, type TaskRecord, type WorkforceApi } from "../../src/orchestration/workforce.ts";
import { RuntimeBus } from "../../src/runtime/bus.ts";
import { makeTestApp, type TestApp } from "../support/app.ts";
import { testEnv } from "../support/env.ts";
import { ENVS, FakeGit, FakeRelay, FakeRuntime, FakeVm, message, PROJECT, teamGateway, teamRecord } from "./fakes.ts";

const TEST_SERVER = resolve(import.meta.dir, "../../../actors/scripts/test-server.ts");
const ready = existsSync(TEST_SERVER) && existsSync(resolve(import.meta.dir, "../../src/generated/index.d.ts"));
if (!ready) console.warn("SKIP compare flow: Terse test server or generated client missing");

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
  git: FakeGit;
  policy: { allowInspect: boolean; maxParallelPerTask: number };
  plannerCalls: number;
  orch: Orchestration;
}

let teamSeq = 0;
function world(): World {
  const teamId = `t-cmp${Date.now().toString(36)}${++teamSeq}`;
  const shas = new Set<string>();
  const relay = new FakeRelay();
  const vm = new FakeVm(shas);
  const git = new FakeGit(shas);
  const policy = { allowInspect: true, maxParallelPerTask: 3 };
  const orch = createOrchestration({
    deps: { env, log: silentLogger, actors: teamGateway(policy), github: {} as GithubClient, keys: {} as Keys, now: Date.now },
    runtime: new FakeRuntime(),
    bus: new RuntimeBus(silentLogger),
    options: { ports: { vm, relay, git, githubToken: async () => "gho_testtoken" }, workforce: wf, tickMs: 0, listTeams: async () => [] },
  });
  const w: World = { teamId, relay, vm, git, policy, plannerCalls: 0, orch };
  vm.planner = () => {
    w.plannerCalls++;
    return { exitCode: 1, timedOut: false, stdout: "", stderr: "" };
  };
  return w;
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

async function addProfile(teamId: string, id: string, envIndex: number, cli: CliKind) {
  const e = ENVS[envIndex]!;
  const registered = await wf.registerProfile(teamId, { id, envId: e.id, ownerUserId: e.ownerUserId, nodeName: e.nodeName!, cli, label: id, scopes: "all", maxConcurrent: 2 });
  expect(registered.ok).toBe(true);
  await wf.updateProfileHealth(teamId, id, { auth: "ok", online: true, observedAt: Date.now() }, `h-${id}-${Date.now()}`);
}

/** Two machines with two CLIs each: ada's (e-alpha) runs Claude Code and Codex, grace's (e-beta) Codex and opencode. */
async function pool(w: World) {
  await addProfile(w.teamId, "cp-claude", 0, "claude");
  await addProfile(w.teamId, "cp-codex-a", 0, "codex");
  await addProfile(w.teamId, "cp-codex-b", 1, "codex");
  await addProfile(w.teamId, "cp-opencode", 1, "opencode");
}

async function task(teamId: string, taskId: string): Promise<TaskRecord> {
  const t = await wf.getTask(teamId, taskId);
  expect(t).not.toBeNull();
  return t!;
}

const PROMPT = "Add a team settings page with member invites and removal.";

async function createCompare(w: World, harnesses: CliKind[], by = "u-owner"): Promise<TaskRecord> {
  const { taskId } = await w.orch.service.create(w.teamId, by, {
    projectId: PROJECT.id,
    prompt: PROMPT,
    acceptance: ["Members list renders"],
    maxAgents: 3,
    mode: "auto",
    pins: [],
    strategy: "compare",
    harnesses,
  });
  await settle(w.orch);
  return task(w.teamId, taskId);
}

async function liveLease(teamId: string, taskId: string, workstreamId: string) {
  const t = await task(teamId, taskId);
  const leaseId = t.workstreams.find((x) => x.id === workstreamId)!.leaseId!;
  return (await wf.getLease(teamId, leaseId))!;
}

function say(w: World, from: string, text: string) {
  w.orch.monitor.handle({ kind: "message", teamId: w.teamId, message: message(from, text), seq: null });
}

/** Starts a compare task and spawns every attempt. */
async function running(w: World, harnesses: CliKind[], by = "u-owner") {
  const created = await createCompare(w, harnesses, by);
  await w.orch.service.start(w.teamId, created.id, {});
  await pump(w.orch, w.teamId);
  const leases = Object.fromEntries(await Promise.all(harnesses.map(async (cli) => [cli, await liveLease(w.teamId, created.id, `ws-${cli}`)] as const)));
  return { taskId: created.id, leases };
}

async function finish(w: World, lease: { id: string; agentName: string }, summary: string) {
  say(w, lease.agentName, `DONE ${lease.id} ${summary}`);
  await settle(w.orch);
}

type Caller = TestApp & { call(who: string, method: string, path: string, body?: unknown): Promise<Response>; cookie(who: string): string | undefined };

async function appFor(w: World): Promise<Caller> {
  const people: Array<[string, Role | null]> = [
    ["u-owner", "owner"],
    ["u-mate", "member"],
    ["u-third", "member"],
    ["u-admin", "admin"],
    ["u-out", null],
  ];
  const users = new Map<string, UserRecord>(
    people.map(([id, role]) => [id, { id, githubId: 1, login: id.slice(2), name: null, avatarUrl: null, email: null, sessionVersion: 1, teamIds: role ? [w.teamId] : [] }]),
  );
  const actors = {
    getUser: async (id: string) => users.get(id) ?? null,
    getTeam: async (id: string) => (id === w.teamId ? teamRecord(id) : null),
  } as unknown as ActorGateway;
  const app = await makeTestApp({ actors, env: { DURABLE_ACTORS_CONTROL_PLANE_URL: terse.url, DURABLE_ACTORS_SECRET: terse.secret }, modules: [w.orch.routes] });
  const cookies = new Map<string, string>();
  for (const [id] of people) cookies.set(id, `${SESSION_COOKIE}=${await app.deps.sessions.encode({ uid: id, sv: 1, exp: Date.now() + 3_600_000 })}`);
  return {
    ...app,
    cookie: (who) => cookies.get(who),
    call: (who, method, path, body) =>
      app.request(path, {
        method,
        csrf: method !== "GET",
        cookie: cookies.get(who),
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

const errorOf = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;

describe.skipIf(!ready)("compare tasks (real Terse)", () => {
  test("create records one attempt per harness at once, with no planner run, and never replans", async () => {
    const w = world();
    await pool(w);
    const t = await createCompare(w, ["claude", "codex", "opencode"]);
    expect(w.plannerCalls).toBe(0);
    expect(t).toMatchObject({ status: "planned", strategy: "compare", pickedWorkstreamId: null, maxAgents: 3 });
    expect(t.plan).toMatchObject({ source: "compare", warnings: [], profileId: null });
    const short = taskShort(t.id);
    expect(t.workstreams.map((x) => [x.id, x.role, x.harness, x.branch, x.ownership, x.dependsOn])).toEqual([
      ["ws-claude", "claude", "claude", `morrow/${short}/claude`, ["**"], []],
      ["ws-codex", "codex", "codex", `morrow/${short}/codex`, ["**"], []],
      ["ws-opencode", "opencode", "opencode", `morrow/${short}/opencode`, ["**"], []],
    ]);
    expect(t.workstreams[0]!.title).toBe(`Claude Code attempt: ${PROMPT}`);
    expect(t.workstreams.every((x) => x.brief.includes(PROMPT) && x.brief.includes("- Members list renders"))).toBe(true);
    await expect(w.orch.service.replan(w.teamId, t.id, { maxAgents: 3, pins: [] })).rejects.toThrow("A compare task has no plan to refine");
    // The detail the browser reads parses with the shared contract.
    expect(TaskDetail.safeParse(await w.orch.service.detail(w.teamId, t.id)).success).toBe(true);
  }, 60_000);

  test("the HTTP body is checked: distinct harnesses, at least 2, none for split, and the team's per-task cap", async () => {
    const w = world();
    await pool(w);
    const app = await appFor(w);
    const create = (body: object) =>
      app.call("u-owner", "POST", `/api/teams/${w.teamId}/tasks`, { projectId: PROJECT.id, prompt: PROMPT, acceptance: [], maxAgents: 3, mode: "auto", pins: [], ...body });
    const refused = async (body: object, message: string) => {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain(message);
    };
    await refused({ strategy: "compare", harnesses: ["claude"] }, "Pick at least 2 harnesses to compare.");
    await refused({ strategy: "compare", harnesses: ["claude", "claude"] }, "Pick each harness once.");
    await refused({ strategy: "split", harnesses: ["claude", "codex"] }, "Harnesses are only picked for Compare.");
    await refused({ strategy: "compare", harnesses: ["claude", "aider"] }, "harnesses");
    await refused({ strategy: "compare", harnesses: ["claude", "codex", "opencode", "claude"] }, "harnesses");
    w.policy.maxParallelPerTask = 2;
    await refused({ strategy: "compare", harnesses: ["claude", "codex", "opencode"] }, "This team runs at most 2 workers per task. Pick 2 harnesses or fewer, or use Split.");
    const ok = await create({ strategy: "compare", harnesses: ["codex", "claude"] });
    expect(ok.status).toBe(202);
    // A body without a strategy is a split task, as before.
    const legacy = await create({});
    expect(legacy.status).toBe(202);
    const { taskId } = (await legacy.json()) as { taskId: string };
    expect((await task(w.teamId, taskId)).strategy).toBe("split");
  }, 60_000);

  test("start places each attempt on a profile of its own harness, and the brief says the attempts are independent", async () => {
    const w = world();
    await pool(w);
    const { taskId, leases } = await running(w, ["claude", "codex", "opencode"]);
    expect(leases.claude!.profileId).toBe("cp-claude");
    expect(["cp-codex-a", "cp-codex-b"]).toContain(leases.codex!.profileId);
    expect(leases.opencode!.profileId).toBe("cp-opencode");
    expect((await task(w.teamId, taskId)).status).toBe("running");
    expect(w.relay.spawns).toHaveLength(3);
    for (const spawn of w.relay.spawns) {
      expect(spawn.channels).toEqual(["proj-proj0000demo"]);
      expect(spawn.task).toContain("## Compare");
      expect(spawn.task).toContain("Never merge, copy or check out another attempt's branch.");
    }
    // A pick that names a profile of another CLI is refused before anything is reserved.
    const w2 = world();
    await pool(w2);
    const t2 = await createCompare(w2, ["claude", "codex"]);
    await expect(w2.orch.service.start(w2.teamId, t2.id, { picks: [{ workstreamId: "ws-claude", profileId: "cp-codex-a" }] })).rejects.toThrow("runs a different CLI than that attempt");
    expect((await task(w2.teamId, t2.id)).status).toBe("planned");
  }, 60_000);

  test("with no profile of a picked harness, start says which harness is missing", async () => {
    const w = world();
    await addProfile(w.teamId, "cp-claude", 0, "claude");
    const t = await createCompare(w, ["claude", "opencode"]);
    await expect(w.orch.service.start(w.teamId, t.id, {})).rejects.toThrow("No ready opencode profile has a free slot. Connect one, wait for one to free up, or start a new task without it.");
  }, 60_000);

  test("a finished attempt is told to the others without a merge line; the task waits in choosing", async () => {
    const w = world();
    await pool(w);
    const { taskId, leases } = await running(w, ["claude", "codex"]);
    await finish(w, leases.codex!, "Invites are a modal");
    await w.orch.comms.pass(w.teamId);
    const done = w.relay.posts.filter((p) => p.notice?.kind === "workstream_done");
    expect(done).toHaveLength(1);
    expect(done[0]!.to).toBe(leases.claude!.agentName);
    expect(done[0]!.text).toContain("The Codex attempt finished on branch");
    expect(done[0]!.text).toContain("Keep going with your own attempt.");
    expect(done[0]!.text).not.toContain("git merge");
    expect((await task(w.teamId, taskId)).status).toBe("running");

    await finish(w, leases.claude!, "Invites are a page");
    const t = await task(w.teamId, taskId);
    expect(t.status).toBe("choosing");
    // Nothing is verified or merged without a pick, however many scheduler passes run.
    await w.orch.scheduler.pass(w.teamId);
    await settle(w.orch);
    expect((await task(w.teamId, taskId)).status).toBe("choosing");
    expect(w.git.merges).toEqual([]);
  }, 60_000);

  test("pick over HTTP: creator or admin only, verifies and merges the picked branch only, tells the channel", async () => {
    const w = world();
    await pool(w);
    const app = await appFor(w);
    const { taskId, leases } = await running(w, ["claude", "codex", "opencode"], "u-mate");
    const base = `/api/teams/${w.teamId}/tasks/${taskId}`;
    const pick = (who: string, workstreamId: string | null, id = taskId) => app.call(who, "POST", `/api/teams/${w.teamId}/tasks/${id}/pick`, { workstreamId });

    // Nothing finished yet.
    let res = await pick("u-mate", null);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("No attempt has finished yet. Cancel the task to stop them all.");

    await finish(w, leases.codex!, "Invites are a modal");
    // Unfinished attempt, unknown attempt, bad body.
    res = await pick("u-mate", "ws-claude");
    expect([res.status, await errorOf(res)]).toEqual([409, "That attempt has not finished yet."]);
    expect((await pick("u-mate", "ws-nope")).status).toBe(404);
    expect((await app.call("u-mate", "POST", `${base}/pick`, { workstreamId: "../x" })).status).toBe(400);
    expect((await app.call("u-mate", "POST", `${base}/pick`, {})).status).toBe(400);

    // Who may pick: not another plain member, not an outsider (404 like a missing task), CSRF required.
    res = await pick("u-third", "ws-codex");
    expect([res.status, await errorOf(res)]).toEqual([403, "Only the task's creator or a team admin can pick an attempt."]);
    expect((await pick("u-out", "ws-codex")).status).toBe(404);
    expect((await pick("u-mate", "ws-codex", "tk-missing")).status).toBe(404);
    expect((await app.request(`${base}/pick`, { method: "POST", csrf: false, cookie: app.cookie("u-mate"), headers: { "content-type": "application/json" }, body: '{"workstreamId":"ws-codex"}' })).status).toBe(403);

    // An admin picks Codex while Claude and opencode still run: they are stopped.
    res = await pick("u-admin", "ws-codex");
    expect(res.status).toBe(200);
    const picked = (await res.json()) as { status: string; releasedLeaseIds: string[] };
    expect(picked.status).toBe("verifying");
    expect(new Set(picked.releasedLeaseIds)).toEqual(new Set([leases.claude!.id, leases.opencode!.id]));
    await pump(w.orch, w.teamId);
    expect(w.relay.releases).toEqual(expect.arrayContaining([leases.claude!.agentName, leases.opencode!.agentName]));
    const notice = w.relay.posts.find((p) => p.key === `pick-${taskId}`);
    expect(notice?.to).toBe("proj-proj0000demo");
    expect(notice?.text).toContain(`admin picked the Codex attempt on morrow/${taskShort(taskId)}/codex`);
    expect(notice?.text).toContain("The other attempts are stopped.");

    // A second pick is refused (already picked, or already verified and finished).
    res = await pick("u-mate", null);
    expect(res.status).toBe(409);
    expect(["An attempt was already picked.", "This task has already finished."]).toContain(await errorOf(res));

    await w.orch.scheduler.pass(w.teamId);
    await settle(w.orch);
    const t = await task(w.teamId, taskId);
    expect(t.status).toBe("completed");
    expect(t.pickedWorkstreamId).toBe("ws-codex");
    expect(t.workstreams.map((x) => [x.id, x.status])).toEqual([
      ["ws-claude", "failed"],
      ["ws-codex", "done"],
      ["ws-opencode", "failed"],
    ]);
    const codexSha = t.workstreams.find((x) => x.id === "ws-codex")!.lastCheckpoint!.sha;
    expect(w.git.merges).toEqual([{ base: `morrow/${taskShort(taskId)}/integration`, head: codexSha }]);
    expect(t.trace.filter((e) => e.kind === "task.attempt_picked")).toHaveLength(1);
    // Picking a finished task is refused.
    expect((await pick("u-admin", "ws-codex")).status).toBe(409);
  }, 90_000);

  test("finish without shipping: no verification, no merge, everything released", async () => {
    const w = world();
    await pool(w);
    const { taskId, leases } = await running(w, ["claude", "codex"]);
    await finish(w, leases.claude!, "Found three bugs in the invite flow");
    const result = await w.orch.service.pick(w.teamId, taskId, "u-owner", "owner", { workstreamId: null });
    expect(result).toEqual({ status: "completed", releasedLeaseIds: [leases.codex!.id] });
    await pump(w.orch, w.teamId);
    await w.orch.scheduler.pass(w.teamId);
    await settle(w.orch);
    const t = await task(w.teamId, taskId);
    expect(t.status).toBe("completed");
    expect(t.pickedWorkstreamId).toBeNull();
    expect(t.verification?.checks.map((c) => [c.name, c.status, c.detail])).toEqual([["Ship", "skipped", "Nothing shipped: the team kept the findings."]]);
    expect(w.git.merges).toEqual([]);
    expect(w.relay.posts.find((p) => p.key === `pick-${taskId}`)?.text).toContain("without shipping an attempt");
  }, 60_000);

  test("a picked attempt that conflicts gets a resolver; a retry re-verifies the pick only", async () => {
    const w = world();
    await pool(w);
    const { taskId, leases } = await running(w, ["claude", "codex"]);
    await finish(w, leases.claude!, "done");
    await finish(w, leases.codex!, "done");
    expect((await task(w.teamId, taskId)).status).toBe("choosing");
    const claudeSha = (await task(w.teamId, taskId)).workstreams.find((x) => x.id === "ws-claude")!.lastCheckpoint!.sha;
    w.git.conflictOn = claudeSha;
    await w.orch.service.pick(w.teamId, taskId, "u-owner", "owner", { workstreamId: "ws-claude" });
    await w.orch.scheduler.pass(w.teamId);
    await settle(w.orch);
    let t = await task(w.teamId, taskId);
    expect(t.status).toBe("resolving");
    expect(t.workstreams.map((x) => x.id)).toContain("ws-resolver");
    expect(w.git.merges.some((m) => m.head === t.workstreams.find((x) => x.id === "ws-codex")!.lastCheckpoint!.sha)).toBe(false);

    // The resolver gives up twice, the task fails; a retry keeps the pick and never reopens Codex.
    for (let i = 0; i < 2; i++) {
      await pump(w.orch, w.teamId);
      const lease = await liveLease(w.teamId, taskId, "ws-resolver");
      say(w, lease.agentName, `DONE ${lease.id} resolved`);
      await settle(w.orch);
      await pump(w.orch, w.teamId);
      await w.orch.scheduler.pass(w.teamId);
      await settle(w.orch);
    }
    t = await task(w.teamId, taskId);
    expect(t.status).toBe("failed");
    await w.orch.service.retry(w.teamId, taskId, "u-owner", "owner");
    t = await task(w.teamId, taskId);
    expect(t.pickedWorkstreamId).toBe("ws-claude");
    expect(t.workstreams.find((x) => x.id === "ws-codex")!.status).toBe("done");
    expect(["verifying", "resolving"]).toContain(t.status);
  }, 90_000);

  test("an attempt whose CLI hits its limit hands off only to the same harness, or waits", async () => {
    const w = world();
    await pool(w);
    const { taskId, leases } = await running(w, ["codex", "opencode"]);
    const codex = leases.codex!;
    const oc = leases.opencode!;
    const otherCodex = codex.profileId === "cp-codex-a" ? "cp-codex-b" : "cp-codex-a";
    // Both attempts hit their plan's limit. Codex has a second profile; opencode has none, and Claude Code (free)
    // must not take its place.
    await addProfile(w.teamId, "cp-claude-2", 1, "claude");
    for (const lease of [codex, oc]) w.vm.logs.set(lease.agentName, "working...\nYou've hit your usage limit. Try again later.\n");
    await w.orch.monitor.watch(w.teamId);
    expect((await wf.getLease(w.teamId, codex.id))!.state).toBe("expired");
    expect((await wf.getLease(w.teamId, oc.id))!.state).toBe("expired");
    await pump(w.orch, w.teamId);
    await w.orch.scheduler.pass(w.teamId);
    await pump(w.orch, w.teamId);

    const second = await liveLease(w.teamId, taskId, "ws-codex");
    expect(second.id).not.toBe(codex.id);
    expect(second.profileId).toBe(otherCodex);
    const t = await task(w.teamId, taskId);
    const ws = t.workstreams.find((x) => x.id === "ws-opencode")!;
    const lease = ws.leaseId ? await wf.getLease(w.teamId, ws.leaseId) : null;
    expect(lease?.id ?? null).toBe(oc.id);
    expect(lease?.state).toBe("expired");
    expect(t.status).toBe("handoff");
  }, 90_000);
});
