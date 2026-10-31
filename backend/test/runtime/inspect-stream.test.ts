// The inspect hub's stream, driven directly with fake sockets, a fake follower (playing vm/logfollow.sh) and a fake
// poller: late joiners get the current screen, credentials never reach a viewer or a snapshot even when split across
// reads, streaming falls back to adaptive polling, liveness checks run apart from reads, and memory stays bounded.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_TERMINAL, type InspectFrame } from "@morrow/contracts";
import type { Freestyle } from "freestyle";
import type { followWorkerLog, LogFollowHandlers, readWorkerLogBytes } from "../../src/integrations/freestyle/index.ts";
import { FreestyleIntegrationError } from "../../src/integrations/freestyle/index.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { InspectHub, MAX_REDACT_HOLD, StreamRedactor, redactSecrets, type InspectHubOptions, type InspectSocketData } from "../../src/runtime/inspect.ts";
import { waitFor } from "./helpers.ts";
import { framesToBytes, linesOf, render, screenOf } from "./screen.ts";
import { claudeCodeSession } from "./tui-stream.ts";

type Output = Extract<InspectFrame, { kind: "inspect.output" }>;
const TEAM = "t-team";
const LEASE = "l-lease";
const enc = new TextEncoder();

class FakeWs {
  readyState = 1;
  frames: InspectFrame[] = [];
  closed: { code: number; reason: string } | null = null;
  buffered = 0;
  constructor(
    readonly data: InspectSocketData,
    private readonly hub: InspectHub,
  ) {}
  send(text: string): number {
    this.frames.push(JSON.parse(text) as InspectFrame);
    return text.length;
  }
  getBufferedAmount(): number {
    return this.buffered;
  }
  close(code: number, reason: string): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closed = { code, reason };
    queueMicrotask(() => this.hub.close(this as never));
  }
  output(): Output[] {
    return this.frames.filter((f): f is Output => f.kind === "inspect.output");
  }
}

/** Plays vm/logfollow.sh over an in-memory log: hello, backlog, then whatever is appended, one read per append. */
class FakeLog {
  bytes = new Uint8Array(0);
  opens: Array<{ start: number | null; off: number; started: boolean; stopped: boolean; ended: boolean; h: LogFollowHandlers }> = [];
  failOpens = 0;
  reads: number[] = [];
  backlog = 65_536;

  follow = (async (o: Parameters<typeof followWorkerLog>[0]) => {
    if (this.failOpens > 0) {
      this.failOpens -= 1;
      throw new Error("PTY open failed");
    }
    const rec = { start: o.start, off: 0, started: false, stopped: false, ended: false, h: o };
    this.opens.push(rec);
    queueMicrotask(() => {
      const size = this.bytes.length;
      rec.off = rec.start === null || rec.start > size ? Math.max(0, size - o.backlogBytes) : rec.start;
      rec.started = true;
      rec.h.onStart({ start: rec.off, size });
      this.pump();
    });
    return {
      stop: async () => {
        rec.stopped = true;
      },
    };
  }) as typeof followWorkerLog;

  read = (async (o: Parameters<typeof readWorkerLogBytes>[0]) => {
    this.reads.push(performance.now());
    const max = o.maxBytes ?? 65_536;
    return this.bytes.length === 0 && this.missing ? null : { bytes: this.bytes.slice(Math.max(0, this.bytes.length - max)), size: this.bytes.length, modifiedAt: new Date().toISOString() };
  }) as typeof readWorkerLogBytes;
  missing = false;

  get current() {
    return this.opens.findLast((r) => !r.stopped && !r.ended);
  }
  append(text: string | Uint8Array): void {
    const add = typeof text === "string" ? enc.encode(text) : text;
    const next = new Uint8Array(this.bytes.length + add.length);
    next.set(this.bytes);
    next.set(add, this.bytes.length);
    this.bytes = next;
    this.pump();
  }
  pump(): void {
    const rec = this.current;
    if (!rec?.started) return;
    while (rec.off < this.bytes.length) {
      const piece = this.bytes.slice(rec.off, Math.min(this.bytes.length, rec.off + 32_768));
      rec.h.onBytes(piece, rec.off);
      rec.off += piece.length;
    }
  }
  end(reason: Parameters<LogFollowHandlers["onEnd"]>[0]["reason"], detail?: string): void {
    const rec = this.current!;
    rec.ended = true;
    rec.h.onEnd(detail ? { reason, detail } : { reason });
  }
}

