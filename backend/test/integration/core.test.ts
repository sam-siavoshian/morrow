// End-to-end against a real `durable-actors dev` (actors/scripts/test-server.ts) and the real Bun server.
// GitHub is the local fake from test/support/fakeGithub.ts. Skips, loudly, only when Terse pieces are absent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MeView, ServerFrame, TeamView } from "@morrow/contracts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { silentLogger } from "../../src/lib/logger.ts";
import type { RunningServer } from "../../src/server.ts";
import { cookiesFrom } from "../support/app.ts";
import { testEnv } from "../support/env.ts";
import { startFakeGithub, type FakeGithub, type FakeUser } from "../support/fakeGithub.ts";

const TEST_SERVER = resolve(import.meta.dir, "../../../actors/scripts/test-server.ts");
const GENERATED = resolve(import.meta.dir, "../../src/generated/index.d.ts");
const ready = existsSync(TEST_SERVER) && existsSync(GENERATED);
if (!ready) console.warn(`SKIP integration: missing ${existsSync(TEST_SERVER) ? GENERATED : TEST_SERVER}`);

const ORIGIN = "http://localhost:3000";

const mkUser = (id: number, login: string, repos: FakeUser["repos"] = []): FakeUser => ({
  id,
  login,
  name: login[0]!.toUpperCase() + login.slice(1),
  avatarUrl: `https://avatars.example.com/u/${id}`,
  token: `gho_${login}_${crypto.randomUUID().slice(0, 8)}`,
  emails: [{ email: `${login}@example.com`, primary: true, verified: true }],
  repos,
});
const owner = mkUser(5001, "olivia", [
  { id: 901, fullName: "olivia/app", rootFiles: ["package.json", "bun.lock"], packageJson: JSON.stringify({ scripts: { test: "bun test" } }) },
  { id: 902, fullName: "olivia/readonly", permissions: { pull: true } },
  ...Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i, fullName: `olivia/filler-${i}` })),
]);
const member = mkUser(5002, "mateo");
const outsider = mkUser(5003, "oscar");
const latecomer = mkUser(5004, "lena");

let terse: { url: string; secret: string; stop(): Promise<void> } | undefined;
let gh: FakeGithub;
let running: RunningServer;
let base: string;

async function login(user: FakeUser, returnTo = "/t/next"): Promise<string> {
  const start = await fetch(`${base}/api/auth/github?returnTo=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = cookiesFrom(start).morrow_oauth_state!.value;
  const code = gh.issueCode(user);
  const cb = await fetch(`${base}/api/auth/github/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: { cookie: `morrow_oauth_state=${stateCookie}` },
  });
  expect(cb.status).toBe(302);
  expect(cb.headers.get("location")).toBe(`${ORIGIN}${returnTo}`);
  const session = cookiesFrom(cb).morrow_session;
  expect(session).toBeDefined();
  return `morrow_session=${session!.value}`;
}

function api(cookie: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers["x-morrow-csrf"] = "1";
    headers.origin = ORIGIN;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
}

async function openRealtime(cookie: string, teamId: string) {
  const res = await api(cookie, "POST", "/api/realtime/ticket", { teamId });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const ticket = new URL(url).searchParams.get("ticket")!;
  const ws = new WebSocket(`${base.replace("http", "ws")}/realtime?ticket=${encodeURIComponent(ticket)}`, { headers: { origin: ORIGIN } } as unknown as string[]);
  const frames: ServerFrame[] = [];
  const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const waitFor = async (pred: (f: ServerFrame) => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await Bun.sleep(25);
    }
    throw new Error(`frame not seen; got ${frames.map((f) => f.kind).join(",")}`);
  };
  return { ws, frames, closed, waitFor };
}

