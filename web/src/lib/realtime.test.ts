import { describe, expect, test } from "bun:test";
import type { InspectFrame, RealtimeTicketResponse, ServerFrame } from "@morrow/contracts";
import { ApiError } from "./api";
import {
  BACKOFF_MAX_MS,
  HIDDEN_PAUSE_MS,
  RealtimeConnection,
  backoffDelay,
  checkTicketUrl,
  connectInspect,
  parseServerFrame,
  type ConnectionStatus,
  type RealtimeDeps,
  type RealtimeFatal,
} from "./realtime";

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  message(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent);
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

/** Manual clock: timers run only when `advance` passes them. */
function harness(options: { tickets?: Array<RealtimeTicketResponse | Error>; hidden?: boolean; online?: boolean } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const frames: ServerFrame[] = [];
  const fatals: RealtimeFatal[] = [];
  const delays: number[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const visibility = { hidden: options.hidden ?? false } as { hidden: boolean };
  const network = { onLine: options.online ?? true };
  let ticketCalls = 0;

  const deps: Partial<RealtimeDeps> = {
    getTicket: async () => {
      const next = options.tickets?.[ticketCalls] ?? { url: `ws://rt.test/realtime?ticket=t${ticketCalls}`, expiresAt: 0 };
      ticketCalls++;
      if (next instanceof Error) throw next;
      return next;
    },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      if (ms !== HIDDEN_PAUSE_MS) delays.push(ms);
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
    now: () => now,
    random: () => 0.5,
    visibility: {
      get hidden() {
        return visibility.hidden;
      },
      addEventListener: (t, fn) => void (listeners[t] ??= []).push(fn),
      removeEventListener: (t, fn) => void (listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn)),
    },
    network: {
      get onLine() {
        return network.onLine;
      },
      addEventListener: (t, fn) => void (listeners[t] ??= []).push(fn),
      removeEventListener: (t, fn) => void (listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn)),
    },
    expectedOrigin: "ws://rt.test",
  };
  const connection = new RealtimeConnection(
    "t-1",
    { onFrame: (f) => frames.push(f), onStatus: (s) => statuses.push(s), onFatal: (f) => fatals.push(f) },
    deps,
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    connection,
    sockets,
    statuses,
    frames,
    fatals,
    delays,
    visibility,
    network,
    timers,
    ticketCalls: () => ticketCalls,
    emit: (type: string) => (listeners[type] ?? []).forEach((fn) => fn()),
    flush,
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && timers.has(id)) {
          timers.delete(id);
          timer.fn();
        }
      }
      await flush();
    },
  };
}

const hello: ServerFrame = { kind: "hello", teamId: "t-1", userId: "u-1" };

describe("frame parsing", () => {
  test("valid frames pass, everything else is dropped", () => {
    expect(parseServerFrame(JSON.stringify(hello), "t-1")).toEqual(hello);
    expect(parseServerFrame("{not json", "t-1")).toBeNull();
    expect(parseServerFrame(JSON.stringify({ kind: "nope", teamId: "t-1" }), "t-1")).toBeNull();
    expect(parseServerFrame(JSON.stringify({ kind: "hello", teamId: "t-1" }), "t-1")).toBeNull();
    expect(parseServerFrame(new ArrayBuffer(4), "t-1")).toBeNull();
  });

  test("frames for another team are dropped", () => {
    expect(parseServerFrame(JSON.stringify({ ...hello, teamId: "t-2" }), "t-1")).toBeNull();
    const err = { kind: "error", teamId: null, code: "bad_request", message: "Unknown frame." };
    expect(parseServerFrame(JSON.stringify(err), "t-1")).toEqual(err as ServerFrame);
    expect(parseServerFrame(JSON.stringify({ ...err, teamId: "t-2" }), "t-1")).toBeNull();
  });
});

