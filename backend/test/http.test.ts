import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { UserRecord } from "../src/actors/types.ts";
import type { TeamRouteModule } from "../src/http/app.ts";
import type { AppEnv } from "../src/http/context.ts";
import { resolveClientIp } from "../src/http/middleware.ts";
import { RateLimiter } from "../src/http/rateLimit.ts";
import { OAUTH_STATE_COOKIE, safeReturnTo } from "../src/http/routes/auth.ts";
import { parseInviteToken } from "../src/http/routes/core.ts";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, SessionService } from "../src/http/session.ts";
import { invoke } from "../src/actors/invoke.ts";
import { encrypt, importAesKey, randomBytes } from "../src/lib/crypto.ts";
import { silentLogger } from "../src/lib/logger.ts";
import { cookiesFrom, makeTestApp, ORIGIN, unreachableActors } from "./support/app.ts";

const user = (sessionVersion: number): UserRecord => ({
  id: "u-1",
  githubId: 1,
  login: "alice",
  name: null,
  avatarUrl: null,
  email: null,
  sessionVersion,
  teamIds: [],
});

const noStackLeak = async (res: Response) => {
  const text = await res.text();
  expect(text).not.toMatch(/\bat .*\.ts|stack|Error:|exploded|node_modules/);
  return JSON.parse(text);
};

describe("session cookie", () => {
  async function setup(opts: { now?: () => number; ttl?: number } = {}) {
    const key = await importAesKey(randomBytes(32));
    let sv = 0;
    let lookups = 0;
    const sessions = new SessionService({
      key,
      secure: false,
      now: opts.now,
      versionCacheTtlMs: opts.ttl,
      actors: { getUser: async (id) => (lookups++, id === "u-1" ? user(sv) : null) },
    });
    const app = new Hono();
    app.get("/", async (c) => c.text(String(await sessions.authenticate(c))));
    app.get("/issue", async (c) => (await sessions.issue(c, "u-1", sv), c.text("ok")));
    const call = (cookie?: string) => app.request("http://x/", { headers: cookie ? { cookie } : {} });
    return { key, sessions, call, app, bump: () => sv++, lookups: () => lookups };
  }

  test("encode/decode round trip; cookie flags", async () => {
    const { sessions, app } = await setup();
    const res = await app.request("http://x/issue");
    const raw = res.headers.get("set-cookie")!;
    expect(raw).toContain(`${SESSION_COOKIE}=v1.`);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).not.toMatch(/Secure/i);
    expect(raw).toContain(`Max-Age=${SESSION_MAX_AGE_MS / 1000}`);
    const token = cookiesFrom(res)[SESSION_COOKIE]!.value;
    expect(await sessions.decode(token)).toMatchObject({ uid: "u-1", sv: 0 });
  });

  test("valid cookie authenticates; tampered, foreign-key and garbage do not", async () => {
    const { sessions, call } = await setup();
    const token = await sessions.encode({ uid: "u-1", sv: 0, exp: Date.now() + 60_000 });
    expect(await (await call(`${SESSION_COOKIE}=${token}`)).text()).toBe("u-1");
    const tampered = token.slice(0, -3) + (token.endsWith("A") ? "BBB" : "AAA");
    expect(await (await call(`${SESSION_COOKIE}=${tampered}`)).text()).toBe("null");
    const other = await importAesKey(randomBytes(32));
    const foreign = await encrypt(other, JSON.stringify({ uid: "u-1", sv: 0, exp: Date.now() + 60_000 }), "morrow:session:v1");
    expect(await (await call(`${SESSION_COOKIE}=${foreign}`)).text()).toBe("null");
    expect(await (await call(`${SESSION_COOKIE}=garbage`)).text()).toBe("null");
    expect(await (await call()).text()).toBe("null");
  });

  test("expired cookie is rejected", async () => {
    let now = 1_000_000;
    const { sessions, call } = await setup({ now: () => now });
    const token = await sessions.encode({ uid: "u-1", sv: 0, exp: now + 1000 });
    expect(await (await call(`${SESSION_COOKIE}=${token}`)).text()).toBe("u-1");
    now += 1001;
    expect(await (await call(`${SESSION_COOKIE}=${token}`)).text()).toBe("null");
  });

  test("version bump revokes; cache honors TTL; forgetVersion revokes at once", async () => {
    let now = 1_000_000;
    const { sessions, call, bump, lookups } = await setup({ now: () => now, ttl: 30_000 });
    const cookie = `${SESSION_COOKIE}=${await sessions.encode({ uid: "u-1", sv: 0, exp: now + SESSION_MAX_AGE_MS })}`;
    expect(await (await call(cookie)).text()).toBe("u-1");
    expect(await (await call(cookie)).text()).toBe("u-1");
    expect(lookups()).toBe(1);
    bump();
    // Within the 30 s cache window another instance's bump is not yet visible.
    expect(await (await call(cookie)).text()).toBe("u-1");
    now += 30_001;
    expect(await (await call(cookie)).text()).toBe("null");
    // Same-process bump: immediate.
    const { sessions: s2, call: call2, bump: bump2 } = await setup({ ttl: 30_000 });
    const c2 = `${SESSION_COOKIE}=${await s2.encode({ uid: "u-1", sv: 0, exp: Date.now() + SESSION_MAX_AGE_MS })}`;
    expect(await (await call2(c2)).text()).toBe("u-1");
    bump2();
    s2.forgetVersion("u-1");
    expect(await (await call2(c2)).text()).toBe("null");
  });

  test("sliding refresh past half life, not before; unknown user rejected", async () => {
    let now = 1_000_000;
    const { sessions, call } = await setup({ now: () => now });
    const fresh = await call(`${SESSION_COOKIE}=${await sessions.encode({ uid: "u-1", sv: 0, exp: now + SESSION_MAX_AGE_MS })}`);
    expect(fresh.headers.get("set-cookie")).toBeNull();
    const old = await call(`${SESSION_COOKIE}=${await sessions.encode({ uid: "u-1", sv: 0, exp: now + SESSION_MAX_AGE_MS / 2 - 1 })}`);
    const refreshed = cookiesFrom(old)[SESSION_COOKIE]!.value;
    expect((await sessions.decode(refreshed))!.exp).toBe(now + SESSION_MAX_AGE_MS);
    const ghost = await call(`${SESSION_COOKIE}=${await sessions.encode({ uid: "u-404", sv: 0, exp: now + 1000 })}`);
    expect(await ghost.text()).toBe("null");
  });
});

