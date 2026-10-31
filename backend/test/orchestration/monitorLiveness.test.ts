// Monitor liveness decisions, without Terse: a stub workforce answers the watch pass's reads and records the
// lease ends it would write. Covers the hosted-Relay-under-load case where the engine infers exits and drops
// node inventories for workers that are still running.
import { describe, expect, test } from "bun:test";
import type { GithubClient } from "../../src/integrations/github/client.ts";
import type { Keys } from "../../src/http/context.ts";
import { initialReconcileMemo, type ReconcileMemo, type ReconcileResult } from "../../src/integrations/relay/index.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { createOrchestration, type Orchestration } from "../../src/orchestration/index.ts";
import type { WorkforceApi } from "../../src/orchestration/workforce.ts";
import { RuntimeBus } from "../../src/runtime/bus.ts";
import { testEnv } from "../support/env.ts";
import { ENVS, FakeGit, FakeRelay, FakeRuntime, FakeVm, teamGateway } from "./fakes.ts";

const TEAM = "t-monlive0001";
const AGENT = "w-abc12345-api-e1";
const NOW = 1_900_000_000_000;

function setup() {
  const env = ENVS[0]!;
  const lease = {
    id: "ls-1",
    taskId: "k-1",
    workstreamId: "ws-api",
    profileId: "cp-a",
    epoch: 1,
    agentName: AGENT,
    nodeName: env.nodeName!,
    state: "running",
    spawnInvocationId: "inv-1",
    createdAt: NOW - 600_000,
    updatedAt: NOW - 300_000,
    expiresAt: null,
  };
  const ends: { leaseId: string; status: string }[] = [];
  const stub: Partial<WorkforceApi> = {
    getView: (async () => ({ profiles: {}, tasks: {}, leases: { [lease.id]: lease } })) as unknown as WorkforceApi["getView"],
    getLease: (async () => lease) as unknown as WorkforceApi["getLease"],
    getProfile: (async () => ({ id: "cp-a", envId: env.id, cli: "claude", ownerUserId: env.ownerUserId })) as unknown as WorkforceApi["getProfile"],
    recordSpawnStatus: (async (_teamId: string, leaseId: string, _epoch: number, status: string) => {
      ends.push({ leaseId, status });
      return { ok: true };
    }) as unknown as WorkforceApi["recordSpawnStatus"],
  };
  const wf = new Proxy(stub, {
    get(target, key) {
      if (typeof key === "string" && !(key in target)) return async () => Promise.reject(new Error(`unexpected workforce call: ${key}`));
      return target[key as keyof typeof target];
    },
  }) as WorkforceApi;

  const shas = new Set<string>();
  const relay = new FakeRelay();
  const vm = new FakeVm(shas);
  const clock = { offset: 0, now: () => NOW + clock.offset };
  const runtime = new FakeRuntime();
  const orch = createOrchestration({
    deps: { env: testEnv(), log: silentLogger, actors: teamGateway(), github: {} as GithubClient, keys: {} as Keys, now: clock.now },
    runtime,
    bus: new RuntimeBus(silentLogger),
    options: { ports: { vm, relay, git: new FakeGit(shas), githubToken: async () => "gho_test" }, workforce: wf, tickMs: 0, listTeams: async () => [] },
  });
  return { orch, relay, vm, clock, lease, ends, runtime };
}

async function settle(orch: Orchestration): Promise<void> {
  const deadline = Date.now() + 10_000;
  let idle = 0;
  while (idle < 3) {
    if (Date.now() > deadline) throw new Error(`lanes still busy: ${orch.ctx.lanes.size}`);
    idle = orch.ctx.lanes.size === 0 ? idle + 1 : 0;
    await Bun.sleep(10);
  }
}

const exited = (orch: Orchestration, reason: string | null) =>
  orch.monitor.handle({
    kind: "agent.exited",
    teamId: TEAM,
    event: { agentName: AGENT, agentId: "a", nodeId: null, nodeName: null, invocationId: "inv-1", reason, at: NOW, seq: null },
  });

