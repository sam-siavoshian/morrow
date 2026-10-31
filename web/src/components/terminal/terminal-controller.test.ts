import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api";
import {
  backoff,
  isFresh,
  MAX_ATTEMPTS,
  MIN_REFRESH_DELAY_MS,
  refreshDelay,
  REFRESH_RETRY_MS,
  TerminalController,
  type TerminalGrant,
  type TerminalState,
} from "./terminal-controller";

describe("refreshDelay", () => {
  test("a minute before expiry for normal tokens", () => {
    expect(refreshDelay(15 * 60_000, 0)).toBe(14 * 60_000);
    expect(refreshDelay(1_000_000 + 5 * 60_000, 1_000_000)).toBe(4 * 60_000);
  });
  test("a quarter of remaining for short tokens", () => {
    expect(refreshDelay(100_000, 0)).toBe(75_000);
    expect(refreshDelay(8_000, 0)).toBe(6_000);
  });
  test("never sooner than the floor, never after expiry", () => {
    expect(refreshDelay(1_200, 0)).toBe(MIN_REFRESH_DELAY_MS);
    expect(refreshDelay(500, 0)).toBe(500);
  });
  test("null once expired or invalid", () => {
    expect(refreshDelay(0, 0)).toBeNull();
    expect(refreshDelay(10, 20)).toBeNull();
    expect(refreshDelay(Number.NaN, 0)).toBeNull();
  });
  test("caps huge delays to a valid timer", () => {
    expect(refreshDelay(Number.MAX_SAFE_INTEGER, 0)).toBe(2_147_483_647);
  });
});

test("isFresh needs more than 10s left", () => {
  const g = grant(20_000);
  expect(isFresh(g, 0)).toBe(true);
  expect(isFresh(g, 10_000)).toBe(false);
  expect(isFresh(null, 0)).toBe(false);
});

test("backoff doubles then caps", () => {
  expect([1, 2, 3, 4, 5, 6, 7].map(backoff)).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
});

function grant(expiresAt: number, n = 0): TerminalGrant {
  return { vmId: "vm", linuxUser: "ada", token: `tok-${n}`, session: "s", expiresAt };
}

/** Manual clock and timers so the controller can be stepped deterministically. */
function harness(opts: { mint?: (n: number) => Promise<TerminalGrant>; connect?: (g: TerminalGrant, onClose: () => void) => Promise<{ dispose(): void }> } = {}) {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const states: TerminalState[] = [];
  const minted: TerminalGrant[] = [];
  const connected: TerminalGrant[] = [];
  const closers: (() => void)[] = [];
  let disposed = 0;
  let mints = 0;
  const controller = new TerminalController(
    {
      mint: async () => {
        const g = await (opts.mint ?? (async (n) => grant(now + 15 * 60_000, n)))(mints++);
        minted.push(g);
        return g;
      },
      connect: async (g, onClose) => {
        connected.push(g);
        closers.push(onClose);
        if (opts.connect) return opts.connect(g, onClose);
        return { dispose: () => void disposed++ };
      },
      now: () => now,
      setTimer: (fn, ms) => {
        timers.set(++id, { at: now + ms, fn });
        return id;
      },
      clearTimer: (h) => void timers.delete(h as number),
    },
    (s) => states.push(s),
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      await flush();
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
    await flush();
  }
  return {
    controller,
    states,
    minted,
    connected,
    closers,
    advance,
    flush,
    get now() {
      return now;
    },
    get disposed() {
      return disposed;
    },
    get pending() {
      return [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b);
    },
  };
}