describe("CSRF and origin", () => {
  test("mutations need the header and APP_ORIGIN, before anything else runs", async () => {
    const { request } = await makeTestApp();
    const post = (headers: Record<string, string>) =>
      request("/api/teams", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: '{"name":"x"}' });
    const variants: Array<Record<string, string>> = [
      {},
      { origin: ORIGIN },
      { "x-morrow-csrf": "1" },
      { "x-morrow-csrf": "1", origin: "https://evil.example" },
      { "x-morrow-csrf": "0", origin: ORIGIN },
      { "x-morrow-csrf": "1", origin: "null" },
    ];
    for (const headers of variants) {
      const res = await post(headers);
      expect(res.status).toBe(403);
      expect((await noStackLeak(res)).error.code).toBe("forbidden");
    }
    // Correct CSRF, no session: authentication is the next gate.
    const res = await post({ "x-morrow-csrf": "1", origin: ORIGIN });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe("unauthenticated");
  });

  test("DELETE is a mutation too; GET is not", async () => {
    const { request } = await makeTestApp();
    expect((await request("/api/teams/t-1/members/u-2", { method: "DELETE" })).status).toBe(403);
    expect((await request("/api/me")).status).toBe(401);
  });
});

describe("OAuth", () => {
  test("start sets a state cookie scoped to /api/auth and redirects to GitHub", async () => {
    const { request, deps } = await makeTestApp({ env: { GITHUB_WEB_URL: "https://github.example" } });
    const res = await request("/api/auth/github?returnTo=/t/abc");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.example/login/oauth/authorize");
    expect(loc.searchParams.get("scope")).toBe("read:user user:email repo");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${deps.env.appOrigin}/api/auth/github/callback`);
    expect(loc.searchParams.get("state")!.length).toBeGreaterThanOrEqual(43);
    const raw = cookiesFrom(res)[OAUTH_STATE_COOKIE]!.raw;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\/api\/auth/);
    expect(raw).toContain("Max-Age=600");
  });

  test("Secure cookies when APP_ORIGIN is https", async () => {
    const { request } = await makeTestApp({ env: { APP_ORIGIN: "https://app.example.com" } });
    const res = await request("/api/auth/github");
    expect(cookiesFrom(res)[OAUTH_STATE_COOKIE]!.raw).toMatch(/; Secure/i);
  });

  test("callback rejects state mismatch, missing cookie, expired state, user denial", async () => {
    let now = 1_000_000;
    const { request } = await makeTestApp({ now: () => now });
    const start = await request("/api/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cookie = `${OAUTH_STATE_COOKIE}=${cookiesFrom(start)[OAUTH_STATE_COOKIE]!.value}`;
    const expectLoginError = async (res: Response, error: string) => {
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/login?error=${error}`);
    };
    await expectLoginError(await request(`/api/auth/github/callback?code=abc&state=wrong${state}`, { cookie }), "state_mismatch");
    await expectLoginError(await request(`/api/auth/github/callback?code=abc&state=${state}`), "state_mismatch");
    await expectLoginError(await request(`/api/auth/github/callback?code=abc&state=${state}`, { cookie: `${OAUTH_STATE_COOKIE}=v1.AAAA.BBBB` }), "state_mismatch");
    await expectLoginError(await request(`/api/auth/github/callback?error=access_denied&state=${state}`, { cookie }), "access_denied");
    now += 10 * 60 * 1000 + 1;
    await expectLoginError(await request(`/api/auth/github/callback?code=abc&state=${state}`, { cookie }), "state_mismatch");
  });

  test("callback always clears the state cookie (single use)", async () => {
    const { request } = await makeTestApp();
    const res = await request("/api/auth/github/callback?code=x&state=y");
    expect(cookiesFrom(res)[OAUTH_STATE_COOKIE]!.raw).toContain("Max-Age=0");
  });

  test("returnTo allows only same-site relative paths", () => {
    expect(safeReturnTo("/t/abc?x=1#y")).toBe("/t/abc?x=1#y");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "\\\\evil", "javascript:alert(1)", "evil", "/a\nb", undefined, ""]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });
});