describe.skipIf(!ready)("integration: core backend against real Terse", () => {
  let ownerCookie: string;
  let memberCookie: string;
  let outsiderCookie: string;
  let teamId: string;
  let projectId: string;

  beforeAll(async () => {
    const { startTestServer } = (await import(TEST_SERVER)) as { startTestServer: () => Promise<typeof terse & {}> };
    terse = await startTestServer();
    gh = startFakeGithub();
    const env = testEnv({
      DURABLE_ACTORS_CONTROL_PLANE_URL: terse.url,
      DURABLE_ACTORS_SECRET: terse.secret,
      GITHUB_API_URL: gh.url,
      GITHUB_WEB_URL: gh.url,
      GITHUB_CLIENT_ID: gh.clientId,
      GITHUB_CLIENT_SECRET: gh.clientSecret,
    });
    const { createActorGateway } = await import("../../src/actors/gateway.ts");
    const { buildDeps, startServer } = await import("../../src/server.ts");
    const deps = await buildDeps(env, {
      actors: createActorGateway(env.terse, silentLogger),
      log: silentLogger,
      // Many sign-ins from one IP in a few seconds; the default auth bucket is covered by unit tests.
      rateLimits: { auth: { capacity: 500, refillPerSecond: 50 }, mutation: { capacity: 500, refillPerSecond: 50 } },
    });
    running = startServer(deps, { port: 0, hostname: "127.0.0.1" });
    base = `http://127.0.0.1:${running.server.port}`;
  }, 90_000);

  afterAll(async () => {
    await running?.shutdown("test done");
    await gh?.stop();
    await terse?.stop();
  }, 30_000);

  test("readyz sees Terse", async () => {
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toEqual({ ok: true, checks: { terse: "up", freestyle: expect.any(String), relay: expect.any(String) } });
    expect(JSON.stringify(body)).not.toMatch(/latency|sockets|teams|upstream/);
  });

  test("OAuth sign-in creates the user; /api/me reflects it; token is stored encrypted", async () => {
    ownerCookie = await login(owner);
    memberCookie = await login(member);
    outsiderCookie = await login(outsider);
    const me = (await (await api(ownerCookie, "GET", "/api/me")).json()) as MeView;
    expect(me).toEqual({
      user: { id: "u-5001", login: "olivia", name: "Olivia", avatarUrl: "https://avatars.example.com/u/5001" },
      teams: [],
      // GITHUB_WEB_URL points at the fake here, so links in the UI go there too.
      features: { freestyle: false, relay: false, githubWebUrl: gh.url.replace(/\/+$/, "") },
    });
    const enc = await running.deps.actors.getGithubTokenEnc("u-5001");
    expect(enc).toStartWith("v1.");
    expect(enc).not.toContain(owner.token);
  });

  test("signing in again keeps the same session version", async () => {
    const again = await login(owner);
    expect((await api(again, "GET", "/api/me")).status).toBe(200);
    expect((await api(ownerCookie, "GET", "/api/me")).status).toBe(200);
  });

  test("create team; owner sees it", async () => {
    const res = await api(ownerCookie, "POST", "/api/teams", { name: "  Rocket Crew!  " });
    expect(res.status).toBe(201);
    const team = (await res.json()) as TeamView;
    teamId = team.id;
    expect(team).toMatchObject({ name: "Rocket Crew!", slug: "rocket-crew", viewerRole: "owner", projects: [], environments: [], relayReady: false });
    expect(team.members).toEqual([{ userId: "u-5001", login: "olivia", name: "Olivia", avatarUrl: "https://avatars.example.com/u/5001", role: "owner" }]);
    const me = (await (await api(ownerCookie, "GET", "/api/me")).json()) as MeView;
    expect(me.teams).toEqual([{ id: teamId, name: "Rocket Crew!", slug: "rocket-crew", role: "owner" }]);
  });

  test("invites: hashed code, wrong code rejected, accept, idempotent re-accept, max uses", async () => {
    expect((await api(memberCookie, "POST", `/api/teams/${teamId}/invites`, {})).status).toBe(404);
    const res = await api(ownerCookie, "POST", `/api/teams/${teamId}/invites`, { maxUses: 1, expiresInHours: 1 });
    expect(res.status).toBe(201);
    const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: number };
    expect(url).toStartWith(`${ORIGIN}/join/${teamId}.`);
    expect(expiresAt).toBeGreaterThan(Date.now() + 59 * 60_000);
    const token = url.slice(`${ORIGIN}/join/`.length);

    const wrong = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect((await api(memberCookie, "POST", "/api/invites/accept", { token: wrong })).status).toBe(404);
    expect((await api(memberCookie, "POST", "/api/invites/accept", { token: `t-nope.${token.split(".").pop()}` })).status).toBe(404);

    const accepted = await api(memberCookie, "POST", "/api/invites/accept", { token });
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as TeamView).viewerRole).toBe("member");
    const again = await api(memberCookie, "POST", "/api/invites/accept", { token });
    expect(again.status).toBe(200);

    const lateCookie = await login(latecomer);
    const exhausted = await api(lateCookie, "POST", "/api/invites/accept", { token });
    expect(exhausted.status).toBe(409);
    expect(((await exhausted.json()) as any).error.code).toBe("conflict");

    const me = (await (await api(memberCookie, "GET", "/api/me")).json()) as MeView;
    expect(me.teams.map((t) => [t.id, t.role])).toEqual([[teamId, "member"]]);
  });

  test("authz matrix: team read, invites, ticket", async () => {
    const cases: Array<[string, string, string, unknown, Record<"owner" | "member" | "outsider", number>]> = [
      ["get team", "GET", `/api/teams/${teamId}`, undefined, { owner: 200, member: 200, outsider: 404 }],
      ["create invite", "POST", `/api/teams/${teamId}/invites`, {}, { owner: 201, member: 403, outsider: 404 }],
      ["realtime ticket", "POST", "/api/realtime/ticket", { teamId }, { owner: 200, member: 200, outsider: 404 }],
      ["link project", "POST", `/api/teams/${teamId}/projects`, { repoFullName: "olivia/nope" }, { owner: 404, member: 403, outsider: 404 }],
      ["unlink project", "DELETE", `/api/teams/${teamId}/projects/p-missing`, undefined, { owner: 404, member: 403, outsider: 404 }],
      ["remove owner", "DELETE", `/api/teams/${teamId}/members/u-5001`, undefined, { owner: 403, member: 403, outsider: 404 }],
    ];
    const cookies = { owner: ownerCookie, member: memberCookie, outsider: outsiderCookie };
    for (const [name, method, path, body, expected] of cases) {
      for (const who of ["owner", "member", "outsider"] as const) {
        const res = await api(cookies[who], method, path, body);
        expect({ name, who, status: res.status }).toEqual({ name, who, status: expected[who] });
      }
      expect((await api(null, method, path, body)).status).toBe(401);
    }
    expect((await api(ownerCookie, "GET", "/api/teams/t-doesnotexist")).status).toBe(404);
    expect((await api(ownerCookie, "GET", "/api/teams/bad%20id")).status).toBe(404);
  });

  test("link project: push access verified, test command detected, duplicates refused", async () => {
    const readonly = await api(ownerCookie, "POST", `/api/teams/${teamId}/projects`, { repoFullName: "olivia/readonly" });
    expect(readonly.status).toBe(403);
    const missing = await api(ownerCookie, "POST", `/api/teams/${teamId}/projects`, { repoFullName: "olivia/ghost" });
    expect(missing.status).toBe(404);
    const bad = await api(ownerCookie, "POST", `/api/teams/${teamId}/projects`, { repoFullName: "../../etc" });
    expect(bad.status).toBe(400);

    const res = await api(ownerCookie, "POST", `/api/teams/${teamId}/projects`, { repoFullName: "OLIVIA/app" });
    expect(res.status).toBe(201);
    const project = await res.json() as any;
    projectId = project.id;
    expect(project).toEqual({ id: projectId, repoFullName: "olivia/app", defaultBranch: "main", testCommand: "bun run test" });
    expect((await api(ownerCookie, "POST", `/api/teams/${teamId}/projects`, { repoFullName: "olivia/app" })).status).toBe(409);

    const custom = await api(ownerCookie, "POST", `/api/teams/${teamId}/projects`, { repoFullName: "olivia/filler-3", testCommand: "make check" });
    expect(((await custom.json()) as any).testCommand).toBe("make check");

    const team = (await (await api(memberCookie, "GET", `/api/teams/${teamId}`)).json()) as TeamView;
    expect(team.projects.map((p) => p.repoFullName)).toEqual(["olivia/app", "olivia/filler-3"]);
  });

  test("GitHub repo listing: pages and search", async () => {
    const p1 = await (await api(ownerCookie, "GET", "/api/github/repos?perPage=50")).json() as any;
    expect(p1.repos).toHaveLength(50);
    expect(p1.nextPage).toBe(2);
    const search = await (await api(ownerCookie, "GET", "/api/github/repos?q=filler-11&perPage=5")).json() as any;
    expect(search.repos.map((r: { fullName: string }) => r.fullName)).toEqual(["olivia/filler-11", "olivia/filler-110", "olivia/filler-111", "olivia/filler-112", "olivia/filler-113"]);
    expect(search.nextPage).toBe(2);
    expect((await api(ownerCookie, "GET", "/api/github/repos?perPage=1000")).status).toBe(400);
  });

  test("realtime: real actor snapshots, live updates, removal disconnects", async () => {
    const ownerRt = await openRealtime(ownerCookie, teamId);
    const memberRt = await openRealtime(memberCookie, teamId);
    await ownerRt.waitFor((f) => f.kind === "hello");
    const tv = (await memberRt.waitFor((f) => f.kind === "team.view")) as Extract<ServerFrame, { kind: "team.view" }>;
    expect(tv.data.viewerRole).toBe("member");
    expect(tv.data.projects.length).toBe(2);
    await memberRt.waitFor((f) => f.kind === "workforce.view");

    expect((await api(ownerCookie, "DELETE", `/api/teams/${teamId}/projects/${projectId}`)).status).toBe(204);
    expect((await api(ownerCookie, "DELETE", `/api/teams/${teamId}/projects/${projectId}`)).status).toBe(404);
    await ownerRt.waitFor((f) => f.kind === "team.view" && f.data.projects.length === 1);

    expect((await api(ownerCookie, "DELETE", `/api/teams/${teamId}/members/u-5002`)).status).toBe(204);
    expect(await memberRt.closed).toBe(4003);
    expect((await api(memberCookie, "GET", `/api/teams/${teamId}`)).status).toBe(404);
    const me = (await (await api(memberCookie, "GET", "/api/me")).json()) as MeView;
    expect(me.teams).toEqual([]);
    ownerRt.ws.close();
  });

  test("members can leave; owner cannot", async () => {
    const res = await api(ownerCookie, "POST", `/api/teams/${teamId}/invites`, {});
    const token = ((await res.json()) as { url: string }).url.slice(`${ORIGIN}/join/`.length);
    expect((await api(memberCookie, "POST", "/api/invites/accept", { token })).status).toBe(201);
    expect((await api(ownerCookie, "DELETE", `/api/teams/${teamId}/members/u-5001`)).status).toBe(403);
    expect((await api(memberCookie, "DELETE", `/api/teams/${teamId}/members/u-5002`)).status).toBe(204);
    expect((await api(memberCookie, "GET", `/api/teams/${teamId}`)).status).toBe(404);
  });

  test("settings: owner promotes and demotes, admins rename and set policy, read back from the actor", async () => {
    const lateCookie = await login(latecomer);
    const inv = await api(ownerCookie, "POST", `/api/teams/${teamId}/invites`, {});
    const created = (await inv.json()) as { id: string; url: string };
    expect(created.id).toStartWith("inv-");
    expect((await api(lateCookie, "POST", "/api/invites/accept", { token: created.url.slice(`${ORIGIN}/join/`.length) })).status).toBe(201);

    // Members cannot promote themselves; the owner can promote them.
    expect((await api(lateCookie, "PATCH", `/api/teams/${teamId}/members/u-5004`, { role: "admin" })).status).toBe(403);
    const promoted = await api(ownerCookie, "PATCH", `/api/teams/${teamId}/members/u-5004`, { role: "admin" });
    expect(promoted.status).toBe(200);
    expect(((await promoted.json()) as TeamView).members.find((m) => m.userId === "u-5004")!.role).toBe("admin");
    expect((await api(ownerCookie, "PATCH", `/api/teams/${teamId}/members/u-5004`, { role: "admin" })).status).toBe(200);

    // Admin powers now apply; role changes stay owner-only, and the owner cannot demote themselves.
    const renamed = await api(lateCookie, "PATCH", `/api/teams/${teamId}`, { name: "  Rocket Crew 2  " });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()) as TeamView).toMatchObject({ name: "Rocket Crew 2", slug: "rocket-crew", viewerRole: "admin" });
    const policy = await api(lateCookie, "PATCH", `/api/teams/${teamId}/policy`, { maxParallelPerTask: 2 });
    expect(((await policy.json()) as TeamView).policy).toEqual({ allowInspect: true, maxParallelPerTask: 2 });
    const inspectOff = await api(ownerCookie, "PATCH", `/api/teams/${teamId}/policy`, { allowInspect: false });
    expect(((await inspectOff.json()) as TeamView).policy).toEqual({ allowInspect: false, maxParallelPerTask: 2 });
    expect((await api(lateCookie, "PATCH", `/api/teams/${teamId}/members/u-5001`, { role: "member" })).status).toBe(403);
    expect((await api(ownerCookie, "PATCH", `/api/teams/${teamId}/members/u-5001`, { role: "member" })).status).toBe(403);
    expect((await api(lateCookie, "GET", `/api/teams/${teamId}/invites`)).status).toBe(200);

    // Demoted again: admin routes close at once.
    expect((await api(ownerCookie, "PATCH", `/api/teams/${teamId}/members/u-5004`, { role: "member" })).status).toBe(200);
    expect((await api(lateCookie, "PATCH", `/api/teams/${teamId}`, { name: "Nope" })).status).toBe(403);
    const me = (await (await api(ownerCookie, "GET", "/api/me")).json()) as MeView;
    expect(me.teams.find((t) => t.id === teamId)!.name).toBe("Rocket Crew 2");
    await api(ownerCookie, "PATCH", `/api/teams/${teamId}/policy`, { allowInspect: true, maxParallelPerTask: 3 });
  });

  test("invite preview: team and inviter for a good link, one identical 404 for everything else", async () => {
    const inv = await api(ownerCookie, "POST", `/api/teams/${teamId}/invites`, { maxUses: 1 });
    const { url, expiresAt } = (await inv.json()) as { url: string; expiresAt: number };
    const token = url.slice(`${ORIGIN}/join/`.length);
    const preview = (t: string | null, cookie: string | null = outsiderCookie) =>
      api(cookie, "GET", t === null ? "/api/invites/preview" : `/api/invites/preview?token=${encodeURIComponent(t)}`);

    const ok = await preview(token);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toEqual({ teamName: "Rocket Crew 2", inviter: { login: "olivia", avatarUrl: "https://avatars.example.com/u/5001" }, expiresAt });
    expect(JSON.stringify(body)).not.toContain(token.split(".").pop()!);
    expect((await preview(token, null)).status).toBe(401);

    const code = token.split(".").pop()!;
    const usedUp = await api(ownerCookie, "POST", `/api/teams/${teamId}/invites`, { maxUses: 1 });
    const usedToken = ((await usedUp.json()) as { url: string }).url.slice(`${ORIGIN}/join/`.length);
    const racer = await login(mkUser(5099, "used"));
    expect((await api(racer, "POST", "/api/invites/accept", { token: usedToken })).status).toBe(201);

    const refusals = [
      `t-doesnotexist.${code}`,
      `${teamId}.${code.slice(0, -1)}${code.endsWith("A") ? "B" : "A"}`,
      usedToken,
      "garbage",
      `${teamId}.short`,
      "",
      null,
    ];
    const bodies = [];
    for (const bad of refusals) {
      const res = await preview(bad);
      expect({ bad, status: res.status }).toEqual({ bad, status: 404 });
      bodies.push(await res.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ error: { code: "not_found", message: "This invite link is not valid." } });
    // The preview consumed nothing: the good link still admits one person.
    expect((await api(outsiderCookie, "POST", "/api/invites/accept", { token })).status).toBe(201);
    expect((await api(outsiderCookie, "DELETE", `/api/teams/${teamId}/members/u-5003`)).status).toBe(204);
  });

  test("invites: list and revoke; a removed member cannot rejoin with the same link (H1)", async () => {
    const inv = await api(ownerCookie, "POST", `/api/teams/${teamId}/invites`, { maxUses: 10 });
    expect(inv.status).toBe(201);
    const { id, url } = (await inv.json()) as { id: string; url: string };
    const token = url.slice(`${ORIGIN}/join/`.length);
    const listed = (await (await api(ownerCookie, "GET", `/api/teams/${teamId}/invites`)).json()) as { invites: Array<{ id: string }> };
    expect(listed.invites[0]).toMatchObject({ id, createdBy: "u-5001", uses: 0, maxUses: 10 });
    expect(JSON.stringify(listed)).not.toContain(token.split(".").pop()!);

    const lateCookie = await login(latecomer);
    expect((await api(ownerCookie, "DELETE", `/api/teams/${teamId}/members/u-5004`)).status).toBe(204);
    const viewer = await login(mkUser(5098, "victor"));
    expect((await api(viewer, "POST", "/api/invites/accept", { token })).status).toBe(201);
    // Removed: the same link is refused, with the same answer as a bad link, and the preview hides the team.
    const rejoin = await api(lateCookie, "POST", "/api/invites/accept", { token });
    expect(rejoin.status).toBe(404);
    expect(((await rejoin.json()) as any).error.message).toBe("This invite link is not valid.");
    expect((await api(lateCookie, "GET", `/api/invites/preview?token=${encodeURIComponent(token)}`)).status).toBe(404);

    // Revoked: nobody can use it, and it leaves the list.
    expect((await api(ownerCookie, "DELETE", `/api/teams/${teamId}/invites/${id}`)).status).toBe(204);
    expect((await api(ownerCookie, "DELETE", `/api/teams/${teamId}/invites/${id}`)).status).toBe(404);
    const stranger = await login(mkUser(5097, "rita"));
    expect((await api(stranger, "GET", `/api/invites/preview?token=${encodeURIComponent(token)}`)).status).toBe(404);
    expect((await api(stranger, "POST", "/api/invites/accept", { token })).status).toBe(404);
    const after = (await (await api(ownerCookie, "GET", `/api/teams/${teamId}/invites`)).json()) as { invites: Array<{ id: string }> };
    expect(after.invites.some((i) => i.id === id)).toBe(false);

    // A fresh link is the explicit way back.
    const fresh = await api(ownerCookie, "POST", `/api/teams/${teamId}/invites`, {});
    const freshToken = ((await fresh.json()) as { url: string }).url.slice(`${ORIGIN}/join/`.length);
    expect((await api(lateCookie, "POST", "/api/invites/accept", { token: freshToken })).status).toBe(201);
    expect((await api(memberCookie, "GET", `/api/teams/${teamId}/invites`)).status).toBe(404);
  });

  test("logout everywhere revokes every existing cookie", async () => {
    const second = await login(outsider);
    expect((await api(outsiderCookie, "POST", "/api/auth/logout?everywhere=1")).status).toBe(204);
    expect((await api(outsiderCookie, "GET", "/api/me")).status).toBe(401);
    expect((await api(second, "GET", "/api/me")).status).toBe(401);
    const fresh = await login(outsider);
    expect((await api(fresh, "GET", "/api/me")).status).toBe(200);
  });

  test("concurrent team creation and invite acceptance stay consistent", async () => {
    // The owner already owns one team; the cap is 5 owned teams, and a burst cannot slip past it.
    const created = await Promise.all(Array.from({ length: 8 }, (_, i) => api(ownerCookie, "POST", "/api/teams", { name: `Parallel ${i}` })));
    expect(created.map((r) => r.status).sort()).toEqual([201, 201, 201, 201, 409, 409, 409, 409]);
    const refused = created.find((r) => r.status === 409)!;
    expect(((await refused.json()) as any).error.message).toBe("You can own at most 5 teams.");
    const me = (await (await api(ownerCookie, "GET", "/api/me")).json()) as MeView;
    expect(me.teams.filter((t) => t.role === "owner").length).toBe(5);

    const inv = await api(ownerCookie, "POST", `/api/teams/${teamId}/invites`, { maxUses: 2 });
    const token = ((await inv.json()) as { url: string }).url.slice(`${ORIGIN}/join/`.length);
    const racers = await Promise.all(Array.from({ length: 4 }, (_, i) => mkUser(6000 + i, `racer${i}`)).map((u) => login(u)));
    const results = await Promise.all(racers.map((c) => api(c, "POST", "/api/invites/accept", { token })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 409, 409]);
  });
});
