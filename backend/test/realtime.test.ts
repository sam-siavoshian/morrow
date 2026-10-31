import { afterEach, describe, expect, test } from "bun:test";
import type { ProfileView, ServerFrame, WorkforceView } from "@morrow/contracts";
import type { Server, ServerWebSocket } from "bun";
import type { ActorGateway, TeamRecord } from "../src/actors/types.ts";
import { parseWorkforceState } from "../src/actors/workforceState.ts";
import { silentLogger } from "../src/lib/logger.ts";
import { RealtimeHub, type SocketData } from "../src/realtime/hub.ts";
import { TicketStore } from "../src/realtime/tickets.ts";
import { newlySignedOut, notifySignedOut, signedOutToast } from "../src/runtime/profiles.ts";
import * as wf from "../../actors/src/lib/workforce.ts";

const ORIGIN = "http://localhost:3000";
const TEAM = "t-alpha";
const OTHER = "t-beta";

const team = (members: Array<[string, "owner" | "admin" | "member"]>, name = "Alpha"): TeamRecord => ({
  id: TEAM,
  name,
  slug: "alpha",
  members: members.map(([userId, role]) => ({ userId, role, login: userId, name: null, avatarUrl: null })),
  projects: [],
  environments: [],
  policy: { allowInspect: true, maxParallelPerTask: 3 },
  relayReady: false,
});
const emptyWorkforce: WorkforceView = { profiles: {}, tasks: {}, leases: {} };

