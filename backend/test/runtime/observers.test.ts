// Observer manager lifecycle with a fake observer: which teams get one, that there is never more than one
// per team, the cursor store, the bus wiring, and restart after a token change. The real engine path
// (history, rotation on member removal) is in relay.e2e.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeSignal } from "../../src/runtime/bus.ts";
import type { TeamRelayObserverOptions } from "../../src/integrations/relay/index.ts";
import { sealRelaySecrets } from "../../src/runtime/relayWorkspaces.ts";
import { idleObserver, makeFixture, OTHER, TEAM, type FakeObserver, type Fixture } from "./helpers.ts";

const open: Fixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

async function setup(now?: () => number) {
  const created: FakeObserver[] = [];
  const f = await makeFixture({
    now,
    createObserver: (options: TeamRelayObserverOptions) => {
      const o = idleObserver(options);
      created.push(o);
      return o;
    },
  });
  open.push(f);
  return { f, created, runtime: f.t.deps.runtime };
}

describe("observer manager", () => {
  test("parallel ensure starts exactly one observer per team", async () => {
    const { created, runtime } = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => runtime.observers.ensure(TEAM)));
    expect(results.every(Boolean)).toBe(true);
    expect(created.length).toBe(1);
    expect(created[0]!.starts).toBe(1);
    expect(created[0]!.options.observerToken).toBe("at_live_TESTSECRETobserver0123456789");
    expect(runtime.observers.teams()).toEqual([TEAM]);
  });

  test("touched teams get an observer; it stops once the team goes idle", async () => {
    let clock = Date.now();
    const { created, runtime } = await setup(() => clock);
    runtime.touchTeam(TEAM);
    await runtime.reconcile();
    expect(runtime.observers.teams()).toEqual([TEAM]);
    await runtime.reconcile();
    expect(created.length).toBe(1);

    clock += runtime.timing.touchTtlMs + 1;
    await runtime.reconcile();
    expect(runtime.observers.teams()).toEqual([]);
    expect(created[0]!.stops).toBe(1);
  });

  test("a team with a live lease keeps its observer without viewers", async () => {
    let clock = Date.now();
    const { f, runtime } = await setup(() => clock);
    f.actors.putLease(OTHER, { id: "l-1", nodeName: "n-x" });
    runtime.noteTeam(OTHER);
    await runtime.reconcile();
    await runtime.reconcile();
    expect(runtime.observers.teams()).toContain(OTHER);
    f.actors.leases.get(OTHER)!.get("l-1")!.state = "released";
    clock += 1;
    await runtime.reconcile();
    await runtime.reconcile();
    expect(runtime.observers.teams()).not.toContain(OTHER);
  });

  test("restart stops the running observer and starts a new one with the stored token", async () => {
    const { f, created, runtime } = await setup();
    await runtime.observers.ensure(TEAM);
    const stored = f.actors.relays.get(TEAM)!;
    const rotated = await sealRelaySecrets(f.t.deps.keys.data, TEAM, {
      workspaceId: stored.workspaceId,
      baseUrl: stored.baseUrl,
      workspaceKey: "rk_live_TESTSECRETworkspacekey0123456789",
      dispatcherToken: "at_live_TESTSECRETdispatcher0123456789",
      observer: { id: stored.observerTokenId, token: "at_live_TESTSECRETrotated000000000000", expiresAt: null },
    });
    f.actors.relays.set(TEAM, { ...rotated, cursor: stored.cursor });
    await runtime.observers.restart(TEAM);
    expect(created.length).toBe(2);
    expect(created[0]!.stops).toBe(1);
    expect(created[1]!.options.observerToken).toBe("at_live_TESTSECRETrotated000000000000");
    // Not running: restart does not start one.
    await runtime.observers.stop(TEAM);
    await runtime.observers.restart(TEAM);
    expect(created.length).toBe(2);
  });

  test("the cursor round-trips through the Team actor; junk is ignored", async () => {
    const { f, created, runtime } = await setup();
    await runtime.observers.ensure(TEAM);
    const store = created[0]!.options.cursorStore;
    expect(await store.load()).toBeNull();
    await store.save(42);
    expect(f.actors.relays.get(TEAM)!.cursor).toBe("42");
    expect(await store.load()).toBe(42);
    f.actors.relays.set(TEAM, { ...f.actors.relays.get(TEAM)!, cursor: "1e9; drop" });
    expect(await store.load()).toBeNull();
  });

  test("observer events reach the runtime bus in order", async () => {
    const { f, created, runtime } = await setup();
    const seen: RuntimeSignal["kind"][] = [];
    f.t.deps.bus.subscribe((s) => void seen.push(s.kind));
    await runtime.observers.ensure(TEAM);
    const cb = created[0]!.options.callbacks!;
    await cb.onAgentActive?.({ agentName: "w-a", agentId: null, at: 1, seq: 1 });
    await cb.onNodeStatus?.({ nodeId: "nd", nodeName: "n-unknown", status: "online", reason: null, at: 2, seq: 2 });
    expect(seen).toEqual(["agent.active", "node.status"]);
  });

  test("stopAll stops every observer and refuses new ones", async () => {
    const { created, runtime } = await setup();
    await runtime.observers.ensure(TEAM);
    await runtime.observers.ensure(OTHER);
    await runtime.observers.stopAll();
    expect(created.map((o) => o.stops)).toEqual([1, 1]);
    expect(await runtime.observers.ensure(TEAM)).toBe(false);
  });

  test("Relay disabled: no observers, no history", async () => {
    const f = await makeFixture({ relay: false });
    open.push(f);
    expect(await f.t.deps.runtime.observers.ensure(TEAM)).toBe(false);
    expect(await f.t.deps.runtime.observers.history(TEAM, null, null)).toBeNull();
    expect(await f.t.deps.runtime.relay(TEAM)).toBeNull();
  });
});
