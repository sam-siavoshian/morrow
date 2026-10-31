import { ClientFrame, InspectFrame, ServerFrame, type RealtimeTicketResponse } from "@morrow/contracts";
import { ApiError, inspectTicket, realtimeTicket } from "./api";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "offline";

/** Why the connection gave up for good. The provider routes on this (sign in again, leave the team). */
export type RealtimeFatal = { reason: "unauthenticated" | "not_member" | "misconfigured"; message: string };

export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 10_000;
/** Hidden longer than this, the socket closes until the tab is visible again. */
export const HIDDEN_PAUSE_MS = 5 * 60_000;
/** A socket that stayed open this long resets the backoff. */
const STABLE_MS = 10_000;
/** Server close code for "you are not (or no longer) a member" (backend `CLOSE.notMember`). */
const CLOSE_NOT_MEMBER = 4003;
const CLOSE_NORMAL = 1000;

/** 0.5 s, 1 s, 2 s ... capped at 10 s, each scaled by a random 0.8x to 1.2x so tabs do not reconnect in lockstep. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** Parses one socket message. Anything that is not a valid frame for `teamId` is dropped (null). */
export function parseServerFrame(raw: unknown, teamId: string): ServerFrame | null {
  if (typeof raw !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ServerFrame.safeParse(json);
  if (!parsed.success) return null;
  const frame = parsed.data;
  if (frame.kind === "error" ? frame.teamId !== null && frame.teamId !== teamId : frame.teamId !== teamId) return null;
  return frame;
}

/**
 * Only ws/wss, and only the configured realtime origin when one is set, so a bad ticket response
 * can never point the socket somewhere else.
 */
export function checkTicketUrl(url: string, expectedOrigin: string | undefined): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  if (expectedOrigin) {
    try {
      if (new URL(expectedOrigin).origin !== parsed.origin) return null;
    } catch {
      return null;
    }
  }
  return parsed.toString();
}

type SocketLike = Pick<WebSocket, "readyState" | "send" | "close"> & {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
};

/** Seams for tests. Browser defaults everywhere. */
export type RealtimeDeps = {
  getTicket: (teamId: string) => Promise<RealtimeTicketResponse>;
  createSocket: (url: string) => SocketLike;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  random: () => number;
  /** `document`-like visibility source; null outside a browser. */
  visibility: { hidden: boolean; addEventListener(type: "visibilitychange", fn: () => void): void; removeEventListener(type: "visibilitychange", fn: () => void): void } | null;
  /** `window`-like online/offline source; null outside a browser. */
  network: { onLine: boolean; addEventListener(type: "online" | "offline", fn: () => void): void; removeEventListener(type: "online" | "offline", fn: () => void): void } | null;
  expectedOrigin: string | undefined;
};

function browserDeps(): RealtimeDeps {
  const hasWindow = typeof window !== "undefined";
  return {
    getTicket: (teamId) => realtimeTicket(teamId),
    createSocket: (url) => new WebSocket(url),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    random: Math.random,
    visibility: hasWindow ? document : null,
    network: hasWindow ? { get onLine() { return navigator.onLine; }, addEventListener: (t, f) => window.addEventListener(t, f), removeEventListener: (t, f) => window.removeEventListener(t, f) } : null,
    expectedOrigin: process.env.NEXT_PUBLIC_REALTIME_URL || undefined,
  };
}

export type RealtimeHandlers = {
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: ConnectionStatus) => void;
  onFatal: (fatal: RealtimeFatal) => void;
};

/**
 * One team socket: ticket, connect, parse, reconnect with backoff and a fresh ticket each time,
 * pause while the tab is hidden for a while. Use one per tab per team (the team session does).
 */
export class RealtimeConnection {
  readonly teamId: string;
  readonly #h: RealtimeHandlers;
  readonly #d: RealtimeDeps;
  #socket: SocketLike | null = null;
  #timer: unknown = null;
  #hiddenTimer: unknown = null;
  #attempt = 0;
  #everOpened = false;
  #openedAt: number | null = null;
  #status: ConnectionStatus = "connecting";
  #running = false;
  #paused = false;
  /** Bumped on every connect/stop so stale async work (a slow ticket fetch) knows to bail. */
  #generation = 0;
  /**
   * The last raw snapshot frame of each kind on this socket. The server resends whole views, often unchanged
   * (a heartbeat, a usage reading that rounds the same), and the workforce view runs to hundreds of KB: a
   * byte-identical copy is dropped before JSON.parse and zod ever see it.
   */
  #snapshots = new Map<string, string>();

