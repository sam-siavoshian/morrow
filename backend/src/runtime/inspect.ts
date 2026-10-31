import { createRequire } from "node:module";
import { Id, WORKER_TERMINAL, type InspectFrame } from "@morrow/contracts";
import { Terminal } from "@xterm/headless";
import type { Server, ServerWebSocket } from "bun";
import type { Freestyle } from "freestyle";
import type { ActorGateway } from "../actors/types.ts";
import {
  FreestyleIntegrationError,
  MAX_FOLLOW_BACKLOG,
  MAX_LOG_TAIL_BYTES,
  followWorkerLog,
  readWorkerLogBytes,
  type FollowEnd,
  type LogFollower,
} from "../integrations/freestyle/index.ts";
import { errorBody } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { Logger } from "../lib/logger.ts";
import type { TicketStore } from "../realtime/tickets.ts";
import type { RuntimeActors } from "./actors.ts";

/**
 * `@xterm/addon-serialize`, loaded without its typings: they import `@xterm/xterm`'s, which pull the DOM lib into
 * the whole backend's type check. This is all of it that is used.
 */
interface Serializer {
  activate(terminal: unknown): void;
  dispose(): void;
  serialize(options?: { scrollback?: number }): string;
}
const { SerializeAddon } = createRequire(import.meta.url)("@xterm/addon-serialize") as { SerializeAddon: new () => Serializer };

export const INSPECT_PATH_PREFIX = "/realtime/inspect/";
const LIVE = new Set(["reserved", "spawning", "running"]);

export interface InspectSocketData {
  inspect: true;
  id: string;
  userId: string;
  teamId: string;
  leaseId: string;
  /** Server-side only: where the worker's log lives. */
  target: Target;
}

type Ws = ServerWebSocket<InspectSocketData>;
type EndReason = Extract<InspectFrame, { kind: "inspect.end" }>["reason"];
type OutputFrame = Extract<InspectFrame, { kind: "inspect.output" }>;

interface Target {
  vmId: string;
  linuxUser: string;
  agentName: string;
}

type Authorization = { ok: true; target: Target } | { ok: false; reason: "not_found" | "forbidden" | "gone" };

export interface InspectHubOptions {
  tickets: TicketStore;
  appOrigin: string;
  actors: Pick<RuntimeActors, "getLease" | "listEnvironments">;
  gateway: Pick<ActorGateway, "getTeam">;
  client: () => Freestyle;
  log: Logger;
  now?: () => number;
  /** Follow the log as it is written (`followWorkerLog`, a Freestyle PTY). Off, or after repeated failures: poll. */
  streaming?: boolean;
  /** Polling: the slowest read, while the log is quiet. */
  pollMs?: number;
  /** Polling: the read interval while output is flowing. Quiet reads back off from here to `pollMs`. */
  fastPollMs?: number;
  /** Lease liveness is checked this often, apart from reads (default: two quiet polls). */
  leaseCheckMs?: number;
  /** Membership and team policy are re-checked this often. */
  recheckMs?: number;
  /** How much of the existing log builds the screen a stream starts from. */
  backlogBytes?: number;
  /** The PTY size workers run in (configure-node.sh pins it). */
  terminal?: { cols: number; rows: number };
  /** Scrollback lines kept per stream on the server, and sent to a viewer that joins. */
  scrollback?: number;
  snapshotScrollback?: number;
  /** New output is sent at most this often, batched. */
  flushMs?: number;
  /** Output that could be the start of a credential is held back until more arrives, or this long. */
  redactHoldMs?: number;
  maxBufferedBytes?: number;
  maxSocketsPerLease?: number;
  /** Streams (live leases being viewed) at once on this server; each holds a screen in memory. */
  maxLeases?: number;
  /** Consecutive read failures before the stream gives up. */
  maxFailures?: number;
  /** Follower failures in a row before falling back to polling, and how long to poll before streaming again. */
  maxStreamFailures?: number;
  streamRetryMs?: number;
  /** Test seams. */
  follow?: typeof followWorkerLog;
  readBytes?: typeof readWorkerLogBytes;
}

type Options = Required<InspectHubOptions>;

export function isInspectSocket(data: unknown): data is InspectSocketData {
  return !!data && typeof data === "object" && (data as { inspect?: unknown }).inspect === true;
}

