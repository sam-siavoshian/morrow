// Unfinished work resumes after a backend restart and after a Terse restart, on a real local Terse: the team is found
// through the TeamDirectory actor (the control plane inventory is empty or ignored), and the TeamWorkforce socket feed
// reconnects on its own. Relay, VMs and GitHub are the fakes from ./fakes.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createActorGateway } from "../../src/actors/gateway.ts";
import type { ActorGateway } from "../../src/actors/types.ts";
import type { Keys } from "../../src/http/context.ts";
import type { GithubClient } from "../../src/integrations/github/client.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { createTeamDirectoryClient } from "../../src/orchestration/directory.ts";
import { createOrchestration, type Orchestration } from "../../src/orchestration/index.ts";
import { createWorkforceClient, listWorkforceTeamIds, type WorkforceApi } from "../../src/orchestration/workforce.ts";
import { RuntimeBus } from "../../src/runtime/bus.ts";
import { testEnv } from "../support/env.ts";
import { ENVS, FakeGit, FakeRelay, FakeRuntime, FakeVm, PROJECT, teamGateway } from "./fakes.ts";

const TEST_SERVER = resolve(import.meta.dir, "../../../actors/scripts/test-server.ts");
const ready = existsSync(TEST_SERVER);

type TerseServer = { url: string; secret: string; stop(): Promise<void>; restart(): Promise<void> };
let terse: TerseServer;
let env: ReturnType<typeof testEnv>;
let wf: WorkforceApi;

beforeAll(async () => {
  if (!ready) return;
  const { startTestServer } = (await import(TEST_SERVER)) as { startTestServer: () => Promise<TerseServer> };
  terse = await startTestServer();
  env = testEnv({ DURABLE_ACTORS_CONTROL_PLANE_URL: terse.url, DURABLE_ACTORS_SECRET: terse.secret });
  wf = createWorkforceClient(env.terse, silentLogger);
}, 300_000);
afterAll(async () => {
  await terse?.stop();
}, 30_000);

const PLAN = [{ role: "api", title: "API", brief: "Add member endpoints.", why: "Server files.", ownership: ["src/api/**"], dependsOn: [] }];
const claudePlan = () => () => ({
  exitCode: 0,
  timedOut: false,
  stderr: "",
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ rationale: "One stream.", workstreams: PLAN }) }),
});

