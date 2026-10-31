import { describe, expect, test } from "bun:test";
import type { PullChecks } from "@morrow/contracts";
import { ApiError } from "@/lib/api";
import { checksSummary, commitMessageError, defaultMergeMethod, freshnessNote, githubFailure, mergeReadiness, relativeAge } from "./pull-state";

const checks = (...states: Array<"passed" | "failed" | "pending" | "neutral">): PullChecks => ({
  state: states.includes("failed") ? "failed" : states.includes("pending") ? "pending" : states.length ? "passed" : "none",
  items: states.map((state, i) => ({ name: `c${i}`, state, detail: null, url: null })),
  truncated: false,
});

type Ready = Parameters<typeof mergeReadiness>[0];
const pr = (patch: Partial<Ready> = {}): Ready => ({
  state: "open",
  mergeable: "clean",
  viewerCanWrite: true,
  mergeMethods: ["squash", "merge"],
  baseRef: "main",
  checks: checks("passed"),
  ...patch,
});

describe("checksSummary", () => {
  test("failing beats running beats passing; none is null", () => {
    expect(checksSummary(checks())).toBeNull();
    expect(checksSummary(checks("passed", "failed", "pending"))).toEqual({ text: "1 check failing", tone: "rose" });
    expect(checksSummary(checks("pending", "pending"))).toEqual({ text: "2 checks running", tone: "lemon" });
    expect(checksSummary(checks("passed", "passed"))).toEqual({ text: "All 2 checks passed", tone: "mint" });
    expect(checksSummary(checks("passed", "neutral"))).toEqual({ text: "1 of 2 checks passed", tone: "mint" });
    expect(checksSummary(checks("passed"))?.text).toBe("Check passed");
  });
});

describe("mergeReadiness", () => {
  test("blocks what is certain to fail, with the reason", () => {
    expect(mergeReadiness(pr({ state: "merged" })).blocker).toBe("Already merged.");
    expect(mergeReadiness(pr({ state: "closed" })).blocker).toContain("Reopen");
    expect(mergeReadiness(pr({ state: "draft", mergeable: "draft" })).blocker).toContain("draft");
    expect(mergeReadiness(pr({ viewerCanWrite: false })).blocker).toContain("write access");
    expect(mergeReadiness(pr({ mergeMethods: [] })).blocker).toContain("write access");
    expect(mergeReadiness(pr({ mergeable: "conflicts" })).blocker).toBe("This branch has conflicts with main. Resolve them before merging.");
    expect(mergeReadiness(pr({ mergeable: "blocked" })).blocker).toContain("blocking");
  });

  test("warns but allows the rest", () => {
    expect(mergeReadiness(pr())).toEqual({ blocker: null, warning: null });
    expect(mergeReadiness(pr({ mergeable: "behind" }))).toMatchObject({ blocker: null, warning: expect.stringContaining("behind main") });
    expect(mergeReadiness(pr({ mergeable: "unknown" })).blocker).toBeNull();
    expect(mergeReadiness(pr({ mergeable: "unstable", checks: checks("failed") })).warning).toBe("Some checks are failing.");
    expect(mergeReadiness(pr({ checks: checks("pending") })).warning).toBe("Some checks are still running.");
  });

  test("default method prefers squash", () => {
    expect(defaultMergeMethod(["merge", "squash"])).toBe("squash");
    expect(defaultMergeMethod(["rebase"])).toBe("rebase");
    expect(defaultMergeMethod([])).toBeNull();
  });
});

describe("freshness and time", () => {
  const fmt = (ms: number) => `@${ms}`;
  test("rate limited, stale, fresh", () => {
    expect(freshnessNote({ fetchedAt: 10, stale: true, rateLimitedUntil: 500 }, 100, fmt)).toBe("Your GitHub rate limit is used up until @500. Showing what was loaded @10.");
    expect(freshnessNote({ fetchedAt: 10, stale: true, rateLimitedUntil: 50 }, 100, fmt)).toBe("GitHub is not answering right now. Showing what was loaded @10.");
    expect(freshnessNote({ fetchedAt: 10, stale: false, rateLimitedUntil: null }, 100, fmt)).toBeNull();
  });

  test("relative age", () => {
    const now = Date.UTC(2020, 5, 10);
    expect(relativeAge(now - 10_000, now)).toBe("just now");
    expect(relativeAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeAge(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeAge(now - 4 * 86_400_000, now)).toBe("4d ago");
    expect(relativeAge(now + 60_000, now)).toBe("just now");
    expect(relativeAge(now - 90 * 86_400_000, now)).toMatch(/2020/);
  });
});

describe("githubFailure and commit messages", () => {
  test("maps API errors to what the view offers", () => {
    expect(githubFailure(new ApiError("unauthenticated", "Reconnect GitHub", 401), "x")).toEqual({ kind: "reconnect", message: "Reconnect GitHub" });
    expect(githubFailure(new ApiError("rate_limited", "Slow down", 429), "x").kind).toBe("rate_limited");
    expect(githubFailure(new ApiError("forbidden", "No", 403), "x").kind).toBe("forbidden");
    expect(githubFailure(new ApiError("feature_disabled", "Off", 501), "x").kind).toBe("disabled");
    expect(githubFailure(new Error("boom"), "Couldn't load.")).toEqual({ kind: "other", message: "Couldn't load." });
  });

  test("commit message checks", () => {
    expect(commitMessageError("   ", 2000)).toBe("Write a commit message.");
    expect(commitMessageError("x".repeat(2001), 2000)).toContain("2,000");
    expect(commitMessageError(" fix ", 2000)).toBeNull();
  });
});

