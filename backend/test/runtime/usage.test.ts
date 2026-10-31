// ProfileService.refreshUsage: cadence (once per 5 min plus jitter per environment, failures included), which
// profiles are read, and how the VM report lands on them.
import { describe, expect, test } from "bun:test";
import type { ProfileUsage } from "@morrow/contracts";
import type { UsageReport } from "../../src/integrations/freestyle/index.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import type { EnvironmentRunner } from "../../src/runtime/environments.ts";
import { ProfileService, USAGE_JITTER_MS, USAGE_REFRESH_MS } from "../../src/runtime/profiles.ts";
import { fakeRuntimeActors } from "../support/fakeRuntimeActors.ts";

const T = "t-usage";
const T0 = 1_800_000_000_000;

const reading = (usedPercent: number, observedAt: number): ProfileUsage => ({
  windows: [{ kind: "five_hour", label: "5-hour", usedPercent, resetsAt: observedAt + 3_600_000 }],
  observedAt,
  source: "probe",
});

function setup(reports: (UsageReport | null | Error)[]) {
  const actors = fakeRuntimeActors();
  let now = T0;
  const reads: string[] = [];
  const service = new ProfileService({ actors, log: silentLogger, now: () => now, features: { freestyle: true, relay: true } });
  const runner = {
    async readUsage(teamId: string, envId: string) {
      reads.push(`${teamId}/${envId}`);
      const next = reports.shift() ?? null;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  service.attach(runner as unknown as EnvironmentRunner);
  const profile = async (id: string, envId: string, cli: "claude" | "codex" | "opencode", auth: "ok" | "auth_required" | "unknown" = "ok") => {
    await actors.registerProfile(T, { id, envId, ownerUserId: "u-1", nodeName: "n-1", cli, label: id, scopes: "all", maxConcurrent: 1 });
    const map = actors.profiles.get(T)!;
    map.set(id, { ...map.get(id)!, auth });
  };
  return {
    actors,
    service,
    reads,
    profile,
    usage: (id: string) => actors.profiles.get(T)!.get(id)!.usage ?? null,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

const ok = (claude: ProfileUsage | null, codex: ProfileUsage | null): UsageReport => ({
  ok: true,
  error: null,
  claude: { status: claude ? "ok" : "expired", usage: claude },
  codex: { status: codex ? "ok" : "no_data", usage: codex },
});

describe("refreshUsage", () => {
  test("stores each CLI's reading on its own profile; opencode and signed-out profiles are left alone", async () => {
    const h = setup([ok(reading(40, T0), reading(10, T0))]);
    await h.profile("pc", "e-1", "claude");
    await h.profile("px", "e-1", "codex");
    await h.profile("po", "e-1", "opencode");
    await h.profile("other", "e-2", "claude");
    expect(await h.service.refreshUsage(T, "e-1")).toBe(2);
    expect(h.reads).toEqual([`${T}/e-1`]);
    expect(h.usage("pc")).toEqual(reading(40, T0));
    expect(h.usage("px")).toEqual(reading(10, T0));
    expect(h.usage("po")).toBeNull();
    expect(h.usage("other")).toBeNull();
  });

  test("no signed-in Claude Code or Codex profile: no VM read at all", async () => {
    const h = setup([]);
    await h.profile("po", "e-1", "opencode");
    await h.profile("pc", "e-1", "claude", "auth_required");
    await h.profile("px", "e-1", "codex", "unknown");
    expect(await h.service.refreshUsage(T, "e-1")).toBe(0);
    expect(h.reads).toEqual([]);
  });

  test("at most one read per environment per interval (jitter included), failed reads too", async () => {
    const h = setup([new Error("vm gone"), { ok: false, error: "timeout", claude: { status: "unavailable", usage: null }, codex: { status: "unavailable", usage: null } }, ok(reading(55, T0), null)]);
    await h.profile("pc", "e-1", "claude");
    await expect(h.service.refreshUsage(T, "e-1")).rejects.toThrow("vm gone");
    expect(await h.service.refreshUsage(T, "e-1")).toBe(0);
    h.advance(USAGE_REFRESH_MS - 1);
    expect(await h.service.refreshUsage(T, "e-1")).toBe(0);
    expect(h.reads).toHaveLength(1);
    h.advance(USAGE_JITTER_MS + 1);
    expect(await h.service.refreshUsage(T, "e-1")).toBe(0);
    expect(h.reads).toHaveLength(2);
    h.advance(USAGE_REFRESH_MS + USAGE_JITTER_MS);
    expect(await h.service.refreshUsage(T, "e-1")).toBe(1);
    expect(h.usage("pc")!.windows[0]!.usedPercent).toBe(55);
  });

  test("a status without a reading changes nothing; an older reading than the stored one is not applied", async () => {
    const h = setup([ok(null, null), ok(reading(20, T0 - 1), null)]);
    await h.profile("pc", "e-1", "claude");
    await h.actors.recordProfileUsage(T, "pc", reading(70, T0));
    expect(await h.service.refreshUsage(T, "e-1")).toBe(0);
    h.advance(USAGE_REFRESH_MS + USAGE_JITTER_MS);
    expect(await h.service.refreshUsage(T, "e-1")).toBe(0);
    expect(h.usage("pc")!.windows[0]!.usedPercent).toBe(70);
  });

  test("an environment that cannot be read now (runner says null) waits for the next interval", async () => {
    const h = setup([null]);
    await h.profile("pc", "e-1", "claude");
    expect(await h.service.refreshUsage(T, "e-1")).toBe(0);
    expect(await h.service.refreshUsage(T, "e-1")).toBe(0);
    expect(h.reads).toHaveLength(1);
  });

  test("removing the environment forgets its schedule", async () => {
    const h = setup([ok(reading(1, T0), null), ok(reading(2, T0 + 1), null)]);
    await h.profile("pc", "e-1", "claude");
    await h.service.refreshUsage(T, "e-1");
    await h.service.removeForEnvironment(T, "e-1");
    await h.profile("pc2", "e-1", "claude");
    expect(await h.service.refreshUsage(T, "e-1")).toBe(1);
    expect(h.reads).toHaveLength(2);
  });
});