function setup(options: Partial<InspectHubOptions> = {}) {
  const log = new FakeLog();
  const lease = { state: "running" };
  const team = { members: [{ userId: "u-a" }, { userId: "u-b" }], policy: { allowInspect: true } };
  let leaseReads = 0;
  const hub = new InspectHub({
    tickets: {} as never,
    appOrigin: "http://app.test",
    actors: {
      getLease: (async () => {
        leaseReads += 1;
        return lease;
      }) as never,
      listEnvironments: (async () => []) as never,
    },
    gateway: { getTeam: (async () => team) as never },
    client: () => ({}) as Freestyle,
    log: silentLogger,
    follow: log.follow,
    readBytes: log.read,
    flushMs: 2,
    redactHoldMs: 15,
    pollMs: 40,
    fastPollMs: 5,
    leaseCheckMs: 20,
    ...options,
  });
  const connect = (userId = "u-a") => {
    const ws = new FakeWs({ inspect: true, id: `s-${Math.random()}`, userId, teamId: TEAM, leaseId: LEASE, target: { vmId: "vm1", linuxUser: "u0123456789ab", agentName: "w-1" } }, hub);
    hub.open(ws as never);
    return ws;
  };
  return { hub, log, lease, team, connect, leaseReads: () => leaseReads };
}

/** Lets batched output, held tails and snapshots settle. */
const settle = () => Bun.sleep(60);

describe("what a viewer sees", () => {
  test("hello carries the PTY size the node pins; configure-node.sh pins the same size", () => {
    const { connect, hub } = setup();
    const ws = connect();
    expect(ws.frames[0]).toEqual({ kind: "inspect.hello", leaseId: LEASE, agentName: "w-1", cols: WORKER_TERMINAL.cols, rows: WORKER_TERMINAL.rows });
    const script = readFileSync(join(import.meta.dir, "../../vm/configure-node.sh"), "utf8");
    expect(script).toContain(`readonly PTY_COLS=${WORKER_TERMINAL.cols} PTY_ROWS=${WORKER_TERMINAL.rows}`);
    expect(script).toContain("Environment=COLUMNS=$PTY_COLS\nEnvironment=LINES=$PTY_ROWS");
    hub.shutdown();
  });

  test("a viewer who joins late sees the screen exactly as a viewer who watched from the start", async () => {
    const chunks = claudeCodeSession({ steps: 80 });
    const { connect, log, hub } = setup();
    const early = connect();
    await settle();
    for (const chunk of chunks.slice(0, 50)) log.append(chunk);
    await settle();
    const late = connect("u-b");
    for (const chunk of chunks.slice(50)) log.append(chunk);
    await settle();

    const truth = linesOf(await render(chunks.join("")));
    expect(truth.join("\n")).toContain("Welcome to Claude Code!");
    expect(linesOf(await render(framesToBytes(early.output())))).toEqual(truth);
    expect(linesOf(await render(framesToBytes(late.output())))).toEqual(truth);
    // The late joiner's first output is one reset carrying the screen, not a raw tail.
    expect(late.output()[0]!.reset).toBe(true);

    // What the old tail did instead: the last 16 KB, raw, starts mid-redraw and paints a different screen.
    const raw = enc.encode(chunks.join(""));
    const tail = new TextDecoder().decode(raw.subarray(raw.length - 16 * 1024));
    expect(linesOf(await render(tail))).not.toEqual(truth);
    hub.shutdown();
  });

  test("a fresh stream builds its screen from the backlog before the first viewer sees anything", async () => {
    const chunks = claudeCodeSession({ steps: 40 });
    const { connect, log, hub } = setup();
    for (const chunk of chunks) log.append(chunk);
    const ws = connect();
    await settle();
    expect(ws.output()[0]!.reset).toBe(true);
    expect(linesOf(await render(framesToBytes(ws.output())))).toEqual(linesOf(await render(chunks.join(""))));
    hub.shutdown();
  });

  test("viewers share one follower; the last one leaving stops it and frees the screen", async () => {
    const { connect, log, hub } = setup();
    const a = connect();
    const b = connect("u-b");
    await settle();
    expect(log.opens.length).toBe(1);
    expect(hub.stats()).toEqual({ leases: 1, sockets: 2, streaming: 1, polling: 0 });
    a.close(1000, "bye");
    b.close(1000, "bye");
    await settle();
    expect(log.opens[0]!.stopped).toBe(true);
    expect(hub.stats()).toEqual({ leases: 0, sockets: 0, streaming: 0, polling: 0 });
  });
});

