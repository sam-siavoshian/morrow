import {
  createObserverEventSource,
  type ObserverEventSourceOptions,
  type RelayMessagingEvent,
  type RelayMessagingEventsSurface,
} from "@agent-relay/sdk";
import type { RelayEventView, RelayMessageView, ServerFrame } from "@morrow/contracts";
import { silentLogger, type Logger } from "../../lib/logger.ts";
import type { RelayConfig } from "./config.ts";
import { lifecycleToView, markFromEvent, messageEventContext, messageToView, parseLifecycle, senderName, validateView } from "./normalize.ts";
import { createRelayReader, type RelayReader } from "./reader.ts";
import { ExitLedger } from "./reconcile.ts";
import { createSenderKindResolver, type SenderKindResolver } from "./senderKind.ts";

const GAP_CONFIRM_MS = 2000;
const SOCKET_OPEN_WAIT_MS = 10_000;

/**
 * The SDK source starts its backfill read and opens the socket at the same time, and only re-backfills on a
 * reopen. When the read wins (common against a nearby engine), events written between the read and the
 * socket opening are never delivered, and later live events push the cursor past them. Holding the
 * backfill until the socket is open closes that window: anything after the read is buffered from the
 * socket. If the socket never opens we proceed after a bound so backfilled history still flows.
 */
function openGate(baseFetch: typeof globalThis.fetch) {
  let markOpen!: () => void;
  const opened = new Promise<void>((resolve) => (markOpen = resolve));
  const Base = globalThis.WebSocket as unknown as new (...args: unknown[]) => WebSocket;
  class OpenAwareWebSocket extends Base {
    constructor(...args: unknown[]) {
      super(...args);
      this.addEventListener("open", () => markOpen(), { once: true });
    }
  }
  const gatedFetch = async (input: string | URL | Request, init?: RequestInit) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([opened, new Promise<void>((resolve) => (timer = setTimeout(resolve, SOCKET_OPEN_WAIT_MS)))]);
    clearTimeout(timer);
    return baseFetch(input, init);
  };
  return { webSocketImpl: OpenAwareWebSocket as unknown as typeof WebSocket, fetch: gatedFetch as typeof globalThis.fetch };
}

export type RelayEventFrame = Extract<ServerFrame, { kind: "relay.event" }>;
export type RelayHistoryFrame = Extract<ServerFrame, { kind: "relay.history" }>;
export type RelayMarkFrame = Extract<ServerFrame, { kind: "relay.mark" }>;
/** The realtime hub's fan-out, injected so this module does not depend on the hub. */
export type PublishFn = (teamId: string, frame: ServerFrame) => void | Promise<void>;

/** Where the team's stream position lives (`Team.relay.cursor`). */
export interface CursorStore {
  load(): Promise<number | null>;
  save(seq: number): Promise<void>;
}

export interface AgentExitedInfo {
  agentName: string;
  agentId: string;
  nodeId: string | null;
  nodeName: string | null;
  invocationId: string | null;
  reason: string | null;
  at: number;
  seq: number | null;
}
export interface NodeStatusInfo {
  nodeId: string;
  nodeName: string | null;
  status: "online" | "offline";
  reason: string | null;
  at: number;
  seq: number | null;
}
export interface AgentActiveInfo {
  agentName: string;
  agentId: string | null;
  at: number;
  seq: number | null;
}

/**
 * Orchestration hooks (monitor, handoff ACK detection). Called in stream order, one at a time, after the frame
 * is published. Keep them fast: a slow hook delays the stream. A throwing hook is logged and skipped.
 */
export interface ObserverCallbacks {
  onMessage?(message: RelayMessageView, seq: number | null): void | Promise<void>;
  onAgentExited?(event: AgentExitedInfo): void | Promise<void>;
  onAgentActive?(event: AgentActiveInfo): void | Promise<void>;
  onNodeStatus?(event: NodeStatusInfo): void | Promise<void>;
}

