import { describe, expect, test } from "bun:test";
import { USAGE_STALE_MS, type MemberView, type ProfileUsage, type ProfileView, type UsageWindow } from "@morrow/contracts";
import { bindingWindow, formatAgo, percentLabel, poolSegment, poolSummary, selectPool } from "./pool-model";

const NOW = Date.UTC(2030, 0, 15, 12, 0);
const MIN = 60_000;
const up = { vmRunning: true, nodeOnline: true, now: NOW };

const five = (used: number, resetsAt: number | null = NOW + 120 * MIN): UsageWindow => ({ kind: "five_hour", label: "5-hour", usedPercent: used, resetsAt });
const week = (used: number, resetsAt: number | null = NOW + 3 * 24 * 60 * MIN): UsageWindow => ({ kind: "weekly", label: "Weekly", usedPercent: used, resetsAt });
const usage = (windows: UsageWindow[], ageMs = 2 * MIN): ProfileUsage => ({ windows, observedAt: NOW - ageMs, source: "probe" });

let seq = 0;
function profile(patch: Partial<ProfileView> = {}): ProfileView {
  seq++;
  return {
    id: `p${seq}`,
    envId: "env-a",
    ownerUserId: "ada",
    cli: "claude",
    label: `CLI ${seq}`,
    auth: "ok",
    availability: "ready",
    cooldownUntil: null,
    limitedReason: null,
    limitedSource: null,
    maxConcurrent: 2,
    activeLeases: 0,
    scopes: "all",
    lastSeenAt: NOW - MIN,
    usage: null,
    ...patch,
  };
}

const member = (userId: string, name: string | null, login = userId): MemberView => ({ userId, login, name, avatarUrl: null, role: "member" });

function pool(profiles: ProfileView[], opts: { viewerId?: string | null; members?: MemberView[]; env?: { vmState: "running" | "paused"; nodeOnline: boolean } } = {}) {
  const env = opts.env ?? { vmState: "running" as const, nodeOnline: true };
  return selectPool({
    workforce: { profiles: Object.fromEntries(profiles.map((p) => [p.id, p])) },
    team: { members: opts.members ?? [member("ada", "Ada"), member("linus", "Linus"), member("grace", null, "grace-h")], environments: [] },
    envStatus: { "env-a": env, "env-b": env },
    viewerId: opts.viewerId === undefined ? "ada" : opts.viewerId,
    now: NOW,
  });
}

describe("binding window", () => {
  test("the window with the least left of 5-hour and weekly binds", () => {
    const s = poolSegment(profile({ usage: usage([five(30), week(90)]) }), up);
    expect(s.binding?.kind).toBe("weekly");
    expect(s.left).toBe(10);
    expect(s.state).toBe("low");
  });
  test("an 'other' window (Weekly Opus) does not bind while 5-hour or weekly exist", () => {
    const s = poolSegment(profile({ usage: usage([five(40), week(20), { kind: "other", label: "Weekly Opus", usedPercent: 99, resetsAt: null }]) }), up);
    expect(s.binding?.kind).toBe("five_hour");
    expect(s.left).toBe(60);
    expect(s.windows).toHaveLength(3);
  });
  test("with only other windows, the tightest of those binds", () => {
    const b = bindingWindow([
      { kind: "other", label: "Daily", left: 70, resetsAt: null },
      { kind: "other", label: "Monthly", left: 40, resetsAt: null },
    ]);
    expect(b?.label).toBe("Monthly");
  });
  test("a tie goes to the window that resets first", () => {
    const b = bindingWindow([
      { kind: "weekly", label: "Weekly", left: 50, resetsAt: NOW + 9 * MIN },
      { kind: "five_hour", label: "5-hour", left: 50, resetsAt: NOW + 5 * MIN },
    ]);
    expect(b?.kind).toBe("five_hour");
  });
  test("a window whose reset has passed reads as full again", () => {
    const s = poolSegment(profile({ usage: usage([five(100, NOW - MIN), week(25)]) }), up);
    expect(s.windows[0]).toMatchObject({ left: 100, resetsAt: null });
    expect(s.binding?.kind).toBe("weekly");
    expect(s.left).toBe(75);
    expect(s.state).toBe("healthy");
  });
  test("used percent is clamped into 0-100 headroom", () => {
    expect(poolSegment(profile({ usage: usage([five(0)]) }), up).left).toBe(100);
    expect(poolSegment(profile({ usage: usage([five(100)]) }), up).left).toBe(0);
  });
});