describe("logout", () => {
  test("clears the cookie without a session; everywhere requires one", async () => {
    const { request } = await makeTestApp();
    const res = await request("/api/auth/logout", { method: "POST", csrf: true });
    expect(res.status).toBe(204);
    expect(cookiesFrom(res)[SESSION_COOKIE]!.raw).toContain("Max-Age=0");
    expect((await request("/api/auth/logout?everywhere=1", { method: "POST", csrf: true })).status).toBe(401);
    expect((await request("/api/auth/logout", { method: "POST" })).status).toBe(403);
  });
});

describe("error responses", () => {
  async function signedIn(getUser: () => Promise<UserRecord | null>, modules?: TeamRouteModule[]) {
    const t = await makeTestApp({ actors: unreachableActors({ getUser }), modules });
    const token = await t.deps.sessions.encode({ uid: "u-1", sv: 0, exp: Date.now() + 60_000 });
    return { ...t, cookie: `${SESSION_COOKIE}=${token}` };
  }

  test("unexpected errors become a generic 500 with no internals", async () => {
    const { request, cookie } = await signedIn(async () => {
      throw new Error("db exploded at /srv/app/secret.ts:12");
    });
    const res = await request("/api/me", { cookie });
    expect(res.status).toBe(500);
    expect(await noStackLeak(res)).toEqual({ error: { code: "internal", message: "Something went wrong." } });
  });

  test("Terse outages become 503 dependency_unavailable", async () => {
    const raw = Object.assign(new Error("host not ready at 127.0.0.1:7100"), { name: "ActorInvocationError", code: "unavailable", requestId: "r" });
    // What the real gateway throws after its retries: invoke() translates the raw invocation error.
    const { request, cookie } = await signedIn(() =>
      invoke(() => Promise.reject(raw), { op: "User.get", idempotent: true }, { log: silentLogger, retry: { attempts: 2, sleep: async () => {} } }),
    );
    const res = await request("/api/me", { cookie });
    expect(res.status).toBe(503);
    const body = await noStackLeak(res);
    expect(body.error.code).toBe("dependency_unavailable");
    expect(JSON.stringify(body)).not.toContain("7100");
  });

  test("a module route that throws is contained", async () => {
    const { request, cookie } = await signedIn(async () => user(0), [
      (teams: Hono<AppEnv>) =>
        teams.get("/:teamId/boom", () => {
          throw new TypeError("Cannot read properties of undefined (reading 'secret')");
        }),
    ]);
    const res = await request("/api/teams/t-1/boom", { cookie });
    expect(res.status).toBe(500);
    expect(await noStackLeak(res)).toEqual({ error: { code: "internal", message: "Something went wrong." } });
  });

  test("bad bodies: malformed JSON, wrong content type, schema errors, oversize", async () => {
    const { request, cookie } = await signedIn(async () => user(0));
    const post = (body: string, type = "application/json") =>
      request("/api/teams", { method: "POST", csrf: true, cookie, headers: { "content-type": type }, body });
    let res = await post("{nope");
    expect(res.status).toBe(400);
    expect((await noStackLeak(res)).error).toEqual({ code: "bad_request", message: "Malformed JSON." });
    res = await post('{"name":"x"}', "text/plain");
    expect(res.status).toBe(400);
    res = await post('{"name":""}');
    expect(res.status).toBe(400);
    const body = await noStackLeak(res);
    expect(body.error.message).toContain("name");
    res = await post(JSON.stringify({ name: "evil\nname" }));
    expect(res.status).toBe(400);
    expect((await noStackLeak(res)).error.message).toContain("single line");
    res = await post(JSON.stringify({ name: "x".repeat(70 * 1024) }));
    expect(res.status).toBe(413);
    expect((await noStackLeak(res)).error.code).toBe("bad_request");
  });

  test("unknown routes are JSON 404; security headers everywhere", async () => {
    const { request } = await makeTestApp();
    const res = await request("/nope");
    expect(res.status).toBe(404);
    expect((await res.json()) as any).toEqual({ error: { code: "not_found", message: "Not found." } });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toMatch(/^req-/);
  });

  test("healthz is public and cheap", async () => {
    const { request } = await makeTestApp();
    const res = await request("/healthz");
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true });
  });

  test("readyz reports Terse down as 503 without details", async () => {
    const { request } = await makeTestApp({
      actors: unreachableActors({
        ping: async () => {
          throw new Error("ECONNREFUSED 127.0.0.1:7100 secret-ish detail");
        },
      }),
    });
    const res = await request("/readyz");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("ECONNREFUSED");
    // Up/down only: no latency, no socket counts, no error text.
    expect(JSON.parse(text)).toEqual({ ok: false, checks: { terse: "down", freestyle: "disabled", relay: "disabled" } });
  });
});

