// Reads coding CLI output (worker PTY logs, headless planner output) and says whether the CLI hit a subscription
// limit, lost its login, crashed, or only hit a transient throttle. Every pattern id matches a row in
// docs/research/cli-signals.md (C*, T*, A*, X* for Claude; D*, R*, B*, Y* for Codex; G* for Gemini CLI; K* for
// Grok). Bump CLASSIFIER_VERSION whenever a pattern changes, so stored signals say which rules produced them.
import { parseDuration, resolveWallTime } from "./resetTime.ts";

export const CLASSIFIER_VERSION = 2;

export type SignalKind = "usage_limit" | "auth_required" | "transient" | "crash";

export interface Signal {
  kind: SignalKind | "none";
  patternId: string | null;
  version: number;
  /** Parsed reset time (epoch ms) for usage limits, when the CLI printed one. */
  resetAt: number | null;
  /** The normalized matched text, bounded. Safe to show: it is the CLI's own message. */
  match: string;
}

interface Pattern {
  id: string;
  kind: SignalKind;
  re: RegExp;
}

/** Usage and auth signals change what we do to a profile, so they must start a line (or follow "API error: "). */
const LINE = "(?<=^|API [Ee]rror: )";
/** Codex wraps auth text in "stream disconnected before completion: ...". */
const LINE_OR_COLON = "(?<=^|: )";
const p = (id: string, kind: SignalKind, source: string, flags = ""): Pattern => ({ id, kind, re: new RegExp(source, `gm${flags}`) });

