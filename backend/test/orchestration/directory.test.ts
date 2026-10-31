// How orchestration finds teams to resume: the team directory (durable) first, the control plane's inventory as a
// hint, and how it keeps the directory right (work noted before a task exists, idle reported with the generation it
// read, teams found only by the hint backfilled). The directory and the actors are fakes; the real TeamDirectory is
// covered in actors/test/store.integration.test.ts and the restart tests.
import { afterEach, describe, expect, test } from "bun:test";
import type { GithubClient } from "../../src/integrations/github/client.ts";
import type { Keys } from "../../src/http/context.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { DIRECTORY_PAGE, listActiveTeams, type TeamDirectoryApi } from "../../src/orchestration/directory.ts";
import { createOrchestration } from "../../src/orchestration/index.ts";
import type { WorkforceApi } from "../../src/orchestration/workforce.ts";
import { RuntimeBus } from "../../src/runtime/bus.ts";
import { testEnv } from "../support/env.ts";
import { FakeGit, FakeRelay, FakeRuntime, FakeVm, PROJECT, teamGateway } from "./fakes.ts";

class FakeDirectory implements TeamDirectoryApi {
  readonly rows = new Map<string, { gen: number; active: boolean }>();
  readonly log: string[] = [];
  failList = false;
  failWork = false;

  async noteTeam(teamId: string) {
    const created = !this.rows.has(teamId);
    if (created) this.rows.set(teamId, { gen: 0, active: false });
    return { ok: true as const, created };
  }
  async noteWork(teamId: string) {
    this.log.push(`work ${teamId}`);
    if (this.failWork) throw new Error("directory down");
    const gen = (this.rows.get(teamId)?.gen ?? 0) + 1;
    this.rows.set(teamId, { gen, active: true });
    return { ok: true as const, gen };
  }
  async noteIdle(teamId: string, gen: number) {
    this.log.push(`idle ${teamId} ${gen}`);
    const row = this.rows.get(teamId);
    const cleared = !!row && row.active && row.gen === gen;
    if (cleared) row!.active = false;
    return { ok: true as const, cleared };
  }
  async listActive(after: string | null, limit: number) {
    if (this.failList) throw new Error("directory down");
    const ids = [...this.rows].filter(([id, r]) => r.active && id > (after ?? "")).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit);
    return { teams: ids.map(([teamId, r]) => ({ teamId, gen: r.gen })), next: ids.length === limit ? ids.at(-1)![0] : null };
  }
}

