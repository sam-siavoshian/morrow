// Fixtures are copied from docs/research/cli-signals.md section 6. "observed" lines come from docs or issues;
// "template" lines are synthetic, built from the CLI source templates (section 6.2).
import { describe, expect, test } from "bun:test";
import { CLASSIFIER_VERSION, classify, cooldownUntil, DEFAULT_COOLDOWN_MS, normalize, parseReset } from "../../src/orchestration/classifier.ts";
import { resolveWallTime, zonedToEpoch } from "../../src/orchestration/resetTime.ts";

// A fixed "now": Wednesday, 10:00 UTC.
const NOW = Date.UTC(2037, 9, 28, 10, 0, 0);

const kind = (line: string) => classify(line, NOW).kind;

describe("classifier: usage limits (observed)", () => {
  const lines = [
    "You've hit your session limit · resets 3:45pm",
    "You've hit your weekly limit · resets Mon 12:00am",
    "You've hit your Opus limit · resets 3:45pm",
    "You've hit your Sonnet limit · resets 3:45pm",
    "You've hit your weekly limit · resets Jul 25, 9pm (America/New_York)",
    "You've hit your weekly limit · resets in 6d",
    "⎿ You've hit your limit · resets 6pm (UTC)",
    "⎿ You've hit your limit · resets 3pm (Asia/Tbilisi)",
    "⎿ You've hit your limit · resets 1am (Europe/Warsaw)",
    'Agent "..." failed: Agent terminated early due to an API error: You\'ve hit your session limit · resets 1pm (Europe/Berlin) (error type rate_limit, HTTP 429, request id req_011Cfwtf3ozq6qKrkf7BifvS, model sent to the API: claude-opus-5-5)',
    "Claude usage limit reached. Your limit will reset at 3pm (America/Santiago).",
    "Claude usage limit reached. Your limit will reset at 7am (UTC).",
    "Claude AI usage limit reached|1749924000",
    "⎿ 5-hour limit reached ∙ resets 12pm",
    "Session limit reached ∙ resets 6pm",
    "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message",
    "You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin-settings/usage",
    "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:01 AM.",
    "You've hit your usage limit. To get more access now, send a request to your admin or try again at Apr 12th, 2037 3:31 PM.",
    "You've hit your usage limit. Upgrade your plan or add credits to continue, or try again at Aug 20, 2037, 3:29 PM.",
  ];
  for (const line of lines) test(line.slice(0, 70), () => expect(kind(line)).toBe("usage_limit"));
});

describe("classifier: usage limits (template)", () => {
  const lines = [
    "You've hit your 5-hour limit · resets 3pm (America/Los_Angeles)",
    "You've hit your weekly limit · resets Nov 3, 3pm (UTC)",
    "You've hit your Opus limit · resets Jan 2, 2038, 9:30am (UTC)",
    "You've hit your 5-hour limit · resets 3pm (UTC) · progress saved",
    "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM.",
    "You’ve hit your usage limit. Try again at Nov 3rd, 2037 3:45 PM.",
    "You’ve hit your usage limit. Try again later.",
    "You've hit your usage limit. Try again in 2 days 3 hours 5 minutes.",
    "You've hit your usage limit. Try again in less than a minute.",
    "Your workspace is out of credits. Add credits to continue.",
  ];
  for (const line of lines) test(line.slice(0, 70), () => expect(kind(line)).toBe("usage_limit"));
});

describe("classifier: false-positive guards", () => {
  test("transient lines never cool down", () => {
    for (const line of [
      "API Error: Server is temporarily limiting requests (not your usage limit)",
      "API Error: Request rejected (429) · this may be a temporary capacity issue. If it persists, check https://status.claude.com.",
      "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. If it persists, check https://status.claude.com.",
      '⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "Opus is experiencing high load, please use /model to switch to Sonnet",
      "ERROR: Reconnecting... 2/5",
      "exceeded retry limit, last status: 429 Too Many Requests, request id: abc",
      "Selected model is at capacity. Please try a different model.",
    ])
      expect(kind(line)).toBe("transient");
  });

  test("warnings are not limits", () => {
    expect(kind("You've used 85% of your session limit · resets 3:45pm")).toBe("none");
    expect(kind("Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.")).toBe("none");
    expect(kind("You're close to your 5-hour limit")).toBe("none");
  });

  test("a limit quoted mid-sentence (e.g. by another agent) is not a limit", () => {
    expect(kind("Relay message from w-abc-api-e3: FYI I got: You've hit your 5-hour limit · resets 3pm")).toBe("none");
    expect(kind("let me grep for \"You've hit your usage limit\" in the codebase")).toBe("none");
  });

  test("plain prose about usage limits is ignored", () => {
    expect(kind("This PR adds a usage limit banner. Not your usage limit problem.")).toBe("none");
  });
});

