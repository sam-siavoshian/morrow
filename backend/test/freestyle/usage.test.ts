// usage.sh output parsing: vendor shapes (Claude /api/oauth/usage, Codex account/rateLimits/read and rollout
// token_count) normalized into ProfileUsage, and every malformed line degrading to "no reading".
import { describe, expect, test } from "bun:test";
import { ProfileUsage } from "@morrow/contracts";
import { clampPercent, codexWindow, parseUsageOutput, sanitizeReset } from "../../src/integrations/freestyle/usage.ts";

const NOW = Date.parse("2037-06-15T10:20:00.000Z");
const line = (claude: unknown, codex: unknown) => JSON.stringify({ v: 1, claude, codex });

describe("parseUsageOutput", () => {
  test("Claude windows: 0-100 utilization, ISO resets, opus/sonnet as named weekly windows", () => {
    const r = parseUsageOutput(
      `noise before\n${line(
        {
          status: "ok",
          windows: [
            { key: "five_hour", used: 37.46, resetsAt: "2037-06-15T14:00:00.000Z" },
            { key: "seven_day", used: 112, resetsAt: "2037-06-19T09:00:00+00:00" },
            { key: "seven_day_opus", used: -3, resetsAt: null },
            { key: "seven_day_sonnet", used: 12, resetsAt: "2038-06-01T00:00:00Z" },
          ],
        },
        { status: "no_data" },
      )}\n`,
      NOW,
    );
    expect(r.ok).toBe(true);
    expect(r.claude.status).toBe("ok");
    expect(r.claude.usage).toEqual({
      windows: [
        { kind: "five_hour", label: "5-hour", usedPercent: 37.5, resetsAt: Date.parse("2037-06-15T14:00:00.000Z") },
        { kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: Date.parse("2037-06-19T09:00:00Z") },
        { kind: "other", label: "Weekly Opus", usedPercent: 0, resetsAt: null },
        // A reset months away is not a real window reset.
        { kind: "other", label: "Weekly Sonnet", usedPercent: 12, resetsAt: null },
      ],
      observedAt: NOW,
      source: "probe",
    });
    expect(ProfileUsage.safeParse(r.claude.usage).success).toBe(true);
    expect(r.codex).toEqual({ status: "no_data", usage: null });
  });

  test("Codex app server: windows named by length, epoch-second resets, read now", () => {
    const r = parseUsageOutput(
      line(
        { status: "expired" },
        {
          status: "ok",
          source: "app_server",
          windows: [
            { used: 23, minutes: 300, resetsAt: 2_128_705_200 },
            { used: 41, minutes: 10_080, resetsAt: 2_129_304_800 },
          ],
        },
      ),
      NOW,
    );
    expect(r.claude).toEqual({ status: "expired", usage: null });
    expect(r.codex.usage).toEqual({
      windows: [
        { kind: "five_hour", label: "5-hour", usedPercent: 23, resetsAt: 2_128_705_200_000 },
        { kind: "weekly", label: "Weekly", usedPercent: 41, resetsAt: 2_129_304_800_000 },
      ],
      observedAt: NOW,
      source: "probe",
    });
  });

  test("Codex rollout: as old as its line, never in the future; a missing time is no reading", () => {
    const rollout = (observedAt: string | undefined) =>
      parseUsageOutput(line({ status: "no_login" }, { status: "ok", source: "rollout", observedAt, windows: [{ used: 55.5, minutes: 300, resetsAt: null }] }), NOW);
    expect(rollout("2037-06-15T10:12:03.120Z").codex.usage!.observedAt).toBe(Date.parse("2037-06-15T10:12:03.120Z"));
    expect(rollout("2038-01-01T00:00:00Z").codex.usage!.observedAt).toBe(NOW);
    expect(rollout(undefined).codex).toEqual({ status: "no_data", usage: null });
    expect(rollout("not a date").codex).toEqual({ status: "no_data", usage: null });
  });

  test("a repeated window counts once", () => {
    const r = parseUsageOutput(
      line(
        { status: "ok", windows: [{ key: "five_hour", used: 10, resetsAt: null }, { key: "five_hour", used: 90, resetsAt: null }] },
        { status: "ok", source: "app_server", windows: [{ used: 1, minutes: 300, resetsAt: null }, { used: 2, minutes: 299, resetsAt: null }] },
      ),
      NOW,
    );
    expect(r.claude.usage!.windows).toHaveLength(1);
    expect(r.codex.usage!.windows).toEqual([{ kind: "five_hour", label: "5-hour", usedPercent: 1, resetsAt: null }]);
  });

  test("malformed output is a failed report, never a number", () => {
    const bad = [
      "",
      "not json",
      JSON.stringify({ v: 2, claude: { status: "no_login" }, codex: { status: "no_login" } }),
      line({ status: "ok", windows: [{ key: "five_hour", used: "37", resetsAt: null }] }, { status: "no_data" }),
      line({ status: "ok", windows: [{ key: "seven_day_oauth_apps", used: 1, resetsAt: null }] }, { status: "no_data" }),
      line({ status: "weird" }, { status: "no_data" }),
      line({ status: "ok", windows: Array.from({ length: 5 }, () => ({ key: "five_hour", used: 1, resetsAt: null })) }, { status: "no_data" }),
      line({ status: "no_login" }, { status: "ok", source: "elsewhere", windows: [] }),
      line({ status: "no_login" }, { status: "ok", source: "app_server", windows: [{ used: 1e400, minutes: 300, resetsAt: null }] }),
      line({ status: "ok", windows: [{ key: "five_hour", used: 1, resetsAt: "x".repeat(41) }] }, { status: "no_data" }),
    ];
    for (const stdout of bad) {
      const r = parseUsageOutput(stdout, NOW);
      expect(r).toEqual({ ok: false, error: "bad_output", claude: { status: "unavailable", usage: null }, codex: { status: "unavailable", usage: null } });
    }
  });

  test("every non-ok status passes through as a fixed word", () => {
    for (const status of ["no_login", "expired", "no_scope", "rejected", "throttled", "unavailable", "no_data"] as const) {
      const r = parseUsageOutput(line({ status }, { status }), NOW);
      expect(r.claude).toEqual({ status, usage: null });
      expect(r.codex).toEqual({ status, usage: null });
    }
  });
});

