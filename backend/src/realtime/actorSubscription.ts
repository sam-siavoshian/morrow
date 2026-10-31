import type { ActorGateway, SocketActor } from "../actors/types.ts";
import type { Logger } from "../lib/logger.ts";
import { backoffDelay } from "../lib/retry.ts";

export interface ActorSubscriptionOptions {
  actor: SocketActor;
  teamId: string;
  gateway: Pick<ActorGateway, "prepareSocket">;
  /** Called with the full merged emitted state after every snapshot or update. */
  onState: (state: Record<string, unknown>) => void;
  log: Logger;
  baseDelayMs?: number;
  maxDelayMs?: number;
  connectTimeoutMs?: number;
  /** Keepalive: a ping this often while open. 0 turns it off. */
  pingMs?: number;
  /** No frame this long after a ping: the connection is dead; close it and reconnect. */
  pongTimeoutMs?: number;
}

/**
 * The keepalive frame. Actors answer it at the gateway (`setWebSocketAutoResponse`), so it never wakes them. The
 * exact text matters: the gateway matches the whole frame. It is also a valid `{ type: "ping" }` message, so an actor
 * deployed before the auto-response answers it from `onMessage` instead of failing the socket.
 */
export const KEEPALIVE_PING = '{"type":"ping"}';
/** What the gateway answers with. Any frame counts as proof of life; this one carries no state. */
export const KEEPALIVE_PONG = '{"type":"pong"}';
/** Client close code for a connection that stopped answering. */
export const KEEPALIVE_CLOSE = 4000;

type StateFrame =
  | { type: "state"; state: Record<string, unknown>; version?: number }
  | { type: "state_update"; changes: Record<string, unknown>; removed: string[]; version: number };

function parseStateFrame(raw: string): StateFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (m.type === "state" && isObj(m.state)) {
    return { type: "state", state: m.state, version: typeof m.version === "number" ? m.version : undefined };
  }
  if (m.type === "state_update" && isObj(m.changes) && Array.isArray(m.removed) && typeof m.version === "number") {
    return { type: "state_update", changes: m.changes, removed: m.removed.filter((r): r is string => typeof r === "string"), version: m.version };
  }
  return null;
}

/**
 * One backend-held socket to an actor's emitted state. Grants are fetched fresh for every connect and
 * never leave this object. Reconnects with jittered exponential backoff until stopped; the attempt
 * counter resets once a snapshot arrives, so a flapping actor does not pin us at the max delay forever.
 */
export class ActorSubscription {
  readonly #o: Required<ActorSubscriptionOptions>;
  #socket: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #stopped = true;
  #state: Record<string, unknown> | null = null;
  #version = -1;
  #connected = false;
  /** A snapshot arrived on the current connection, so `state` is current, not left over from a dropped one. */
  #fresh = false;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ActorSubscriptionOptions) {
    this.#o = {
      ...options,
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 10_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      pingMs: options.pingMs ?? 25_000,
      pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
    };
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** Open, and `state` came from this connection's snapshot (plus updates since): safe to read as current. */
  get live(): boolean {
    return this.#connected && this.#fresh;
  }

  /** The state version of the last applied frame, -1 before any. */
  get version(): number {
    return this.#version;
  }

  get state(): Record<string, unknown> | null {
    return this.#state;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#stopKeepalive();
    const socket = this.#socket;
    this.#socket = null;
    this.#connected = false;
    this.#fresh = false;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, "unsubscribed");
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    const log = this.#o.log;
    let url: string;
    try {
      url = (await this.#o.gateway.prepareSocket(this.#o.actor, this.#o.teamId)).websocketUrl;
    } catch (error) {
      log.warn("actor socket grant failed", { actor: this.#o.actor, teamId: this.#o.teamId, error });
      return this.#scheduleReconnect();
    }
    if (this.#stopped) return;

    const socket = new WebSocket(url);
    this.#socket = socket;
    const connectTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) socket.close();
    }, this.#o.connectTimeoutMs);

    socket.onopen = () => {
      clearTimeout(connectTimer);
      if (this.#socket !== socket) return socket.close(1000, "superseded");
      this.#connected = true;
      this.#fresh = false;
      this.#startKeepalive(socket);
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      this.#alive();
      if (typeof event.data !== "string" || event.data === KEEPALIVE_PONG) return;
      const frame = parseStateFrame(event.data);
      if (!frame) return;
      if (frame.type === "state") {
        this.#state = frame.state;
        this.#version = frame.version ?? -1;
        this.#attempt = 0;
        this.#fresh = true;
      } else {
        // Updates before the first snapshot, or older than what we hold, are not applicable.
        if (!this.#state || (this.#version >= 0 && frame.version <= this.#version)) return;
        const next = { ...this.#state, ...frame.changes };
        for (const key of frame.removed) delete next[key];
        this.#state = next;
        this.#version = frame.version;
      }
      try {
        this.#o.onState(this.#state);
      } catch (error) {
        log.error("actor state handler threw", { actor: this.#o.actor, teamId: this.#o.teamId, error });
      }
    };
    socket.onclose = (event) => {
      clearTimeout(connectTimer);
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#connected = false;
      this.#fresh = false;
      this.#stopKeepalive();
      if (this.#stopped) return;
      log.warn("actor socket closed", { actor: this.#o.actor, teamId: this.#o.teamId, closeCode: event.code });
      this.#scheduleReconnect();
    };
  }

  // Without traffic a dead connection (a half-open TCP link, a restarted gateway that never sent a close) looks open
  // forever, and this backend would read stale state from it. A ping every `pingMs` that gets no frame back within
  // `pongTimeoutMs` closes it, and the normal reconnect takes over.
  #startKeepalive(socket: WebSocket): void {
    this.#stopKeepalive();
    if (this.#o.pingMs <= 0) return;
    this.#pingTimer = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN || this.#pongTimer) return;
      try {
        socket.send(KEEPALIVE_PING);
      } catch {
        return;
      }
      this.#pongTimer = setTimeout(() => {
        this.#pongTimer = null;
        if (this.#socket !== socket) return;
        this.#o.log.warn("actor socket stopped answering; reconnecting", { actor: this.#o.actor, teamId: this.#o.teamId });
        // Let go now: on a dead link the close handshake may never finish, so waiting for `onclose` could take minutes.
        this.#socket = null;
        this.#connected = false;
        this.#fresh = false;
        this.#stopKeepalive();
        try {
          socket.close(KEEPALIVE_CLOSE, "keepalive timeout");
        } catch {
          // Already closing.
        }
        this.#scheduleReconnect();
      }, this.#o.pongTimeoutMs);
    }, this.#o.pingMs);
  }

  #alive(): void {
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    this.#pongTimer = null;
  }

  #stopKeepalive(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#alive();
    this.#pingTimer = null;
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    this.#attempt += 1;
    const delay = Math.max(this.#o.baseDelayMs / 2, backoffDelay(this.#attempt, this.#o.baseDelayMs, this.#o.maxDelayMs));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#connect();
    }, delay);
  }
}