function world() {
  const teamId = `t-rs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const shas = new Set<string>();
  const relay = new FakeRelay();
  const vm = new FakeVm(shas);
  vm.planner = claudePlan();
  const git = new FakeGit(shas);
  const runtime = new FakeRuntime();
  const real = createActorGateway(env.terse, silentLogger);
  // Team lookups from the fake team; sockets through the real gateway (backend identity).
  const fake = teamGateway();
  const actors = new Proxy(fake, { get: (t, p) => (p === "prepareSocket" ? real.prepareSocket : Reflect.get(t, p)) }) as ActorGateway;
  const make = (listTeams: () => Promise<string[]>): Orchestration => {
    const orch = createOrchestration({
      deps: { env, log: silentLogger, actors, github: {} as GithubClient, keys: {} as Keys, now: () => Date.now() },
      runtime,
      bus: new RuntimeBus(silentLogger),
      options: {
        ports: { vm, relay, git, githubToken: async () => "gho_test" },
        workforce: wf,
        tickMs: 0,
        partners: false,
        listTeams,
        directory: createTeamDirectoryClient(env.terse, silentLogger),
        feed: "actors",
      },
    });
    return orch;
  };
  return { teamId, relay, make };
}

async function waitUntil(check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

async function settle(orch: Orchestration, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let idle = 0; idle < 3; ) {
    if (Date.now() > deadline) throw new Error(`lanes still busy: ${orch.ctx.lanes.size}`);
    idle = orch.ctx.lanes.size === 0 ? idle + 1 : 0;
    await Bun.sleep(20);
  }
}

/** A task planned and started, its spawn items left in the outbox by a process that then died. */
async function abandonedStart(w: ReturnType<typeof world>): Promise<string> {
  const first = w.make(async () => []);
  const e = ENVS[0]!;
  expect((await wf.registerProfile(w.teamId, { id: "cp-a", envId: e.id, ownerUserId: e.ownerUserId, nodeName: e.nodeName!, cli: "claude", label: "a", scopes: "all", maxConcurrent: 2 })).ok).toBe(true);
  await wf.updateProfileHealth(w.teamId, "cp-a", { auth: "ok", online: true, observedAt: Date.now() }, `h-${Date.now()}`);
  const { taskId } = await first.service.create(w.teamId, "u-owner", { projectId: PROJECT.id, prompt: "Add member endpoints with tests.", acceptance: [], maxAgents: 1, mode: "auto", pins: [], strategy: "split", harnesses: [] });
  await settle(first);
  const reserved = await wf.reserveWorkers(w.teamId, taskId, [{ workstreamId: "ws-api", profileId: "cp-a" }], `rw-${crypto.randomUUID()}`);
  expect(reserved.ok).toBe(true);
  await first.stop();
  expect(w.relay.spawns).toHaveLength(0);
  return taskId;
}

/** Ticks a fresh process until the spawn left behind has happened. */
async function resumes(orch: Orchestration, w: ReturnType<typeof world>): Promise<void> {
  orch.start();
  const deadline = Date.now() + 60_000;
  while (w.relay.spawns.length === 0) {
    if (Date.now() > deadline) throw new Error("the abandoned spawn never ran");
    orch.tick();
    await settle(orch);
    await Bun.sleep(200);
  }
  await settle(orch);
}

describe.skipIf(!ready)("restarts (real Terse)", () => {
  test("backend restart: a fresh process with an empty inventory finds the team in the directory and resumes", async () => {
    const w = world();
    const taskId = await abandonedStart(w);
    const fresh = w.make(async () => []);
    await resumes(fresh, w);
    expect(w.relay.spawns).toHaveLength(1);
    expect((await wf.getTask(w.teamId, taskId))!.status).not.toBe("planned");
    // The fresh process holds a live socket to the team.
    await waitUntil(() => fresh.feed!.live(w.teamId));
    await fresh.stop();
  }, 180_000);

  test("Terse restart: inventory and alarms are gone; the directory and the feed bring the work back", async () => {
    const w = world();
    await abandonedStart(w);
    await terse.restart();
    // After a restart the control plane's inventory no longer lists the team.
    expect(await listWorkforceTeamIds(env.terse)).not.toContain(w.teamId);
    const fresh = w.make(() => listWorkforceTeamIds(env.terse));
    await resumes(fresh, w);
    expect(w.relay.spawns).toHaveLength(1);
    await fresh.stop();
  }, 300_000);

  test("Terse restart under a running process: its sockets reconnect and pushes resume", async () => {
    const w = world();
    const orch = w.make(async () => []);
    orch.track(w.teamId);
    await waitUntil(() => orch.feed!.live(w.teamId));
    await terse.restart();
    await waitUntil(() => orch.feed!.live(w.teamId), 120_000);
    // A write made by someone else after the restart arrives as a push on the reconnected socket.
    const e = ENVS[0]!;
    const revision = orch.feed!.revision(w.teamId);
    expect((await wf.registerProfile(w.teamId, { id: "cp-z", envId: e.id, ownerUserId: e.ownerUserId, nodeName: e.nodeName!, cli: "claude", label: "z", scopes: "all", maxConcurrent: 1 })).ok).toBe(true);
    await waitUntil(() => orch.feed!.revision(w.teamId) > revision);
    expect(orch.feed!.view(w.teamId)!.profiles["cp-z"]).toBeDefined();
    await orch.stop();
  }, 300_000);
});
