/**
 * Against a real relaycast-engine plus real `agent-relay node up` brokers advertising the fake harness:
 * node health, verified spawn and its failure modes, reconcile, release, lifecycle normalization and
 * broker death. Every broker runs under a temp HOME and cwd.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RelayEventView, ServerFrame } from "@morrow/contracts";
import {
  RelayIntegrationError,
  TeamRelayObserver,
  createRelayReader,
  ensureProjectChannel,
  getNodeHealth,
  initialReconcileMemo,
  liveAgentNames,
  provisionTeamWorkspace,
  reconcileWorker,
  releaseWorker,
  spawnWorker,
  workerAgentName,
  type AgentActiveInfo,
  type NodeStatusInfo,
  type RelayConfig,
  type RelayReader,
  type SpawnWorkerRequest,
  type TeamRelaySecrets,
} from "../../src/integrations/relay/index.ts";
import { FAKE_HARNESS, RELAY_E2E, runTag, startBroker, startEngine, stopAll, testTaskShort, waitFor, type Broker, type Engine } from "./harness.ts";

let engine: Engine;
let config: RelayConfig;
let team: TeamRelaySecrets;
let reader: RelayReader;
let broker: Broker;
let channel: string;
let observer: TeamRelayObserver;
const frames: ServerFrame[] = [];
const active: AgentActiveInfo[] = [];
const nodeEvents: NodeStatusInfo[] = [];

const request = (name: string, overrides: Partial<SpawnWorkerRequest> = {}): SpawnWorkerRequest => ({
  name,
  node: broker.nodeName,
  cli: FAKE_HARNESS,
  task: "Fix the flaky login test. Reply ACK when you start.",
  channels: [channel],
  workerCwd: broker.workDir,
  ...overrides,
});

const spawn = (req: SpawnWorkerRequest, r: RelayReader = reader) =>
  spawnWorker({ config, dispatcherToken: team.dispatcherToken, reader: r, request: req });

/**
 * engine 11.1.0 rejects some broker inventory frames after a worker exits ("write issued through the engine
 * handle inside a transaction"), so the node's control link drops and reconnects about a second later.
 * Reads in that window are correctly "unknown"; tests wait for the node to settle before asserting.
 */
const settled = (name = broker.nodeName) => waitFor(`node ${name} healthy`, async () => (await getNodeHealth(reader, name)).healthy, 20_000, 200);

const statusFrames = () =>
  frames.flatMap((f) => (f.kind === "relay.event" && f.data.type !== "message" ? [f.data] : []));

beforeAll(async () => {
  if (!RELAY_E2E) return;
  engine = await startEngine();
  config = { baseUrl: engine.baseUrl };
  team = await provisionTeamWorkspace({ config, teamId: `t-${runTag}node`, store: { save: async () => {} } });
  reader = createRelayReader(config, team.observer.token);
  ({ channel } = await ensureProjectChannel({ config, dispatcherToken: team.dispatcherToken, projectShort: "nodes" }));
  observer = new TeamRelayObserver({
    teamId: "t-node",
    config,
    observerToken: team.observer.token,
    cursorStore: { load: async () => null, save: async () => {} },
    publish: (_team, frame) => void frames.push(ServerFrame.parse(frame)),
    callbacks: {
      onAgentActive: (e) => void active.push(e),
      onNodeStatus: (e) => void nodeEvents.push(e),
    },
  });
  await observer.start();
  broker = await startBroker({ baseUrl: engine.baseUrl, workspaceKey: team.workspaceKey });
}, 90_000);

afterAll(async () => {
  await observer?.stop();
  await stopAll();
}, 30_000);

describe.skipIf(!RELAY_E2E)("node health", () => {
  test("a live broker reports online, live, handlers live, and its harness", async () => {
    const health = await getNodeHealth(reader, broker.nodeName);
    expect(health).toMatchObject({ name: broker.nodeName, online: true, healthy: true });
    expect(health.harnesses).toContain(FAKE_HARNESS);
    const missing = await getNodeHealth(reader, `n-t${runTag}missing`);
    expect(missing.online).toBe(false);
    expect(missing.healthy).toBe(false);
  });
});