describe("classifier: auth and crash", () => {
  test("auth_required (observed)", () => {
    for (const line of [
      "Not logged in · Please run /login",
      "OAuth token revoked · Please run /login",
      "Login expired · Please run /login",
      "Please run /login · API Error: 401 Invalid authentication credentials",
      "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.",
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "Invalid API key · Fix external API key",
      "Invalid API key · Please run /login",
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."},"request_id":"req_011CWR6QbR9zivmQtHS6Tzck"} · Please run /login',
      'ERROR: unexpected status 401 Unauthorized: {"detail":"Unauthorized"}, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: redacted, request id: redacted',
      "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
    ])
      expect(kind(line)).toBe("auth_required");
  });

  test("auth wrapped in a transient stream error wins over the transient part", () => {
    const line =
      "■ stream disconnected before completion: You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth";
    expect(classify(line, NOW)).toMatchObject({ kind: "auth_required", patternId: "B4" });
  });

  test("crash", () => {
    expect(kind("Execution error")).toBe("crash");
    expect(kind("Session crashed (exit 1)")).toBe("crash");
    expect(kind("internal error; agent loop died unexpectedly")).toBe("crash");
  });
});

describe("classifier: Gemini CLI and Grok", () => {
  test("Gemini CLI quota lines are usage limits", () => {
    expect(classify("│ Usage limit reached for gemini-2.5-pro.\n│ Access resets at 3:00 PM.", NOW)).toMatchObject({ kind: "usage_limit", patternId: "G1" });
    expect(classify("You have exhausted your daily quota on this model.", NOW)).toMatchObject({ kind: "usage_limit", patternId: "G2" });
  });

  test("Grok's signed-out lines need a login", () => {
    expect(classify("Not signed in. Run `grok login` to authenticate (or `grok login --device-code` if no browser)", NOW)).toMatchObject({ kind: "auth_required", patternId: "K1" });
    expect(classify("Not signed in. To authenticate without a browser, run:", NOW)).toMatchObject({ kind: "auth_required", patternId: "K1" });
  });

  test("the same words quoted mid-sentence, or cut short, are not signals", () => {
    for (const line of ["the agent said: Usage limit reached for x.", "Usage limit reached for", "Not signed in", "I am not signed in. Run `grok login` later"])
      expect(kind(line)).toBe("none");
  });
});

describe("classifier: log tails", () => {
  test("the latest signal wins", () => {
    const log = "API Error: Repeated 529 Overloaded errors.\nworking...\nYou've hit your 5-hour limit · resets 3pm (UTC)\n";
    expect(classify(log, NOW)).toMatchObject({ kind: "usage_limit", patternId: "C1", version: CLASSIFIER_VERSION });
    const recovered = "You've hit your 5-hour limit · resets 3pm (UTC)\nAPI Error: Repeated 529 Overloaded errors.";
    expect(classify(recovered, NOW).kind).toBe("transient");
  });

  test("ANSI escapes, NBSP and wrapped lines are normalized", () => {
    const log = "\u001b[31m⎿ You’ve hit your limit\u001b[0m ∙ resets\n6pm (UTC)\u001b]0;title\u0007\r\n";
    const signal = classify(log, NOW);
    expect(signal.kind).toBe("usage_limit");
    expect(signal.resetAt).toBe(Date.UTC(2037, 9, 28, 18, 0));
    expect(normalize("\u001b[1mA\u001b[0m\r\n■  B")).toBe("A\nB");
  });

  test("the match is bounded and comes from the matched line only", () => {
    const signal = classify(`secret-line\nYou've hit your 5-hour limit · resets 3pm (UTC) ${"x".repeat(1000)}`, NOW);
    expect(signal.match.startsWith("You've hit your 5-hour limit")).toBe(true);
    expect(signal.match.length).toBeLessThanOrEqual(300);
    expect(signal.match).not.toContain("secret-line");
  });

  test("empty text is none", () => {
    expect(classify("", NOW)).toEqual({ kind: "none", patternId: null, version: CLASSIFIER_VERSION, resetAt: null, match: "" });
  });
});