/**
 * `/realtime/inspect/:leaseId`: a read-only view of one worker's terminal. Relay workers run in the broker's own
 * PTYs, not in Freestyle terminal sessions, so this follows the worker's log file (the broker writes the PTY output
 * there): streamed as it is written by a follower in a Freestyle PTY (`followWorkerLog`), or polled
 * (`readWorkerLogBytes`, adaptive: fast while output flows, backing off when quiet) when streaming fails. Both run a
 * fixed VM script as the broker's own Linux user.
 *
 * Each stream feeds a headless terminal of the worker's PTY size, so a viewer who joins late gets the current screen
 * (and recent scrollback) instead of a raw tail that starts mid-escape and paints garbage until the next full
 * repaint. Everything is redacted (`StreamRedactor`, holding back a tail that could be a credential split across
 * reads) before it reaches the screen or a socket, and again as each frame is sent.
 *
 * Authorization happens before the upgrade: Origin, a single-use inspect ticket bound to user + team + lease,
 * membership, a live lease in that team, and `policy.allowInspect`. It is re-checked while the socket is open; the
 * stream ends when the lease does. One stream per lease is shared by every viewer and stops with its last viewer.
 * Client messages are dropped.
 */
export class InspectHub {
  readonly #o: Options;
  readonly #streams = new Map<string, LeaseStream>();
  #closing = false;