// Matching order inside one position: auth, usage, transient, crash (section 1.2 / 2.2 "Matching order").
const PATTERNS: Pattern[] = [
  // ---- auth_required
  p("A1", "auth_required", `${LINE}Not logged in · (?:Please run|Run) /login`),
  p("A2", "auth_required", `${LINE}OAuth token revoked · Please run /login`),
  p("A3", "auth_required", `${LINE}Login expired · (?:Please run /login|Run /login)`),
  p("A4", "auth_required", `${LINE}Please run /login · API Error: 401`),
  p("A5", "auth_required", `${LINE}API Error: 401\\b.*?(?:authentication_error|OAuth token has expired)`),
  p("A6", "auth_required", `${LINE}Failed to authenticate[.:]`),
  p("A7", "auth_required", `${LINE}Invalid API key · (?:Fix external API key|Please run /login)`),
  p("A8", "auth_required", `${LINE}Authentication required · Sign in again to continue`),
  p("A9", "auth_required", `${LINE}Your organization has disabled Claude subscription access for Claude Code`),
  p("A10", "auth_required", `${LINE}Credit balance is too low`),
  p("A11", "auth_required", `${LINE}Not logged in\\. Run claude auth login`),
  p("B1", "auth_required", `${LINE_OR_COLON}Your access token could not be refreshed`),
  p("B2", "auth_required", `${LINE_OR_COLON}unexpected status 401 Unauthorized`),
  p("B4", "auth_required", `${LINE_OR_COLON}(?:You didn't provide an API key|Incorrect API key provided)`),
  p("B5", "auth_required", `^Not logged in$`),
  p("K1", "auth_required", `${LINE}Not signed in\\. (?:Run \`grok login\`|To authenticate without a browser)`),

  // ---- usage_limit (never anchored on a bare "usage limit": T1 contains "not your usage limit")
  p("C1", "usage_limit", `${LINE}You've hit your (?:5-hour limit|session limit|weekly limit|Opus limit|Sonnet limit|Fable limit|limit|usage limit)\\b`),
  p("C7", "usage_limit", `${LINE}Claude usage limit reached\\.\\s+Your limit will reset`),
  p("C8", "usage_limit", `${LINE}Claude AI usage limit reached\\|\\d{10}`),
  p("C9", "usage_limit", `${LINE}(?:5-hour|Session|Weekly|Opus|Sonnet) limit reached [·] resets`, "i"),
  p(
    "C10",
    "usage_limit",
    `${LINE}You've hit your (?:monthly spend limit|individual (?:spend|usage) limit|org's monthly (?:spend|usage) limit|team's shared budget|channel's monthly (?:spend|usage) limit)`,
  ),
  p(
    "C11",
    "usage_limit",
    `${LINE}(?:You're out of usage credits|Your org is out of usage · (?:add funds|contact your admin)|Your seat type doesn't include (?:extra )?usage|Your usage allocation has been disabled by your admin|Your group's usage limit is set to \\$0|You're out of extra usage|(?:Fable|Haiku|Mythos|Opus|Sonnet)(?: [^·\\n]{1,40})? requires usage credits\\.)`,
  ),
  p("C12", "usage_limit", `usage limit reached · (?:send a message after it resets|continues automatically when it resets)`),
  p("D1", "usage_limit", `${LINE}You've hit your usage limit(?: for [^.\\n]+?)?[.,]`),
  p("D9", "usage_limit", `${LINE}(?:Your workspace is out of credits|You hit your spend cap set)`),
  p("D10", "usage_limit", `${LINE}Quota exceeded\\. Check your plan and billing details\\.`),
  p("D11", "usage_limit", `${LINE}To use Codex with your ChatGPT plan, upgrade to Plus`),
  p("G1", "usage_limit", `${LINE}Usage limit reached for \\S{1,80}\\.(?=\\s|$)`),
  p("G2", "usage_limit", `${LINE}You have exhausted your daily quota on this model\\.`),

  // ---- transient (retry, never a cooldown)
  p("T1", "transient", `Server is temporarily limiting requests \\(not your usage limit\\)`),
  p("T2", "transient", `API Error: Request rejected \\(429\\)`),
  p("T3", "transient", `Repeated 529 Overloaded errors`),
  p("T4", "transient", `API Error:? \\(?529\\b|"type":"overloaded_error"`),
  p("T6", "transient", `(?:Opus|Fable) is experiencing high load`),
  p("T7", "transient", `^Request timed out$|API Error: 5\\d\\d\\b`),
  p("R1", "transient", `exceeded retry limit, last status: 429\\b`),
  p("R2", "transient", `^rate limit exceeded: `),
  p("R3", "transient", `Selected model is at capacity`),
  p("R4", "transient", `currently experiencing high demand`),
  p("R5", "transient", `Reconnecting\\.\\.\\. (?:\\d+/\\d+|waiting for network)`),
  p("R6", "transient", `stream disconnected before completion:`),
  p("R7", "transient", `Flex capacity unavailable\\.`),

  // ---- crash
  p("X1", "crash", `^Execution error$`),
  p("X2", "crash", `Session crashed \\(`),
  p("Y1", "crash", `agent loop died unexpectedly|^Fatal error: |^turn failed$|exceeded retry limit, last status: 5\\d\\d`),
  p("B6", "crash", `Not inside a trusted directory and --skip-git-repo-check was not specified`),
];

const PRIORITY: Record<SignalKind, number> = { auth_required: 0, usage_limit: 1, transient: 2, crash: 3 };
const MATCH_CHARS = 300;
const RESET_WINDOW_CHARS = 300;

/** Section 0.6: strip escapes, unify look-alike characters, drop UI glyphs, collapse spaces. Keeps line breaks. */
export function normalize(raw: string): string {
  const text = raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2219\u2022]/g, "·")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]+/g, " ")
        .trim()
        .replace(/^(?:(?:[⎿■●⏺│>]|ERROR:)\s*)+/u, ""),
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Classifies CLI output. The latest signal in the text wins (a session can recover from an old error);
 * where two signals cover the same position, auth beats usage beats transient beats crash.
 */