describe("reset time parsing", () => {
  const at = (line: string) => classify(line, NOW).resetAt;

  test("time only: next occurrence in the printed zone", () => {
    expect(at("You've hit your 5-hour limit · resets 3pm (UTC)")).toBe(Date.UTC(2037, 9, 28, 15, 0));
    // 3pm in Los Angeles (PDT, UTC-7 on Oct 28) is 22:00 UTC.
    expect(at("You've hit your 5-hour limit · resets 3pm (America/Los_Angeles)")).toBe(Date.UTC(2037, 9, 28, 22, 0));
    // 9am UTC already passed today: tomorrow.
    expect(at("You've hit your limit · resets 9am (UTC)")).toBe(Date.UTC(2037, 9, 29, 9, 0));
    expect(at("You've hit your session limit · resets 3:45pm")).toBe(Date.UTC(2037, 9, 28, 15, 45));
  });

  test("date forms", () => {
    expect(at("You've hit your weekly limit · resets Nov 3, 3pm (UTC)")).toBe(Date.UTC(2037, 10, 3, 15, 0));
    expect(at("You've hit your Opus limit · resets Jan 2, 2038, 9:30am (UTC)")).toBe(Date.UTC(2038, 0, 2, 9, 30));
    expect(at("You've hit your weekly limit · resets Jul 25, 9pm (America/New_York)")).toBe(Date.UTC(2037, 6, 26, 1, 0));
    // Weekday form: next Monday (Nov 2) at midnight UTC.
    expect(at("You've hit your weekly limit · resets Mon 12:00am")).toBe(Date.UTC(2037, 10, 2, 0, 0));
  });

  test("relative and epoch forms", () => {
    expect(at("You've hit your weekly limit · resets in 6d")).toBe(NOW + 6 * 86_400_000);
    expect(at("You've hit your usage limit. Try again in 2 days 3 hours 5 minutes.")).toBe(NOW + (2 * 24 * 60 + 3 * 60 + 5) * 60_000);
    expect(at("You've hit your usage limit. Try again in less than a minute.")).toBe(NOW + 60_000);
    expect(at("Claude AI usage limit reached|1749924000")).toBe(1749924000 * 1000);
  });

  test("codex forms (TZ=UTC)", () => {
    expect(at("You’ve hit your usage limit. Try again at Nov 3rd, 2037 3:45 PM.")).toBe(Date.UTC(2037, 10, 3, 15, 45));
    expect(at("You've hit your usage limit. Upgrade your plan or add credits to continue, or try again at Aug 20, 2037, 3:29 PM.")).toBe(
      Date.UTC(2037, 7, 20, 15, 29),
    );
    expect(at("You’ve hit your usage limit. Visit x to purchase more credits or try again at 3:45 PM.")).toBe(Date.UTC(2037, 9, 28, 15, 45));
    expect(at("You’ve hit your usage limit. Try again later.")).toBeNull();
  });

  test("garbage and unknown zones degrade safely", () => {
    expect(parseReset("resets 13pm (UTC)", NOW)).toBeNull();
    expect(at("You've hit your limit · resets 6pm (Not/AZone)")).toBe(Date.UTC(2037, 9, 28, 18, 0));
    expect(resolveWallTime({ hour: 3, minute: 70, ampm: "pm" }, NOW)).toBeNull();
  });

  test("zonedToEpoch handles DST", () => {
    // Berlin: CEST (UTC+2) until Oct 25 2037, CET (UTC+1) after.
    expect(zonedToEpoch(2037, 9, 24, 12, 0, "Europe/Berlin")).toBe(Date.UTC(2037, 9, 24, 10, 0));
    expect(zonedToEpoch(2037, 9, 26, 12, 0, "Europe/Berlin")).toBe(Date.UTC(2037, 9, 26, 11, 0));
  });

  test("cooldown deadline is clamped", () => {
    expect(cooldownUntil({ resetAt: null }, NOW)).toBe(NOW + DEFAULT_COOLDOWN_MS);
    expect(cooldownUntil({ resetAt: NOW - 1 }, NOW)).toBe(NOW + DEFAULT_COOLDOWN_MS);
    expect(cooldownUntil({ resetAt: NOW + 1_000 }, NOW)).toBe(NOW + 60_000);
    expect(cooldownUntil({ resetAt: NOW + 30 * 86_400_000 }, NOW)).toBeLessThan(NOW + 7 * 86_400_000);
  });
});