  constructor(options: InspectHubOptions) {
    const pollMs = options.pollMs ?? 1_500;
    this.#o = {
      ...options,
      now: options.now ?? Date.now,
      streaming: options.streaming ?? true,
      pollMs,
      fastPollMs: Math.min(options.fastPollMs ?? 250, pollMs),
      leaseCheckMs: options.leaseCheckMs ?? 2 * pollMs,
      recheckMs: options.recheckMs ?? 15_000,
      backlogBytes: Math.min(options.backlogBytes ?? MAX_LOG_TAIL_BYTES, MAX_LOG_TAIL_BYTES, MAX_FOLLOW_BACKLOG),
      terminal: options.terminal ?? WORKER_TERMINAL,
      scrollback: options.scrollback ?? 500,
      snapshotScrollback: options.snapshotScrollback ?? 300,
      flushMs: options.flushMs ?? 16,
      redactHoldMs: options.redactHoldMs ?? 100,
      maxBufferedBytes: options.maxBufferedBytes ?? 1024 * 1024,
      maxSocketsPerLease: options.maxSocketsPerLease ?? 20,
      maxLeases: options.maxLeases ?? 100,
      maxFailures: options.maxFailures ?? 10,
      maxStreamFailures: options.maxStreamFailures ?? 3,
      streamRetryMs: options.streamRetryMs ?? 5 * 60_000,
      follow: options.follow ?? followWorkerLog,
      readBytes: options.readBytes ?? readWorkerLogBytes,
    };
  }

  /** For health output: viewed leases, sockets, and how each lease is being read. */
  stats(): { leases: number; sockets: number; streaming: number; polling: number } {
    let sockets = 0;
    let streaming = 0;
    for (const s of this.#streams.values()) {
      sockets += s.sockets.size;
      if (s.mode === "stream") streaming += 1;
    }
    return { leases: this.#streams.size, sockets, streaming, polling: this.#streams.size - streaming };
  }

  async handleUpgrade(req: Request, server: Server<InspectSocketData>): Promise<Response | undefined> {
    const reject = (status: number, code: Parameters<typeof errorBody>[0], message: string) =>
      Response.json(errorBody(code, message), { status, headers: { "cache-control": "no-store" } });
    if (this.#closing) return reject(503, "dependency_unavailable", "Server is restarting.");
    if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return reject(400, "bad_request", "Expected a WebSocket upgrade.");
    // Origin first, so a cross-site page cannot burn a user's ticket.
    if (req.headers.get("origin") !== this.#o.appOrigin) return reject(403, "forbidden", "Origin not allowed.");
    const url = new URL(req.url);
    const leaseId = decodeURIComponent(url.pathname.slice(INSPECT_PATH_PREFIX.length));
    if (!Id.safeParse(leaseId).success) return reject(404, "not_found", "Not found.");
    const ticket = this.#o.tickets.consume(url.searchParams.get("ticket"), "inspect");
    if (!ticket || ticket.leaseId !== leaseId) return reject(401, "unauthenticated", "Invalid or expired inspect ticket.");

    let auth: Authorization;
    try {
      auth = await this.#authorize(ticket.userId, ticket.teamId, leaseId);
    } catch (error) {
      this.#o.log.warn("inspect authorization failed", { teamId: ticket.teamId, leaseId, error });
      return reject(503, "dependency_unavailable", "Try again shortly.");
    }
    if (!auth.ok) {
      if (auth.reason === "forbidden") return reject(403, "forbidden", "You cannot inspect this worker.");
      return reject(404, "not_found", "This worker is not running.");
    }
    const existing = this.#streams.get(streamKey(ticket.teamId, leaseId));
    if (existing && existing.sockets.size >= this.#o.maxSocketsPerLease) return reject(429, "rate_limited", "Too many viewers on this worker.");
    if (!existing && this.#streams.size >= this.#o.maxLeases) return reject(503, "dependency_unavailable", "Too many live views on this server. Try again shortly.");
    const data: InspectSocketData = { inspect: true, id: newId("sock"), userId: ticket.userId, teamId: ticket.teamId, leaseId, target: auth.target };
    if (server.upgrade(req, { data })) return undefined;
    return reject(400, "bad_request", "WebSocket upgrade failed.");
  }

  open(ws: Ws): void {
    if (this.#closing) return ws.close(1001, "unavailable");
    const k = streamKey(ws.data.teamId, ws.data.leaseId);
    let stream = this.#streams.get(k);
    if (!stream) {
      stream = new LeaseStream(this.#o, ws.data.teamId, ws.data.leaseId, ws.data.target, {
        send: (socket, frame) => this.#send(socket, frame),
        endAll: (s, reason) => this.#endAll(s, reason),
        check: (s) => this.#stillAllowed(s),
      });
      this.#streams.set(k, stream);
      stream.start();
    }
    stream.sockets.add(ws);
    const { cols, rows } = this.#o.terminal;
    this.#send(ws, { kind: "inspect.hello", leaseId: ws.data.leaseId, agentName: ws.data.target.agentName, cols, rows });
    stream.join(ws);
  }

  /** Read-only: everything the browser sends is ignored. */
  message(_ws: Ws, _message: string | Buffer): void {}

  close(ws: Ws): void {
    const stream = this.#streams.get(streamKey(ws.data.teamId, ws.data.leaseId));
    if (!stream) return;
    stream.leave(ws);
    if (stream.sockets.size === 0) this.#stop(stream);
  }

  /** Ends the user's inspect sockets at once: in `teamId` (member removed) or every team (null, sign-out everywhere). */
  closeUser(teamId: string | null, userId: string): void {
    for (const stream of this.#streams.values()) {
      if (teamId !== null && stream.teamId !== teamId) continue;
      for (const ws of stream.sockets) if (ws.data.userId === userId) this.#end(ws, "not_authorized");
    }
  }

  shutdown(): void {
    this.#closing = true;
    for (const stream of [...this.#streams.values()]) {
      for (const ws of stream.sockets) this.#end(ws, "server_shutdown", 1001);
      this.#stop(stream);
    }
  }

  async #authorize(userId: string, teamId: string, leaseId: string): Promise<Authorization> {
    const team = await this.#o.gateway.getTeam(teamId);
    if (!team || !team.members.some((m) => m.userId === userId)) return { ok: false, reason: "not_found" };
    if (!team.policy.allowInspect) return { ok: false, reason: "forbidden" };
    const lease = await this.#o.actors.getLease(teamId, leaseId);
    if (!lease || !LIVE.has(lease.state)) return { ok: false, reason: "gone" };
    const env = (await this.#o.actors.listEnvironments(teamId)).find((e) => e.nodeName === lease.nodeName && e.phase !== "disconnected");
    if (!env?.freestyleVmId || !env.linuxUser) return { ok: false, reason: "gone" };
    return { ok: true, target: { vmId: env.freestyleVmId, linuxUser: env.linuxUser, agentName: lease.agentName } };
  }

  /** Lease liveness on every check; membership and policy every `recheckMs`. Ends streams that lost access. */
  async #stillAllowed(stream: LeaseStream): Promise<boolean> {
    const lease = await this.#o.actors.getLease(stream.teamId, stream.leaseId);
    if (stream.stopped) return false;
    if (!lease || !LIVE.has(lease.state)) {
      this.#endAll(stream, "lease_ended");
      return false;
    }
    if (this.#o.now() - stream.lastAuthAt < this.#o.recheckMs) return true;
    stream.lastAuthAt = this.#o.now();
    const team = await this.#o.gateway.getTeam(stream.teamId);
    if (stream.stopped) return false;
    if (!team?.policy.allowInspect) {
      this.#endAll(stream, "not_authorized");
      return false;
    }
    const members = new Set(team.members.map((m) => m.userId));
    for (const ws of stream.sockets) if (!members.has(ws.data.userId)) this.#end(ws, "not_authorized");
    return stream.sockets.size > 0;
  }

  #send(ws: Ws, frame: InspectFrame): void {
    if (ws.readyState !== 1) return;
    // The last gate: output was redacted before the screen saw it; this also covers a credential a TUI drew in pieces.
    const safe = frame.kind === "inspect.output" ? { ...frame, data: redactSecrets(frame.data) } : frame;
    const status = ws.send(JSON.stringify(safe));
    if (status === 0 || ws.getBufferedAmount() > this.#o.maxBufferedBytes) ws.close(1013, "slow consumer");
  }

  #end(ws: Ws, reason: EndReason, code = 1000): void {
    this.#send(ws, { kind: "inspect.end", reason });
    ws.close(code, reason);
  }

  #endAll(stream: LeaseStream, reason: EndReason): void {
    for (const ws of [...stream.sockets]) this.#end(ws, reason);
    this.#stop(stream);
  }

  #stop(stream: LeaseStream): void {
    stream.stop();
    const k = streamKey(stream.teamId, stream.leaseId);
    if (this.#streams.get(k) === stream) this.#streams.delete(k);
  }
}

interface StreamHooks {
  send(ws: Ws, frame: InspectFrame): void;
  endAll(stream: LeaseStream, reason: EndReason): void;
  check(stream: LeaseStream): Promise<boolean>;
}

/** How the next bytes relate to what the screen has: `restart` clears it first, `partial` starts mid-file. */
interface Continuity {
  restart: boolean;
  partial: boolean;
}

/**
 * One viewed lease: reads the log (follower or polls), keeps the screen, and fans output out to its sockets.
 * Memory per stream is bounded: the screen (`scrollback` lines), at most `flushMs` of batched output, a credential
 * hold of at most `MAX_REDACT_HOLD` characters, and what arrives while a joining viewer's snapshot is taken.
 */
class LeaseStream {
  readonly sockets = new Set<Ws>();
  /** Sockets that have their snapshot and get every new frame. */
  readonly #live = new Set<Ws>();
  /**
   * Sockets waiting for their snapshot: null until the first read built the screen, then the output that arrived
   * since the snapshot was asked for.
   */
  readonly #joining = new Map<Ws, OutputFrame[] | null>();
  mode: "stream" | "poll" = "poll";
  stopped = false;
  lastAuthAt: number;

  readonly #o: Options;
  readonly #hooks: StreamHooks;
  readonly #term: Terminal;
  readonly #serializer: Serializer = new SerializeAddon();
  readonly #redactor = new StreamRedactor();
  #decoder = new TextDecoder("utf-8", { fatal: false });
  /** The next log byte the screen is waiting for; null before the first read. */
  #offset: number | null = null;
  /** After a rotated or vanished log: the next bytes start a new screen. */
  #restartNext = false;
  #next: Continuity | null = null;
  #primed = false;
  #primeAt: number | null = null;
  #pending = "";
  #pendingReset = false;
  #follower: LogFollower | null = null;
  /** Bumped per follower, so a late event from an older one is ignored. */
  #generation = 0;
  #streamFailures = 0;
  #streamAfter = 0;
  #readFailures = 0;
  #pollDelay: number;
  #checking = false;
  #readTimer: ReturnType<typeof setTimeout> | null = null;
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #holdTimer: ReturnType<typeof setTimeout> | null = null;
  #primeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    options: Options,
    readonly teamId: string,
    readonly leaseId: string,
    readonly target: Target,
    hooks: StreamHooks,
  ) {
    this.#o = options;
    this.#hooks = hooks;
    this.lastAuthAt = options.now();
    this.#pollDelay = options.fastPollMs;
    this.#term = new Terminal({ cols: options.terminal.cols, rows: options.terminal.rows, scrollback: options.scrollback, allowProposedApi: true });
    this.#term.loadAddon(this.#serializer);
  }

  start(): void {
    this.#checkTimer = setInterval(() => void this.#check(), this.#o.leaseCheckMs);
    this.#checkTimer.unref?.();
    // A viewer never waits long for a first read that hangs, or for a log that does not exist yet.
    this.#primeTimer = setTimeout(() => this.#prime(), 2_500);
    this.#primeTimer.unref?.();
    if (this.#o.streaming) void this.#startFollow();
    else this.#startPoll();
  }

  join(ws: Ws): void {
    this.#joining.set(ws, null);
    if (this.#primed) this.#snapshot(ws);
  }

  leave(ws: Ws): void {
    this.sockets.delete(ws);
    this.#live.delete(ws);
    this.#joining.delete(ws);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of [this.#readTimer, this.#flushTimer, this.#holdTimer, this.#primeTimer]) if (timer) clearTimeout(timer);
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#readTimer = this.#flushTimer = this.#holdTimer = this.#primeTimer = this.#checkTimer = null;
    this.#generation += 1;
    const follower = this.#follower;
    this.#follower = null;
    if (follower) void follower.stop().catch(() => {});
    this.#live.clear();
    this.#joining.clear();
    this.#pending = "";
    this.#term.dispose();
  }

  // ---- reading: follower first, polling as the fallback

  async #startFollow(): Promise<void> {
    this.mode = "stream";
    const generation = ++this.#generation;
    const current = () => generation === this.#generation && !this.stopped;
    let ended = false;
    const { vmId, linuxUser, agentName } = this.target;
    try {
      const follower = await this.#o.follow({
        client: this.#o.client(),
        vmId,
        linuxUser,
        agentName,
        start: this.#offset,
        backlogBytes: this.#o.backlogBytes,
        onStart: (at) => current() && this.#onStart(at),
        onBytes: (bytes, offset) => current() && this.#onBytes(bytes, offset),
        onEnd: (end) => {
          ended = true;
          if (current()) this.#onFollowEnd(end);
        },
      });
      if (current() && !ended) this.#follower = follower;
      else if (!ended) void follower.stop().catch(() => {});
    } catch (error) {
      if (current()) this.#onFollowEnd({ reason: "closed", detail: error instanceof Error ? error.message : "open failed" });
    }
  }

  #onStart(at: { start: number; size: number }): void {
    if (this.stopped) return;
    if (this.#offset === null) {
      this.#next = { restart: this.#restartNext, partial: at.start > 0 };
      this.#restartNext = false;
      this.#primeAt = at.size;
    } else if (at.start !== this.#offset) {
      // The log shrank, or more was written than the follower would replay: the screen starts over.
      this.#next = { restart: true, partial: at.start > 0 };
    }
    this.#offset = at.start;
    this.#streamFailures = 0;
    if (!this.#primed && this.#primeAt !== null && this.#offset >= this.#primeAt) this.#prime();
  }

  #onBytes(bytes: Uint8Array, offset: number): void {
    if (this.stopped) return;
    this.#ingest(bytes, this.#next ?? { restart: false, partial: false });
    this.#next = null;
    this.#offset = offset + bytes.byteLength;
    if (!this.#primed && this.#primeAt !== null && this.#offset >= this.#primeAt) this.#prime();
  }

  #onFollowEnd(end: FollowEnd): void {
    this.#follower = null;
    if (this.stopped) return;
    const ctx = { teamId: this.teamId, leaseId: this.leaseId, reason: end.reason, detail: end.detail };
    if (end.reason === "unsafe") {
      this.#o.log.warn("inspect log refused", ctx);
      return this.#hooks.endAll(this, "unavailable");
    }
    if (end.reason === "lifetime") return void this.#startFollow();
    if (end.reason === "rotated" || end.reason === "missing") {
      this.#offset = null;
      this.#restartNext = true;
      return this.#later(() => void this.#startFollow(), 500);
    }
    this.#streamFailures += 1;
    if (this.#streamFailures >= this.#o.maxStreamFailures) {
      this.#o.log.warn("inspect stream failing, polling instead", { ...ctx, failures: this.#streamFailures, retryInMs: this.#o.streamRetryMs });
      this.#streamFailures = 0;
      this.#streamAfter = this.#o.now() + this.#o.streamRetryMs;
      return this.#startPoll();
    }
    this.#o.log.info("inspect stream ended, reopening", { ...ctx, failures: this.#streamFailures });
    this.#later(() => void this.#startFollow(), 500 * this.#streamFailures);
  }

  #startPoll(): void {
    this.mode = "poll";
    this.#pollDelay = this.#o.fastPollMs;
    this.#later(() => void this.#poll(), 0);
  }

  async #poll(): Promise<void> {
    if (this.stopped) return;
    if (this.#o.streaming && this.#streamAfter > 0 && this.#o.now() >= this.#streamAfter) {
      this.#streamAfter = 0;
      return void this.#startFollow();
    }
    let flowing = false;
    try {
      const { vmId, linuxUser, agentName } = this.target;
      const read = await this.#o.readBytes({
        client: this.#o.client(),
        vmId,
        linuxUser,
        agentName,
        maxBytes: this.#offset === null ? this.#o.backlogBytes : MAX_LOG_TAIL_BYTES,
      });
      this.#readFailures = 0;
      if (this.stopped) return;
      if (read) {
        const { bytes, size } = read;
        const partial = size > bytes.byteLength;
        if (this.#offset === null) {
          this.#ingest(bytes, { restart: this.#restartNext, partial });
          this.#restartNext = false;
          flowing = bytes.byteLength > 0;
        } else if (size < this.#offset) {
          this.#ingest(bytes, { restart: true, partial });
          flowing = true;
        } else if (size > this.#offset) {
          const delta = size - this.#offset;
          // More is new than one read holds: the gap is skipped, so the screen starts over.
          if (delta > bytes.byteLength) this.#ingest(bytes, { restart: true, partial: true });
          else this.#ingest(bytes.subarray(bytes.byteLength - delta), { restart: false, partial: false });
          flowing = true;
        }
        this.#offset = size;
      }
      this.#prime();
    } catch (error) {
      if (this.stopped) return;
      this.#readFailures += 1;
      const unsafe = error instanceof FreestyleIntegrationError && error.kind === "unsafe_path";
      this.#o.log.warn("inspect log read failed", { teamId: this.teamId, leaseId: this.leaseId, failures: this.#readFailures, error });
      if (unsafe || this.#readFailures >= this.#o.maxFailures) return this.#hooks.endAll(this, "unavailable");
    }
    this.#pollDelay = flowing ? this.#o.fastPollMs : Math.min(this.#o.pollMs, this.#pollDelay * 2);
    this.#later(() => void this.#poll(), this.#pollDelay);
  }

  async #check(): Promise<void> {
    if (this.stopped || this.#checking) return;
    this.#checking = true;
    try {
      await this.#hooks.check(this);
    } catch (error) {
      this.#o.log.warn("inspect access check failed", { teamId: this.teamId, leaseId: this.leaseId, error });
    } finally {
      this.#checking = false;
    }
  }

  #later(fn: () => void, ms: number): void {
    if (this.stopped) return;
    if (this.#readTimer) clearTimeout(this.#readTimer);
    this.#readTimer = setTimeout(() => {
      this.#readTimer = null;
      if (!this.stopped) fn();
    }, ms);
    this.#readTimer.unref?.();
  }

  // ---- the screen and the sockets

  #ingest(bytes: Uint8Array, at: Continuity): void {
    if (at.restart) {
      // What was held belongs to the old screen; release it there, then start over.
      const held = this.#redactor.flush();
      if (held) this.#emit(held);
      this.#redactor.reset();
      this.#decoder = new TextDecoder("utf-8", { fatal: false });
      this.#emitReset();
    }
    let text = this.#decoder.decode(bytes, { stream: true });
    if (at.partial) {
      // Started mid-file: skip to the first line or escape sequence, never mid-sequence.
      const starts = [text.indexOf("\n"), text.indexOf("\x1b")].filter((i) => i >= 0);
      const cut = starts.length > 0 ? Math.min(...starts) : text.length;
      text = text.slice(text[cut] === "\n" ? cut + 1 : cut);
    }
    const out = this.#redactor.push(text);
    if (out) this.#emit(out);
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    if (this.#redactor.holding) {
      this.#holdTimer = setTimeout(() => {
        this.#holdTimer = null;
        const held = this.#redactor.flush();
        if (held && !this.stopped) this.#emit(held);
      }, this.#o.redactHoldMs);
      this.#holdTimer.unref?.();
    }
  }

  #emit(text: string): void {
    if (this.stopped) return;
    this.#term.write(text);
    this.#pending += text;
    for (const queue of this.#joining.values()) {
      if (!queue) continue;
      const last = queue.at(-1);
      if (last && !last.reset) last.data += text;
      else queue.push({ kind: "inspect.output", data: text, reset: false });
    }
    if (!this.#flushTimer) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = null;
        this.#flush();
      }, this.#o.flushMs);
      this.#flushTimer.unref?.();
    }
  }

  #emitReset(): void {
    this.#flush();
    // Through the write queue (RIS), so it lands after everything written before it.
    this.#term.write("\x1bc");
    this.#pendingReset = true;
    for (const queue of this.#joining.values()) queue?.push({ kind: "inspect.output", data: "", reset: true });
  }

  #flush(): void {
    if (!this.#pending && !this.#pendingReset) return;
    const frame: OutputFrame = { kind: "inspect.output", data: this.#pending, reset: this.#pendingReset };
    this.#pending = "";
    this.#pendingReset = false;
    for (const ws of this.#live) this.#hooks.send(ws, frame);
  }

  #prime(): void {
    if (this.#primed || this.stopped) return;
    this.#primed = true;
    if (this.#primeTimer) clearTimeout(this.#primeTimer);
    this.#primeTimer = null;
    for (const ws of this.#joining.keys()) this.#snapshot(ws);
  }

  /**
   * A joining viewer gets the screen as it is once everything written so far is parsed, then whatever arrived while
   * that happened, then joins the live fan-out. xterm runs a write callback before parsing the next write, so the
   * snapshot holds exactly the output emitted before this call, and the queue exactly what came after.
   */
  #snapshot(ws: Ws): void {
    this.#joining.set(ws, []);
    this.#term.write("", () => {
      const queue = this.#joining.get(ws);
      if (this.stopped || !queue || !this.sockets.has(ws)) return;
      // Batched output the live viewers have not been sent yet is already in this snapshot: send it to them first.
      this.#flush();
      this.#hooks.send(ws, { kind: "inspect.output", data: this.#serializer.serialize({ scrollback: this.#o.snapshotScrollback }), reset: true });
      for (const frame of queue) this.#hooks.send(ws, frame);
      this.#joining.delete(ws);
      this.#live.add(ws);
    });
  }
}

