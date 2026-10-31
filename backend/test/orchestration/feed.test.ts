// WorkforceFeed and wrapWorkforce against a local socket speaking the Terse state protocol, then the orchestration
// tick on top of them: claims on push, the safety period, scheduling on view changes, the polling fallback.
import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import type { GithubClient } from "../../src/integrations/github/client.ts";
import type { Keys } from "../../src/http/context.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { createWorkforceFeed, SETTLE_MS, wrapWorkforce, type FeedChange, type WorkforceFeed } from "../../src/orchestration/feed.ts";
import { createOrchestration } from "../../src/orchestration/index.ts";
import type { WorkforceApi } from "../../src/orchestration/workforce.ts";
import { RuntimeBus } from "../../src/runtime/bus.ts";
import { testEnv } from "../support/env.ts";
import { FakeGit, FakeRelay, FakeRuntime, FakeVm, teamGateway } from "./fakes.ts";

const TEAM = "t-feed";
const EMPTY = { profilesView: {}, tasksView: {}, leasesView: {}, outboxSummary: { open: 0, nextDueAt: null } };

function stateServer(initial: Record<string, unknown>) {
  const sockets = new Set<ServerWebSocket<unknown>>();
  let state = { ...initial };
  let version = 1;
  const server: Server<unknown> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req, { data: {} }) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "state", state, version }));
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {},
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/`,
    update(changes: Record<string, unknown>) {
      state = { ...state, ...changes };
      version++;
      for (const ws of sockets) ws.send(JSON.stringify({ type: "state_update", changes, removed: [], version }));
    },
    drop() {
      for (const ws of sockets) ws.close(1011, "restart");
    },
    stop: () => server.stop(true),
  };
}

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(2);
  }
}

function feedOn(url: string, clock: { now(): number }, changes: FeedChange[] = []): WorkforceFeed {
  const feed = createWorkforceFeed({
    gateway: { prepareSocket: async () => ({ websocketUrl: url, connectByMs: Date.now() + 10_000 }) },
    log: silentLogger,
    now: clock.now,
    onChange: (_teamId, change) => changes.push(change),
    subscription: { baseDelayMs: 10, maxDelayMs: 20, pingMs: 0 },
  });
  cleanup.push(() => feed.stop());
  return feed;
}

function countingApi(view: unknown) {
  const calls: string[] = [];
  let release: (() => void) | null = null;
  const api = {
    getView: async () => {
      calls.push("getView");
      return view;
    },
    getTask: async () => {
      calls.push("getTask");
      return null;
    },
    stoppingSubagents: async () => {
      calls.push("stoppingSubagents");
      return [];
    },
    reserveWorkers: () => {
      calls.push("reserveWorkers");
      return new Promise((resolve) => (release = () => resolve({ ok: true })));
    },
  } as unknown as WorkforceApi;
  return { api, calls, finishWrite: () => release?.() };
}

describe("WorkforceFeed", () => {
  test("not live until the snapshot; composes the split fields; revision moves only when a part changes", async () => {
    const srv = stateServer({ ...EMPTY, profilesView: { p1: { id: "p1" } } });
    cleanup.push(srv.stop);
    const clock = { now: () => Date.now() };
    const changes: FeedChange[] = [];
    const feed = feedOn(srv.url, clock, changes);
    expect(feed.live(TEAM)).toBe(false);
    feed.watch(TEAM);
    await until(() => feed.live(TEAM));
    expect(feed.view(TEAM)).toEqual({ profiles: { p1: { id: "p1" } }, tasks: {}, leases: {} } as never);
    expect(feed.summary(TEAM)).toEqual({ open: 0, nextDueAt: null });
    const rev = feed.revision(TEAM);

    srv.update({ outboxSummary: { open: 2, nextDueAt: 123 } });
    await until(() => feed.summary(TEAM)?.open === 2);
    expect(feed.revision(TEAM)).toBe(rev);
    expect(changes.at(-1)).toEqual({ viewChanged: false, summary: { open: 2, nextDueAt: 123 } });

    srv.update({ tasksView: { "tk-1": { id: "tk-1" } } });
    await until(() => feed.revision(TEAM) === rev + 1);
    expect(feed.view(TEAM)!.tasks).toEqual({ "tk-1": { id: "tk-1" } } as never);
    expect(changes.at(-1)!.viewChanged).toBe(true);
  });

  test("reads an actor that still emits one `view` field; it has no summary, so claims keep polling", async () => {
    const view = { profiles: {}, tasks: { "tk-1": { id: "tk-1" } }, leases: {} };
    const srv = stateServer({ view });
    cleanup.push(srv.stop);
    const feed = feedOn(srv.url, { now: () => Date.now() });
    feed.watch(TEAM);
    await until(() => feed.live(TEAM));
    expect(feed.view(TEAM)).toEqual(view as never);
    expect(feed.summary(TEAM)).toBeNull();
  });

  test("a dropped socket is not live until the new snapshot; unwatch and stop close it for good", async () => {
    const srv = stateServer(EMPTY);
    cleanup.push(srv.stop);
    const feed = feedOn(srv.url, { now: () => Date.now() });
    feed.watch(TEAM);
    await until(() => feed.live(TEAM));
    srv.drop();
    await until(() => !feed.live(TEAM));
    expect(feed.view(TEAM)).toBeNull();
    await until(() => feed.live(TEAM));
    feed.unwatch(TEAM);
    expect(feed.live(TEAM)).toBe(false);
    expect(feed.size).toBe(0);
    feed.stop();
    feed.watch(TEAM);
    expect(feed.size).toBe(0);
  });
});

describe("wrapWorkforce", () => {
  test("getView answers from the feed when settled; during and just after a write it asks the actor", async () => {
    const srv = stateServer(EMPTY);
    cleanup.push(srv.stop);
    const clock = { at: Date.now(), now: () => clock.at };
    const feed = feedOn(srv.url, clock);
    const rpcView = { profiles: { from: "rpc" }, tasks: {}, leases: {} };
    const { api, calls, finishWrite } = countingApi(rpcView);
    const wf = wrapWorkforce(api, feed);

    // Not watched: straight to the actor.
    expect(await wf.getView(TEAM)).toEqual(rpcView as never);
    feed.watch(TEAM);
    await until(() => feed.live(TEAM));
    calls.length = 0;
    expect(await wf.getView(TEAM)).toEqual({ profiles: {}, tasks: {}, leases: {} } as never);
    expect(calls).toEqual([]);

    const write = wf.reserveWorkers(TEAM, "tk-1", [], "k-1");
    expect(await wf.getView(TEAM)).toEqual(rpcView as never);
    finishWrite();
    await write;
    clock.at += SETTLE_MS - 1;
    expect(await wf.getView(TEAM)).toEqual(rpcView as never);
    clock.at += 1;
    expect(await wf.getView(TEAM)).toEqual({ profiles: {}, tasks: {}, leases: {} } as never);

    // Other reads always go to the actor and never unsettle the feed.
    await wf.getTask(TEAM, "tk-1");
    await wf.stoppingSubagents(TEAM, "ls-1");
    expect(await wf.getView(TEAM)).toEqual({ profiles: {}, tasks: {}, leases: {} } as never);
    expect(calls).toEqual(["reserveWorkers", "getView", "getView", "getTask", "stoppingSubagents"]);
  });
});

describe("orchestration on a pushed view", () => {
  function setup(initial: Record<string, unknown>) {
    const srv = stateServer(initial);
    cleanup.push(srv.stop);
    const clock = { at: Date.now(), now: () => clock.at };
    const calls: string[] = [];
    const view = { profiles: {}, tasks: {}, leases: {} };
    const wf = new Proxy({} as WorkforceApi, {
      get(_t, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return async () => {
          calls.push(prop);
          if (prop === "getView") return view;
          if (prop === "claimOutbox") return [];
          if (prop === "getNotified") return {};
          if (prop === "reconcile") return { restoredProfileIds: [], expiredLeaseIds: [], nextAlarmAt: null };
          return null;
        };
      },
    });
    let feed!: WorkforceFeed;
    const shas = new Set<string>();
    const orch = createOrchestration({
      deps: { env: testEnv(), log: silentLogger, actors: teamGateway(), github: {} as GithubClient, keys: {} as Keys, now: clock.now },
      runtime: new FakeRuntime(),
      bus: new RuntimeBus(silentLogger),
      options: {
        ports: { vm: new FakeVm(shas), relay: new FakeRelay(), git: new FakeGit(shas), githubToken: async () => "gho_test" },
        workforce: wf,
        tickMs: 0,
        listTeams: async () => [],
        feed: (onChange) =>
          (feed = createWorkforceFeed({
            gateway: { prepareSocket: async () => ({ websocketUrl: srv.url, connectByMs: Date.now() + 10_000 }) },
            log: silentLogger,
            now: clock.now,
            onChange,
            subscription: { baseDelayMs: 10, maxDelayMs: 20, pingMs: 0 },
          })),
      },
    });
    cleanup.push(() => orch.stop());
    const settle = async () => {
      for (let idle = 0; idle < 3; ) {
        idle = orch.ctx.lanes.size === 0 ? idle + 1 : 0;
        await Bun.sleep(1);
      }
    };
    const run = async (seconds: number) => {
      for (let i = 0; i < seconds; i++) {
        clock.at += 1_000;
        orch.tick();
        await settle();
      }
    };
    const count = (method: string) => calls.filter((c) => c === method).length;
    return { srv, clock, calls, orch, run, settle, count, feed: () => feed };
  }

  test("claims the moment a push says an item is due, and at the due time, not on a timer", async () => {
    const t = setup(EMPTY);
    t.orch.track(TEAM);
    await until(() => t.feed().live(TEAM));
    await t.run(61);
    t.calls.length = 0;

    // Nothing due: a quiet minute is one safety claim.
    await t.run(60);
    expect(t.count("claimOutbox")).toBe(1);

    // A push with an item due now: claimed without waiting for a tick.
    t.calls.length = 0;
    t.clock.at += 1_000;
    t.srv.update({ outboxSummary: { open: 1, nextDueAt: t.clock.at } });
    await until(() => t.count("claimOutbox") === 1);

    // Due in 10 s: claimed then, not before (the fake actor never clears it, so it keeps claiming each second after).
    t.calls.length = 0;
    t.srv.update({ outboxSummary: { open: 1, nextDueAt: t.clock.at + 10_000 } });
    await until(() => t.feed().summary(TEAM)?.nextDueAt === t.clock.at + 10_000);
    await t.run(9);
    expect(t.count("claimOutbox")).toBe(0);
    await t.run(1);
    expect(t.count("claimOutbox")).toBe(1);
  });

  test("a view change runs a scheduling pass without a sweep; the sweep and notify run once a minute", async () => {
    const t = setup(EMPTY);
    t.orch.track(TEAM);
    await until(() => t.feed().live(TEAM));
    await t.run(61);
    t.calls.length = 0;
    await t.run(60);
    expect(t.count("reconcile")).toBe(1);
    expect(t.count("getNotified")).toBe(1);
    // Only reads right after our own writes (the sweep, the safety claim) skip the pushed view.
    expect(t.count("getView")).toBeLessThanOrEqual(3);

    t.calls.length = 0;
    const rev = t.feed().revision(TEAM);
    t.srv.update({ tasksView: { "tk-9": { id: "tk-9" } } });
    await until(() => t.feed().revision(TEAM) === rev + 1);
    t.clock.at += 1_000;
    await t.run(5);
    // One pass (reads the pushed view: no getView, no sweep) and one notify for the new revision.
    expect(t.count("reconcile")).toBe(0);
    expect(t.count("getView")).toBe(0);
    expect(t.count("getNotified")).toBe(1);
  });

  test("without a live socket the loops poll as before", async () => {
    const t = setup(EMPTY);
    t.srv.stop();
    t.orch.track(TEAM);
    await t.run(60);
    expect(t.count("claimOutbox")).toBe(6);
    expect(t.count("reconcile")).toBe(4);
    expect(t.feed().live(TEAM)).toBe(false);
  });
});
