// Actor calls per minute for one busy team (a task with two running workers), from the orchestration loops alone:
// polling (no feed, the old behavior and the fallback) against a pushed view (a real WorkforceFeed on a local socket
// that speaks the Terse state protocol). The actors are counting fakes over a real view built by the actor's own state
// machine, and the clock is simulated, so the numbers are exact and the run is fast.
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { ActorGateway } from "../../src/actors/types.ts";
import type { GithubClient } from "../../src/integrations/github/client.ts";
import type { Keys } from "../../src/http/context.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { createWorkforceFeed, type WorkforceFeed } from "../../src/orchestration/feed.ts";
import { createOrchestration, type Orchestration } from "../../src/orchestration/index.ts";
import type { WorkforceApi } from "../../src/orchestration/workforce.ts";
import { RuntimeBus } from "../../src/runtime/bus.ts";
import { testEnv } from "../support/env.ts";
import { ENVS, FakeGit, FakeRelay, FakeRuntime, FakeVm, teamGateway } from "./fakes.ts";
import * as awf from "../../../actors/src/lib/workforce.ts";
import { summarizeOutbox } from "../../../actors/src/lib/outbox-summary.ts";

const TEAM = "t-rate";
const MINUTES = 10;

/** A team mid-task: two profiles, a planned task, two workers spawned and running. */
function busyTeam(now: number): awf.WorkforceState {
  let state: awf.WorkforceState = { profiles: {}, tasks: {}, leases: {}, outbox: {}, epoch: 0 };
  const step = <R>(run: (d: awf.WorkforceDraft) => R): R => {
    const d = new awf.WorkforceDraft(state, now);
    const result = run(d);
    awf.finalize(d);
    state = { profiles: d.profiles, tasks: d.tasks, leases: d.leases, outbox: d.outbox, epoch: d.epoch };
    return result;
  };
  ENVS.forEach((env, i) =>
    step((d) => awf.registerProfile(d, { id: `p${i + 1}`, envId: env.id, ownerUserId: env.ownerUserId, nodeName: env.nodeName!, cli: "claude", label: `P${i + 1}`, scopes: "all", maxConcurrent: 2 })),
  );
  step((d) => awf.createTask(d, { id: "tk-1", projectId: "p-proj0000demo", title: "Settings", prompt: "Build the settings page.", acceptance: ["works"], createdBy: "u-owner", maxAgents: 2 }));
  const ws = (id: string, role: string) => ({ id, role, title: role, brief: `Do ${role}.`, why: "Separate files.", branch: `morrow/tk-1/${role}`, dependsOn: [], ownership: [`src/${role}/**`] });
  step((d) => awf.recordPlan(d, "tk-1", { source: "fallback", profileId: null, rationale: "Split.", warnings: [], workstreams: [ws("ws-api", "api"), ws("ws-web", "web")] }));
  const reserved = step((d) => awf.reserveWorkers(d, "tk-1", [{ workstreamId: "ws-api", profileId: "p1" }, { workstreamId: "ws-web", profileId: "p2" }]));
  if (!reserved.ok) throw new Error(JSON.stringify(reserved));
  for (const claim of step((d) => awf.claimOutbox(d, 10))) step((d) => awf.completeOutbox(d, claim.id, { ok: true, invocationId: `inv-${claim.leaseId}`, sha: null, detail: null }));
  for (const lease of reserved.leases) step((d) => awf.recordSpawnStatus(d, lease.id, lease.epoch, "running", `inv-${lease.id}`));
  return state;
}

/** Counts every call by method; answers from the fixed state like the actor would. */
function countingWorkforce(state: awf.WorkforceState) {
  const calls = new Map<string, number>();
  const view = awf.buildWorkforceView(state);
  const notified = Object.fromEntries(Object.values(view.tasks).map((t) => [t.id, t.traceTotal ?? t.trace.length]));
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    getView: () => view,
    getTask: (id) => (state.tasks[id as string] ? awf.taskRecord(state.tasks[id as string]!) : null),
    getLease: (id) => state.leases[id as string] ?? null,
    getProfile: (id) => state.profiles[id as string] ?? null,
    getNotified: () => notified,
    claimOutbox: () => [],
    reconcile: () => ({ restoredProfileIds: [], expiredLeaseIds: [], nextAlarmAt: null }),
  };
  const wf = new Proxy({} as WorkforceApi, {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return async (_teamId: string, ...args: unknown[]) => {
        calls.set(prop, (calls.get(prop) ?? 0) + 1);
        const answer = answers[prop];
        return answer ? structuredClone(answer(...args)) : { ok: true };
      };
    },
  });
  return { wf, calls, view };
}