describe.skipIf(!RELAY_E2E)("spawn", () => {
  test("verified spawn starts; a second attempt for the same lease is name_in_use, never a new worker", async () => {
    const name = workerAgentName(testTaskShort("a"), "be", 1);
    const started = await spawn(request(name));
    if (started.outcome !== "started") throw new Error(`spawn not started: ${JSON.stringify(started)}`);
    expect(started.invocationId).toMatch(/^inv_/);
    expect(liveAgentNames(await reader.getNode(broker.nodeName))).toContain(name);
    await waitFor("agent.status.active", async () => active.some((a) => a.agentName === name), 10_000);

    // Pre-flight finds the record: the outbox hands the lease to reconcile, with the original invocation.
    const again = await spawn(request(name));
    expect(again).toMatchObject({ outcome: "unconfirmed", code: "name_in_use", invocationId: started.invocationId });

    // Without the pre-flight (record not visible yet), the broker itself refuses the duplicate.
    const blind: RelayReader = { ...reader, getAgent: async () => null };
    const dup = await spawn(request(name), blind);
    expect(dup).toMatchObject({ outcome: "unconfirmed", code: "name_in_use" });
    expect(liveAgentNames(await reader.getNode(broker.nodeName)).filter((n) => n === name).length).toBe(1);
    console.log(`[spawn] started ${name} invocation=${started.invocationId} warning=${started.warning}`);
  }, 150_000);

  test("bad cwd, unknown node and unadvertised harness fail without launching anything", async () => {
    const badCwd = await spawn(request(workerAgentName(testTaskShort("b"), "be", 1), { workerCwd: `/nonexistent-morrow-${runTag}/wt` }));
    expect(badCwd).toMatchObject({ outcome: "failed", code: "bad_cwd" });

    const noNode = await spawn(request(workerAgentName(testTaskShort("c"), "be", 1), { node: `n-t${runTag}ghost` }));
    expect(noNode).toMatchObject({ outcome: "failed", code: "node_not_found" });

    const noHarness = await spawn(request(workerAgentName(testTaskShort("d"), "be", 1), { cli: "claude" }));
    expect(noHarness).toMatchObject({ outcome: "failed", code: "capability_mismatch" });

    const live = liveAgentNames(await reader.getNode(broker.nodeName));
    expect(live.some((n) => /-(b|c|d)-be-e1$/.test(n))).toBe(false);
  }, 60_000);

  test("input problems throw before any network call", async () => {
    const offline: RelayReader = {
      ...reader,
      getAgent: async () => {
        throw new Error("network must not be touched");
      },
    };
    const huge = "é".repeat(7169); // 14,338 UTF-8 bytes, 7,169 characters
    const tooBig = await spawn(request(workerAgentName(testTaskShort("e"), "be", 1), { task: huge }), offline).catch((e) => e);
    expect(tooBig).toBeInstanceOf(RelayIntegrationError);
    expect((tooBig as RelayIntegrationError).code).toBe("brief_too_large");
    expect((tooBig as RelayIntegrationError).details).toMatchObject({ bytes: 14338, limit: 14336 });

    for (const bad of [{ workerCwd: "relative/wt" }, { name: broker.nodeName }, { name: "W-Upper-e1" }]) {
      const err = await spawn(request(workerAgentName(testTaskShort("f"), "be", 1), bad), offline).catch((e) => e);
      expect((err as RelayIntegrationError).code).toBe("invalid_input");
    }
  });
});