describe("backoff", () => {
  test("0.5 s doubling to a 10 s cap, jittered 0.8x to 1.2x", () => {
    expect(backoffDelay(0, () => 0.5)).toBe(500);
    expect(backoffDelay(1, () => 0.5)).toBe(1000);
    expect(backoffDelay(4, () => 0.5)).toBe(8000);
    expect(backoffDelay(5, () => 0.5)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(50, () => 0.5)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(0, () => 0)).toBe(400);
    expect(backoffDelay(30, () => 0.999999)).toBeLessThanOrEqual(12_000);
  });
});

describe("ticket urls", () => {
  test("only ws(s) on the expected origin", () => {
    expect(checkTicketUrl("wss://rt.example.com/realtime?ticket=a", "wss://rt.example.com")).toBe("wss://rt.example.com/realtime?ticket=a");
    expect(checkTicketUrl("wss://evil.com/realtime?ticket=a", "wss://rt.example.com")).toBeNull();
    expect(checkTicketUrl("https://rt.example.com/realtime", undefined)).toBeNull();
    expect(checkTicketUrl("javascript:alert(1)", undefined)).toBeNull();
    expect(checkTicketUrl("ws://anything/realtime", undefined)).toBe("ws://anything/realtime");
  });
});

describe("RealtimeConnection", () => {
  test("connects, delivers valid frames, drops invalid ones", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    // "connecting" is the initial status, so the first change reported is "open".
    expect(h.connection.status).toBe("connecting");
    expect(h.statuses).toEqual([]);
    h.sockets[0]!.open();
    expect(h.statuses.at(-1)).toBe("open");
    h.sockets[0]!.message(hello);
    h.sockets[0]!.message("garbage");
    h.sockets[0]!.message({ kind: "hello", teamId: "t-2", userId: "u-1" });
    expect(h.frames).toEqual([hello]);
  });

  test("a byte-identical snapshot is dropped; a changed one, or the first on a new socket, is delivered", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    h.sockets[0]!.open();
    const empty: ServerFrame = { kind: "workforce.view", teamId: "t-1", data: { profiles: {}, tasks: {}, leases: {} } };
    h.sockets[0]!.message(empty);
    h.sockets[0]!.message(empty);
    expect(h.frames).toEqual([empty]);
    // Other kinds are never deduplicated: two identical relay events are two messages.
    h.sockets[0]!.message(hello);
    h.sockets[0]!.message(hello);
    expect(h.frames).toEqual([empty, hello, hello]);
    h.sockets[0]!.drop();
    await h.advance(h.delays.at(-1)!);
    h.sockets[1]!.open();
    h.sockets[1]!.message(empty);
    expect(h.frames).toEqual([empty, hello, hello, empty]);
  });

  test("reconnects with growing delays and a fresh ticket every time", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    h.sockets[0]!.drop();
    expect(h.statuses.at(-1)).toBe("reconnecting");
    for (let i = 1; i <= 7; i++) {
      await h.advance(h.delays.at(-1)!);
      expect(h.sockets).toHaveLength(i + 1);
      h.sockets[i]!.drop();
    }
    expect(h.delays).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
    expect(h.ticketCalls()).toBe(8);
    expect(new Set(h.sockets.map((s) => s.url)).size).toBe(8);
  });

  test("a socket that stayed open resets the backoff", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    h.sockets[0]!.drop();
    await h.advance(500);
    h.sockets[1]!.drop();
    await h.advance(1000);
    h.sockets[2]!.open();
    await h.advance(15_000);
    h.sockets[2]!.drop();
    expect(h.delays.at(-1)).toBe(500);
  });

  test("ticket failures back off too", async () => {
    const h = harness({ tickets: [new ApiError("network_error", "x", 0), new ApiError("dependency_unavailable", "x", 503)] });
    h.connection.start();
    await h.flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.delays).toEqual([500]);
    await h.advance(500);
    expect(h.delays).toEqual([500, 1000]);
    await h.advance(1000);
    expect(h.sockets).toHaveLength(1);
  });

  test("signed out or removed from the team is fatal, with no retry", async () => {
    const h = harness({ tickets: [new ApiError("unauthenticated", "x", 401)] });
    h.connection.start();
    await h.flush();
    expect(h.fatals).toEqual([{ reason: "unauthenticated", message: "Your session ended. Sign in again." }]);
    expect(h.statuses.at(-1)).toBe("offline");
    expect(h.timers.size).toBe(0);

    const k = harness();
    k.connection.start();
    await k.flush();
    k.sockets[0]!.open();
    k.sockets[0]!.drop(4003);
    expect(k.fatals[0]!.reason).toBe("not_member");
    expect(k.timers.size).toBe(0);
  });

  test("a 403 ticket is a misconfiguration, not lost membership", async () => {
    const h = harness({ tickets: [new ApiError("forbidden", "Cross-origin request rejected.", 403)] });
    h.connection.start();
    await h.flush();
    expect(h.fatals).toEqual([{ reason: "misconfigured", message: "Live updates are misconfigured on this server." }]);
    expect(h.timers.size).toBe(0);

    const k = harness({ tickets: [new ApiError("not_found", "Team not found.", 404)] });
    k.connection.start();
    await k.flush();
    expect(k.fatals[0]!.reason).toBe("not_member");
  });

  test("a ticket pointing at another origin is refused", async () => {
    const h = harness({ tickets: [{ url: "wss://evil.example/realtime?ticket=a", expiresAt: 0 }] });
    h.connection.start();
    await h.flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.fatals[0]!.reason).toBe("misconfigured");
  });

  test("pauses after 5 minutes hidden and resumes on visibility", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    h.sockets[0]!.open();
    h.visibility.hidden = true;
    h.emit("visibilitychange");
    await h.advance(HIDDEN_PAUSE_MS - 1);
    expect(h.sockets[0]!.closed).toBeNull();
    await h.advance(1);
    expect(h.sockets[0]!.closed?.code).toBe(1000);
    expect(h.statuses.at(-1)).toBe("offline");
    // The close event after our own close must not schedule a reconnect.
    h.sockets[0]!.drop(1000);
    expect(h.timers.size).toBe(0);

    h.visibility.hidden = false;
    h.emit("visibilitychange");
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.statuses.at(-1)).toBe("reconnecting");
  });

  test("a short hide does not pause", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    h.sockets[0]!.open();
    h.visibility.hidden = true;
    h.emit("visibilitychange");
    await h.advance(60_000);
    h.visibility.hidden = false;
    h.emit("visibilitychange");
    await h.advance(HIDDEN_PAUSE_MS);
    expect(h.sockets[0]!.closed).toBeNull();
    expect(h.sockets).toHaveLength(1);
  });

  test("offline waits for the network instead of spinning", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    h.network.onLine = false;
    h.sockets[0]!.drop();
    expect(h.statuses.at(-1)).toBe("offline");
    expect(h.timers.size).toBe(0);
    h.network.onLine = true;
    h.emit("online");
    await h.flush();
    expect(h.sockets).toHaveLength(2);
  });

  test("retryNow skips the backoff wait, and does nothing when open or stopped", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    h.sockets[0]!.open();
    expect(h.connection.retryNow()).toBe(false);
    for (let i = 0; i < 4; i++) {
      h.sockets.at(-1)!.drop();
      await h.advance(h.delays.at(-1)!);
    }
    h.sockets.at(-1)!.drop();
    const before = h.sockets.length;
    expect(h.connection.retryNow()).toBe(true);
    await h.flush();
    expect(h.sockets).toHaveLength(before + 1);
    // The pending backoff timer was cleared, so nothing else connects on its own.
    await h.advance(60_000);
    expect(h.sockets).toHaveLength(before + 1);
    // A fresh backoff: the next drop waits the minimum again.
    h.sockets.at(-1)!.drop();
    expect(h.delays.at(-1)).toBe(500);
    h.connection.stop();
    expect(h.connection.retryNow()).toBe(false);
  });

  test("history requests go out only while open", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    expect(h.connection.requestHistory("m-1", null)).toBe(false);
    h.sockets[0]!.open();
    expect(h.connection.requestHistory("m-1", "proj-abc")).toBe(true);
    expect(JSON.parse(h.sockets[0]!.sent[0]!)).toEqual({ kind: "relay.history", before: "m-1", channel: "proj-abc" });
  });

  test("thread requests go out only while open, and only for a valid message id", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    expect(h.connection.requestThread("k-1")).toBe(false);
    h.sockets[0]!.open();
    expect(h.connection.requestThread("../k 1")).toBe(false);
    expect(h.connection.requestThread("k-1")).toBe(true);
    expect(h.sockets[0]!.sent.map((f) => JSON.parse(f))).toEqual([{ kind: "relay.thread", messageId: "k-1" }]);
  });

  test("stop closes the socket and cancels everything", async () => {
    const h = harness();
    h.connection.start();
    await h.flush();
    h.sockets[0]!.drop();
    h.connection.stop();
    expect(h.timers.size).toBe(0);
    await h.advance(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  test("a slow ticket that lands after stop opens nothing", async () => {
    let resolve!: (t: RealtimeTicketResponse) => void;
    const sockets: FakeSocket[] = [];
    const connection = new RealtimeConnection(
      "t-1",
      { onFrame: () => {}, onStatus: () => {}, onFatal: () => {} },
      { getTicket: () => new Promise((r) => (resolve = r)), createSocket: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!), visibility: null, network: null, expectedOrigin: undefined },
    );
    connection.start();
    connection.stop();
    resolve({ url: "ws://rt.test/realtime?ticket=a", expiresAt: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(sockets).toHaveLength(0);
  });
});

describe("connectInspect", () => {
  const ticket = async () => ({ url: "ws://rt.test/realtime/inspect/l-1?ticket=a", expiresAt: 0 });

  test("streams output and stops on inspect.end", async () => {
    const sockets: FakeSocket[] = [];
    const frames: InspectFrame[] = [];
    const ends: string[] = [];
    connectInspect("t-1", "l-1", (f) => frames.push(f), {
      onEnd: (reason) => ends.push(reason),
      deps: { getTicket: ticket, createSocket: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!), expectedOrigin: "ws://rt.test" },
    });
    await new Promise((r) => setTimeout(r, 0));
    const s = sockets[0]!;
    s.open();
    s.message({ kind: "inspect.hello", leaseId: "l-1", agentName: "w-abc-api-e1" });
    s.message({ kind: "inspect.output", data: "hi", reset: false });
    s.message("junk");
    s.message({ kind: "inspect.end", reason: "lease_ended" });
    s.message({ kind: "inspect.output", data: "late", reset: false });
    s.drop();
    expect(frames.map((f) => f.kind)).toEqual(["inspect.hello", "inspect.output"]);
    expect(ends).toEqual(["lease_ended"]);
    expect(s.closed).not.toBeNull();
    expect(sockets).toHaveLength(1);
  });

  test("no ticket: ends once with the error, never connects", async () => {
    const ends: Array<[string, ApiError | undefined]> = [];
    let created = 0;
    connectInspect("t-1", "l-1", () => {}, {
      onEnd: (reason, error) => ends.push([reason, error]),
      deps: {
        getTicket: async () => {
          throw new ApiError("not_found", "This worker is not running.", 404);
        },
        createSocket: (url) => (created++, new FakeSocket(url)),
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(created).toBe(0);
    expect(ends).toHaveLength(1);
    expect(ends[0]![0]).toBe("unavailable");
    expect(ends[0]![1]?.message).toBe("This worker is not running.");
  });

  test("close() before the ticket lands opens nothing and reports nothing", async () => {
    let created = 0;
    const ends: string[] = [];
    const handle = connectInspect("t-1", "l-1", () => {}, {
      onEnd: (r) => ends.push(r),
      deps: { getTicket: ticket, createSocket: (url) => (created++, new FakeSocket(url)), expectedOrigin: undefined },
    });
    handle.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(created).toBe(0);
    expect(ends).toEqual([]);
  });
});
