import type { ProfileUsage, UsageWindow } from "@morrow/contracts";
import type { Freestyle } from "freestyle";
import { z } from "zod";
import { freestyle } from "./client.ts";
import { runScript } from "./exec.ts";
import { assertLinuxUser } from "./names.ts";

/** Two HTTP-bound reads plus a Codex app-server start; the script bounds each one itself. */
export const USAGE_TIMEOUT_MS = 40_000;
/** No subscription window resets further out than this (Codex's longest is a month). */
const MAX_RESET_AHEAD_MS = 35 * 24 * 60 * 60_000;
/** A reset already past by more than clock skew is not a reset time. */
const RESET_PAST_SLACK_MS = 60_000;
/** No subscription window is longer than a month or so; anything past this is not a real window length. */
const MAX_WINDOW_MINUTES = 60 * 24 * 60;

/** Why there is no reading. Fixed words only: nothing from the vendor reaches the browser. */
export type UsageStatus = "ok" | "no_login" | "expired" | "no_scope" | "rejected" | "throttled" | "unavailable" | "no_data";

export interface CliUsage {
  status: UsageStatus;
  /** Present only with `ok`. */
  usage: ProfileUsage | null;
}

export interface UsageReport {
  ok: boolean;
  error: "timeout" | "exec_failed" | "bad_output" | null;
  claude: CliUsage;
  codex: CliUsage;
}

const Status = z.enum(["no_login", "expired", "no_scope", "rejected", "throttled", "unavailable", "no_data"]);
const Iso = z.string().max(40);
const Num = z.number().finite();

const ClaudeWire = z.union([
  z.object({
    status: z.literal("ok"),
    windows: z
      .array(z.object({ key: z.enum(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]), used: Num, resetsAt: Iso.nullable() }))
      .max(4),
  }),
  z.object({ status: Status }),
]);

const CodexWire = z.union([
  z.object({
    status: z.literal("ok"),
    source: z.enum(["app_server", "rollout"]),
    observedAt: Iso.optional(),
    windows: z.array(z.object({ used: Num, minutes: Num.nullable(), resetsAt: Num.nullable() })).max(4),
  }),
  z.object({ status: Status }),
]);

const UsageWire = z.object({ v: z.literal(1), claude: ClaudeWire, codex: CodexWire });

const CLAUDE_WINDOWS: Record<"five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet", Pick<UsageWindow, "kind" | "label">> = {
  five_hour: { kind: "five_hour", label: "5-hour" },
  seven_day: { kind: "weekly", label: "Weekly" },
  seven_day_opus: { kind: "other", label: "Weekly Opus" },
  seven_day_sonnet: { kind: "other", label: "Weekly Sonnet" },
};

/** 0-100, one decimal. Vendors report above 100 once a window is overdrawn; that still reads as full. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/** A reset instant we can trust: a real time, no further out than any window lasts. */
export function sanitizeReset(at: number | null, observedAt: number): number | null {
  if (at === null || !Number.isFinite(at) || at <= 0) return null;
  const ms = Math.round(at);
  return ms > observedAt + MAX_RESET_AHEAD_MS || ms < observedAt - RESET_PAST_SLACK_MS ? null : ms;
}

/**
 * Codex names windows by length (codex-rs tui `get_limits_duration`, within 5 %): 5h, daily, weekly, monthly.
 * Anything else keeps its length as the label.
 */
export function codexWindow(minutes: number | null): Pick<UsageWindow, "kind" | "label"> {
  const near = (target: number) => minutes !== null && Math.abs(minutes - target) <= target * 0.05;
  if (near(300)) return { kind: "five_hour", label: "5-hour" };
  if (near(10_080)) return { kind: "weekly", label: "Weekly" };
  if (near(1_440)) return { kind: "other", label: "Daily" };
  if (near(43_200)) return { kind: "other", label: "Monthly" };
  if (minutes === null || minutes <= 0 || minutes > MAX_WINDOW_MINUTES) return { kind: "other", label: "Usage" };
  return { kind: "other", label: minutes < 1_440 ? `${Math.round(minutes / 60)}-hour` : `${Math.round(minutes / 1_440)}-day` };
}

/** Same (kind, label) once: a vendor that repeats a window cannot double it in the view. */
function unique(windows: UsageWindow[]): UsageWindow[] {
  const seen = new Set<string>();
  return windows.filter((w) => {
    const key = `${w.kind}|${w.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function claudeUsage(wire: z.infer<typeof ClaudeWire>, now: number): CliUsage {
  if (wire.status !== "ok") return { status: wire.status, usage: null };
  const windows = wire.windows.map((w) => ({
    ...CLAUDE_WINDOWS[w.key],
    usedPercent: clampPercent(w.used),
    resetsAt: sanitizeReset(w.resetsAt === null ? null : Date.parse(w.resetsAt), now),
  }));
  return { status: "ok", usage: { windows: unique(windows), observedAt: now, source: "probe" } };
}

function codexUsage(wire: z.infer<typeof CodexWire>, now: number): CliUsage {
  if (wire.status !== "ok") return { status: wire.status, usage: null };
  // The app server answers live; a rollout snapshot is as old as the session line that wrote it.
  let observedAt = now;
  if (wire.source === "rollout") {
    const at = wire.observedAt === undefined ? Number.NaN : Date.parse(wire.observedAt);
    if (!Number.isFinite(at)) return { status: "no_data", usage: null };
    observedAt = Math.min(at, now);
  }
  const windows = wire.windows.map((w) => ({
    ...codexWindow(w.minutes),
    usedPercent: clampPercent(w.used),
    resetsAt: sanitizeReset(w.resetsAt === null ? null : w.resetsAt * 1000, observedAt),
  }));
  return { status: "ok", usage: { windows: unique(windows), observedAt, source: "probe" } };
}

function failedReport(error: UsageReport["error"]): UsageReport {
  return { ok: false, error, claude: { status: "unavailable", usage: null }, codex: { status: "unavailable", usage: null } };
}

/** Parse usage.sh output. Anything malformed is "no reading", never a guessed number. */
export function parseUsageOutput(stdout: string, now = Date.now()): UsageReport {
  const line = stdout.trimEnd().split("\n").at(-1) ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return failedReport("bad_output");
  }
  const parsed = UsageWire.safeParse(raw);
  if (!parsed.success) return failedReport("bad_output");
  return { ok: true, error: null, claude: claudeUsage(parsed.data.claude, now), codex: codexUsage(parsed.data.codex, now) };
}

/**
 * Read subscription usage as the engineer's Linux user (the CLI logins live in that home). Exec-level
 * failures come back as `ok: false`; API errors (VM gone, provider down) throw FreestyleIntegrationError.
 */
export async function probeUsage(opts: { vmId: string; linuxUser: string; client?: Freestyle }): Promise<UsageReport> {
  assertLinuxUser(opts.linuxUser);
  const vm = (opts.client ?? freestyle()).vms.ref(opts.vmId);
  const outcome = await runScript(vm, { user: opts.linuxUser, script: "usage", timeoutMs: USAGE_TIMEOUT_MS, step: "usage probe" });
  if (outcome.statusCode === null) return failedReport("timeout");
  if (outcome.statusCode !== 0) return failedReport("exec_failed");
  return parseUsageOutput(outcome.stdout, Date.now());
}