describe("segment states", () => {
  test("healthy at 20% left or more, low below", () => {
    expect(poolSegment(profile({ usage: usage([five(80)]) }), up).state).toBe("healthy");
    expect(poolSegment(profile({ usage: usage([five(80.5)]) }), up).state).toBe("low");
  });
  test("no reading yet is unknown, never zero or full", () => {
    const s = poolSegment(profile(), up);
    expect(s).toMatchObject({ state: "unknown", left: null, observedAt: null, source: null, stale: false });
  });
  test("a view written before usage existed (field absent) is unknown", () => {
    const legacy = profile();
    delete legacy.usage;
    expect(poolSegment(legacy, up).state).toBe("unknown");
  });
  test("limited reads 0 left with its reset", () => {
    const s = poolSegment(profile({ availability: "limited", cooldownUntil: NOW + 40 * MIN, limitedSource: "detected", usage: usage([five(10)]) }), up);
    expect(s).toMatchObject({ state: "limited", left: 0, until: NOW + 40 * MIN });
  });
  test("signed out beats everything; offline when the VM or node is down", () => {
    expect(poolSegment(profile({ auth: "auth_required", availability: "limited" }), up).state).toBe("auth");
    expect(poolSegment(profile({ usage: usage([five(10)]) }), { ...up, vmRunning: false }).state).toBe("offline");
    expect(poolSegment(profile(), { ...up, nodeOnline: false }).state).toBe("offline");
  });
  test("opencode has no plan window: unmetered, readings ignored", () => {
    const s = poolSegment(profile({ cli: "opencode", usage: usage([five(90)]) }), up);
    expect(s).toMatchObject({ state: "unmetered", left: null, windows: [], binding: null });
  });
  test("Cursor Agent, Gemini CLI and Grok are metered: unknown until a reading comes in, then the window binds", () => {
    for (const cli of ["cursor", "gemini", "grok"] as const) {
      expect(poolSegment(profile({ cli, usage: null }), up)).toMatchObject({ state: "unknown", left: null });
      expect(poolSegment(profile({ cli, usage: usage([five(90)]) }), up)).toMatchObject({ state: "low", left: 10 });
    }
  });
  test("a reading older than 30 minutes is stale; exactly 30 is not", () => {
    expect(poolSegment(profile({ usage: usage([five(10)], USAGE_STALE_MS) }), up).stale).toBe(false);
    expect(poolSegment(profile({ usage: usage([five(10)], USAGE_STALE_MS + 1) }), up).stale).toBe(true);
  });
});

