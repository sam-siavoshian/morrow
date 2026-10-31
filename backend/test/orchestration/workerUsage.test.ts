// Usage readings in worker output: Claude Code stream-json rate_limit_event and TUI warnings, Codex token_count
// events and TUI warnings. Samples follow the shapes in the Claude Code 2.1.312 binary and Codex 0.165 source.
import { describe, expect, test } from "bun:test";
import { ProfileUsage } from "@morrow/contracts";
import { parseWorkerUsage } from "../../src/orchestration/workerUsage.ts";

const NOW = Date.parse("2037-06-15T10:20:00.000Z");
const SEC = Math.floor(NOW / 1000);

describe("parseWorkerUsage", () => {
  test("Claude rate_limit_event with unifiedWindows: fractions become percents, every window kept", () => {
    const event = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: SEC + 3600,
        rateLimitType: "five_hour",
        utilization: 0.91,
        unifiedWindows: {
          five_hour: { utilization: 0.91, resetsAt: SEC + 3600, status: "allowed_warning" },
          seven_day: { utilization: 0.623, resetsAt: SEC + 86_400 },
          seven_day_overage_included: { utilization: 0.1 },
        },
      },
      uuid: "u",
      session_id: "s",
    };
    const r = parseWorkerUsage(`some output\n${JSON.stringify(event)}\n`, NOW)!;
    expect(r.usage).toEqual({
      windows: [
        { kind: "five_hour", label: "5-hour", usedPercent: 91, resetsAt: (SEC + 3600) * 1000 },
        { kind: "weekly", label: "Weekly", usedPercent: 62.3, resetsAt: (SEC + 86_400) * 1000 },
      ],
      observedAt: NOW,
      source: "worker",
    });
    expect(ProfileUsage.safeParse(r.usage).success).toBe(true);
  });

  test("Claude rate_limit_event without windows: its own type; rejected without utilization reads as full", () => {
    const one = (info: Record<string, unknown>) => parseWorkerUsage(JSON.stringify({ type: "rate_limit_event", rate_limit_info: info }), NOW);
    expect(one({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.4 })!.usage.windows).toEqual([
      { kind: "other", label: "Weekly Opus", usedPercent: 40, resetsAt: null },
    ]);
    expect(one({ status: "rejected", rateLimitType: "five_hour", resetsAt: SEC + 60 })!.usage.windows).toEqual([
      { kind: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: (SEC + 60) * 1000 },
    ]);
    expect(one({ status: "allowed", rateLimitType: "overage", utilization: 0.5 })).toBeNull();
    expect(one({ status: "allowed", rateLimitType: "five_hour" })).toBeNull();
  });

  test("Claude TUI warning and limit lines", () => {
    const warn = parseWorkerUsage("⎿ You’ve used 85% of your session limit · resets 3pm (UTC)\n", NOW)!;
    expect(warn.usage.windows).toEqual([{ kind: "five_hour", label: "5-hour", usedPercent: 85, resetsAt: Date.parse("2037-06-15T15:00:00Z") }]);
    expect(warn.line).toBe("You've used 85% of your session limit · resets 3pm (UTC)");
    expect(parseWorkerUsage("You've used 60% of your weekly limit", NOW)!.usage.windows[0]).toMatchObject({ kind: "weekly", usedPercent: 60, resetsAt: null });
    expect(parseWorkerUsage("You've hit your 5-hour limit · resets 3pm (UTC)", NOW)!.usage.windows[0]).toMatchObject({ kind: "five_hour", usedPercent: 100 });
    expect(parseWorkerUsage("Weekly limit reached ∙ resets 6pm", NOW)!.usage.windows[0]).toMatchObject({ kind: "weekly", usedPercent: 100 });
    expect(parseWorkerUsage("You've hit your Sonnet limit", NOW)!.usage.windows[0]).toMatchObject({ label: "Weekly Sonnet", usedPercent: 100 });
  });

  test("Codex token_count (rollout or bare) and the TUI heads-up", () => {
    const limits = { primary: { used_percent: 55.5, window_minutes: 300, resets_at: SEC + 600 }, secondary: { used_percent: 41, window_minutes: 10_080, resets_at: null } };
    const rollout = JSON.stringify({ timestamp: "2037-06-15T10:12:03.120Z", type: "event_msg", payload: { type: "token_count", info: null, rate_limits: limits } });
    expect(parseWorkerUsage(rollout, NOW)!.usage.windows).toEqual([
      { kind: "five_hour", label: "5-hour", usedPercent: 55.5, resetsAt: (SEC + 600) * 1000 },
      { kind: "weekly", label: "Weekly", usedPercent: 41, resetsAt: null },
    ]);
    expect(parseWorkerUsage(JSON.stringify({ type: "token_count", rate_limits: limits }), NOW)!.usage.windows).toHaveLength(2);
    expect(parseWorkerUsage(JSON.stringify({ type: "token_count", info: {} }), NOW)).toBeNull();
    expect(parseWorkerUsage("■ Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.", NOW)!.usage.windows).toEqual([
      { kind: "five_hour", label: "5-hour", usedPercent: 75, resetsAt: null },
    ]);
    expect(parseWorkerUsage("Heads up, you have less than 10% of your weekly limit left.", NOW)!.usage.windows[0]).toMatchObject({ kind: "weekly", usedPercent: 90 });
  });

  test("the latest reading wins", () => {
    const text = ["You've used 50% of your session limit", "work", "You've used 70% of your session limit", "more work"].join("\n");
    expect(parseWorkerUsage(text, NOW)!.usage.windows[0]!.usedPercent).toBe(70);
  });

  test("nothing usable: plain output, transient errors, broken or hostile JSON", () => {
    for (const text of [
      "",
      "compiling...\nall tests passed",
      "API Error: Server is temporarily limiting requests (not your usage limit)",
      "You've hit your limit · resets 6pm",
      '{"type":"rate_limit_event","rate_limit_info":',
      '{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"__proto__","utilization":0.5}}',
      '{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour","utilization":"0.5"}}',
      `{"type":"token_count","rate_limits":{"primary":{"used_percent":"9"}},"pad":"${"x".repeat(20_000)}"}`,
    ])
      expect(parseWorkerUsage(text, NOW)).toBeNull();
  });

  test("out-of-range values are clamped and far-off resets dropped", () => {
    const r = parseWorkerUsage(JSON.stringify({ type: "token_count", rate_limits: { primary: { used_percent: 141, window_minutes: 300, resets_at: SEC + 90 * 86_400 } } }), NOW)!;
    expect(r.usage.windows).toEqual([{ kind: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: null }]);
  });

  test("wording inside other output does not move the meter", () => {
    expect(parseWorkerUsage("$ bun test\nexpect(msg).toBe(\"You've used 99% of your weekly limit\")", NOW)).toBeNull();
    expect(parseWorkerUsage("echo You've hit your 5-hour limit", NOW)).toBeNull();
    expect(parseWorkerUsage("log: Heads up, you have less than 1% of your 5h limit left", NOW)).toBeNull();
    // The real TUI lines, with their prefixes, still count.
    expect(parseWorkerUsage("  ⎿ You've used 40% of your weekly limit", NOW)!.usage.windows[0]).toMatchObject({ kind: "weekly", usedPercent: 40 });
  });

  test("absurd windows and past resets are dropped, not shown", () => {
    const line = (w: Record<string, unknown>) => JSON.stringify({ type: "token_count", rate_limits: { primary: w } });
    const huge = parseWorkerUsage(line({ used_percent: 50, window_minutes: 1e300, resets_at: 1 }), NOW)!.usage.windows[0]!;
    expect(huge.label).toBe("Usage");
    expect(huge.resetsAt).toBeNull();
    const past = parseWorkerUsage(line({ used_percent: 50, window_minutes: 300, resets_at: Math.floor((NOW - 10 * 60_000) / 1000) }), NOW)!.usage.windows[0]!;
    expect(past.resetsAt).toBeNull();
    const skew = parseWorkerUsage(line({ used_percent: 50, window_minutes: 300, resets_at: Math.floor((NOW - 30_000) / 1000) }), NOW)!.usage.windows[0]!;
    expect(skew.resetsAt).not.toBeNull();
  });
});