/** The longest tail held back as a possible credential; beyond it the head is released (best effort). */
export const MAX_REDACT_HOLD = 4096;
/** Characters a credential or an escape sequence right before one can be made of. */
const HOLD_CHAR = /[A-Za-z0-9_.\-[;:?\x1b]/;
/** A JSON member that may still be naming or filling a credential field: `"access_token": "abc`. */
const FIELD_TAIL = /^"[A-Za-z_]{0,40}(?:"\s{0,8}(?::\s{0,8}(?:"[^"\n]{0,2048})?)?)?$/;

/**
 * `redactSecrets` for a stream that arrives in pieces: a credential split across two reads would otherwise slip
 * through as two harmless-looking halves. `push` releases (redacted) everything up to a tail that could still be the
 * start of a credential (a run of token characters, the escape sequence right before it, or an open JSON credential
 * member) and holds that tail until more arrives. `flush` releases the tail when nothing more came in time, masking
 * a credential it may only be the start of, and keeps it as context: when the rest arrives, it is redacted together
 * with what was already shown, and only the part not yet shown is sent. `reset` drops that context (a new screen).
 */
export class StreamRedactor {
  /** Raw text not yet released in full; its first `#shownRaw` characters were already sent, as `#shown`. */
  #held = "";
  #shownRaw = 0;
  #shown = "";