describe("rate limiting", () => {
  test("token bucket: burst, refill, isolation", () => {
    let now = 0;
    const rl = new RateLimiter({ now: () => now, limits: { mutation: { capacity: 3, refillPerSecond: 1 } } });
    expect([1, 2, 3].map(() => rl.take("mutation", "u-1").ok)).toEqual([true, true, true]);
    const denied = rl.take("mutation", "u-1");
    expect(denied).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(rl.take("mutation", "u-2").ok).toBe(true);
    expect(rl.take("read", "u-1").ok).toBe(true);
    now += 1000;
    expect(rl.take("mutation", "u-1").ok).toBe(true);
    expect(rl.take("mutation", "u-1").ok).toBe(false);
  });

  test("memory is bounded: sweep drops full buckets, LRU cap evicts", () => {
    let now = 0;
    const rl = new RateLimiter({ now: () => now, maxKeys: 100 });
    for (let i = 0; i < 500; i++) rl.take("read", `u-${i}`);
    expect(rl.size).toBe(100);
    now += 3_600_000;
    rl.sweep();
    expect(rl.size).toBe(0);
  });

  test("auth routes are limited per client and answer 429 with Retry-After", async () => {
    const { request } = await makeTestApp();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await request("/api/auth/github")).status);
    expect(statuses.slice(0, 20).every((s) => s === 302)).toBe(true);
    const res = await request("/api/auth/github");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(((await res.json()) as any).error.code).toBe("rate_limited");
  });
});