describe("helpers", () => {
  test("clampPercent bounds to 0-100 with one decimal", () => {
    expect(clampPercent(37.46)).toBe(37.5);
    expect(clampPercent(141)).toBe(100);
    expect(clampPercent(-1)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
  });

  test("sanitizeReset drops nonsense and far-future resets", () => {
    expect(sanitizeReset(null, NOW)).toBeNull();
    expect(sanitizeReset(Number.NaN, NOW)).toBeNull();
    expect(sanitizeReset(0, NOW)).toBeNull();
    expect(sanitizeReset(NOW + 60_000, NOW)).toBe(NOW + 60_000);
    expect(sanitizeReset(NOW + 40 * 24 * 3_600_000, NOW)).toBeNull();
  });

  test("codexWindow follows the TUI's 5 % length match", () => {
    expect(codexWindow(300)).toEqual({ kind: "five_hour", label: "5-hour" });
    expect(codexWindow(310)).toEqual({ kind: "five_hour", label: "5-hour" });
    expect(codexWindow(10_080)).toEqual({ kind: "weekly", label: "Weekly" });
    expect(codexWindow(1_440)).toEqual({ kind: "other", label: "Daily" });
    expect(codexWindow(43_200)).toEqual({ kind: "other", label: "Monthly" });
    expect(codexWindow(120)).toEqual({ kind: "other", label: "2-hour" });
    expect(codexWindow(4_320)).toEqual({ kind: "other", label: "3-day" });
    expect(codexWindow(null)).toEqual({ kind: "other", label: "Usage" });
  });
});