/** Relay says gone by absence, the streak having begun `ago` ms before now. Records the memo each call got. */
function goneByAbsence(relay: FakeRelay, clock: { now: () => number }, ago: number, seen: Array<{ memo: ReconcileMemo; startedAt: number | undefined }>) {
  relay.reconcile = async (_access, input) => {
    seen.push({ memo: input.memo, startedAt: input.startedAt });
    const memo = { absentReads: 3, firstAbsentAt: clock.now() - ago, lastAbsentHeartbeatAt: clock.now() - 1_000 };
    return { state: "gone", reason: "absent", invocationId: "inv-1", memo } satisfies ReconcileResult;
  };
}

describe("monitor: liveness under a degraded Relay", () => {
  test("an inferred exit (missing_from_inventory) never ends a live lease; the broker's exit does", async () => {
    const { orch, ends } = setup();
    exited(orch, "missing_from_inventory");
    await settle(orch);
    expect(ends).toEqual([]);
    exited(orch, "deregistered");
    await settle(orch);
    expect(ends).toEqual([{ leaseId: "ls-1", status: "exited" }]);
  });

  test("an exit without a reason (older engines) still ends the lease", async () => {
    const { orch, ends } = setup();
    exited(orch, null);
    await settle(orch);
    expect(ends).toEqual([{ leaseId: "ls-1", status: "exited" }]);
  });

  test("absence is overruled when the worker's log changed after the absence began; the streak starts over", async () => {
    const { orch, relay, vm, clock, lease, ends } = setup();
    const seen: Array<{ memo: ReconcileMemo; startedAt: number | undefined }> = [];
    goneByAbsence(relay, clock, 40_000, seen);
    vm.readLogTail = async () => ({ text: "thinking\n", truncated: false, size: 9, modifiedAt: new Date(clock.now() - 2_000).toISOString() });
    await orch.monitor.watch(TEAM);
    expect(ends).toEqual([]);
    expect(seen[0]!.startedAt).toBe(lease.updatedAt);

    clock.offset = 25_000;
    await orch.monitor.watch(TEAM);
    // The overruled verdict reset the streak the next read starts from.
    expect(seen[1]!.memo).toEqual(initialReconcileMemo());
    expect(ends).toEqual([]);
  });

  test("absence stands when the log is older than the absence, missing or unreadable", async () => {
    for (const tail of ["old", "none", "throws"] as const) {
      const { orch, relay, vm, clock, ends } = setup();
      goneByAbsence(relay, clock, 40_000, []);
      vm.readLogTail = async () => {
        if (tail === "throws") throw new Error("exec failed");
        if (tail === "none") return null;
        return { text: "x", truncated: false, size: 1, modifiedAt: new Date(clock.now() - 45_000).toISOString() };
      };
      await orch.monitor.watch(TEAM);
      expect(ends).toEqual([{ leaseId: "ls-1", status: "exited" }]);
    }
  });

  test("a long unknown with a crash line ends the lease only once the log has gone quiet", async () => {
    for (const quiet of [false, true]) {
      const { orch, relay, vm, clock, ends, runtime } = setup();
      relay.reconcileAs.set(AGENT, "unknown");
      vm.readLogTail = async () => {
        const modifiedAt = new Date(quiet ? NOW - 120_000 : clock.now() - 3_000).toISOString();
        return { text: "exceeded retry limit, last status: 529\nretrying\n", truncated: false, size: 40, modifiedAt };
      };
      for (let i = 0; i <= 5; i++) {
        clock.offset = i * 21_000;
        await orch.monitor.watch(TEAM);
      }
      // The stub lease never leaves `running`, so a quiet one is ended again on each later pass.
      expect([ends.length > 0, runtime.restarts.length]).toEqual(quiet ? [true, 1] : [false, 0]);
    }
  });

  test("a gone verdict from a conclusive exit never waits on the VM", async () => {
    const { orch, relay, vm, ends } = setup();
    let reads = 0;
    vm.readLogTail = async () => {
      reads++;
      return { text: "x", truncated: false, size: 1, modifiedAt: new Date(NOW).toISOString() };
    };
    relay.reconcile = async (_access, input) => ({ state: "gone", reason: "exited", invocationId: "inv-1", memo: input.memo });
    await orch.monitor.watch(TEAM);
    expect([ends, reads]).toEqual([[{ leaseId: "ls-1", status: "exited" }], 0]);
  });
});
