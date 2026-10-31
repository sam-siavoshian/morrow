import { ClientFrame, ServerFrame, type Role, type WorkforceView } from "@morrow/contracts";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { ActorGateway, TeamRecord } from "../actors/types.ts";
import { toTeamView } from "../actors/views.ts";
import { errorBody } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { Logger } from "../lib/logger.ts";
import { ActorSubscription } from "./actorSubscription.ts";
import type { TicketStore } from "./tickets.ts";

export interface SocketData {
  id: string;
  userId: string;
  teamId: string;
  /** Inbound frame budget (token bucket). */
  tokens: number;
  tokensAt: number;
}

type Ws = ServerWebSocket<SocketData>;

/** What a viewer-scoped handler gets: who is asking, and a way to answer only them. */
export interface ViewerContext {
  teamId: string;
  userId: string;
  send(frame: ServerFrame): boolean;
}

type ClientFrameOf<K extends ClientFrame["kind"]> = Extract<ClientFrame, { kind: K }>;
type ClientFrameHandler<K extends ClientFrame["kind"]> = (ctx: ViewerContext, frame: ClientFrameOf<K>) => void | Promise<void>;

export const CLOSE = {
  goingAway: 1001,
  policy: 1008,
  tryAgainLater: 1013,
  notMember: 4003,
} as const;

export interface RealtimeHubOptions {
  actors: Pick<ActorGateway, "prepareSocket" | "mapTeamState" | "mapWorkforceState">;
  tickets: TicketStore;
  appOrigin: string;
  log: Logger;
  now?: () => number;
  /** Bytes queued on one socket before it is treated as a slow consumer and closed. */
  maxBufferedBytes?: number;
  maxSocketsPerUser?: number;
  inboundBurst?: number;
  inboundPerSecond?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** How long a new viewer waits for the first team snapshot before it is asked to retry. */
  snapshotTimeoutMs?: number;
}

class TeamChannel {
  readonly sockets = new Set<Ws>();
  /** Sockets whose membership was confirmed against a team snapshot. Only these get team data. */
  readonly admitted = new Set<Ws>();
  team: TeamRecord | null = null;
  /** Resolves on the first team snapshot. */
  readonly teamReady: Promise<void>;
  markTeamReady!: () => void;
  workforce: WorkforceView | null = null;
  /** Serialized team.view per viewer role, rebuilt on each team update. */
  teamFrames = new Map<Role, string>();
  workforceFrame: string | null = null;
  subscriptions: ActorSubscription[] = [];
  constructor(readonly teamId: string) {
    this.teamReady = new Promise((resolve) => (this.markTeamReady = resolve));
  }
}

/**
 * Per-team fan-out for /realtime. The backend holds one Team and one TeamWorkforce actor socket per team
 * with viewers, forwards their emitted state as `team.view` / `workforce.view`, and tears both down when
 * the last viewer leaves. Other modules push frames with `publish(teamId, frame)`.
 */
export class RealtimeHub {
  readonly #o: Required<RealtimeHubOptions>;
  readonly #channels = new Map<string, TeamChannel>();
  readonly #socketsByUser = new Map<string, Set<Ws>>();
  readonly #clientHandlers = new Map<string, ClientFrameHandler<never>>();
  readonly #joinHandlers: Array<(ctx: ViewerContext) => void | Promise<void>> = [];
  readonly #workforceHandlers: Array<(teamId: string, prev: WorkforceView | null, next: WorkforceView) => void> = [];
  /** Per socket: resolves true once membership is confirmed, false when the socket was refused. */
  readonly #admission = new WeakMap<Ws, Promise<boolean>>();
  #closing = false;