describe("credentials", () => {
  const SECRETS = [
    ["ANTHROPIC_API_KEY=", "sk-ant-api03-Zq9XyWvUtSrQpOnMlKjIhGfEdCbA0123456789"],
    ["token ", "gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    ['{"access_token": "', 'opaque-Value-123456789"}'],
    ["Bearer ", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3b3JrZXIifQ.c2lnbmF0dXJlLXZhbHVl"],
    [`\x1b[1m`, "rk_live_WorkspaceKey0123456789abcdef"],
    [`\x1b[38;5;214m`, "sk-ant-oat01-ColouredSecret0123456789"],
  ] as const;
  const secretPart = (s: string) => s.replace(/^(sk-ant-api03-|gho_|sk-ant-oat01-|rk_live_|eyJhbGciOiJIUzI1NiJ9\.)/, "").replace(/"}$/, "").slice(0, 12);

  test("a token split across reads at any point never reaches a viewer, live or in a late snapshot", async () => {
    const cases = SECRETS.flatMap(([prefix, secret]) => {
      const line = `${prefix}${secret} done\r\n`;
      return Array.from({ length: line.length - 1 }, (_, i) => ({ line, cut: i + 1, secret }));
    });
    await Promise.all(
      cases.map(async ({ line, cut, secret }) => {
        const { connect, log, hub } = setup();
        const early = connect();
        await Bun.sleep(5);
        log.append(line.slice(0, cut));
        await Bun.sleep(1);
        log.append(line.slice(cut));
        await Bun.sleep(40);
        const late = connect("u-b");
        await Bun.sleep(40);
        for (const ws of [early, late]) expect(JSON.stringify(ws.frames)).not.toContain(secretPart(secret));
        expect((await screenOf(late.output())).join("\n")).toContain("[redacted]");
        expect((await screenOf(early.output())).join("\n")).toContain("[redacted]");
        hub.shutdown();
      }),
    );
  }, 30_000);

  test("a token a TUI draws in pieces with cursor moves is masked in the snapshot", async () => {
    const { connect, log, hub } = setup();
    connect();
    await settle();
    // `sk-ant-` at column 1, the rest painted later at column 8 of the same row.
    log.append("\x1b[5;1Hsk-ant-");
    await settle();
    log.append("\x1b[9;1Hother\x1b[5;8Hapi03-PaintedLater0123456789\x1b[20;1H");
    await settle();
    const late = connect("u-b");
    await settle();
    const snapshot = late.output()[0]!;
    expect(snapshot.reset).toBe(true);
    expect(snapshot.data).not.toContain("PaintedLater");
    expect((await screenOf([snapshot])).join("\n")).toContain("sk-ant-[redacted]");
    hub.shutdown();
  });

  test("a credential whose rest arrives after the hold ran out is still masked, before and after", () => {
    for (const [prefix, secret] of SECRETS) {
      const line = `${prefix}${secret} done\r\n`;
      for (let cut = 1; cut < line.length; cut += 1) {
        for (const splits of [[cut], [cut, Math.min(line.length - 1, cut + 5)]]) {
          const r = new StreamRedactor();
          let out = "";
          let from = 0;
          for (const at of [...splits, line.length]) {
            out += r.push(line.slice(from, at));
            out += r.flush(); // The hold always runs out: the worst case.
            from = at;
          }
          expect(out).not.toContain(secretPart(secret));
          expect(out).toContain("[redacted]");
          expect(out.endsWith(" done\r\n")).toBe(true);
        }
      }
    }
    // Ordinary text that pauses mid-word is shown as is.
    const r = new StreamRedactor();
    expect(r.push("Reading fil") + r.flush() + r.push("es now\r\n")).toBe("Reading files now\r\n");
  });

  test("StreamRedactor releases everything else at once and holds a bounded tail", () => {
    const r = new StreamRedactor();
    expect(r.push("plain words, then a newline\r\n")).toBe("plain words, then a newline\r\n");
    expect(r.holding).toBe(false);
    expect(r.push("prefix sk-ant-ap")).toBe("prefix ");
    expect(r.push("i03-SECRETSECRETSECRET1 ok\n")).toBe("sk-ant-[redacted] ok\n");
    r.push("x".repeat(200_000));
    expect(r.flush().length).toBeLessThanOrEqual(MAX_REDACT_HOLD);
    // A colour code right before a prefix still counts as a word start.
    expect(redactSecrets("\x1b[1msk-ant-api03-AAAA_bbbb\x1b[0m")).toBe("\x1b[1msk-ant-[redacted]\x1b[0m");
    expect(redactSecrets("rt_sigaction task-runner")).toBe("rt_sigaction task-runner");
  });
});

describe("reading", () => {
  test("a follower that reaches its lifetime is replaced from the same offset, invisibly", async () => {
    const { connect, log, hub } = setup();
    const ws = connect();
    log.append("one\r\n");
    await settle();
    log.end("lifetime");
    await settle();
    expect(log.opens.length).toBe(2);
    expect(log.opens[1]!.start).toBe(5);
    log.append("two\r\n");
    await settle();
    expect(ws.output().filter((f) => f.reset).length).toBe(1);
    expect(await screenOf(ws.output())).toEqual(["one", "two"]);
    hub.shutdown();
  });

  test("a rotated log starts a new screen for everyone", async () => {
    const { connect, log, hub } = setup();
    const ws = connect();
    log.append("old run\r\n");
    await settle();
    log.bytes = enc.encode("new run\r\n");
    log.end("rotated");
    await Bun.sleep(700);
    expect(await screenOf(ws.output())).toEqual(["new run"]);
    expect(ws.output().filter((f) => f.reset).length).toBe(2);
    hub.shutdown();
  });

  test("a follower that keeps failing falls back to polling, then tries streaming again", async () => {
    const { connect, log, hub } = setup({ streamRetryMs: 300 });
    log.failOpens = 3;
    log.append("hello\r\n");
    const ws = connect();
    await waitFor(() => hub.stats().polling === 1, 3_000, "fallback to polling");
    await waitFor(() => log.reads.length > 0, 1_000, "polled");
    log.append("polled\r\n");
    await waitFor(async () => (await screenOf(ws.output())).includes("polled"), 1_000, "polled output");
    await waitFor(() => hub.stats().streaming === 1 && log.opens.length === 1, 2_000, "streaming again");
    log.append("streamed\r\n");
    await settle();
    expect(await screenOf(ws.output())).toEqual(["hello", "polled", "streamed"]);
    hub.shutdown();
  });

  test("polling is fast while output flows and backs off when quiet", async () => {
    const { connect, log, hub } = setup({ streaming: false, fastPollMs: 5, pollMs: 80 });
    connect();
    const flowing = setInterval(() => log.append("."), 3);
    await Bun.sleep(150);
    clearInterval(flowing);
    const busy = log.reads.slice(-10);
    const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);
    expect(Math.max(...gaps(busy))).toBeLessThan(30);
    await Bun.sleep(500);
    const quiet = gaps(log.reads.slice(-3));
    expect(Math.min(...quiet)).toBeGreaterThanOrEqual(70);
    hub.shutdown();
  });

  test("lease liveness is checked on its own clock, not per read", async () => {
    const { connect, log, hub, leaseReads } = setup({ streaming: false, fastPollMs: 2, pollMs: 2, leaseCheckMs: 100 });
    connect();
    await Bun.sleep(300);
    expect(log.reads.length).toBeGreaterThan(40);
    expect(leaseReads()).toBeLessThanOrEqual(4);
    hub.shutdown();
  });

  test("a lease that ends closes a streaming view and stops its follower", async () => {
    const { connect, log, lease } = setup({ leaseCheckMs: 20 });
    const ws = connect();
    await settle();
    lease.state = "released";
    await waitFor(() => ws.closed !== null, 1_000, "lease end");
    expect(ws.frames.at(-1)).toEqual({ kind: "inspect.end", reason: "lease_ended" });
    expect(log.opens[0]!.stopped).toBe(true);
  });

  test("an unsafe log ends the view, streamed or polled, before any of it is shown", async () => {
    const streamed = setup();
    const a = streamed.connect();
    await settle();
    streamed.log.end("unsafe", "symlink");
    await waitFor(() => a.closed !== null, 1_000, "unsafe end");
    expect(a.frames.at(-1)).toEqual({ kind: "inspect.end", reason: "unavailable" });

    const polled = setup({
      streaming: false,
      readBytes: (async () => {
        throw new FreestyleIntegrationError("unsafe_path", "no");
      }) as typeof readWorkerLogBytes,
    });
    const b = polled.connect();
    await waitFor(() => b.closed !== null, 1_000, "unsafe poll end");
    expect(b.frames.at(-1)).toEqual({ kind: "inspect.end", reason: "unavailable" });
    expect(b.output()).toEqual([]);
  });
});

describe("bounds", () => {
  test("a joining viewer gets at most the snapshot scrollback, however long the session", async () => {
    const { connect, log, hub } = setup({ scrollback: 200, snapshotScrollback: 50 });
    connect();
    for (let i = 0; i < 3_000; i += 1) log.append(`line ${i}\r\n`);
    await settle();
    const late = connect("u-b");
    await settle();
    const lines = await screenOf([late.output()[0]!]);
    expect(lines.length).toBeLessThanOrEqual(50 + WORKER_TERMINAL.rows);
    expect(lines.at(-1)).toBe("line 2999");
    hub.shutdown();
  });

  test("a slow viewer is cut off, the others keep streaming", async () => {
    const { connect, log, hub } = setup({ maxBufferedBytes: 1_000 });
    const slow = connect();
    const fine = connect("u-b");
    await settle();
    slow.buffered = 10_000;
    log.append("x\r\n");
    await settle();
    expect(slow.closed).toEqual({ code: 1013, reason: "slow consumer" });
    expect(fine.closed).toBeNull();
    hub.shutdown();
  });

  test("streams per server are capped before the upgrade; another viewer of a viewed lease still fits", async () => {
    let leaseId = "l-other";
    const { hub, connect } = setup({
      maxLeases: 1,
      tickets: { consume: () => ({ userId: "u-a", teamId: TEAM, leaseId }) } as never,
      actors: {
        getLease: (async () => ({ state: "running", nodeName: "n", agentName: "w-2" })) as never,
        listEnvironments: (async () => [{ nodeName: "n", phase: "ready", freestyleVmId: "vm1", linuxUser: "u0123456789ab" }]) as never,
      },
    });
    connect();
    const upgrades: unknown[] = [];
    const server = { upgrade: (_req: Request, opts: { data: unknown }) => upgrades.push(opts.data) > 0 } as never;
    const req = (id: string) => new Request(`http://api.test/realtime/inspect/${id}?ticket=t`, { headers: { upgrade: "websocket", origin: "http://app.test" } });
    const refused = await hub.handleUpgrade(req("l-other"), server);
    expect(refused?.status).toBe(503);
    expect(upgrades).toEqual([]);
    leaseId = LEASE;
    expect(await hub.handleUpgrade(req(LEASE), server)).toBeUndefined();
    expect(upgrades.length).toBe(1);
    hub.shutdown();
  });
});