/** Busy teams have an open task; idle ones have nothing. */
function workforce(busy: Set<string>, calls: string[]) {
  return new Proxy({} as WorkforceApi, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return async (teamId: string) => {
        calls.push(`${prop} ${teamId}`);
        if (prop === "getView")
          return { profiles: {}, leases: {}, tasks: busy.has(teamId) ? { "tk-1": { id: "tk-1", status: "draft", createdAt: 0, trace: [], workstreams: [] } } : {} };
        if (prop === "claimOutbox") return [];
        if (prop === "getNotified") return {};
        if (prop === "createTask") return { ok: true, taskId: "tk-1" };
        if (prop === "reconcile") return { restoredProfileIds: [], expiredLeaseIds: [], nextAlarmAt: null };
        return null;
      };
    },
  });
}

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setup(input: { directory: FakeDirectory; inventory: () => Promise<string[]>; busy?: string[]; reseedMs?: number }) {
  const clock = { at: Date.now(), now: () => clock.at };
  const busy = new Set(input.busy ?? []);
  const calls: string[] = [];
  const shas = new Set<string>();
  const orch = createOrchestration({
    deps: { env: testEnv(), log: silentLogger, actors: teamGateway(), github: {} as GithubClient, keys: {} as Keys, now: clock.now },
    runtime: new FakeRuntime(),
    bus: new RuntimeBus(silentLogger),
    options: {
      ports: { vm: new FakeVm(shas), relay: new FakeRelay(), git: new FakeGit(shas), githubToken: async () => "gho_test" },
      workforce: workforce(busy, calls),
      tickMs: 0,
      listTeams: input.inventory,
      directory: input.directory,
      reseedMs: input.reseedMs,
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
  const tracked = (teamId: string) => calls.some((c) => c === `reconcile ${teamId}`);
  return { orch, run, settle, calls, busy, clock, tracked };
}

describe("listActiveTeams", () => {
  test("follows pages to the end and stops on a cursor that does not move", async () => {
    const dir = new FakeDirectory();
    for (let i = 0; i < DIRECTORY_PAGE * 2 + 3; i++) await dir.noteWork(`t-${String(i).padStart(5, "0")}`);
    expect((await listActiveTeams(dir)).size).toBe(DIRECTORY_PAGE * 2 + 3);
    const stuck = { listActive: async () => ({ teams: [{ teamId: "t-a", gen: 1 }], next: "t-a" }) };
    expect([...(await listActiveTeams(stuck))]).toEqual([["t-a", 1]]);
  });
});

describe("finding teams to resume", () => {
  test("tracks the directory's active teams and the inventory hint", async () => {
    const dir = new FakeDirectory();
    await dir.noteWork("t-dir");
    await dir.noteTeam("t-quiet");
    const t = setup({ directory: dir, inventory: async () => ["t-hint"], busy: ["t-dir", "t-hint"] });
    await t.run(2);
    expect(t.tracked("t-dir")).toBe(true);
    expect(t.tracked("t-hint")).toBe(true);
    expect(t.tracked("t-quiet")).toBe(false);
  });

  test("an inventory outage does not stop seeding from the directory", async () => {
    const dir = new FakeDirectory();
    await dir.noteWork("t-dir");
    const t = setup({ directory: dir, inventory: async () => Promise.reject(new Error("control plane down")), busy: ["t-dir"] });
    await t.run(2);
    expect(t.tracked("t-dir")).toBe(true);
  });

  test("a directory outage tracks the hint now and asks the directory again soon", async () => {
    const dir = new FakeDirectory();
    await dir.noteWork("t-dir");
    dir.failList = true;
    const t = setup({ directory: dir, inventory: async () => ["t-hint"], busy: ["t-dir", "t-hint"] });
    await t.run(2);
    expect(t.tracked("t-hint")).toBe(true);
    expect(t.tracked("t-dir")).toBe(false);
    dir.failList = false;
    await t.run(11);
    expect(t.tracked("t-dir")).toBe(true);
  });

  test("a busy team found only by the hint is written to the directory", async () => {
    const dir = new FakeDirectory();
    const t = setup({ directory: dir, inventory: async () => ["t-hint"], busy: ["t-hint"] });
    await t.run(2);
    expect(dir.rows.get("t-hint")).toEqual({ gen: 1, active: true });
  });
  test("a re-list never extends tracking, and an idle team the hint still lists is left alone for an hour", async () => {
    const dir = new FakeDirectory();
    const t = setup({ directory: dir, inventory: async () => ["t-old"] });
    await t.run(2);
    expect(t.tracked("t-old")).toBe(true);
    // Re-listed every 5 min, yet dropped after the 10 min grace: listing is not activity.
    await t.run(11 * 60);
    t.calls.length = 0;
    await t.run(30 * 60);
    expect(t.calls.filter((c) => c.endsWith(" t-old"))).toEqual([]);
    // After the quiet hour the hint may bring it back (it costs one look, then it is dropped again).
    await t.run(35 * 60);
    expect(t.tracked("t-old")).toBe(true);
  }, 30_000);
});

describe("keeping the directory right", () => {
  test("work is noted before the task exists", async () => {
    const dir = new FakeDirectory();
    const t = setup({ directory: dir, inventory: async () => [] });
    t.calls.length = 0;
    await t.orch.service.create("t-new", "u-owner", { projectId: PROJECT.id, prompt: "Add a page.", acceptance: [], maxAgents: 1, mode: "auto", pins: [], strategy: "split", harnesses: [] });
    expect(dir.log[0]).toBe("work t-new");
    expect(t.calls.indexOf("createTask t-new")).toBeGreaterThanOrEqual(0);
    expect(dir.rows.get("t-new")?.active).toBe(true);
    await t.settle();
  });

  test("a directory outage does not block task creation; the next pass notes the work", async () => {
    const dir = new FakeDirectory();
    dir.failWork = true;
    const t = setup({ directory: dir, inventory: async () => [], busy: ["t-new"] });
    await t.orch.service.create("t-new", "u-owner", { projectId: PROJECT.id, prompt: "Add a page.", acceptance: [], maxAgents: 1, mode: "auto", pins: [], strategy: "split", harnesses: [] });
    expect(t.calls).toContain("createTask t-new");
    expect(dir.rows.has("t-new")).toBe(false);
    dir.failWork = false;
    await t.run(16);
    expect(dir.rows.get("t-new")?.active).toBe(true);
  });

  test("an idle team is reported idle with the generation this process saw; newer work keeps it active", async () => {
    const dir = new FakeDirectory();
    await dir.noteWork("t-a");
    await dir.noteWork("t-b");
    // No re-list during the test: the idle reports carry the generations from the first listing.
    const t = setup({ directory: dir, inventory: async () => [], reseedMs: 60 * 60_000 });
    await t.run(2);
    // Another replica notes new work on t-b after we listed it.
    await dir.noteWork("t-b");
    // Past the tracking grace period with nothing to do.
    await t.run(11 * 60);
    expect(dir.log).toContain("idle t-a 1");
    expect(dir.log).toContain("idle t-b 1");
    expect(dir.rows.get("t-a")!.active).toBe(false);
    expect(dir.rows.get("t-b")!.active).toBe(true);
  }, 30_000);
});
