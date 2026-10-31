// What Morrow does on its own to keep workers talking (architecture 9.8): when a quiet worker gets nudged, and the test
// results it reads from a worker's log. Pure: the monitor decides when to look and the comms layer sends.
//  - Nudges: a worker that is working (its log keeps changing) but has not posted in the task thread or channel for
//    90 s gets a direct message, then again after 3 more minutes, then every 6, at most 5 per lease. The schedule is
//    a function of the quiet time since its last post, and a nudge's Relay key is derived from the lease, its epoch,
//    that last post's time and the nudge's number, so a restarted backend that sees the same silence sends the same
//    message (Relay keeps one per key) instead of a second one.
//  - Test results: the summary line a test runner prints (bun, jest, vitest, pytest, cargo) in the worker's log. Only
//    the runner and the counts leave this module, never log text.
import { normalize } from "./classifier.ts";

/** Quiet time before the first nudge. */
export const NUDGE_FIRST_MS = 90_000;
/** Gaps between later nudges; the last one repeats. */
export const NUDGE_GAPS_MS: readonly number[] = [180_000, 360_000];
/** Most nudges one lease gets in this process, and most per quiet stretch across restarts. */
export const NUDGES_PER_LEASE = 5;
/** A peer's question to a worker unanswered this long gets the worker one reminder (per question). */
export const ANSWER_NUDGE_MS = 60_000;
/** Most answer reminders one lease gets in this process. */
export const ANSWER_NUDGES_PER_LEASE = 10;

/** How many nudges are due after `quietMs` without a post: 0 before 90 s, 1 at 90 s, 2 at 4.5 min, 3 at 10.5 min, then one every 6 min, at most 5. */
export function nudgesDue(quietMs: number): number {
  if (!(quietMs >= NUDGE_FIRST_MS)) return 0;
  let at = NUDGE_FIRST_MS;
  let due = 1;
  while (due < NUDGES_PER_LEASE) {
    const gap = NUDGE_GAPS_MS[Math.min(due - 1, NUDGE_GAPS_MS.length - 1)]!;
    if (quietMs < at + gap) break;
    at += gap;
    due++;
  }
  return due;
}

/** What one lease was nudged about in this process: the quiet stretch (its start), the highest nudge sent in it, all sent. */
export interface NudgeState {
  anchor: number;
  sent: number;
  total: number;
}

/**
 * The nudge to send now, or null. `anchor` is when the quiet stretch began: the worker's last post, or when it started
 * running. A post moves the anchor, which starts the schedule over.
 */
export function nextNudge(state: NudgeState | null, anchor: number, now: number): { index: number; quietMs: number } | null {
  if ((state?.total ?? 0) >= NUDGES_PER_LEASE) return null;
  const quietMs = now - anchor;
  const due = nudgesDue(quietMs);
  const sent = state && state.anchor === anchor ? state.sent : 0;
  return due > sent ? { index: due, quietMs } : null;
}

/** The state after nudge `index` for the stretch that began at `anchor` went out. */
export function afterNudge(state: NudgeState | null, anchor: number, index: number): NudgeState {
  return { anchor, sent: index, total: (state?.total ?? 0) + 1 };
}

export type TestRunner = "bun" | "jest" | "vitest" | "pytest" | "cargo";

export interface TestSummary {
  runner: TestRunner;
  passed: number;
  failed: number;
  /** The normalized summary line (and the bun counts before it): what tells one run's summary from another's. Never sent. */
  line: string;
}

const count = (text: string, word: RegExp): number => {
  const match = word.exec(text);
  return match ? Number(match[1]) : 0;
};
const BUN_RAN = /^Ran (\d+) tests? across (\d+) files?\b/;
const BUN_PASS = /^(\d+) pass$/;
const BUN_FAIL = /^(\d+) fail$/;
const JEST = /^Tests: (.*\d+ total)$/;
const VITEST = /^Tests (\d+ (?:failed|passed)\b.*\(\d+\))$/;
const PYTEST = /^=+ (.*\b(?:passed|failed)\b.*) in \d+(?:\.\d+)?s\b.*=+$/;
const CARGO = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/;
/** How far above bun's `Ran N tests` line its pass and fail counts may be. */
const BUN_LOOKBACK = 8;

/**
 * The last test summary in a worker's log tail, or null. Matches whole lines only, after the classifier's
 * normalization (escapes and UI glyphs gone), so a sentence that mentions tests is not a result.
 */
export function parseTestSummary(raw: string): TestSummary | null {
  const lines = normalize(raw).split("\n");
  let last: TestSummary | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let found: TestSummary | null = null;
    if (BUN_RAN.test(line)) {
      let passed: number | null = null;
      let failed: number | null = null;
      for (let j = i - 1; j >= Math.max(0, i - BUN_LOOKBACK); j--) {
        const prev = lines[j]!;
        if (passed === null && BUN_PASS.test(prev)) passed = Number(BUN_PASS.exec(prev)![1]);
        if (failed === null && BUN_FAIL.test(prev)) failed = Number(BUN_FAIL.exec(prev)![1]);
      }
      if (passed !== null || failed !== null) found = { runner: "bun", passed: passed ?? 0, failed: failed ?? 0, line: `${passed ?? 0} pass ${failed ?? 0} fail ${line}` };
    } else if (JEST.test(line)) {
      const body = JEST.exec(line)![1]!;
      found = { runner: "jest", passed: count(body, /(\d+) passed/), failed: count(body, /(\d+) failed/), line };
    } else if (VITEST.test(line)) {
      const body = VITEST.exec(line)![1]!;
      found = { runner: "vitest", passed: count(body, /(\d+) passed/), failed: count(body, /(\d+) failed/), line };
    } else if (PYTEST.test(line)) {
      const body = PYTEST.exec(line)![1]!;
      found = { runner: "pytest", passed: count(body, /(\d+) passed/), failed: count(body, /(\d+) failed/) + count(body, /(\d+) errors?\b/), line };
    } else if (CARGO.test(line)) {
      const match = CARGO.exec(line)!;
      found = { runner: "cargo", passed: Number(match[1]), failed: Number(match[2]), line };
    }
    if (found && Number.isSafeInteger(found.passed) && Number.isSafeInteger(found.failed)) last = found;
  }
  return last;
}
