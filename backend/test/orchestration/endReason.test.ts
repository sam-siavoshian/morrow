// What the monitor records as a worker's end reason: plain words, one line, within the actor's limit, no secrets.
import { describe, expect, test } from "bun:test";
import type { Signal } from "../../src/orchestration/classifier.ts";
import { END_DETAIL_MAX, endDetail } from "../../src/orchestration/endReason.ts";

const signal = (kind: Signal["kind"], match = ""): Signal => ({ kind, patternId: kind === "none" ? null : "p", version: 1, resetAt: null, match });

describe("endDetail", () => {
  test("maps the monitor's internal reasons to plain words", () => {
    expect(endDetail("agent exited", null)).toBe("process exited");
    expect(endDetail("reconcile: absent", null)).toBe("missing from Relay");
    expect(endDetail("reconcile: exited", null)).toBe("process exited");
    expect(endDetail("login expired", null)).toBe("CLI not signed in (login expired)");
    expect(endDetail("node offline", null)).toBe("its VM stopped reporting");
    expect(endDetail("worker crashed and its node stopped reporting", null)).toBe("crashed, then its VM stopped reporting");
    expect(endDetail("never reported running", null)).toBe("never reported running");
  });

  test("keeps Relay's exit reason, cleaned", () => {
    expect(endDetail("agent exited (exit_code_137)", null)).toBe("process exited (exit code 137)");
    expect(endDetail("agent exited (exited)", null)).toBe("process exited");
    expect(endDetail("agent exited (\u001b[31mboom\nline2)", null)).toBe("process exited ([31mboom line2)");
  });

  test("adds what the log said when it explains the end", () => {
    expect(endDetail("agent exited", signal("auth_required", "Please run /login"))).toBe("process exited; log: Please run /login");
    expect(endDetail("login expired", signal("auth_required", "Please run /login"))).toBe("CLI not signed in (login expired)");
    expect(endDetail("agent exited", signal("usage_limit", ""))).toBe("process exited; log: hit a usage limit");
    expect(endDetail("agent exited", signal("none"))).toBe("process exited");
    expect(endDetail("agent exited", signal("transient", "ECONNRESET"))).toBe("process exited");
  });

  test("never a secret, never over the actor's limit, never broken characters", () => {
    const out = endDetail("agent exited", signal("crash", `token rk_live_abcdefghijklmnop0123 ${"🙂".repeat(200)}`));
    expect(out).not.toContain("abcdefghijklmnop0123");
    expect(out.length).toBeLessThanOrEqual(END_DETAIL_MAX);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
    expect(endDetail("x".repeat(500), null).length).toBeLessThanOrEqual(END_DETAIL_MAX);
    expect(endDetail("", null)).toBe("process exited");
  });
});