  /** True while some of the held text has not been sent at all. */
  get holding(): boolean {
    return this.#held.length > this.#shownRaw;
  }

  push(text: string): string {
    const all = this.#held + text;
    let cut = all.length;
    while (cut > 0 && HOLD_CHAR.test(all[cut - 1]!)) cut -= 1;
    // An open JSON member: try the last few quotes, earliest first, so the key stays with its value.
    const window = Math.max(0, all.length - 2_200);
    const quotes: number[] = [];
    for (let i = all.length - 1; i >= window && quotes.length < 4; i -= 1) if (all[i] === '"') quotes.unshift(i);
    for (const q of quotes) {
      if (q < cut && FIELD_TAIL.test(all.slice(q))) {
        cut = q;
        break;
      }
    }
    // Never release a credential member's value without the quote that closes it (held as a possible new member).
    const open = OPEN_FIELD_RE.exec(all.slice(0, cut));
    if (open) cut = open.index;
    // Bounded: at most MAX_REDACT_HOLD unsent characters (plus the shown context, itself at most that).
    if (all.length - Math.max(cut, this.#shownRaw) > MAX_REDACT_HOLD) cut = all.length - MAX_REDACT_HOLD;
    if (cut <= this.#shownRaw) {
      // Everything new may still be the same credential as the shown context: keep holding all of it.
      this.#held = all;
      return "";
    }
    const out = this.#release(all.slice(0, cut), false);
    this.#held = all.slice(cut);
    return out;
  }

  /** Nothing more came in time: send the held tail, masked, and keep it as context for what follows. */
  flush(): string {
    if (!this.holding) return "";
    const out = this.#release(this.#held, true);
    this.#shownRaw = this.#held.length;
    this.#shown = maskOpenTail(redactSecrets(this.#held));
    return out;
  }

  reset(): void {
    this.#held = this.#shown = "";
    this.#shownRaw = 0;
  }

  #release(raw: string, timed: boolean): string {
    let out = redactSecrets(raw);
    if (timed) out = maskOpenTail(out);
    const shown = this.#shown;
    const shownRaw = this.#shownRaw;
    this.#shown = "";
    this.#shownRaw = 0;
    if (!shown) return out;
    // Redacted with its context, the text normally starts with what was already sent; send only the rest.
    if (out.startsWith(shown)) return out.slice(shown.length);
    // It does not (the context completed a credential differently): mask the run that continues it.
    const rest = redactSecrets(raw.slice(shownRaw));
    return rest.replace(/^[A-Za-z0-9_.\-]+/, "[redacted]");
  }
}

/**
 * What a held tail may only be the start of, masked: an open credential member's value, the start of a JWT, or a
 * credential prefix with nothing after it yet. Any of them completes in the next piece, which is checked against it.
 */
function maskOpenTail(text: string): string {
  return text
    .replace(OPEN_FIELD_RE, "$1[redacted]")
    .replace(OPEN_JWT_RE, "eyJ[redacted]")
    .replace(OPEN_PREFIX_RE, "$1[redacted]");
}

/**
 * Relay, GitHub, Anthropic and OpenAI credential shapes, plus JWTs (Codex's login is one). A worker or a test
 * prints whatever its environment and home hold, and inspect and the Tests tab show that to every member. A prefix
 * counts at a word start or right after an escape sequence (a TUI colours a value: `ESC[1msk-ant-...`). Best effort
 * on its own: live inspect runs it through `StreamRedactor`, so a token split across reads is caught too.
 */
const B = String.raw`(?:(?<![A-Za-z0-9_])|(?<=\x1b\[[0-9;:?]*[A-Za-z]))`;
const SECRET_RE = new RegExp(
  String.raw`(rk_live_|at_live_|nt_live_|ot_live_|${B}gh[opusr]_|${B}github_pat_|${B}sk-ant-|${B}sk-(?=[A-Za-z0-9_-]{20})|${B}rt_(?=[A-Za-z0-9_-]{16}))[A-Za-z0-9_-]+`,
  "g",
);
const JWT_RE = new RegExp(String.raw`${B}eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*`, "g");
/** CLI login files (`~/.codex/auth.json`, `~/.claude/.credentials.json`) name their tokens; mask any value they name. */
const TOKEN_FIELD_RE = /("(?:access_?token|refresh_?token|id_?token|api_?key|accessToken|refreshToken|idToken|apiKey|OPENAI_API_KEY)"\s*:\s*")[^"]*(")/gi;
const OPEN_FIELD_RE = /("(?:access_?token|refresh_?token|id_?token|api_?key|accessToken|refreshToken|idToken|apiKey|OPENAI_API_KEY)"\s*:\s*")[^"\n]*$/i;
const OPEN_JWT_RE = new RegExp(String.raw`${B}eyJ[A-Za-z0-9_.-]*$`);
const OPEN_PREFIX_RE = new RegExp(String.raw`((?:rk|at|nt|ot)_live_|${B}gh[opusr]_|${B}github_pat_|${B}sk-ant-|${B}sk-|${B}rt_)$`);

export function redactSecrets(text: string): string {
  return text.replace(TOKEN_FIELD_RE, "$1[redacted]$2").replace(JWT_RE, "eyJ[redacted]").replace(SECRET_RE, "$1[redacted]");
}

function streamKey(teamId: string, leaseId: string): string {
  return `${teamId}/${leaseId}`;
}
