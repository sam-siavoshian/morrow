import type { ServerFrame } from "@morrow/contracts";
import {
  MAX_HISTORY_PAGE,
  TeamRelayObserver,
  channelHistory,
  createRelayReader,
  createSenderKindResolver,
  threadHistory,
  type CursorStore,
  type ObserverHealth,
  type PublishFn,
  type RelayConfig,
  type SenderKindResolver,
  type TeamRelayObserverOptions,
} from "../integrations/relay/index.ts";
import type { Logger } from "../lib/logger.ts";
import type { RuntimeActors } from "./actors.ts";
import type { RuntimeBus } from "./bus.ts";
import { KeyedMutex } from "./keyed.ts";
import type { RelayWorkspaces } from "./relayWorkspaces.ts";

/** Channel shown when a viewer connects or asks without naming one. Every workspace seeds it. */
export const DEFAULT_HISTORY_CHANNEL = "general";
export const HISTORY_PAGE_SIZE = 50;
const CURSOR = /^\d{1,15}$/;

export interface ObserverLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  replaceToken(token: string): Promise<void>;
  health(): ObserverHealth;
}

export interface ObserverManagerOptions {
  workspaces: RelayWorkspaces;
  actors: RuntimeActors;
  publish: PublishFn;
  bus: RuntimeBus;
  log: Logger;
  flushIntervalMs?: number;
  /** Test seam; defaults to a real `TeamRelayObserver`. */
  createObserver?: (options: TeamRelayObserverOptions) => ObserverLike;
}

interface Entry {
  observer: ObserverLike;
  config: RelayConfig;
  token: string;
  senderKinds: SenderKindResolver;
}

type HistoryFrame = Extract<ServerFrame, { kind: "relay.history" }>;

/**
 * At most one `TeamRelayObserver` per team, started for active teams and stopped when idle. The runtime
 * decides what "active" means; this class only starts, stops, renews and serves history pages.
 */
export class ObserverManager {
  readonly #o: ObserverManagerOptions;
  readonly #entries = new Map<string, Entry>();
  /** Start/stop/restart per team never overlap. */
  readonly #locks = new KeyedMutex();
  #closed = false;

  constructor(options: ObserverManagerOptions) {
    this.#o = options;
  }

  teams(): string[] {
    return [...this.#entries.keys()];
  }

  health(teamId: string): ObserverHealth | null {
    return this.#entries.get(teamId)?.observer.health() ?? null;
  }

  /** Starts the team's observer if it is not running. False when Relay is disabled. */
  ensure(teamId: string): Promise<boolean> {
    return this.#locks.run(teamId, async () => {
      if (this.#entries.has(teamId)) return true;
      if (this.#closed) return false;
      const material = await this.#o.workspaces.observerToken(teamId);
      if (!material) return false;
      const entry = this.#build(teamId, material.config, material.token);
      await entry.observer.start();
      if (this.#closed) {
        await entry.observer.stop();
        return false;
      }
      this.#entries.set(teamId, entry);
      return true;
    });
  }

  /** Flushes the cursor and disconnects. */
  stop(teamId: string): Promise<void> {
    return this.#locks.run(teamId, async () => {
      const entry = this.#entries.get(teamId);
      if (!entry) return;
      this.#entries.delete(teamId);
      await entry.observer.stop().catch((error) => this.#o.log.warn("relay observer stop failed", { teamId, error }));
    });
  }

  /**
   * Rotated or revoked tokens do not close a socket that is already open, so after a rotation the
   * observer is stopped and started again with the token now in storage.
   */
  async restart(teamId: string): Promise<void> {
    const wasRunning = this.#entries.has(teamId);
    await this.stop(teamId);
    if (wasRunning) await this.ensure(teamId);
  }

  async stopAll(): Promise<void> {
    this.#closed = true;
    await Promise.all(this.teams().map((teamId) => this.stop(teamId)));
  }

  /** One page of a channel's history, oldest first, read with the observer token. */
  async history(teamId: string, channel: string | null, before: string | null): Promise<HistoryFrame | null> {
    if (!(await this.ensure(teamId))) return null;
    const entry = this.#entries.get(teamId);
    if (!entry) return null;
    const name = channel ?? DEFAULT_HISTORY_CHANNEL;
    const page = await channelHistory({
      config: entry.config,
      observerToken: entry.token,
      senderKinds: entry.senderKinds,
      channel: name,
      before,
      limit: HISTORY_PAGE_SIZE,
    });
    return { kind: "relay.history", teamId, channel: name, data: page.events, nextBefore: page.nextBefore };
  }

  /** A thread's root and newest replies (a task thread), oldest first, read with the observer token. */
  async thread(teamId: string, messageId: string): Promise<HistoryFrame | null> {
    if (!(await this.ensure(teamId))) return null;
    const entry = this.#entries.get(teamId);
    if (!entry) return null;
    const events = await threadHistory({
      config: entry.config,
      observerToken: entry.token,
      senderKinds: entry.senderKinds,
      channel: null,
      messageId,
      limit: MAX_HISTORY_PAGE,
    });
    return { kind: "relay.history", teamId, channel: null, data: events, nextBefore: null, thread: messageId };
  }

  #build(teamId: string, config: RelayConfig, token: string): Entry {
    const log = this.#o.log.child({ teamId });
    const cursorStore: CursorStore = {
      load: async () => {
        const cursor = (await this.#o.actors.getRelay(teamId))?.cursor ?? null;
        return cursor !== null && CURSOR.test(cursor) ? Number(cursor) : null;
      },
      save: (seq) => this.#o.actors.setRelayCursor(teamId, String(seq)),
    };
    const create = this.#o.createObserver ?? ((options: TeamRelayObserverOptions) => new TeamRelayObserver(options));
    const entry: Entry = {
      config,
      token,
      // Built per lookup so a renewed token is picked up; the resolver caches results.
      senderKinds: createSenderKindResolver({ lookup: (name) => createRelayReader(config, entry.token).agentType(name) }),
      observer: create({
        teamId,
        config,
        observerToken: token,
        cursorStore,
        publish: this.#o.publish,
        callbacks: this.#o.bus.callbacksFor(teamId),
        logger: log,
        flushIntervalMs: this.#o.flushIntervalMs,
        onAuthFailure: () => void this.#renew(teamId, entry),
      }),
    };
    return entry;
  }

  /** The stream's token was rejected: mint a fresh one and resume from the cursor. */
  async #renew(teamId: string, entry: Entry): Promise<void> {
    try {
      const observer = await this.#o.workspaces.renewObserver(teamId);
      if (this.#entries.get(teamId) !== entry) return;
      entry.token = observer.token;
      await entry.observer.replaceToken(observer.token);
      this.#o.log.info("relay observer resumed with a renewed token", { teamId });
    } catch (error) {
      this.#o.log.error("relay observer token renewal failed", { teamId, error });
    }
  }
}
