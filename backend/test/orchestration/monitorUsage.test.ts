// Monitor -> recordProfileUsage wiring, without Terse: a stub workforce answers the reads the watch pass makes
// and records usage writes. The end-to-end version against real Terse lives in flow.test.ts.
import { describe, expect, test } from "bun:test";
import type { ProfileUsage } from "@morrow/contracts";
import type { GithubClient } from "../../src/integrations/github/client.ts";
import type { Keys } from "../../src/http/context.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { createOrchestration } from "../../src/orchestration/index.ts";
import type { WorkforceApi } from "../../src/orchestration/workforce.ts";
import { RuntimeBus } from "../../src/runtime/bus.ts";
import { testEnv } from "../support/env.ts";
import { ENVS, FakeGit, FakeRelay, FakeRuntime, FakeVm, teamGateway } from "./fakes.ts";

const TEAM = "t-monusage01";
const AGENT = "w-abc12345-api";

function setup(cli: "claude" | "codex" | "opencode" = "claude", opts: { recordFails?: boolean } = {}) {
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
    createdAt: 0,
    updatedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const recorded: { profileId: string; usage: ProfileUsage }[] = [];
  const calls: string[] = [];
  const stub: Partial<WorkforceApi> = {
    getView: (async () => ({ profiles: {}, tasks: {}, leases: { [lease.id]: lease } })) as unknown as WorkforceApi["getView"],
    getLease: (async () => lease) as unknown as WorkforceApi["getLease"],
    getProfile: (async () => ({ id: "cp-a", envId: env.id, cli, ownerUserId: env.ownerUserId })) as unknown as WorkforceApi["getProfile"],
    recordProfileUsage: (async (_teamId: string, profileId: string, usage: ProfileUsage) => {
      if (opts.recordFails) throw new Error("actor unavailable");
      recorded.push({ profileId, usage });
      return { applied: true };
    }) as unknown as WorkforceApi["recordProfileUsage"],
  };
  // Anything else the pass touches is a test failure, not a silent no-op.
  const wf = new Proxy(stub, {
    get(target, key) {
      if (typeof key === "string" && !(key in target)) {
        return async () => {
          calls.push(key);
          throw new Error(`unexpected workforce call: ${key}`);
        };
      }
      return target[key as keyof typeof target];
    },
  }) as WorkforceApi;

  const shas = new Set<string>();
  const relay = new FakeRelay();
  relay.reconcileAs.set(AGENT, "running");
  const vm = new FakeVm(shas);
  const clock = { offset: 0, now: () => 1_900_000_000_000 + clock.offset };
  const orch = createOrchestration({
    deps: { env: testEnv(), log: silentLogger, actors: teamGateway(), github: {} as GithubClient, keys: {} as Keys, now: clock.now },
    runtime: new FakeRuntime(),
    bus: new RuntimeBus(silentLogger),
    options: { ports: { vm, relay, git: new FakeGit(shas), githubToken: async () => "gho_test" }, workforce: wf, tickMs: 0, listTeams: async () => [] },
  });
  return { orch, vm, clock, recorded, calls };
}

describe("monitor: worker usage readings", () => {
  test("a printed reading is recorded once per line; a new line is a new reading", async () => {
    const { orch, vm, clock, recorded, calls } = setup();
    vm.logs.set(AGENT, "editing\nYou've used 85% of your weekly limit · resets 6pm (UTC)\nstill working\n");
    await orch.monitor.watch(TEAM);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.profileId).toBe("cp-a");
    expect(recorded[0]!.usage).toMatchObject({ source: "worker", observedAt: clock.now() });
    expect(recorded[0]!.usage.windows).toEqual([{ kind: "weekly", label: "Weekly", usedPercent: 85, resetsAt: expect.any(Number) }]);

    clock.offset = 25_000;
    await orch.monitor.watch(TEAM);
    expect(recorded).toHaveLength(1);

    clock.offset = 50_000;
    const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91, resetsAt: Math.floor(clock.now() / 1000) + 3600 } };
    vm.logs.set(AGENT, `${vm.logs.get(AGENT)}${JSON.stringify(event)}\n`);
    await orch.monitor.watch(TEAM);
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.usage.windows).toEqual([{ kind: "five_hour", label: "5-hour", usedPercent: 91, resetsAt: (Math.floor((1_900_000_000_000 + 50_000) / 1000) + 3600) * 1000 }]);
    expect(calls).toEqual([]);
  });

  test("polls no faster than the log interval", async () => {
    const { orch, vm, clock, recorded } = setup();
    vm.logs.set(AGENT, "You've used 40% of your session limit\n");
    await orch.monitor.watch(TEAM);
    vm.logs.set(AGENT, "You've used 41% of your session limit\n");
    clock.offset = 5_000;
    await orch.monitor.watch(TEAM);
    expect(recorded.map((r) => r.usage.windows[0]!.usedPercent)).toEqual([40]);
  });

  test("opencode output is never read as plan usage", async () => {
    const { orch, vm, recorded } = setup("opencode");
    vm.logs.set(AGENT, "You've used 85% of your weekly limit\n");
    await orch.monitor.watch(TEAM);
    expect(recorded).toEqual([]);
  });

  test("no reading in the log, no write", async () => {
    const { orch, vm, recorded, calls } = setup("codex");
    vm.logs.set(AGENT, "running tests\n12 passed\n");
    await orch.monitor.watch(TEAM);
    expect(recorded).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a failed usage write does not stop the pass", async () => {
    const { orch, vm, calls } = setup("claude", { recordFails: true });
    vm.logs.set(AGENT, "You've used 85% of your weekly limit\n");
    await orch.monitor.watch(TEAM);
    expect(calls).toEqual([]);
  });
});