describe("selectPool", () => {
  test("groups by member, viewer first, then team order, CLIs ordered claude, codex, opencode", () => {
    const p = pool(
      [
        profile({ ownerUserId: "linus", cli: "opencode", usage: null }),
        profile({ ownerUserId: "grace", cli: "codex", usage: usage([five(10)]) }),
        profile({ ownerUserId: "ada", cli: "codex", usage: usage([five(50)]) }),
        profile({ ownerUserId: "ada", cli: "claude", usage: usage([five(30)]) }),
        profile({ ownerUserId: "linus", cli: "claude", usage: usage([five(60)]) }),
      ],
      { viewerId: "grace" },
    );
    expect(p.groups.map((g) => [g.name, g.isViewer])).toEqual([
      ["grace-h", true],
      ["Ada", false],
      ["Linus", false],
    ]);
    expect(p.groups[1]!.segments.map((s) => s.cli)).toEqual(["claude", "codex"]);
    expect(p.groups[2]!.segments.map((s) => s.cli)).toEqual(["claude", "opencode"]);
    expect(p.total).toBe(5);
  });
  test("new harnesses sort after opencode: cursor, gemini, grok", () => {
    const p = pool([
      profile({ cli: "grok", usage: null }),
      profile({ cli: "gemini", usage: null }),
      profile({ cli: "opencode", usage: null }),
      profile({ cli: "cursor", usage: null }),
      profile({ cli: "claude", usage: usage([five(30)]) }),
    ]);
    expect(p.groups[0]!.segments.map((s) => s.cli)).toEqual(["claude", "opencode", "cursor", "gemini", "grok"]);
  });
  test("a profile whose owner left the team still counts, under 'Former member'", () => {
    const p = pool([profile({ ownerUserId: "gone", usage: usage([five(10)]) })]);
    expect(p.groups[0]).toMatchObject({ name: "Former member", isViewer: false });
  });
  test("headline is the mean binding headroom over current readings; limited counts as 0", () => {
    const p = pool([
      profile({ usage: usage([five(20)]) }), // 80
      profile({ usage: usage([five(60), week(10)]) }), // 40
      profile({ availability: "limited", cooldownUntil: NOW + 30 * MIN, limitedSource: "detected" }), // 0
      profile({ cli: "opencode" }), // not measured
      profile(), // unknown, not measured
      profile({ usage: usage([five(0)], USAGE_STALE_MS + MIN) }), // stale, not measured
    ]);
    expect(p.left).toBe(40);
    expect(p.measured).toBe(3);
    expect(p.limited).toBe(1);
    expect(p.nextReset).toBe(NOW + 30 * MIN);
    expect(p.stale).toBe(1);
  });
  test("no current readings: headline is null, not 0 or 100", () => {
    const p = pool([profile(), profile({ cli: "opencode" })]);
    expect(p.left).toBeNull();
    expect(p.measured).toBe(0);
  });
  test("next reset is the soonest among limited CLIs", () => {
    const p = pool([
      profile({ availability: "limited", cooldownUntil: NOW + 90 * MIN, limitedSource: "detected" }),
      profile({ availability: "limited", cooldownUntil: NOW + 20 * MIN, limitedSource: "detected" }),
    ]);
    expect(p.nextReset).toBe(NOW + 20 * MIN);
    expect(poolSummary(p, NOW, "en-US")).toContain("2 limited until ");
  });
  test("a paused VM puts its CLIs offline and out of the headline", () => {
    const p = pool([profile({ usage: usage([five(10)]) })], { env: { vmState: "paused", nodeOnline: true } });
    expect(p.offline).toBe(1);
    expect(p.left).toBeNull();
  });
  test("signed-out CLIs are counted", () => {
    expect(pool([profile({ auth: "auth_required" }), profile()]).needsSignIn).toBe(1);
  });
  test("empty workforce", () => {
    const p = selectPool({ workforce: null, team: null, envStatus: {}, viewerId: null, now: NOW });
    expect(p).toMatchObject({ groups: [], total: 0, left: null, limited: 0 });
  });
});

describe("summary and labels", () => {
  test("empty pool asks to connect a CLI", () => {
    expect(poolSummary(pool([]), NOW)).toBe("Connect a CLI to start the pool");
  });
  test("full summary names headroom, count, limits and sign-ins", () => {
    const p = pool([
      profile({ usage: usage([five(36)]) }),
      profile({ availability: "limited", cooldownUntil: NOW + 40 * MIN, limitedSource: "detected" }),
      profile({ auth: "auth_required" }),
    ]);
    const text = poolSummary(p, NOW, "en-US");
    expect(text).toStartWith("Pool · 32% left · 3 CLIs · 1 limited until ");
    expect(text).toEndWith(" · 1 needs sign-in");
    expect(text).not.toContain("—");
  });
  test("no readings yet says so", () => {
    expect(poolSummary(pool([profile()]), NOW)).toBe("Pool · no usage data yet · 1 CLI");
  });
  test("formatAgo buckets", () => {
    expect(formatAgo(NOW - 30_000, NOW)).toBe("just now");
    expect(formatAgo(NOW - 3 * MIN, NOW)).toBe("3m ago");
    expect(formatAgo(NOW - 125 * MIN, NOW)).toBe("2h ago");
    expect(formatAgo(NOW - 3 * 24 * 60 * MIN, NOW)).toBe("3d ago");
    expect(formatAgo(NOW + MIN, NOW)).toBe("just now");
  });
  test("percentLabel never rounds a touched window to 100 or an open one to 0", () => {
    expect(percentLabel(99.6)).toBe("99%");
    expect(percentLabel(0.3)).toBe("1%");
    expect(percentLabel(100)).toBe("100%");
    expect(percentLabel(0)).toBe("0%");
    expect(percentLabel(42.4)).toBe("42%");
  });
});