  constructor(teamId: string, handlers: RealtimeHandlers, deps: Partial<RealtimeDeps> = {}) {
    this.teamId = teamId;
    this.#h = handlers;
    this.#d = { ...browserDeps(), ...deps };
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#d.visibility?.addEventListener("visibilitychange", this.#onVisibility);
    this.#d.network?.addEventListener("online", this.#onOnline);
    this.#d.network?.addEventListener("offline", this.#onOffline);
    if (this.#d.visibility?.hidden) this.#armHiddenPause();
    void this.#connect();
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#d.visibility?.removeEventListener("visibilitychange", this.#onVisibility);
    this.#d.network?.removeEventListener("online", this.#onOnline);
    this.#d.network?.removeEventListener("offline", this.#onOffline);
    this.#clearTimers();
    this.#closeSocket("stopped");
    this.#generation++;
  }

  /**
   * Reconnect now with a fresh backoff, for a user pressing Retry. False when there is nothing to retry:
   * the connection was stopped (a fatal error stops it for good) or it is already open.
   */
  retryNow(): boolean {
    if (!this.#running || this.#status === "open") return false;
    this.#closeSocket("retry");
    this.#resume();
    return true;
  }

  /** Asks for an older page of a channel. False when the socket is not open (try again on reconnect). */
  requestHistory(before: string | null, channel: string | null): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1 || this.#status !== "open") return false;
    const frame = ClientFrame.parse({ kind: "relay.history", before, channel });
    socket.send(JSON.stringify(frame));
    return true;
  }

  /** Asks for a thread's replies (a task thread). False when the socket is not open (try again on reconnect). */
  requestThread(messageId: string): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1 || this.#status !== "open") return false;
    const parsed = ClientFrame.safeParse({ kind: "relay.thread", messageId });
    if (!parsed.success) return false;
    socket.send(JSON.stringify(parsed.data));
    return true;
  }

