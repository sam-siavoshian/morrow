// Usage readings a worker's own output gives away, between two probe reads. Workers run as TUIs in Relay PTYs,
// so this reads what the TUI prints, plus the JSON events a headless or logging harness writes:
//  - Claude Code stream-json `rate_limit_event` (`rate_limit_info.utilization` is a 0-1 fraction, `resetsAt`
//    epoch seconds; `unifiedWindows` names each window).
//  - Claude Code TUI: "You've used 85% of your session limit · resets 3pm" and "You've hit your 5-hour limit".
//  - Codex `token_count` events with `rate_limits` (0-100, epoch seconds), as in session rollouts.
//  - Codex TUI: "Heads up, you have less than 25% of your 5h limit left" (read as 75 % used).
// The latest reading in the text wins. Shapes: docs/research/cli-signals.md and the Claude Code / Codex sources.
import type { ProfileUsage, UsageWindow } from "@morrow/contracts";
import { clampPercent, codexWindow, sanitizeReset } from "../integrations/freestyle/usage.ts";
import { normalize, parseReset } from "./classifier.ts";

export interface WorkerUsage {
  usage: ProfileUsage;
  /** The line it came from, so the monitor reports each printed reading once, not on every log read. */
  line: string;
}

type Named = Pick<UsageWindow, "kind" | "label">;

const CLAUDE_KEYS: Record<string, Named> = {
  five_hour: { kind: "five_hour", label: "5-hour" },
  seven_day: { kind: "weekly", label: "Weekly" },
  seven_day_opus: { kind: "other", label: "Weekly Opus" },
  seven_day_sonnet: { kind: "other", label: "Weekly Sonnet" },
};

const CLAUDE_NAMES: Record<string, Named> = {
  "5-hour": CLAUDE_KEYS.five_hour!,
  session: CLAUDE_KEYS.five_hour!,
  weekly: CLAUDE_KEYS.seven_day!,
  opus: CLAUDE_KEYS.seven_day_opus!,
  sonnet: CLAUDE_KEYS.seven_day_sonnet!,
};

const CODEX_NAMES: Record<string, number> = { "5h": 300, daily: 1_440, weekly: 10_080, monthly: 43_200 };

// Anchored to the start of a normalized line (TUI prefixes already stripped): a test or a file the worker prints
// that merely contains this wording must not move the pool meter.
const CLAUDE_USED = /^You've used (\d{1,3})% of your (5-hour|session|weekly|Opus|Sonnet) limit/i;
const CLAUDE_HIT = /^(?:You've hit your (5-hour|session|weekly|Opus|Sonnet) limit|(5-hour|Session|Weekly|Opus|Sonnet) limit reached · resets)/i;
const CODEX_LEFT = /^Heads up, you have less than (\d{1,3})% of your (5h|daily|weekly|monthly) limit left/i;
const MAX_LINE = 16_384;

/** Own keys only: a vendor key like "__proto__" must not resolve to Object.prototype. */
const claudeKey = (key: unknown): Named | undefined => (typeof key === "string" && Object.hasOwn(CLAUDE_KEYS, key) ? CLAUDE_KEYS[key] : undefined);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function window(named: Named, usedPercent: number, resetsAt: number | null, now: number): UsageWindow {
  return { ...named, usedPercent: clampPercent(usedPercent), resetsAt: sanitizeReset(resetsAt, now) };
}

function fromRateLimitEvent(info: Record<string, unknown>, now: number): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const unified = obj(info.unifiedWindows);
  if (unified) {
    for (const [key, raw] of Object.entries(unified)) {
      const w = obj(raw);
      const named = claudeKey(key);
      const used = num(w?.utilization);
      if (!named || !w || used === null) continue;
      const reset = num(w.resetsAt);
      windows.push(window(named, used * 100, reset === null ? null : reset * 1000, now));
    }
    if (windows.length > 0) return windows;
  }
  const named = claudeKey(info.rateLimitType);
  if (!named) return [];
  const used = num(info.utilization) ?? (info.status === "rejected" ? 1 : null);
  if (used === null) return [];
  const reset = num(info.resetsAt);
  return [window(named, used * 100, reset === null ? null : reset * 1000, now)];
}

function fromCodexRateLimits(limits: Record<string, unknown>, now: number): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const raw of [limits.primary, limits.secondary]) {
    const w = obj(raw);
    const used = num(w?.used_percent);
    if (!w || used === null) continue;
    const reset = num(w.resets_at);
    windows.push(window(codexWindow(num(w.window_minutes)), used, reset === null ? null : reset * 1000, now));
  }
  return windows;
}

function fromJson(line: string, now: number): UsageWindow[] {
  if (!line.startsWith("{") || line.length > MAX_LINE || !(line.includes("rate_limit_event") || line.includes("rate_limits"))) return [];
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  const event = obj(value);
  if (!event) return [];
  if (event.type === "rate_limit_event") {
    const info = obj(event.rate_limit_info);
    return info ? fromRateLimitEvent(info, now) : [];
  }
  // A rollout line keeps the event under `payload`; a bare event has it at the top.
  for (const holder of [obj(event.payload), obj(event.msg), event]) {
    if (holder?.type !== "token_count") continue;
    const limits = obj(holder.rate_limits);
    return limits ? fromCodexRateLimits(limits, now) : [];
  }
  return [];
}

function fromText(line: string, now: number): UsageWindow[] {
  const used = CLAUDE_USED.exec(line);
  if (used) return [window(CLAUDE_NAMES[used[2]!.toLowerCase()]!, Number(used[1]), parseReset(line.slice(used.index), now), now)];
  const hit = CLAUDE_HIT.exec(line);
  if (hit) return [window(CLAUDE_NAMES[(hit[1] ?? hit[2])!.toLowerCase()]!, 100, parseReset(line.slice(hit.index), now), now)];
  const left = CODEX_LEFT.exec(line);
  if (left) return [window(codexWindow(CODEX_NAMES[left[2]!.toLowerCase()]!), 100 - Number(left[1]), null, now)];
  return [];
}

/** The latest usage reading in a worker's log tail, or null when it printed none. */
export function parseWorkerUsage(raw: string, now: number): WorkerUsage | null {
  const lines = normalize(raw).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const windows = fromJson(line, now);
    const found = windows.length > 0 ? windows : fromText(line, now);
    if (found.length > 0) return { usage: { windows: found.slice(0, 6), observedAt: now, source: "worker" }, line: line.slice(0, 300) };
  }
  return null;
}