export interface TeamRelayObserverOptions {
  teamId: string;
  config: RelayConfig;
  observerToken: string;
  cursorStore: CursorStore;
  publish: PublishFn;
  callbacks?: ObserverCallbacks;
  logger?: Logger;
  /** Defaults to a reader on the observer token (rebuilt by `replaceToken`). */
  reader?: RelayReader;
  senderKinds?: SenderKindResolver;
  exits?: ExitLedger;
  /** Cursor writes happen at most this often (plus once on stop). */
  flushIntervalMs?: number;
  /** Past this many unprocessed events the source is dropped and resumed from the cursor once drained. */
  maxQueue?: number;
  /** The token was rejected (expired, rotated or revoked). Renew it and call `replaceToken`. */
  onAuthFailure?: () => void;
  /**
   * How often to compare our cursor with the log head; 0 disables. The SDK source backfills once and then
   * relies on the socket, so events landing between the backfill read and the socket opening are only
   * recovered on a later reconnect. When the head is ahead and nothing arrived since the last check, we
   * resubscribe from the cursor, which backfills the gap.
   */
  gapCheckIntervalMs?: number;
  createSource?: (options: ObserverEventSourceOptions) => RelayMessagingEventsSurface;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface QueueItem {
  seq: number | null;
  event: RelayMessagingEvent;
}

export interface ObserverHealth {
  running: boolean;
  cursor: number;
  queueDepth: number;
  lastEventAt: number | null;
  lastErrorAt: number | null;
  authFailed: boolean;
  resubscribes: number;
}

/**
 * One per team: the durable event log (backfill from the persisted cursor) plus the live observer socket,
 * normalized to `RelayEventView` and handed to the hub and the orchestration hooks in seq order.
 *
 * Delivery: the cursor only advances past an event after it was fully processed, and it is flushed every
 * `flushIntervalMs` and on `stop()`. A clean restart resumes with no gap and no duplicate; a crash replays
 * at most the events processed since the last flush (frames carry `seq` so the UI can drop repeats).
 */
export class TeamRelayObserver {
  readonly teamId: string;
  readonly exits: ExitLedger;
  readonly #o: TeamRelayObserverOptions;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #maxQueue: number;
  #token: string;
  #reader: RelayReader;
  readonly #ownReader: boolean;
  readonly #kinds: SenderKindResolver;
  #source: RelayMessagingEventsSurface | null = null;
  #generation = 0;
  #armedSeq: number | null = null;
  #queue: QueueItem[] = [];
  #draining = false;
  #drainDone: Promise<void> = Promise.resolve();
  #overflowed = false;
  #running = false;
  #cursor = 0;
  #savedCursor = 0;
  #saving: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastEventAt: number | null = null;
  #lastErrorAt: number | null = null;
  #authFailed = false;
  #resubscribes = 0;
  #gapTimer: ReturnType<typeof setTimeout> | null = null;
  /** A head we already resubscribed for; if the backfill still cannot reach it, retrying is pointless. */
  #gapHead = 0;

  constructor(options: TeamRelayObserverOptions) {
    this.#o = options;
    this.teamId = options.teamId;
    this.#token = options.observerToken;
    this.#log = (options.logger ?? silentLogger).child({ teamId: options.teamId, component: "relay.observer" });
    this.#now = options.now ?? Date.now;
    this.#maxQueue = options.maxQueue ?? 5000;
    this.#ownReader = !options.reader;
    this.#reader = options.reader ?? createRelayReader(options.config, options.observerToken);
    this.#kinds = options.senderKinds ?? createSenderKindResolver({ lookup: (name) => this.#reader.agentType(name) });
    this.exits = options.exits ?? new ExitLedger();
  }

  get cursor(): number {
    return this.#cursor;
  }