describe("TerminalController", () => {
  test("connects and schedules a refresh a minute before expiry", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    await h.flush();
    expect(h.states.map((s) => s.kind)).toEqual(["connecting", "connected"]);
    expect(h.minted).toHaveLength(1);
    expect(h.pending).toEqual([14 * 60_000]);
  });

  test("refresh mints a new token in memory without reconnecting", async () => {
    const h = harness();
    h.controller.start();
    await h.advance(14 * 60_000);
    expect(h.minted).toHaveLength(2);
    expect(h.connected).toHaveLength(1);
    expect(h.pending).toEqual([14 * 60_000]);
  });

  test("a drop reconnects with the refreshed token, not a stale one", async () => {
    const h = harness();
    h.controller.start();
    await h.advance(14 * 60_000 + 1);
    h.closers[0]!();
    await h.advance(backoff(1));
    expect(h.connected).toHaveLength(2);
    expect(h.connected[1]!.token).toBe("tok-1");
    expect(h.minted).toHaveLength(2);
    expect(h.states.at(-1)).toEqual({ kind: "connected" });
  });

  test("a stale grant is re-minted before reconnecting", async () => {
    const h = harness({ mint: async (n) => grant(20_000, n) });
    h.controller.start();
    await h.flush();
    await h.flush();
    // At 12s the 20s grant has 8s left: too stale to reuse, so the reconnect mints first.
    await h.advance(12_000);
    h.closers[0]!();
    await h.advance(backoff(1));
    expect(h.minted.length).toBeGreaterThanOrEqual(2);
    expect(h.connected[1]!.token).not.toBe("tok-0");
  });

  test("gives up after MAX_ATTEMPTS failed connects and shows disconnected", async () => {
    const h = harness({ connect: async () => Promise.reject(new Error("socket refused")) });
    h.controller.start();
    await h.advance(120_000);
    expect(h.connected).toHaveLength(MAX_ATTEMPTS + 1);
    expect(h.states.at(-1)?.kind).toBe("disconnected");
    // Failed connects drop the grant, so every attempt mints afresh.
    expect(h.minted).toHaveLength(MAX_ATTEMPTS + 1);
  });

  test("reconnect() resets the budget", async () => {
    let fail = true;
    const h = harness({ connect: async () => (fail ? Promise.reject(new Error("x")) : { dispose() {} }) });
    h.controller.start();
    await h.advance(120_000);
    expect(h.states.at(-1)?.kind).toBe("disconnected");
    fail = false;
    h.controller.reconnect();
    await h.advance(0);
    expect(h.states.at(-1)).toEqual({ kind: "connected" });
  });

  test.each([
    ["unauthenticated", "expired"],
    ["feature_disabled", "disabled"],
    ["forbidden", "unavailable"],
    ["conflict", "unavailable"],
    ["not_found", "unavailable"],
  ] as const)("mint error %s ends in %s without retrying", async (code, kind) => {
    const h = harness({ mint: async () => Promise.reject(new ApiError(code, "nope", 400)) });
    h.controller.start();
    await h.advance(60_000);
    expect(h.states.at(-1)?.kind).toBe(kind);
    expect(h.connected).toHaveLength(0);
    expect(h.pending).toEqual([]);
  });

  test("rate limited waits for retry-after", async () => {
    let calls = 0;
    const h = harness({
      mint: async (n) => {
        calls++;
        if (n === 0) throw new ApiError("rate_limited", "slow down", 429, 7);
        return grant(15 * 60_000, n);
      },
    });
    h.controller.start();
    await h.flush();
    await h.flush();
    expect(h.pending).toEqual([7_000]);
    await h.advance(6_999);
    expect(calls).toBe(1);
    await h.advance(1);
    expect(h.states.at(-1)).toEqual({ kind: "connected" });
  });

  test("failed refresh retries quietly while the token is valid", async () => {
    const h = harness({
      mint: async (n) => {
        if (n === 1) throw new ApiError("network_error", "offline", 0);
        return grant(15 * 60_000, n);
      },
    });
    h.controller.start();
    await h.advance(14 * 60_000);
    expect(h.states.at(-1)).toEqual({ kind: "connected" });
    expect(h.pending).toEqual([REFRESH_RETRY_MS]);
    await h.advance(REFRESH_RETRY_MS);
    expect(h.minted).toHaveLength(2);
    expect(h.minted[1]!.token).toBe("tok-2");
  });

  test("refresh hitting unauthenticated forgets the token but keeps the open shell", async () => {
    const h = harness({
      mint: async (n) => {
        if (n >= 1) throw new ApiError("unauthenticated", "signed out", 401);
        return grant(15 * 60_000, n);
      },
    });
    h.controller.start();
    await h.advance(14 * 60_000);
    expect(h.states.at(-1)).toEqual({ kind: "connected" });
    expect(h.pending).toEqual([]);
    h.closers[0]!();
    await h.advance(backoff(1));
    expect(h.states.at(-1)?.kind).toBe("expired");
  });

  test("stop() clears timers, disposes, and ignores late callbacks", async () => {
    const h = harness();
    h.controller.start();
    await h.flush();
    await h.flush();
    h.controller.stop();
    expect(h.disposed).toBe(1);
    expect(h.pending).toEqual([]);
    const before = h.states.length;
    h.closers[0]!();
    await h.advance(60_000);
    expect(h.states.length).toBe(before);
  });

  test("stop() during a slow connect disposes the late connection", async () => {
    let release!: () => void;
    let disposed = false;
    const h = harness({
      connect: () =>
        new Promise((resolve) => {
          release = () => resolve({ dispose: () => void (disposed = true) });
        }),
    });
    h.controller.start();
    await h.flush();
    await h.flush();
    h.controller.stop();
    release();
    await h.flush();
    expect(disposed).toBe(true);
    expect(h.states.map((s) => s.kind)).toEqual(["connecting"]);
  });
});