  constructor(options: RealtimeHubOptions) {
    this.#o = {
      ...options,
      now: options.now ?? Date.now,
      maxBufferedBytes: options.maxBufferedBytes ?? 1024 * 1024,
      maxSocketsPerUser: options.maxSocketsPerUser ?? 12,
      inboundBurst: options.inboundBurst ?? 20,
      inboundPerSecond: options.inboundPerSecond ?? 5,
      reconnectBaseMs: options.reconnectBaseMs ?? 500,
      reconnectMaxMs: options.reconnectMaxMs ?? 10_000,
      snapshotTimeoutMs: options.snapshotTimeoutMs ?? 15_000,
    };
  }

  /** Bun websocket handlers. Bun enforces the same buffer cap as a backstop to our own check. */
  get websocket(): WebSocketHandler<SocketData> {
    return {
      maxPayloadLength: 16 * 1024,
      idleTimeout: 60,
      sendPings: true,
      backpressureLimit: this.#o.maxBufferedBytes * 2,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      open: (ws) => this.#open(ws),
      message: (ws, message) => this.#message(ws, message),
      close: (ws) => this.#close(ws),
    };
  }

  /**
   * Authenticates and upgrades `GET /realtime?ticket=...`. Origin is checked before the ticket is
   * consumed, so a cross-site page cannot burn a user's ticket. Returns a Response on rejection,
   * undefined when Bun took over the connection.
   */
  handleUpgrade(req: Request, server: Server<SocketData>): Response | undefined {
    const reject = (status: number, code: Parameters<typeof errorBody>[0], message: string) =>
      Response.json(errorBody(code, message), { status, headers: { "cache-control": "no-store" } });
    if (this.#closing) return reject(503, "dependency_unavailable", "Server is restarting.");
    if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return reject(400, "bad_request", "Expected a WebSocket upgrade.");
    if (req.headers.get("origin") !== this.#o.appOrigin) return reject(403, "forbidden", "Origin not allowed.");
    const ticket = this.#o.tickets.consume(new URL(req.url).searchParams.get("ticket"), "realtime");
    if (!ticket) return reject(401, "unauthenticated", "Invalid or expired realtime ticket.");
    if ((this.#socketsByUser.get(ticket.userId)?.size ?? 0) >= this.#o.maxSocketsPerUser)
      return reject(429, "rate_limited", "Too many open realtime connections.");
    const data: SocketData = {
      id: newId("sock"),
      userId: ticket.userId,
      teamId: ticket.teamId,
      tokens: this.#o.inboundBurst,
      tokensAt: this.#o.now(),
    };
    if (server.upgrade(req, { data })) return undefined;
    return reject(400, "bad_request", "WebSocket upgrade failed.");
  }

  /** Sends a validated frame to every viewer of `teamId`. Returns how many sockets accepted it. */
  publish(teamId: string, frame: ServerFrame): number {
    const parsed = ServerFrame.safeParse(frame);
    if (!parsed.success || parsed.data.teamId !== teamId) {
      this.#o.log.error("refusing invalid realtime frame", { teamId, kind: (frame as { kind?: unknown })?.kind });
      return 0;
    }
    const channel = this.#channels.get(teamId);
    if (!channel) return 0;
    const data = JSON.stringify(parsed.data);
    let sent = 0;
    for (const ws of channel.admitted) if (this.#send(ws, data)) sent++;
    return sent;
  }

  /**
   * Sends a validated frame to one member's sockets on `teamId` only, never to the rest of the team.
   * Nothing is sent unless the latest team snapshot still lists them as a member.
   */
  publishToUser(teamId: string, userId: string, frame: ServerFrame): number {
    const parsed = ServerFrame.safeParse(frame);
    if (!parsed.success || parsed.data.teamId !== teamId) {
      this.#o.log.error("refusing invalid realtime frame", { teamId, kind: (frame as { kind?: unknown })?.kind });
      return 0;
    }
    const channel = this.#channels.get(teamId);
    if (!channel?.team?.members.some((m) => m.userId === userId)) return 0;
    const data = JSON.stringify(parsed.data);
    let sent = 0;
    for (const ws of this.#socketsByUser.get(userId) ?? []) if (channel.admitted.has(ws) && this.#send(ws, data)) sent++;
    return sent;
  }

  /**
   * Seam for modules that react to workforce changes (the signed-out notice). `prev` is null for a
   * team's first snapshot after its channel opens, so nothing that happened before then is replayed.
   */
  onWorkforceChange(handler: (teamId: string, prev: WorkforceView | null, next: WorkforceView) => void): void {
    this.#workforceHandlers.push(handler);
  }

  /** Closes a user's sockets for one team, e.g. after they are removed from it. */
  kick(teamId: string, userId: string, reason = "removed from team"): void {
    // A ticket minted just before the removal must not open a socket after it.
    this.#o.tickets.revokeUser(userId, teamId);
    for (const ws of this.#socketsByUser.get(userId) ?? []) {
      if (ws.data.teamId === teamId) ws.close(CLOSE.notMember, reason);
    }
  }

  /** Closes every socket a user holds, e.g. after logout-everywhere. */
  disconnectUser(userId: string, reason = "signed out"): void {
    this.#o.tickets.revokeUser(userId);
    for (const ws of [...(this.#socketsByUser.get(userId) ?? [])]) ws.close(CLOSE.notMember, reason);
  }

  /** Seam for the Relay module: answer `relay.history` requests. */
  onClientFrame<K extends Exclude<ClientFrame["kind"], "ping">>(kind: K, handler: ClientFrameHandler<K>): void {
    this.#clientHandlers.set(kind, handler as unknown as ClientFrameHandler<never>);
  }

  /** Seam for modules that send their own snapshot (Relay history, env status) when a viewer connects. */
  onViewerJoin(handler: (ctx: ViewerContext) => void | Promise<void>): void {
    this.#joinHandlers.push(handler);
  }

  hasViewers(teamId: string): boolean {
    return (this.#channels.get(teamId)?.sockets.size ?? 0) > 0;
  }

  activeTeamIds(): string[] {
    return [...this.#channels.keys()];
  }

  /** Members with an admitted socket on `teamId` right now (each once). */
  viewerIds(teamId: string): string[] {
    const channel = this.#channels.get(teamId);
    return channel ? [...new Set([...channel.admitted].map((ws) => ws.data.userId))] : [];
  }

  stats(): { teams: number; sockets: number; upstreamConnected: number } {
    let sockets = 0;
    let upstreamConnected = 0;
    for (const ch of this.#channels.values()) {
      sockets += ch.sockets.size;
      upstreamConnected += ch.subscriptions.filter((s) => s.connected).length;
    }
    return { teams: this.#channels.size, sockets, upstreamConnected };
  }

  /** Graceful shutdown: refuse new upgrades, close every viewer and every actor socket. */
  close(): void {
    this.#closing = true;
    for (const channel of this.#channels.values()) {
      for (const sub of channel.subscriptions) sub.stop();
      for (const ws of channel.sockets) ws.close(CLOSE.goingAway, "server shutting down");
    }
    this.#channels.clear();
    this.#socketsByUser.clear();
  }

  #open(ws: Ws): void {
    if (this.#closing) return ws.close(CLOSE.goingAway, "server shutting down");
    const { teamId, userId } = ws.data;
    let channel = this.#channels.get(teamId);
    if (!channel) {
      channel = this.#createChannel(teamId);
      this.#channels.set(teamId, channel);
    }
    channel.sockets.add(ws);
    let mine = this.#socketsByUser.get(userId);
    if (!mine) this.#socketsByUser.set(userId, (mine = new Set()));
    mine.add(ws);

    this.#send(ws, JSON.stringify({ kind: "hello", teamId, userId } satisfies ServerFrame));
    const admission = this.#admit(channel, ws);
    this.#admission.set(ws, admission);
    void admission.then((admitted) => {
      if (!admitted) return;
      const ctx = this.#viewerContext(ws);
      for (const handler of this.#joinHandlers) {
        Promise.resolve()
          .then(() => handler(ctx))
          .catch((error) => this.#o.log.error("viewer join handler failed", { teamId, error }));
      }
    });
  }

  /**
   * Nothing team-scoped (team or workforce view, published frames, Relay history from join or client
   * handlers) reaches a socket before its membership is confirmed against a team snapshot. A brand-new
   * channel waits for its first snapshot; a ticket minted just before the user was removed is refused here.
   */
  async #admit(channel: TeamChannel, ws: Ws): Promise<boolean> {
    if (!channel.team) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ready = await Promise.race([
        channel.teamReady.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.#o.snapshotTimeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (ws.readyState !== 1) return false;
      if (!ready) {
        ws.close(CLOSE.tryAgainLater, "team unavailable");
        return false;
      }
      // The first snapshot already sent this socket its team.view, or closed it. (Re-read: set meanwhile.)
      const team = channel.team as TeamRecord | null;
      if (!team?.members.some((m) => m.userId === ws.data.userId)) return false;
    } else if (!this.#sendTeamView(channel, ws)) return false;
    if (ws.readyState !== 1) return false;
    channel.admitted.add(ws);
    if (channel.workforceFrame) this.#send(ws, channel.workforceFrame);
    return true;
  }

  #message(ws: Ws, message: string | Buffer): void {
    if (!this.#takeInbound(ws)) return ws.close(CLOSE.policy, "too many messages");
    if (typeof message !== "string") return ws.close(CLOSE.policy, "text frames only");
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return void this.#sendError(ws, "bad_request", "Malformed frame.");
    }
    const parsed = ClientFrame.safeParse(raw);
    if (!parsed.success) return void this.#sendError(ws, "bad_request", "Unknown frame.");
    const frame = parsed.data;
    if (frame.kind === "ping") return;
    const handler = this.#clientHandlers.get(frame.kind) as ClientFrameHandler<typeof frame.kind> | undefined;
    if (!handler) return void this.#sendError(ws, "feature_disabled", "This feature is not available.");
    Promise.resolve(this.#admission.get(ws) ?? false)
      .then((admitted) => (admitted && ws.readyState === 1 ? handler(this.#viewerContext(ws), frame) : undefined))
      .catch((error) => {
        this.#o.log.error("client frame handler failed", { teamId: ws.data.teamId, kind: frame.kind, error });
        this.#sendError(ws, "internal", "Something went wrong.");
      });
  }

  #close(ws: Ws): void {
    const { teamId, userId } = ws.data;
    const mine = this.#socketsByUser.get(userId);
    mine?.delete(ws);
    if (mine && mine.size === 0) this.#socketsByUser.delete(userId);
    const channel = this.#channels.get(teamId);
    if (!channel) return;
    channel.sockets.delete(ws);
    channel.admitted.delete(ws);
    if (channel.sockets.size === 0) {
      for (const sub of channel.subscriptions) sub.stop();
      this.#channels.delete(teamId);
    }
  }

  #createChannel(teamId: string): TeamChannel {
    const channel = new TeamChannel(teamId);
    const log = this.#o.log.child({ teamId });
    const common = {
      teamId,
      gateway: this.#o.actors,
      log,
      baseDelayMs: this.#o.reconnectBaseMs,
      maxDelayMs: this.#o.reconnectMaxMs,
    };
    channel.subscriptions = [
      new ActorSubscription({ ...common, actor: "Team", onState: (state) => this.#onTeamState(channel, state) }),
      new ActorSubscription({ ...common, actor: "TeamWorkforce", onState: (state) => this.#onWorkforceState(channel, state) }),
    ];
    for (const sub of channel.subscriptions) sub.start();
    return channel;
  }

  #onTeamState(channel: TeamChannel, state: Record<string, unknown>): void {
    const team = this.#o.actors.mapTeamState(state, channel.teamId);
    if (!team) return this.#o.log.warn("team state did not map to a view", { teamId: channel.teamId });
    channel.team = team;
    channel.teamFrames.clear();
    for (const ws of channel.sockets) this.#sendTeamView(channel, ws);
    channel.markTeamReady();
  }

  #onWorkforceState(channel: TeamChannel, state: Record<string, unknown>): void {
    const view = this.#o.actors.mapWorkforceState(state);
    if (!view) return this.#o.log.warn("workforce state did not map to a view", { teamId: channel.teamId });
    const frame = JSON.stringify({ kind: "workforce.view", teamId: channel.teamId, data: view } satisfies ServerFrame);
    // The actor emits the view in parts plus an outbox summary; an update that moved only the summary (or a part
    // the browser view does not show) gives the same frame, which viewers already have.
    if (frame === channel.workforceFrame) return;
    const prev = channel.workforce;
    channel.workforce = view;
    channel.workforceFrame = frame;
    for (const ws of channel.admitted) this.#send(ws, channel.workforceFrame);
    for (const handler of this.#workforceHandlers) {
      try {
        handler(channel.teamId, prev, view);
      } catch (error) {
        this.#o.log.error("workforce change handler failed", { teamId: channel.teamId, error });
      }
    }
  }

  /** Membership is re-checked on every team update: a removed member's socket is closed, not just skipped. */
  #sendTeamView(channel: TeamChannel, ws: Ws): boolean {
    const member = channel.team?.members.find((m) => m.userId === ws.data.userId);
    if (!channel.team || !member) {
      channel.admitted.delete(ws);
      ws.close(CLOSE.notMember, "not a team member");
      return false;
    }
    let frame = channel.teamFrames.get(member.role);
    if (!frame) {
      const view = toTeamView(channel.team, ws.data.userId);
      if (!view) return false;
      frame = JSON.stringify({ kind: "team.view", teamId: channel.teamId, data: view } satisfies ServerFrame);
      channel.teamFrames.set(member.role, frame);
    }
    return this.#send(ws, frame);
  }

  #send(ws: Ws, data: string): boolean {
    if (ws.readyState !== 1) return false;
    const status = ws.send(data);
    if (status === 0 || ws.getBufferedAmount() > this.#o.maxBufferedBytes) {
      this.#o.log.warn("closing slow realtime consumer", { teamId: ws.data.teamId, userId: ws.data.userId });
      ws.close(CLOSE.tryAgainLater, "slow consumer");
      return false;
    }
    return true;
  }

  #sendError(ws: Ws, code: string, message: string): void {
    this.#send(ws, JSON.stringify({ kind: "error", teamId: ws.data.teamId, code, message } satisfies ServerFrame));
  }

  #viewerContext(ws: Ws): ViewerContext {
    return {
      teamId: ws.data.teamId,
      userId: ws.data.userId,
      send: (frame) => {
        const parsed = ServerFrame.safeParse(frame);
        if (!parsed.success || parsed.data.teamId !== ws.data.teamId) return false;
        return this.#send(ws, JSON.stringify(parsed.data));
      },
    };
  }

  #takeInbound(ws: Ws): boolean {
    const now = this.#o.now();
    const d = ws.data;
    d.tokens = Math.min(this.#o.inboundBurst, d.tokens + ((now - d.tokensAt) / 1000) * this.#o.inboundPerSecond);
    d.tokensAt = now;
    if (d.tokens < 1) return false;
    d.tokens -= 1;
    return true;
  }
}