/** Speaks the Terse socket protocol for one actor: a `state` snapshot of the split emitted fields. */
function stateServer(state: Record<string, unknown>) {
  const server: Server<unknown> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req, { data: {} }) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: (ws) => {
        ws.send(JSON.stringify({ type: "state", state, version: 1 }));
      },
      message: (ws, message) => {
        if (message === '{"type":"ping"}') ws.send('{"type":"pong"}');
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Rates = { total: number; byMethod: Record<string, number> };

async function measure(mode: "poll" | "push", heat: "hot" | "idle"): Promise<Rates> {
  const start = Date.now();
  const clock = { at: start, now: () => clock.at };
  const state = busyTeam(start);
  const { wf, calls, view } = countingWorkforce(state);
  const relay = new FakeRelay();
  for (const lease of Object.values(state.leases)) relay.agents.set(lease.agentName, { invocationId: `inv-${lease.id}`, node: lease.nodeName, task: "", cwd: "" });
  const shas = new Set<string>();
  const gateway = teamGateway();
  const teamCalls = { n: 0 };
  const counted = new Proxy(gateway, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop !== "getTeam") return value;
      return (...args: unknown[]) => {
        teamCalls.n++;
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as ActorGateway;

  let feed: WorkforceFeed | null = null;
  let url = "";
  if (mode === "push") {
    const server = stateServer({ profilesView: view.profiles, tasksView: view.tasks, leasesView: view.leases, outboxSummary: summarizeOutbox(state.outbox) });
    cleanup.push(server.stop);
    url = server.url;
  }
  const orch: Orchestration = createOrchestration({
    deps: { env: testEnv(), log: silentLogger, actors: counted, github: {} as GithubClient, keys: {} as Keys, now: clock.now },
    runtime: new FakeRuntime(),
    bus: new RuntimeBus(silentLogger),
    options: {
      ports: { vm: new FakeVm(shas), relay, git: new FakeGit(shas), githubToken: async () => "gho_test" },
      workforce: wf,
      tickMs: 0,
      listTeams: async () => [TEAM],
      ...(mode === "push"
        ? {
            feed: (onChange: Parameters<typeof createWorkforceFeed>[0]["onChange"]) =>
              (feed = createWorkforceFeed({
                gateway: { prepareSocket: async () => ({ websocketUrl: url, connectByMs: Date.now() + 10_000 }) },
                log: silentLogger,
                now: clock.now,
                onChange,
              })),
          }
        : {}),
    },
  });
  cleanup.push(() => orch.stop());

  const settle = async () => {
    for (let idle = 0; idle < 2; ) {
      idle = orch.ctx.lanes.size === 0 ? idle + 1 : 0;
      await Bun.sleep(0);
    }
  };
  const hold = () => {
    if (heat === "hot") orch.ctx.memory.team(TEAM).hotUntil = clock.at + 3_600_000;
    else orch.ctx.memory.team(TEAM).hotUntil = 0;
  };
  orch.track(TEAM);
  if (mode === "push") {
    const deadline = Date.now() + 5_000;
    while (!feed!.live(TEAM)) {
      if (Date.now() > deadline) throw new Error("feed never went live");
      await Bun.sleep(5);
    }
  }
  // Warm up one simulated minute (first passes, seeding), then count.
  for (let s = 0; s < 60; s++) {
    hold();
    clock.at += 1_000;
    orch.tick();
    await settle();
  }
  calls.clear();
  teamCalls.n = 0;
  for (let s = 0; s < MINUTES * 60; s++) {
    hold();
    clock.at += 1_000;
    orch.tick();
    await settle();
  }
  const byMethod: Record<string, number> = {};
  for (const [method, n] of [...calls].sort()) byMethod[`TeamWorkforce.${method}`] = n / MINUTES;
  if (teamCalls.n) byMethod["Team.getTeam"] = teamCalls.n / MINUTES;
  return { total: Object.values(byMethod).reduce((a, b) => a + b, 0), byMethod };
}

const show = (label: string, r: Rates) =>
  console.log(`${label.padEnd(12)} ${r.total.toFixed(1).padStart(6)} calls/min  ${Object.entries(r.byMethod).map(([m, n]) => `${m} ${n}`).join(", ")}`);

describe("actor calls per minute, one team with two running workers", () => {
  test("a pushed view cuts the loops' calls; polling (the fallback) is unchanged", async () => {
    const pollHot = await measure("poll", "hot");
    const pollIdle = await measure("poll", "idle");
    const pushHot = await measure("push", "hot");
    const pushIdle = await measure("push", "idle");
    show("poll, hot", pollHot);
    show("poll, idle", pollIdle);
    show("push, hot", pushHot);
    show("push, idle", pushIdle);

    // Polling: claims every second while hot, every 10 s idle; view reads by the watch, schedule and notify passes.
    expect(pollHot.byMethod["TeamWorkforce.claimOutbox"]).toBe(60);
    expect(pollIdle.byMethod["TeamWorkforce.claimOutbox"]).toBe(6);
    expect(pollIdle.byMethod["TeamWorkforce.getView"]).toBeGreaterThanOrEqual(20);

    // Pushed: nothing is due and nothing changes, so only the once-a-minute safety claim, sweep and notify remain,
    // plus the per-lease liveness reads (getLease, getProfile every 20 s per running worker), which do not use the view.
    for (const push of [pushHot, pushIdle]) {
      expect(push.byMethod["TeamWorkforce.claimOutbox"]).toBe(1);
      expect(push.byMethod["TeamWorkforce.reconcile"]).toBe(1);
      // Only reads right after our own writes (the once-a-minute sweep and claim) go to the actor (feed.ts SETTLE_MS).
      expect(push.byMethod["TeamWorkforce.getView"] ?? 0).toBeLessThanOrEqual(3);
      expect(push.byMethod["TeamWorkforce.getNotified"] ?? 0).toBeLessThanOrEqual(1);
    }
    expect(pushIdle.total).toBeLessThan(pollIdle.total / 2);
    expect(pushHot.total).toBeLessThan(pollHot.total / 4);
  }, 120_000);
});