describe("client IP behind trusted proxies", () => {
  test("hops 0 uses the socket peer and ignores X-Forwarded-For entirely", () => {
    expect(resolveClientIp("6.6.6.6", "203.0.113.9", 0)).toBe("203.0.113.9");
    expect(resolveClientIp(undefined, "203.0.113.9", 0)).toBe("203.0.113.9");
    expect(resolveClientIp("6.6.6.6", undefined, 0)).toBe("unknown");
  });

  test("hops 1 takes the entry the one trusted proxy appended; spoofed entries to its left are ignored", () => {
    expect(resolveClientIp("198.51.100.4", "10.0.0.2", 1)).toBe("198.51.100.4");
    expect(resolveClientIp("6.6.6.6, 7.7.7.7, 198.51.100.4", "10.0.0.2", 1)).toBe("198.51.100.4");
    expect(resolveClientIp("6.6.6.6,198.51.100.4", "10.0.0.2", 1)).toBe("198.51.100.4");
  });

  test("hops 2 skips the second proxy's own entry", () => {
    expect(resolveClientIp("6.6.6.6, 198.51.100.4, 10.0.0.1", "10.0.0.2", 2)).toBe("198.51.100.4");
    expect(resolveClientIp("198.51.100.4, 10.0.0.1", "10.0.0.2", 2)).toBe("198.51.100.4");
  });

  test("a missing or short header falls back to the leftmost hop, never past the chain", () => {
    expect(resolveClientIp(undefined, "10.0.0.2", 1)).toBe("10.0.0.2");
    expect(resolveClientIp("", "10.0.0.2", 2)).toBe("10.0.0.2");
    expect(resolveClientIp("198.51.100.4", "10.0.0.2", 3)).toBe("198.51.100.4");
  });

  test("garbage in the selected slot falls back to the peer; ports, brackets and mapped IPv4 normalize", () => {
    expect(resolveClientIp("6.6.6.6, not-an-ip", "10.0.0.2", 1)).toBe("10.0.0.2");
    expect(resolveClientIp("6.6.6.6, <script>", "10.0.0.2", 1)).toBe("10.0.0.2");
    expect(resolveClientIp(`6.6.6.6, ${"1".repeat(100)}`, "10.0.0.2", 1)).toBe("10.0.0.2");
    expect(resolveClientIp(" , ,, ", "10.0.0.2", 1)).toBe("10.0.0.2");
    expect(resolveClientIp("198.51.100.4:51234", "10.0.0.2", 1)).toBe("198.51.100.4");
    expect(resolveClientIp("[2001:DB8::1]:443", "10.0.0.2", 1)).toBe("2001:db8::1");
    expect(resolveClientIp("2001:db8::1", "10.0.0.2", 1)).toBe("2001:db8::1");
    expect(resolveClientIp(undefined, "::ffff:127.0.0.1", 0)).toBe("127.0.0.1");
  });

  test("pre-auth limit: rotating the spoofable left part does not mint new buckets; the appended hop does", async () => {
    const { request } = await makeTestApp({ env: { TRUSTED_PROXY_HOPS: "1" } });
    const hit = (xff: string) => request("/api/auth/github", { headers: { "x-forwarded-for": xff } });
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await hit(`10.9.${i}.1, 198.51.100.4`)).status);
    expect(statuses.slice(0, 20).every((s) => s === 302)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await hit("198.51.100.5")).status).toBe(302);
  });
});

describe("invite tokens", () => {
  test("parse <teamId>.<code>, split on the last dot", () => {
    const code = "A".repeat(43);
    expect(parseInviteToken(`t-abc.${code}`)).toEqual({ teamId: "t-abc", code });
    expect(parseInviteToken(`t.with.dots.${code}`)).toEqual({ teamId: "t.with.dots", code });
    for (const bad of [code, `.${code}`, `t-abc.${code}x`, `t-abc.${"A".repeat(42)}`, `t/abc.${code}`, `t-abc.${"A".repeat(42)}=`]) {
      expect(parseInviteToken(bad)).toBeNull();
    }
  });
});

describe("app wiring", () => {
  test("team module seam receives the signed-in teams router", async () => {
    let mounted = false;
    await makeTestApp({
      modules: [
        (teams: Hono<AppEnv>) => {
          mounted = typeof teams.get === "function";
        },
      ],
    });
    expect(mounted).toBe(true);
  });
});