/** Speaks the durable-actors socket protocol: a `state` snapshot on connect, `state_update` diffs after. */
function startFakeActorServer(initial: Record<string, Record<string, unknown>>) {
  const sockets = new Map<string, Set<ServerWebSocket<{ key: string }>>>();
  const state = structuredClone(initial);
  const version: Record<string, number> = {};
  let closes = 0;
  const server = Bun.serve<{ key: string }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const key = new URL(req.url).searchParams.get("key")!;
      return srv.upgrade(req, { data: { key } }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        const set = sockets.get(ws.data.key) ?? new Set();
        set.add(ws);
        sockets.set(ws.data.key, set);
        version[ws.data.key] ??= 1;
        ws.send(JSON.stringify({ type: "state", state: state[ws.data.key] ?? {}, version: version[ws.data.key] }));
      },
      message() {},
      close(ws) {
        closes++;
        sockets.get(ws.data.key)?.delete(ws);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/v1/socket`,
    update(key: string, changes: Record<string, unknown>, opts: { version?: number } = {}) {
      version[key] = opts.version ?? (version[key] ?? 1) + 1;
      state[key] = { ...state[key], ...changes };
      for (const ws of sockets.get(key) ?? []) ws.send(JSON.stringify({ type: "state_update", changes, removed: [], version: version[key] }));
    },
    dropAll(key: string) {
      for (const ws of sockets.get(key) ?? []) ws.close(1011, "restart");
    },
    open: (key: string) => sockets.get(key)?.size ?? 0,
    closes: () => closes,
    stop: () => server.stop(true),
  };
}

interface Harness {
  hub: RealtimeHub;
  tickets: TicketStore;
  actor: ReturnType<typeof startFakeActorServer>;
  grants: string[];
  url: string;
  connect(userId: string, teamId?: string, origin?: string): Promise<Client>;
  setNow(ms: number): void;
}

interface Client {
  ws: WebSocket;
  frames: ServerFrame[];
  closed: Promise<{ code: number; reason: string }>;
  next(kind: ServerFrame["kind"], timeoutMs?: number): Promise<ServerFrame>;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function harness(
  options: { maxBufferedBytes?: number; maxSocketsPerUser?: number; members?: Array<[string, "owner" | "admin" | "member"]>; realMapper?: boolean } = {},
): Promise<Harness> {
  let now = Date.now();
  const actor = startFakeActorServer({
    [`Team:${TEAM}`]: { team: team(options.members ?? [["u-owner", "owner"], ["u-member", "member"]]) },
    [`TeamWorkforce:${TEAM}`]: { view: emptyWorkforce },
    [`Team:${OTHER}`]: { team: { ...team([["u-other", "owner"]], "Beta"), id: OTHER } },
    [`TeamWorkforce:${OTHER}`]: { view: emptyWorkforce },
  });
  const grants: string[] = [];
  const actors: Pick<ActorGateway, "prepareSocket" | "mapTeamState" | "mapWorkforceState"> = {
    prepareSocket: async (name, teamId) => {
      grants.push(`${name}:${teamId}`);
      return { websocketUrl: `${actor.url}?key=${encodeURIComponent(`${name}:${teamId}`)}`, connectByMs: Date.now() + 60_000 };
    },
    mapTeamState: (s) => (s.team as TeamRecord) ?? null,
    mapWorkforceState: options.realMapper ? (s) => parseWorkforceState(s, silentLogger) : (s) => (s.view as WorkforceView) ?? null,
  };
  const tickets = new TicketStore({ now: () => now });
  const hub = new RealtimeHub({
    actors,
    tickets,
    appOrigin: ORIGIN,
    log: silentLogger,
    now: () => now,
    reconnectBaseMs: 20,
    reconnectMaxMs: 50,
    maxBufferedBytes: options.maxBufferedBytes,
    maxSocketsPerUser: options.maxSocketsPerUser,
  });
  const server: Server<SocketData> = Bun.serve<SocketData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => hub.handleUpgrade(req, srv) ?? undefined,
    websocket: hub.websocket,
  });
  cleanups.push(() => actor.stop(), () => server.stop(true), () => hub.close());
  const url = `ws://127.0.0.1:${server.port}/realtime`;

  const connect = async (userId: string, teamId = TEAM, origin = ORIGIN): Promise<Client> => {
    const { ticket } = tickets.issue(userId, teamId);
    const ws = new WebSocket(`${url}?ticket=${encodeURIComponent(ticket)}`, { headers: { origin } } as unknown as string[]);
    const frames: ServerFrame[] = [];
    const waiters: Array<() => void> = [];
    ws.onmessage = (e) => {
      frames.push(JSON.parse(String(e.data)));
      for (const w of waiters.splice(0)) w();
    };
    const closed = new Promise<{ code: number; reason: string }>((resolve) => (ws.onclose = (e) => resolve({ code: e.code, reason: e.reason })));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket error"));
    });
    cleanups.push(() => ws.close());
    let seen = 0;
    const next = (kind: ServerFrame["kind"], timeoutMs = 3000) =>
      new Promise<ServerFrame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${kind} frame; got ${frames.map((f) => f.kind).join(",")}`)), timeoutMs);
        const check = () => {
          for (; seen < frames.length; seen++) {
            if (frames[seen]!.kind === kind) {
              clearTimeout(timer);
              return resolve(frames[seen++]!);
            }
          }
          waiters.push(check);
        };
        check();
      });
    return { ws, frames, closed, next };
  };

  return { hub, tickets, actor, grants, url, connect, setNow: (ms) => (now = ms) };
}

const upgradeHeaders = (origin: string) => ({
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
  "sec-websocket-version": "13",
  origin,
});

const httpUrl = (wsUrl: string) => wsUrl.replace(/^ws/, "http");

describe("tickets", () => {
  test("single use, bound to user+team, expire after 30 s", () => {
    let now = 0;
    const store = new TicketStore({ now: () => now });
    const { ticket, expiresAt } = store.issue("u-1", "t-1");
    expect(expiresAt).toBe(30_000);
    expect(store.consume(ticket)).toEqual({ userId: "u-1", teamId: "t-1", expiresAt: 30_000 });
    expect(store.consume(ticket)).toBeNull();
    const late = store.issue("u-1", "t-1").ticket;
    now = 30_000;
    expect(store.consume(late)).toBeNull();
    expect(store.consume("")).toBeNull();
    expect(store.consume(null)).toBeNull();
    expect(store.consume("x".repeat(500))).toBeNull();
  });

  test("per-user cap evicts that user's oldest; sweep clears expired", () => {
    let now = 0;
    const store = new TicketStore({ now: () => now, maxPerUser: 3 });
    const t = [1, 2, 3, 4].map(() => store.issue("u-1", "t-1").ticket);
    store.issue("u-2", "t-1");
    expect(store.consume(t[0])).toBeNull();
    expect(store.consume(t[3])).not.toBeNull();
    now = 60_000;
    store.sweep();
    expect(store.size).toBe(0);
  });
});

describe("realtime hub", () => {
  test("rejects a foreign Origin before consuming the ticket", async () => {
    const h = await harness();
    const { ticket } = h.tickets.issue("u-owner", TEAM);
    const res = await fetch(`${httpUrl(h.url)}?ticket=${ticket}`, { headers: upgradeHeaders("https://evil.example") });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("forbidden");
    const missing = await fetch(`${httpUrl(h.url)}?ticket=${ticket}`, { headers: { ...upgradeHeaders(ORIGIN), origin: "" } });
    expect(missing.status).toBe(403);
    // Still valid: the rejected attempts did not burn it.
    expect(h.tickets.consume(ticket)).not.toBeNull();
  });

  test("rejects missing, unknown, reused and expired tickets; non-upgrade requests", async () => {
    const h = await harness();
    const status = async (q: string) => (await fetch(`${httpUrl(h.url)}${q}`, { headers: upgradeHeaders(ORIGIN) })).status;
    expect(await status("")).toBe(401);
    expect(await status("?ticket=nope")).toBe(401);

    const c = await h.connect("u-owner");
    await c.next("hello");
    const { ticket } = h.tickets.issue("u-owner", TEAM);
    const ok = new WebSocket(`${h.url}?ticket=${ticket}`, { headers: { origin: ORIGIN } } as unknown as string[]);
    await new Promise((r) => (ok.onopen = r));
    cleanups.push(() => ok.close());
    expect(await status(`?ticket=${ticket}`)).toBe(401);

    const expiring = h.tickets.issue("u-owner", TEAM).ticket;
    h.setNow(Date.now() + 31_000);
    expect(await status(`?ticket=${expiring}`)).toBe(401);

    const plain = await fetch(`${httpUrl(h.url)}?ticket=x`, { headers: { origin: ORIGIN } });
    expect(plain.status).toBe(400);
  });

  test("hello + snapshots on connect, role-specific team.view, no grant leaks", async () => {
    const h = await harness();
    const owner = await h.connect("u-owner");
    expect(await owner.next("hello")).toEqual({ kind: "hello", teamId: TEAM, userId: "u-owner" });
    const tv = (await owner.next("team.view")) as Extract<ServerFrame, { kind: "team.view" }>;
    expect(tv.data.viewerRole).toBe("owner");
    expect(tv.data.members.map((m) => m.userId)).toEqual(["u-owner", "u-member"]);
    expect(((await owner.next("workforce.view")) as Extract<ServerFrame, { kind: "workforce.view" }>).data).toEqual(emptyWorkforce);

    // Second viewer joins an already-subscribed team: snapshot comes from cache, no new grants.
    const grantsBefore = h.grants.length;
    const member = await h.connect("u-member");
    const mv = (await member.next("team.view")) as Extract<ServerFrame, { kind: "team.view" }>;
    expect(mv.data.viewerRole).toBe("member");
    await member.next("workforce.view");
    expect(h.grants.length).toBe(grantsBefore);
    for (const f of [...owner.frames, ...member.frames]) expect(JSON.stringify(f)).not.toContain("key=");
  });

  test("state_update merges and fans out; stale versions are ignored", async () => {
    const h = await harness();
    const c = await h.connect("u-owner");
    await c.next("team.view");
    h.actor.update(`Team:${TEAM}`, { team: team([["u-owner", "owner"], ["u-member", "member"]], "Renamed") });
    expect(((await c.next("team.view")) as Extract<ServerFrame, { kind: "team.view" }>).data.name).toBe("Renamed");
    h.actor.update(`Team:${TEAM}`, { team: team([["u-owner", "owner"], ["u-member", "member"]], "Stale") }, { version: 1 });
    await Bun.sleep(100);
    expect(c.frames.filter((f) => f.kind === "team.view").map((f) => (f as { data: { name: string } }).data.name)).toEqual(["Alpha", "Renamed"]);
  });

  test("a member dropped from team state is disconnected", async () => {
    const h = await harness();
    const owner = await h.connect("u-owner");
    const member = await h.connect("u-member");
    await member.next("team.view");
    h.actor.update(`Team:${TEAM}`, { team: team([["u-owner", "owner"]]) });
    expect((await member.closed).code).toBe(4003);
    await owner.next("team.view");
    expect(owner.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("publish reaches only that team; invalid frames are refused", async () => {
    const h = await harness();
    const a = await h.connect("u-owner");
    const b = await h.connect("u-other", OTHER);
    await a.next("workforce.view");
    await b.next("workforce.view");
    const toast: ServerFrame = { kind: "toast", teamId: TEAM, data: { level: "info", title: "hi", body: null } };
    expect(h.hub.publish(TEAM, toast)).toBe(1);
    expect(await a.next("toast")).toEqual(toast);
    expect(h.hub.publish(OTHER, toast)).toBe(0);
    expect(h.hub.publish(TEAM, { kind: "toast", teamId: TEAM, data: { level: "nope" } } as unknown as ServerFrame)).toBe(0);
    await Bun.sleep(50);
    expect(b.frames.some((f) => f.kind === "toast")).toBe(false);
  });

  test("pool usage on workforce.view reaches every member of that team live, and no one else", async () => {
    const h = await harness();
    const owner = await h.connect("u-owner");
    const member = await h.connect("u-member");
    const other = await h.connect("u-other", OTHER);
    for (const c of [owner, member, other]) await c.next("workforce.view");
    const usage = { windows: [{ kind: "weekly" as const, label: "Weekly", usedPercent: 77.7, resetsAt: null }], observedAt: 5, source: "probe" as const };
    const profile: ProfileView = {
      id: "cp-1",
      envId: "env-1",
      ownerUserId: "u-member",
      cli: "codex",
      label: "Codex",
      auth: "ok",
      availability: "ready",
      cooldownUntil: null,
      limitedReason: null,
      limitedSource: null,
      maxConcurrent: 1,
      activeLeases: 0,
      scopes: "all",
      lastSeenAt: null,
      usage,
    };
    h.actor.update(`TeamWorkforce:${TEAM}`, { view: { ...emptyWorkforce, profiles: { "cp-1": profile } } });
    for (const c of [owner, member]) {
      const frame = (await c.next("workforce.view")) as Extract<ServerFrame, { kind: "workforce.view" }>;
      expect(frame.data.profiles["cp-1"]!.usage).toEqual(usage);
    }
    await Bun.sleep(50);
    expect(other.frames.some((f) => JSON.stringify(f).includes("77.7"))).toBe(false);
  });

  test("client frames: ping is silent, junk gets an error frame, relay.history goes to its handler", async () => {
    const h = await harness();
    const c = await h.connect("u-owner");
    await c.next("hello");
    c.ws.send(JSON.stringify({ kind: "ping" }));
    c.ws.send("{not json");
    expect(await c.next("error")).toMatchObject({ code: "bad_request" });
    c.ws.send(JSON.stringify({ kind: "relay.history", before: null, channel: null }));
    expect(await c.next("error")).toMatchObject({ code: "feature_disabled" });
    h.hub.onClientFrame("relay.history", (ctx, frame) => {
      ctx.send({ kind: "relay.history", teamId: ctx.teamId, data: [] });
      expect(frame.channel).toBe("general");
    });
    c.ws.send(JSON.stringify({ kind: "relay.history", before: null, channel: "general" }));
    expect(await c.next("relay.history")).toEqual({ kind: "relay.history", teamId: TEAM, data: [] });
  });

  test("viewer join handlers get a per-viewer send", async () => {
    const h = await harness();
    h.hub.onViewerJoin((ctx) => void ctx.send({ kind: "toast", teamId: ctx.teamId, data: { level: "info", title: `hi ${ctx.userId}`, body: null } }));
    const c = await h.connect("u-owner");
    expect(await c.next("toast")).toMatchObject({ data: { title: "hi u-owner" } });
  });

  test("publishToUser reaches only that member's sockets on that team; non-members and bad frames get nothing", async () => {
    const h = await harness();
    const ownerA = await h.connect("u-owner");
    const ownerB = await h.connect("u-owner");
    const member = await h.connect("u-member");
    const other = await h.connect("u-other", OTHER);
    for (const c of [ownerA, ownerB, member, other]) await c.next("workforce.view");
    const toast: ServerFrame = { kind: "toast", teamId: TEAM, data: { level: "warning", title: "yours", body: null } };
    expect(h.hub.publishToUser(TEAM, "u-owner", toast)).toBe(2);
    expect(await ownerA.next("toast")).toEqual(toast);
    expect(await ownerB.next("toast")).toEqual(toast);
    // Not a member of TEAM (even with a socket on another team): nothing.
    expect(h.hub.publishToUser(TEAM, "u-other", toast)).toBe(0);
    expect(h.hub.publishToUser(OTHER, "u-owner", { ...toast, teamId: OTHER })).toBe(0);
    // teamId mismatch and malformed frames are refused.
    expect(h.hub.publishToUser(TEAM, "u-owner", { ...toast, teamId: OTHER })).toBe(0);
    expect(h.hub.publishToUser(TEAM, "u-owner", { kind: "toast", teamId: TEAM, data: { level: "nope" } } as unknown as ServerFrame)).toBe(0);
    // Unknown team (no channel).
    expect(h.hub.publishToUser("t-none", "u-owner", { ...toast, teamId: "t-none" })).toBe(0);
    await Bun.sleep(50);
    expect(member.frames.some((f) => f.kind === "toast")).toBe(false);
    expect(other.frames.some((f) => f.kind === "toast")).toBe(false);
    expect(ownerA.frames.filter((f) => f.kind === "toast")).toHaveLength(1);
  });

  test("publishToUser stops once the member is dropped from team state", async () => {
    const h = await harness();
    const owner = await h.connect("u-owner");
    const member = await h.connect("u-member");
    await member.next("workforce.view");
    await owner.next("workforce.view");
    h.actor.update(`Team:${TEAM}`, { team: team([["u-owner", "owner"]]) });
    await member.closed;
    await owner.next("team.view");
    expect(h.hub.publishToUser(TEAM, "u-member", { kind: "toast", teamId: TEAM, data: { level: "info", title: "x", body: null } })).toBe(0);
  });

  test("signed-out notice: once per ok -> auth_required transition, to the owner only", async () => {
    const h = await harness();
    notifySignedOut(h.hub, silentLogger);
    const profile = (auth: ProfileView["auth"], owner = "u-member"): ProfileView => ({
      id: "cp-1",
      envId: "env-1",
      ownerUserId: owner,
      cli: "claude",
      label: "Claude Max",
      auth,
      availability: "ready",
      cooldownUntil: null,
      limitedReason: null,
      limitedSource: null,
      maxConcurrent: 1,
      activeLeases: 0,
      scopes: "all",
      lastSeenAt: null,
    });
    const view = (auth: ProfileView["auth"]): WorkforceView => ({ ...emptyWorkforce, profiles: { "cp-1": profile(auth) } });
    // The first snapshot already says signed out: no notice (it predates this channel).
    h.actor.update(`TeamWorkforce:${TEAM}`, { view: view("auth_required") });
    const owner = await h.connect("u-owner");
    const member = await h.connect("u-member");
    await owner.next("workforce.view");
    await member.next("workforce.view");

    h.actor.update(`TeamWorkforce:${TEAM}`, { view: view("ok") });
    await member.next("workforce.view");
    h.actor.update(`TeamWorkforce:${TEAM}`, { view: view("auth_required") });
    const notice = await member.next("toast");
    expect(notice).toEqual({
      kind: "toast",
      teamId: TEAM,
      data: { level: "warning", title: "Claude Max (Claude Code) is signed out", body: "It won't take new tasks until you sign in again from Workforce." },
    });
    // Later probes that keep it signed out (lastSeenAt moves) do not repeat it.
    h.actor.update(`TeamWorkforce:${TEAM}`, { view: { ...view("auth_required"), profiles: { "cp-1": { ...profile("auth_required"), lastSeenAt: 5 } } } });
    await member.next("workforce.view");
    await Bun.sleep(50);
    expect(member.frames.filter((f) => f.kind === "toast")).toHaveLength(1);
    expect(owner.frames.some((f) => f.kind === "toast")).toBe(false);

    // A fresh sign-in then a new loss notifies again.
    h.actor.update(`TeamWorkforce:${TEAM}`, { view: view("ok") });
    await member.next("workforce.view");
    h.actor.update(`TeamWorkforce:${TEAM}`, { view: view("auth_required") });
    await member.next("toast");
    expect(member.frames.filter((f) => f.kind === "toast")).toHaveLength(2);
  });

  test("flooding the socket closes it with 1008", async () => {
    const h = await harness();
    const c = await h.connect("u-owner");
    await c.next("hello");
    for (let i = 0; i < 100; i++) c.ws.send(JSON.stringify({ kind: "ping" }));
    expect((await c.closed).code).toBe(1008);
  });

  test("slow consumers are dropped instead of buffering without bound", async () => {
    const h = await harness({ maxBufferedBytes: 1024 });
    const c = await h.connect("u-owner");
    await c.next("workforce.view");
    const big = "x".repeat(8 * 1024 * 1024);
    for (let i = 0; i < 4 && c.ws.readyState === WebSocket.OPEN; i++) {
      h.hub.publish(TEAM, { kind: "toast", teamId: TEAM, data: { level: "info", title: "big", body: big } });
    }
    expect((await c.closed).code).toBe(1013);
  });

  test("last viewer leaving closes the actor sockets; next viewer resubscribes", async () => {
    const h = await harness();
    const c = await h.connect("u-owner");
    await c.next("workforce.view");
    expect(h.actor.open(`Team:${TEAM}`)).toBe(1);
    expect(h.actor.open(`TeamWorkforce:${TEAM}`)).toBe(1);
    c.ws.close();
    await c.closed;
    await Bun.sleep(100);
    expect(h.hub.stats().teams).toBe(0);
    expect(h.actor.open(`Team:${TEAM}`)).toBe(0);
    expect(h.actor.open(`TeamWorkforce:${TEAM}`)).toBe(0);
    const again = await h.connect("u-owner");
    await again.next("team.view");
    expect(h.actor.open(`Team:${TEAM}`)).toBe(1);
  });

  test("actor socket drop: reconnects with a fresh grant and re-sends state", async () => {
    const h = await harness();
    const c = await h.connect("u-owner");
    await c.next("team.view");
    const grants = h.grants.filter((g) => g === `Team:${TEAM}`).length;
    h.actor.dropAll(`Team:${TEAM}`);
    await c.next("team.view", 3000);
    expect(h.grants.filter((g) => g === `Team:${TEAM}`).length).toBe(grants + 1);
  });

  test("kick, disconnectUser and the per-user socket cap", async () => {
    const h = await harness({ maxSocketsPerUser: 2 });
    const a = await h.connect("u-owner");
    const b = await h.connect("u-member");
    await a.next("hello");
    await b.next("hello");
    h.hub.kick(TEAM, "u-member");
    expect((await b.closed).code).toBe(4003);
    await h.connect("u-owner");
    const { ticket } = h.tickets.issue("u-owner", TEAM);
    expect((await fetch(`${httpUrl(h.url)}?ticket=${ticket}`, { headers: upgradeHeaders(ORIGIN) })).status).toBe(429);
    h.hub.disconnectUser("u-owner");
    expect((await a.closed).code).toBe(4003);
  });

  test("membership is confirmed before anything team-scoped: a non-member gets only hello, then 4003", async () => {
    const h = await harness({ members: [["u-owner", "owner"]] });
    let joins = 0;
    let historyCalls = 0;
    h.hub.onViewerJoin((ctx) => {
      joins++;
      ctx.send({ kind: "relay.history", teamId: ctx.teamId, data: [] });
    });
    h.hub.onClientFrame("relay.history", () => void historyCalls++);
    // A ticket minted while u-gone was a member, used after the removal reached the Team actor.
    const gone = await h.connect("u-gone");
    gone.ws.send(JSON.stringify({ kind: "relay.history", before: null, channel: null }));
    expect((await gone.closed).code).toBe(4003);
    expect(gone.frames.map((f) => f.kind)).toEqual(["hello"]);
    expect(joins).toBe(0);
    expect(historyCalls).toBe(0);
    // A member joining the same channel still gets the join snapshot.
    const owner = await h.connect("u-owner");
    expect(await owner.next("relay.history")).toEqual({ kind: "relay.history", teamId: TEAM, data: [] });
    expect(joins).toBe(1);
  });

  test("kick and disconnectUser burn tickets minted before them", async () => {
    const h = await harness();
    const member = h.tickets.issue("u-member", TEAM).ticket;
    const owner = h.tickets.issue("u-owner", TEAM).ticket;
    const otherTeam = h.tickets.issue("u-member", OTHER).ticket;
    h.hub.kick(TEAM, "u-member");
    const status = async (t: string) => (await fetch(`${httpUrl(h.url)}?ticket=${t}`, { headers: upgradeHeaders(ORIGIN) })).status;
    expect(await status(member)).toBe(401);
    h.hub.disconnectUser("u-owner");
    expect(await status(owner)).toBe(401);
    // A kick is per team: the same user's ticket for another team is untouched.
    expect(h.tickets.consume(otherTeam)).toMatchObject({ userId: "u-member", teamId: OTHER });
  });

  test("close() shuts every viewer with 1001 and refuses new upgrades", async () => {
    const h = await harness();
    const c = await h.connect("u-owner");
    await c.next("hello");
    h.hub.close();
    expect((await c.closed).code).toBe(1001);
    const { ticket } = h.tickets.issue("u-owner", TEAM);
    expect((await fetch(`${httpUrl(h.url)}?ticket=${ticket}`, { headers: upgradeHeaders(ORIGIN) })).status).toBe(503);
  });
});

describe("signed-out transitions", () => {
  const p = (id: string, auth: ProfileView["auth"], patch: Partial<ProfileView> = {}): ProfileView => ({
    id,
    envId: "env-1",
    ownerUserId: "u-1",
    cli: "codex",
    label: "Codex",
    auth,
    availability: "ready",
    cooldownUntil: null,
    limitedReason: null,
    limitedSource: null,
    maxConcurrent: 1,
    activeLeases: 0,
    scopes: "all",
    lastSeenAt: null,
    ...patch,
  });
  const view = (...profiles: ProfileView[]): WorkforceView => ({ ...emptyWorkforce, profiles: Object.fromEntries(profiles.map((x) => [x.id, x])) });

  test("only ok -> auth_required counts", () => {
    expect(newlySignedOut(null, view(p("a", "auth_required")))).toEqual([]);
    expect(newlySignedOut(view(), view(p("a", "auth_required")))).toEqual([]);
    expect(newlySignedOut(view(p("a", "unknown")), view(p("a", "auth_required")))).toEqual([]);
    expect(newlySignedOut(view(p("a", "auth_required")), view(p("a", "auth_required")))).toEqual([]);
    expect(newlySignedOut(view(p("a", "auth_required")), view(p("a", "ok")))).toEqual([]);
    expect(newlySignedOut(view(p("a", "ok"), p("b", "ok")), view(p("a", "auth_required"), p("b", "ok"))).map((x) => x.id)).toEqual(["a"]);
  });

  test("the notice names the label and CLI once, as plain text", () => {
    expect(signedOutToast(TEAM, p("a", "auth_required")).data.title).toBe("Codex is signed out");
    expect(signedOutToast(TEAM, p("a", "auth_required", { cli: "opencode", label: "<b>Ada</b>" })).data.title).toBe("<b>Ada</b> (opencode) is signed out");
  });
});

/** A real view (profile, task with a plan) built by the actor's own state machine. */
function realWorkforceView(): WorkforceView {
  const d = new wf.WorkforceDraft({ profiles: {}, tasks: {}, leases: {}, outbox: {}, epoch: 0 }, 1_800_000_000_000);
  wf.registerProfile(d, { id: "p1", envId: "e-1", ownerUserId: "u-owner", nodeName: "n-p1", cli: "claude", label: "Mine", scopes: "all", maxConcurrent: 2 });
  wf.createTask(d, { id: "tk-1", projectId: "p-1", title: "Checkout", prompt: "Build checkout.", acceptance: ["works"], createdBy: "u-owner", maxAgents: 2 });
  wf.finalize(d);
  return wf.buildWorkforceView(d) as unknown as WorkforceView;
}

describe("workforce view split into parts", () => {
  test("viewers get byte-identical workforce.view frames from the split fields, and nothing for summary-only updates", async () => {
    const h = await harness({ realMapper: true });
    const view = realWorkforceView();
    // An actor on the old shape first.
    h.actor.update(`TeamWorkforce:${TEAM}`, { view });
    const owner = await h.connect("u-owner");
    const raw: string[] = [];
    owner.ws.addEventListener("message", (e) => {
      if (String(e.data).includes('"workforce.view"')) raw.push(String(e.data));
    });
    await owner.next("workforce.view");
    const before = JSON.stringify({ kind: "workforce.view", teamId: TEAM, data: parseWorkforceState({ view }, silentLogger) });

    // The actor is upgraded: same data in three parts plus a summary. Viewers already have this frame.
    h.actor.update(`TeamWorkforce:${TEAM}`, { view: null, profilesView: view.profiles, tasksView: view.tasks, leasesView: view.leases, outboxSummary: { open: 0, nextDueAt: null } });
    h.actor.update(`TeamWorkforce:${TEAM}`, { outboxSummary: { open: 1, nextDueAt: 5 } });
    await Bun.sleep(150);
    expect(owner.frames.filter((f) => f.kind === "workforce.view")).toHaveLength(1);

    // A change to one part: one new frame, the same bytes the old single field would have produced.
    const renamed = { ...view.profiles, p1: { ...view.profiles.p1!, label: "Renamed" } };
    const seen = raw.length;
    if (seen === 1) expect(raw[0]).toBe(before);
    h.actor.update(`TeamWorkforce:${TEAM}`, { profilesView: renamed });
    const next = (await owner.next("workforce.view")) as Extract<ServerFrame, { kind: "workforce.view" }>;
    expect(next.data.profiles.p1!.label).toBe("Renamed");
    await Bun.sleep(50);
    expect(raw.at(-1)).toBe(JSON.stringify({ kind: "workforce.view", teamId: TEAM, data: parseWorkforceState({ view: { ...view, profiles: renamed } }, silentLogger) }));
    expect(raw).toHaveLength(seen + 1);
    expect(before.length).toBeGreaterThan(100);
  });
});
