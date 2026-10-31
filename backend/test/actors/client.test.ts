// How the backend reaches Terse Cloud (src/actors/client.ts), against a fake Terse API on localhost. Its sessions point
// at a real local Terse, so RPC runs the generated session transport end to end: the API key is exchanged at
// `/access` and never sent to the runtime.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createTerseTransport, generated, pingTerse, prepareActorSocket } from "../../src/actors/client.ts";
import type { Env } from "../../src/env.ts";
import { listWorkforceTeamIds } from "../../src/orchestration/workforce.ts";

const TEST_SERVER = resolve(import.meta.dir, "../../../actors/scripts/test-server.ts");
const ready = existsSync(TEST_SERVER);
const KEY = "terse_test_0123456789abcdef";

type TerseServer = { url: string; secret: string; stop(): Promise<void> };
let terse: TerseServer | undefined;
let api: ReturnType<typeof Bun.serve>;
let grant: unknown;
const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];

const cloud = (apiKey = KEY): Extract<Env["terse"], { kind: "cloud" }> => ({
  kind: "cloud",
  actorUrl: `${api.url.origin}/local/actors`,
  apiKey,
  projectId: "local",
});

beforeAll(async () => {
  api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      calls.push({ method: req.method, path: url.pathname, auth, body: req.method === "POST" ? await req.json().catch(() => null) : null });
      // Like the real API: unauthenticated requests are redirected to sign-in.
      if (auth !== `Bearer ${KEY}`) return url.pathname.endsWith("/access") ? new Response(null, { status: 401 }) : Response.redirect("https://app.example/login", 302);
      if (req.method === "POST" && url.pathname === "/local/actors/access") {
        if (!terse) return new Response(null, { status: 503 });
        return Response.json({ projectId: "local", controlPlaneUrl: terse.url, token: terse.secret, expiresAtMs: Date.now() + 300_000 });
      }
      if (req.method === "POST" && url.pathname === "/local/actors") return Response.json(grant);
      if (req.method === "GET" && url.pathname === "/sdk/projects/local/actors/contract") return Response.json({ actors: [] });
      return new Response(null, { status: 404 });
    },
  });
  if (!ready) return;
  const { startTestServer } = (await import(TEST_SERVER)) as { startTestServer: () => Promise<TerseServer> };
  terse = await startTestServer();
}, 300_000);
afterAll(async () => {
  await terse?.stop();
  api?.stop(true);
}, 30_000);
afterEach(() => {
  calls.length = 0;
});

describe.skipIf(!ready)("Terse Cloud RPC", () => {
  test("calls a real actor through an exchanged session; the key never reaches the runtime", async () => {
    const seen: Array<{ origin: string; auth: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input.toString(), init);
        seen.push({ origin: new URL(request.url).origin, auth: new Headers(init?.headers ?? request.headers).get("authorization") });
        return realFetch(input, init);
      },
      { preconnect: realFetch.preconnect },
    );
    const transport = createTerseTransport(cloud());
    try {
      const directory = generated.actors.TeamDirectory.get("teams", transport);
      expect(await directory.stats()).toEqual({ teams: 0, active: 0 });
      expect(await directory.noteTeam("t-cloud")).toEqual({ ok: true, created: true });
      expect(await directory.stats()).toEqual({ teams: 1, active: 0 });
    } finally {
      transport.dispose?.();
      globalThis.fetch = realFetch;
    }
    // One exchange serves every call while the session is fresh.
    expect(calls.filter((c) => c.path === "/local/actors/access")).toHaveLength(1);
    const runtime = seen.filter((s) => s.origin === new URL(terse!.url).origin);
    expect(runtime.length).toBeGreaterThan(0);
    for (const call of runtime) expect(call.auth).not.toContain(KEY);
  });

  test("a refused key fails the call instead of reaching the runtime", async () => {
    const transport = createTerseTransport(cloud("terse_wrong_0123456789abcdef"));
    try {
      await expect(generated.actors.TeamDirectory.get("teams", transport).stats()).rejects.toThrow();
    } finally {
      transport.dispose?.();
    }
    expect(calls.map((c) => c.path)).toEqual(["/local/actors/access"]);
  });
});

describe("Terse Cloud socket grants", () => {
  const authorization = { actorId: "team-1", metadata: { userId: "system.backend" } };

  test("asks the API for a grant with the key and the actor's address", async () => {
    grant = { websocketUrl: "wss://actors.example/v1/socket?grant=abc", homeRegion: "north-america-west", connectByMs: 1_900_000_000_000 };
    expect(await prepareActorSocket(cloud(), "TeamWorkforce", authorization)).toEqual({
      websocketUrl: "wss://actors.example/v1/socket?grant=abc",
      connectByMs: 1_900_000_000_000,
    });
    expect(calls).toEqual([
      { method: "POST", path: "/local/actors", auth: `Bearer ${KEY}`, body: { actorName: "TeamWorkforce", actorId: "team-1", metadata: { userId: "system.backend" } } },
    ]);
  });

  test("refuses a grant that is not wss://, malformed, or not issued", async () => {
    grant = { websocketUrl: "ws://actors.example/v1/socket", connectByMs: 1 };
    await expect(prepareActorSocket(cloud(), "Team", authorization)).rejects.toThrow("unexpected response shape");
    grant = { websocketUrl: "wss://actors.example/v1/socket" };
    await expect(prepareActorSocket(cloud(), "Team", authorization)).rejects.toThrow("unexpected response shape");
    await expect(prepareActorSocket(cloud("terse_wrong_0123456789abcdef"), "Team", authorization)).rejects.toThrow();
  });
});

describe("Terse Cloud readiness and inventory", () => {
  test("ping reads the deployment's contract with the key and fails without a valid one", async () => {
    await pingTerse(cloud(), 2_000);
    expect(calls).toEqual([{ method: "GET", path: "/sdk/projects/local/actors/contract", auth: `Bearer ${KEY}`, body: null }]);
    await expect(pingTerse(cloud("terse_wrong_0123456789abcdef"), 2_000)).rejects.toThrow();
  });

  test("the inventory hint is empty without asking anyone; the TeamDirectory lists the teams", async () => {
    let asked = false;
    const fetchFn = Object.assign(
      async () => {
        asked = true;
        return new Response(null, { status: 500 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    expect(await listWorkforceTeamIds(cloud(), fetchFn)).toEqual([]);
    expect(asked).toBe(false);
  });
});