export function classify(raw: string, now: number): Signal {
  const text = normalize(raw);
  let best: { pattern: Pattern; index: number; end: number; text: string } | null = null;
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const m of text.matchAll(pattern.re)) {
      const end = m.index + m[0].length;
      const better =
        !best || end > best.end || (end === best.end && PRIORITY[pattern.kind] < PRIORITY[best.pattern.kind]);
      if (better) best = { pattern, index: m.index, end, text: m[0] };
    }
  }
  if (!best) return { kind: "none", patternId: null, version: CLASSIFIER_VERSION, resetAt: null, match: "" };
  const lineEnd = text.indexOf("\n", best.end);
  const context = text.slice(best.index, best.index + RESET_WINDOW_CHARS).replace(/\n/g, " ");
  return {
    kind: best.pattern.kind,
    patternId: best.pattern.id,
    version: CLASSIFIER_VERSION,
    resetAt: best.pattern.kind === "usage_limit" ? parseReset(context, now) : null,
    match: text.slice(best.index, lineEnd === -1 ? undefined : lineEnd).slice(0, MATCH_CHARS),
  };
}

const MONTH = "(?<mon>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const CLAUDE_RESET = new RegExp(
  `resets? (?:at )?(?:(?<wd>Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?(?:${MONTH} (?<day>\\d{1,2}), (?:(?<year>\\d{4}), )?)?(?<hour>\\d{1,2})(?::(?<min>\\d{2}))?(?<ampm>am|pm)(?: \\((?<tz>[A-Za-z_]+(?:/[A-Za-z0-9_+\\-]+)*)\\))?`,
  "i",
);
const CLAUDE_IN = /resets in (?<rel>(?:\d+d)?\s*(?:\d+h)?\s*(?:\d+m)?)/i;
const CLAUDE_EPOCH = /usage limit reached\|(?<epoch>\d{10})/;
const CODEX_AT = new RegExp(
  `try again at (?:${MONTH} (?<day>\\d{1,2})(?:st|nd|rd|th)?, (?<year>\\d{4}),? )?(?<hour>\\d{1,2}):(?<min>\\d{2}) (?<ampm>AM|PM)`,
  "i",
);
const CODEX_IN = /try again in (?<dur>less than a minute|(?:\d+ days?)?\s*(?:\d+ hours?)?\s*(?:\d+ minutes?)?)\./i;

/** Reset instant from the text right after a usage-limit match. Null means "unknown": callers use a default. */
export function parseReset(context: string, now: number): number | null {
  const epoch = CLAUDE_EPOCH.exec(context)?.groups?.epoch;
  if (epoch) return Number(epoch) * 1000;
  for (const re of [CLAUDE_RESET, CODEX_AT]) {
    const g = re.exec(context)?.groups;
    if (!g) continue;
    const at = resolveWallTime(
      {
        hour: Number(g.hour),
        minute: g.min ? Number(g.min) : 0,
        ampm: g.ampm ?? null,
        month: g.mon ?? null,
        day: g.day ? Number(g.day) : null,
        year: g.year ? Number(g.year) : null,
        weekday: g.wd ?? null,
        tz: g.tz ?? null,
      },
      now,
    );
    if (at !== null) return at;
  }
  for (const re of [CLAUDE_IN, CODEX_IN]) {
    const g = re.exec(context)?.groups;
    const ms = g ? parseDuration(g.rel ?? g.dur ?? "") : null;
    if (ms !== null) return now + ms;
  }
  return null;
}

export const DEFAULT_COOLDOWN_MS = 60 * 60_000;
const MIN_COOLDOWN_MS = 60_000;
/** Below the actor's 7-day cap, with room for clock skew between us and Terse. */
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60_000 - 15 * 60_000;

/** The cooldown deadline for a detected limit: the parsed reset when sane, else now + 60 min. */
export function cooldownUntil(signal: Pick<Signal, "resetAt">, now: number): number {
  const at = signal.resetAt ?? now + DEFAULT_COOLDOWN_MS;
  if (at <= now) return now + DEFAULT_COOLDOWN_MS;
  return Math.min(Math.max(at, now + MIN_COOLDOWN_MS), now + MAX_COOLDOWN_MS);
}