describe.skipIf(!RELAY_E2E)("reconcile and release", () => {
  test("releasing a live worker waits for exit as truth, then deletes the record; unknown names are a no-op", async () => {
    const name = workerAgentName(testTaskShort("h"), "be", 1);
    await settled();
    expect((await spawn(request(name))).outcome).toBe("started");
    const released = await releaseWorker({
      config,
      workspaceKey: team.workspaceKey,
      reader,
      agentName: name,
      nodeName: broker.nodeName,
      reason: "lease ended",
      exits: observer.exits,
    });
    expect(released).toEqual({ gone: true, deleted: true });
    expect(["deregistered", "released"]).toContain(observer.exits.get(name)?.reason ?? "none");
    expect(liveAgentNames(await reader.getNode(broker.nodeName))).not.toContain(name);
    expect(await reader.getAgent(name)).toBeNull();
    // The name is free again: the same lease epoch can be spawned afresh.
    await settled();
    expect((await spawn(request(name))).outcome).toBe("started");
    expect(
      await releaseWorker({ config, workspaceKey: team.workspaceKey, reader, agentName: name, nodeName: broker.nodeName, reason: "cleanup", exits: observer.exits }),
    ).toEqual({ gone: true, deleted: true });

    const ghost = workerAgentName(testTaskShort("i"), "be", 1);
    expect(await releaseWorker({ config, workspaceKey: team.workspaceKey, reader, agentName: ghost, nodeName: broker.nodeName, reason: "x" })).toEqual({
      gone: true,
      deleted: true,
    });
  }, 240_000);
  test("a crashed worker: absence alone never reads as gone early; an inferred exit is not conclusive", async () => {
    // Own broker: on this engine a worker crash leaves the node's control link flapping (see `settled`).
    const crashNode = await startBroker({ baseUrl: engine.baseUrl, workspaceKey: team.workspaceKey });
    const name = workerAgentName(testTaskShort("g"), "be", 1);
    const started = await spawn(request(name, { node: crashNode.nodeName, workerCwd: crashNode.workDir }));
    if (started.outcome !== "started") throw new Error(`spawn not started: ${JSON.stringify(started)}`);
    const expectedInvocationId = started.invocationId;
    const read = (memo = initialReconcileMemo(), exits?: typeof observer.exits) =>
      reconcileWorker({ reader, agentName: name, nodeName: crashNode.nodeName, expectedInvocationId, memo, exits });

    const first = await read();
    expect(first).toMatchObject({ state: "running", invocationId: expectedInvocationId });

    expect(crashNode.killWorker(name)).toBe(true);
    // Without the ledger: one absent read, an immediate re-read, or a read while the node is unhealthy is
    // never enough. Poll for six seconds and record every verdict.
    const verdicts: string[] = [];
    let memo = first.memo;
    let sawAbsentOnce = false;
    for (const deadline = Date.now() + 6000; Date.now() < deadline; ) {
      const v = await read(memo);
      memo = v.memo;
      verdicts.push(`${v.state}:${v.reason}`);
      if (v.reason === "absent_unconfirmed") {
        sawAbsentOnce = true;
        const again = await read(memo);
        expect(again.state).toBe("unknown");
        memo = again.memo;
      }
      if (v.state === "gone") break;
      await Bun.sleep(250);
    }
    // Absence alone needs three newer heartbeats spanning 30 s on a healthy node; six seconds is never enough.
    expect(verdicts.filter((v) => v.startsWith("gone"))).toEqual([]);
    expect(sawAbsentOnce || verdicts.some((v) => v.endsWith("node_offline"))).toBe(true);

    // The engine reports the crash, when it reports it at all, as `missing_from_inventory`: its own inference,
    // which hosted Relay also emits for live workers under load. So the ledger alone never ends the worker.
    const exitSeen = await waitFor("agent.exited seen", async () => observer.exits.get(name) !== undefined, 10_000).then(() => true, () => false);
    const viaLedger = await read(initialReconcileMemo(), observer.exits);
    if (exitSeen) expect(observer.exits.get(name)).toMatchObject({ reason: "missing_from_inventory" });
    expect(viaLedger.state === "gone" ? viaLedger.reason : "unknown").not.toBe("exited");

    // Releasing the offline record deletes it at once.
    const released = await releaseWorker({ config, workspaceKey: team.workspaceKey, reader, agentName: name, nodeName: crashNode.nodeName, reason: "test" });
    expect(released).toEqual({ gone: true, deleted: true });
    expect(await reader.getAgent(name)).toBeNull();
    await crashNode.stop();
    console.log(`[reconcile] ${name}: ${[...new Set(verdicts)].join(" -> ")}; exitSeen=${exitSeen} ledger=${viaLedger.state}:${viaLedger.reason}`);
  }, 150_000);
});

describe.skipIf(!RELAY_E2E)("lifecycle on the observer stream", () => {
  test("every lifecycle frame is contract-valid; agent active/offline/exited all appear", async () => {
    const statuses = statusFrames();
    for (const view of statuses) expect(RelayEventView.safeParse(view).success).toBe(true);
    const agentStatuses = new Set(statuses.flatMap((v) => (v.type === "agent.status" && v.agentName.startsWith(`w-t${runTag}`) ? [v.status] : [])));
    expect([...agentStatuses].sort()).toEqual(["active", "exited", "offline"]);
    const exited = statuses.find((v) => v.type === "agent.status" && v.status === "exited");
    expect(exited).toMatchObject({ nodeName: broker.nodeName });
    const flaps = statuses.filter((v) => v.type === "node.status" && v.nodeName === broker.nodeName && v.status === "offline").length;
    console.log(`[lifecycle] ${statuses.length} status frames, agent statuses ${[...agentStatuses].join("/")}, main node offline flaps=${flaps}`);
  });

  test("killing a broker produces node.status offline with its name", async () => {
    const doomed = await startBroker({ baseUrl: engine.baseUrl, workspaceKey: team.workspaceKey });
    const killedAt = Date.now();
    doomed.killBroker();
    await waitFor("node offline", async () => nodeEvents.some((e) => e.nodeName === doomed.nodeName && e.status === "offline"), 20_000, 200);
    const seenAfter = Date.now() - killedAt;
    const frame = statusFrames().find((v) => v.type === "node.status" && v.nodeName === doomed.nodeName && v.status === "offline");
    expect(frame).toBeDefined();
    expect(RelayEventView.safeParse(frame).success).toBe(true);
    expect((await getNodeHealth(reader, doomed.nodeName)).online).toBe(false);
    // The surviving node is untouched.
    await settled();
    await doomed.stop();
    console.log(`[node] ${doomed.nodeName} offline event after ${seenAfter} ms`);
  }, 90_000);
});

test.skipIf(!RELAY_E2E)("no frame ever carried token material", () => {
  const blob = JSON.stringify(frames);
  expect(blob).not.toContain(team.observer.token);
  expect(blob).not.toContain(team.dispatcherToken);
  expect(blob).not.toContain(team.workspaceKey);
  expect(blob).not.toMatch(/(ot|at|rk)_live_/);
});