  health(): ObserverHealth {
    return {
      running: this.#running,
      cursor: this.#cursor,
      queueDepth: this.#queue.length,
      lastEventAt: this.#lastEventAt,
      lastErrorAt: this.#lastErrorAt,
      authFailed: this.#authFailed,
      resubscribes: this.#resubscribes,
    };
  }

  /** Loads the cursor and connects. A failed cursor load throws: starting from 0 would replay the whole log. */
  async start(): Promise<void> {
    if (this.#running) return;
    const loaded = await this.#o.cursorStore.load();
    if (loaded !== null && (!Number.isSafeInteger(loaded) || loaded < 0)) throw new Error("relay cursor store returned an invalid cursor");
    this.#cursor = this.#savedCursor = loaded ?? 0;
    this.#running = true;
    const interval = Math.max(250, this.#o.flushIntervalMs ?? 5000);
    this.#timer = setInterval(() => void this.#flush(), interval);
    this.#timer.unref?.();
    this.#connect();
    this.#scheduleGapCheck(true);
    this.#log.info("relay.observer.started", { cursor: this.#cursor });
  }

  /** Disconnects, finishes every queued event, then writes the final cursor. */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    if (this.#gapTimer) clearTimeout(this.#gapTimer);
    this.#gapTimer = null;
    await this.#disconnect();
    await this.#drainDone;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    // A periodic save may be mid-flight with an older target; wait it out, then write the final position.
    while (this.#saving) await this.#saving;
    await this.#flush();
    this.#log.info("relay.observer.stopped", { cursor: this.#cursor });
  }

  /** Swap in renewed/rotated token material and resume from the cursor. */
  async replaceToken(observerToken: string): Promise<void> {
    this.#token = observerToken;
    this.#authFailed = false;
    if (this.#ownReader) this.#reader = createRelayReader(this.#o.config, observerToken);
    if (!this.#running) return;
    await this.#disconnect();
    await this.#drainDone;
    if (this.#running) this.#connect();
  }

  #scheduleGapCheck(first = false): void {
    const interval = this.#o.gapCheckIntervalMs ?? 15_000;
    if (!this.#running || interval <= 0) return;
    this.#gapTimer = setTimeout(() => void this.#checkGap(), first ? Math.min(interval, 3000) : interval);
    this.#gapTimer.unref?.();
  }

  async #checkGap(): Promise<void> {
    try {
      const head = await this.#logHead();
      if (head === null || head <= this.#cursor || head <= this.#gapHead || this.#queue.length > 0 || !this.#running) return;
      // Socket delivery takes milliseconds; if the cursor still trails this head after a short pause with
      // nothing queued, those events are not coming on this connection.
      await new Promise((resolve) => setTimeout(resolve, GAP_CONFIRM_MS));
      if (!this.#running || this.#cursor >= head || this.#queue.length > 0 || this.#overflowed) return;
      this.#log.warn("relay.observer.gap_detected", { cursor: this.#cursor, head });
      this.#gapHead = head;
      await this.#disconnect();
      await this.#drainDone;
      if (this.#running) {
        this.#resubscribes++;
        this.#connect();
      }
    } catch (error) {
      this.#log.warn("relay.observer.gap_check_failed", { err: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    } finally {
      this.#scheduleGapCheck();
    }
  }

  async #logHead(): Promise<number | null> {
    const response = await (this.#o.fetch ?? fetch)(`${this.#o.config.baseUrl}/v1/workspace/events?since=${this.#cursor}&limit=1`, {
      headers: { authorization: `Bearer ${this.#token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      this.#onSourceError(new Error(`observer gap check failed: HTTP ${response.status}`), this.#generation);
      return null;
    }
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { data?: { latest_seq?: unknown } } | null;
    const head = body?.data?.latest_seq;
    return typeof head === "number" && Number.isSafeInteger(head) ? head : null;
  }

  #connect(): void {
    const generation = ++this.#generation;
    const create = this.#o.createSource ?? createObserverEventSource;
    const gate = openGate(this.#o.fetch ?? fetch);
    const source = create({
      observerToken: this.#token,
      baseUrl: this.#o.config.baseUrl,
      sinceSeq: this.#cursor,
      webSocketImpl: gate.webSocketImpl,
      fetch: gate.fetch,
      // The source calls onCursor(seq) synchronously right before emitting that seq's event, which is how a
      // normalized message event (which drops the raw frame) gets its seq back.
      onCursor: (seq) => {
        if (generation === this.#generation) this.#armedSeq = seq;
      },
      onError: (error) => this.#onSourceError(error, generation),
    });
    source.on("any", (event) => {
      if (generation !== this.#generation) return;
      const armed = this.#armedSeq;
      this.#armedSeq = null;
      const rawSeq = event.type === "unknown" ? readSeq(event.raw) : null;
      this.#enqueue({ seq: rawSeq ?? armed, event }, generation);
    });
    this.#source = source;
    source.connect();
  }

  async #disconnect(): Promise<void> {
    this.#generation++;
    this.#armedSeq = null;
    const source = this.#source;
    this.#source = null;
    if (source) await source.disconnect().catch((error) => this.#log.warn("relay.observer.disconnect_failed", { err: error }));
  }

  #onSourceError(error: unknown, generation: number): void {
    this.#lastErrorAt = this.#now();
    const message = error instanceof Error ? error.message : String(error);
    this.#log.warn("relay.observer.source_error", { err: message.slice(0, 300) });
    if (generation === this.#generation && !this.#authFailed && /HTTP (401|403)\b/.test(message)) {
      this.#authFailed = true;
      this.#log.error("relay.observer.auth_failed", {});
      try {
        this.#o.onAuthFailure?.();
      } catch (hookError) {
        this.#log.warn("relay.observer.hook_failed", { hook: "onAuthFailure", err: hookError });
      }
    }
  }

  #enqueue(item: QueueItem, generation: number): void {
    if (this.#queue.length >= this.#maxQueue) {
      // Drop this and everything after it, then resume from the last processed seq once drained: the
      // durable log re-delivers them, so nothing is lost and memory stays bounded.
      if (!this.#overflowed) {
        this.#overflowed = true;
        this.#log.warn("relay.observer.queue_overflow", { depth: this.#queue.length, cursor: this.#cursor });
        if (generation === this.#generation) void this.#disconnect();
      }
      return;
    }
    this.#queue.push(item);
    if (!this.#draining) {
      this.#draining = true;
      this.#drainDone = this.#drain();
    }
  }

  async #drain(): Promise<void> {
    for (;;) {
      const item = this.#queue.shift();
      if (!item) break;
      try {
        await this.#process(item);
      } catch (error) {
        this.#log.error("relay.observer.process_failed", { seq: item.seq, err: error });
      }
      if (item.seq !== null && item.seq > this.#cursor) this.#cursor = item.seq;
    }
    this.#draining = false;
    if (this.#overflowed && this.#running) {
      this.#overflowed = false;
      this.#resubscribes++;
      this.#connect();
    }
  }

  async #process({ seq, event }: QueueItem): Promise<void> {
    if (seq !== null && seq <= this.#cursor) return;
    const now = this.#now();
    this.#lastEventAt = now;
    const cb = this.#o.callbacks ?? {};

    const placed = messageEventContext(event);
    if (placed) {
      const kind = await this.#kinds.kindOf(senderName(placed.message));
      const view = validateView(messageToView(placed.message, placed.context, kind, now));
      if (view?.type !== "message") return this.#drop(event.type, seq);
      await this.#publish(view, seq);
      await this.#hook("onMessage", () => cb.onMessage?.(view, seq));
      return;
    }
    // Reactions and read receipts are display only: published for the UI, never handed to orchestration.
    const mark = markFromEvent(event, now);
    if (mark) {
      const frame: RelayMarkFrame = { kind: "relay.mark", teamId: this.teamId, seq, data: mark };
      try {
        await this.#o.publish(this.teamId, frame);
      } catch (error) {
        this.#log.warn("relay.observer.publish_failed", { seq, err: error });
      }
      return;
    }
    if (event.type !== "unknown") return;

    const lifecycle = parseLifecycle(event.raw, now);
    if (!lifecycle) return;
    switch (lifecycle.kind) {
      case "agent.exited": {
        this.exits.record({ agentName: lifecycle.agentName, invocationId: lifecycle.invocationId, reason: lifecycle.reason, at: lifecycle.at });
        const nodeName = lifecycle.nodeId ? await this.#nodeName(lifecycle.nodeId) : null;
        await this.#publishLifecycle(lifecycleToView(lifecycle, nodeName), seq, event.sourceType);
        const info: AgentExitedInfo = { ...lifecycle, nodeName, seq };
        await this.#hook("onAgentExited", () => cb.onAgentExited?.(info));
        return;
      }
      case "node.status": {
        const nodeName = lifecycle.nodeName ?? (await this.#nodeName(lifecycle.nodeId));
        await this.#publishLifecycle(lifecycleToView(lifecycle, nodeName), seq, event.sourceType);
        const info: NodeStatusInfo = { nodeId: lifecycle.nodeId, nodeName, status: lifecycle.status, reason: lifecycle.reason, at: lifecycle.at, seq };
        await this.#hook("onNodeStatus", () => cb.onNodeStatus?.(info));
        return;
      }
      case "agent.status": {
        await this.#publishLifecycle(lifecycleToView(lifecycle, null), seq, event.sourceType);
        if (lifecycle.status === "active") {
          const info: AgentActiveInfo = { agentName: lifecycle.agentName, agentId: lifecycle.agentId, at: lifecycle.at, seq };
          await this.#hook("onAgentActive", () => cb.onAgentActive?.(info));
        }
        return;
      }
    }
  }

  async #nodeName(nodeId: string): Promise<string | null> {
    try {
      return await this.#reader.nodeNameById(nodeId);
    } catch {
      return null;
    }
  }

  async #publishLifecycle(view: RelayEventView | null, seq: number | null, sourceType: string | undefined): Promise<void> {
    const valid = validateView(view);
    if (!valid) return this.#drop(sourceType ?? "unknown", seq);
    await this.#publish(valid, seq);
  }

  async #publish(data: RelayEventView, seq: number | null): Promise<void> {
    const frame: RelayEventFrame = { kind: "relay.event", teamId: this.teamId, seq, data };
    try {
      await this.#o.publish(this.teamId, frame);
    } catch (error) {
      this.#log.warn("relay.observer.publish_failed", { seq, err: error });
    }
  }

  async #hook(name: keyof ObserverCallbacks, run: () => unknown): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.#log.warn("relay.observer.hook_failed", { hook: name, err: error });
    }
  }

  #drop(type: string, seq: number | null): void {
    this.#log.debug("relay.observer.frame_dropped", { type, seq });
  }

  async #flush(): Promise<void> {
    if (this.#saving) return this.#saving;
    const target = this.#cursor;
    if (target === this.#savedCursor) return;
    this.#saving = this.#o.cursorStore
      .save(target)
      .then(() => {
        this.#savedCursor = target;
      })
      .catch((error) => this.#log.warn("relay.observer.cursor_save_failed", { cursor: target, err: error }))
      .finally(() => {
        this.#saving = null;
      });
    return this.#saving;
  }
}

export function relayHistoryFrame(teamId: string, events: RelayEventView[]): RelayHistoryFrame {
  return { kind: "relay.history", teamId, data: events };
}

function readSeq(raw: unknown): number | null {
  const seq = raw && typeof raw === "object" ? (raw as { seq?: unknown }).seq : undefined;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}