  #setStatus(status: ConnectionStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    this.#h.onStatus(status);
  }

  async #connect(): Promise<void> {
    if (!this.#running || this.#paused) return;
    const generation = ++this.#generation;
    this.#setStatus(this.#everOpened || this.#attempt > 0 ? "reconnecting" : "connecting");

    let ticket: RealtimeTicketResponse;
    try {
      ticket = await this.#d.getTicket(this.teamId);
    } catch (error) {
      if (generation !== this.#generation) return;
      if (error instanceof ApiError) {
        if (error.code === "unauthenticated") return this.#fatal("unauthenticated", "Your session ended. Sign in again.");
        // Non-members get 404. A 403 here is the CSRF/origin check refusing this app's origin: a deployment
        // mistake, so no redirect (the team page would just send the viewer back, forever).
        if (error.code === "not_found") return this.#fatal("not_member", "You no longer have access to this team.");
        if (error.code === "forbidden") return this.#fatal("misconfigured", "Live updates are misconfigured on this server.");
      }
      return this.#scheduleReconnect();
    }
    if (generation !== this.#generation) return;

    const url = checkTicketUrl(ticket.url, this.#d.expectedOrigin);
    if (!url) return this.#fatal("misconfigured", "Live updates are misconfigured on this server.");

    let socket: SocketLike;
    try {
      socket = this.#d.createSocket(url);
    } catch {
      return this.#scheduleReconnect();
    }
    this.#socket = socket;
    this.#snapshots.clear();
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#everOpened = true;
      this.#openedAt = this.#d.now();
      this.#setStatus("open");
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      const raw = event.data;
      for (const last of this.#snapshots.values()) if (raw === last) return;
      const frame = parseServerFrame(raw, this.teamId);
      if (!frame) return;
      if (frame.kind === "workforce.view" || frame.kind === "team.view") this.#snapshots.set(frame.kind, raw as string);
      this.#h.onFrame(frame);
    };
    socket.onerror = () => {
      // A close event always follows; reconnect is handled there.
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (this.#openedAt !== null && this.#d.now() - this.#openedAt >= STABLE_MS) this.#attempt = 0;
      this.#openedAt = null;
      if (event.code === CLOSE_NOT_MEMBER) return this.#fatal("not_member", "You no longer have access to this team.");
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#paused) return;
    if (this.#d.network && !this.#d.network.onLine) return this.#setStatus("offline");
    this.#setStatus("reconnecting");
    const delay = backoffDelay(this.#attempt, this.#d.random);
    this.#attempt++;
    this.#clearReconnectTimer();
    this.#timer = this.#d.setTimeout(() => {
      this.#timer = null;
      void this.#connect();
    }, delay);
  }

  #fatal(reason: RealtimeFatal["reason"], message: string): void {
    this.stop();
    this.#setStatus("offline");
    this.#h.onFatal({ reason, message });
  }

  #closeSocket(reason: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#openedAt = null;
    if (socket && socket.readyState < 2) socket.close(CLOSE_NORMAL, reason);
  }

  #clearReconnectTimer(): void {
    if (this.#timer !== null) this.#d.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #clearTimers(): void {
    this.#clearReconnectTimer();
    if (this.#hiddenTimer !== null) this.#d.clearTimeout(this.#hiddenTimer);
    this.#hiddenTimer = null;
  }

  #armHiddenPause(): void {
    if (this.#hiddenTimer !== null) return;
    this.#hiddenTimer = this.#d.setTimeout(() => {
      this.#hiddenTimer = null;
      if (!this.#d.visibility?.hidden) return;
      this.#paused = true;
      this.#clearReconnectTimer();
      this.#closeSocket("hidden");
      this.#generation++;
      this.#setStatus("offline");
    }, HIDDEN_PAUSE_MS);
  }

  /** Resume now with a fresh backoff: the user is looking. */
  #resume(): void {
    this.#paused = false;
    this.#attempt = 0;
    this.#clearReconnectTimer();
    void this.#connect();
  }

  #onVisibility = (): void => {
    if (this.#d.visibility?.hidden) return this.#armHiddenPause();
    if (this.#hiddenTimer !== null) this.#d.clearTimeout(this.#hiddenTimer);
    this.#hiddenTimer = null;
    if (this.#paused) this.#resume();
  };

  #onOnline = (): void => {
    if (this.#paused || this.#socket) return;
    this.#resume();
  };

  #onOffline = (): void => {
    if (!this.#socket) {
      this.#clearReconnectTimer();
      this.#setStatus("offline");
    }
  };
}

/** Why an inspect session ended. `closed`: the socket dropped without an `inspect.end`. */
export type InspectEnd = Extract<InspectFrame, { kind: "inspect.end" }>["reason"] | "closed";

export type InspectHandle = { close(): void };

export function parseInspectFrame(raw: unknown): InspectFrame | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = InspectFrame.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Read-only tail of one worker's log. Single use: one fresh ticket, one socket, no reconnect loop.
 * `onEnd` fires exactly once: on `inspect.end`, when the socket drops, or when no ticket could be had
 * (the ApiError is passed through so the screen can show its message). `close()` ends it silently.
 */
export function connectInspect(
  teamId: string,
  leaseId: string,
  onFrame: (frame: Exclude<InspectFrame, { kind: "inspect.end" }>) => void,
  options: {
    onEnd?: (reason: InspectEnd, error?: ApiError) => void;
    deps?: Partial<Pick<RealtimeDeps, "createSocket" | "expectedOrigin">> & { getTicket?: (teamId: string, leaseId: string) => Promise<RealtimeTicketResponse> };
  } = {},
): InspectHandle {
  const getTicket = options.deps?.getTicket ?? inspectTicket;
  const createSocket = options.deps?.createSocket ?? ((url: string) => new WebSocket(url));
  const expectedOrigin = options.deps && "expectedOrigin" in options.deps ? options.deps.expectedOrigin : process.env.NEXT_PUBLIC_REALTIME_URL || undefined;
  let socket: SocketLike | null = null;
  let done = false;

  const finish = (reason: InspectEnd, error?: ApiError) => {
    if (done) return;
    done = true;
    const s = socket;
    socket = null;
    if (s && s.readyState < 2) s.close(CLOSE_NORMAL, "done");
    options.onEnd?.(reason, error);
  };

  void getTicket(teamId, leaseId).then(
    (ticket) => {
      if (done) return;
      const url = checkTicketUrl(ticket.url, expectedOrigin);
      if (!url) return finish("unavailable");
      try {
        socket = createSocket(url);
      } catch {
        return finish("unavailable");
      }
      const own = socket;
      own.onmessage = (event) => {
        if (socket !== own) return;
        const frame = parseInspectFrame(event.data);
        if (!frame) return;
        if (frame.kind === "inspect.end") return finish(frame.reason);
        onFrame(frame);
      };
      own.onclose = () => {
        if (socket === own) finish("closed");
      };
      own.onerror = () => {};
      own.onopen = () => {};
    },
    (error: unknown) => {
      finish("unavailable", error instanceof ApiError ? error : new ApiError("internal", "Couldn't open this worker's live session. Check your connection and try again.", 0));
    },
  );

  return {
    close() {
      if (done) return;
      done = true;
      const s = socket;
      socket = null;
      if (s && s.readyState < 2) s.close(CLOSE_NORMAL, "closed");
    },
  };
}
