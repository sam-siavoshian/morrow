// ActorSubscription keepalive against a local WebSocket server standing in for the Terse gateway.
import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { silentLogger } from "../src/lib/logger.ts";
import { ActorSubscription, KEEPALIVE_PING, KEEPALIVE_PONG } from "../src/realtime/actorSubscription.ts";

type Mode = { answerPings: boolean };

function gateway(mode: Mode) {
  const sockets: ServerWebSocket<unknown>[] = [];
  const received: string[] = [];
  let connects = 0;
  const server: Server<unknown> = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: {} })) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        connects++;
        sockets.push(ws);
        ws.send(JSON.stringify({ type: "state", state: { n: connects }, version: 1 }));
      },
      message(ws, message) {
        received.push(String(message));
        if (mode.answerPings && message === KEEPALIVE_PING) ws.send(KEEPALIVE_PONG);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/`,
    received,
    get connects() {
      return connects;
    },
    push(state: Record<string, unknown>, version: number) {
      for (const ws of sockets) ws.send(JSON.stringify({ type: "state_update", changes: state, removed: [], version }));
    },
    stop: () => server.stop(true),
  };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function subscribe(url: string, states: Record<string, unknown>[], timing: { pingMs: number; pongTimeoutMs: number }) {
  const sub = new ActorSubscription({
    actor: "TeamWorkforce",
    teamId: "t-keepalive",
    gateway: { prepareSocket: async () => ({ websocketUrl: url, connectByMs: Date.now() + 10_000 }) },
    onState: (state) => states.push(state),
    log: silentLogger,
    baseDelayMs: 10,
    maxDelayMs: 20,
    ...timing,
  });
  cleanup.push(() => sub.stop());
  sub.start();
  return sub;
}

describe("ActorSubscription keepalive", () => {
  test("pings while open; answered pings keep one connection and never reach onState", async () => {
    const gw = gateway({ answerPings: true });
    cleanup.push(gw.stop);
    const states: Record<string, unknown>[] = [];
    const sub = subscribe(gw.url, states, { pingMs: 30, pongTimeoutMs: 200 });
    await until(() => sub.live);
    await until(() => gw.received.length >= 5);
    expect(gw.received.every((m) => m === KEEPALIVE_PING)).toBe(true);
    expect(gw.connects).toBe(1);
    expect(states).toEqual([{ n: 1 }]);
    gw.push({ m: 2 }, 2);
    await until(() => states.length === 2);
    expect(states[1]).toEqual({ n: 1, m: 2 });
    expect(sub.version).toBe(2);
  });

  test("a connection that stops answering is dropped and replaced; it is not live until the new snapshot", async () => {
    const gw = gateway({ answerPings: false });
    cleanup.push(gw.stop);
    const states: Record<string, unknown>[] = [];
    const sub = subscribe(gw.url, states, { pingMs: 30, pongTimeoutMs: 40 });
    await until(() => gw.connects >= 3);
    // Every connection got its own snapshot.
    await until(() => states.length >= 3);
    expect(states.slice(0, 3)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test("any frame counts as an answer", async () => {
    const gw = gateway({ answerPings: false });
    cleanup.push(gw.stop);
    const states: Record<string, unknown>[] = [];
    const sub = subscribe(gw.url, states, { pingMs: 30, pongTimeoutMs: 60 });
    await until(() => sub.live);
    let version = 1;
    const pump = setInterval(() => gw.push({ v: ++version }, version), 10);
    cleanup.push(() => clearInterval(pump));
    await Bun.sleep(400);
    expect(gw.connects).toBe(1);
    expect(sub.live).toBe(true);
  });

  test("pingMs 0 turns the keepalive off", async () => {
    const gw = gateway({ answerPings: false });
    cleanup.push(gw.stop);
    const sub = subscribe(gw.url, [], { pingMs: 0, pongTimeoutMs: 10 });
    await until(() => sub.live);
    await Bun.sleep(100);
    expect(gw.received).toEqual([]);
    expect(gw.connects).toBe(1);
  });
});
