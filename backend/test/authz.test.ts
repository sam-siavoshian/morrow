// Role matrix for every team route, including `admin`. Terse is replaced by a fixed team fixture at the gateway
// boundary; GitHub is the local fake.
// The same routes run against real Terse in test/integration/core.test.ts for owner/member/outsider.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Role } from "@morrow/contracts";
import type { AcceptInviteResult, ActorGateway, TeamRecord, UserRecord } from "../src/actors/types.ts";
import { encryptGithubToken } from "../src/http/githubAccess.ts";
import { SESSION_COOKIE } from "../src/http/session.ts";
import { makeTestApp, unreachableActors, type TestApp } from "./support/app.ts";
import { startFakeGithub, type FakeGithub } from "./support/fakeGithub.ts";

const TEAM = "t-matrix";
const people: Array<[string, Role | null]> = [
  ["u-owner", "owner"],
  ["u-admin", "admin"],
  ["u-admin2", "admin"],
  ["u-member", "member"],
  ["u-member2", "member"],
  ["u-out", null],
];

let gh: FakeGithub;
let t: TestApp;
let acceptResult: AcceptInviteResult = { ok: true, role: "member", alreadyMember: false };
const calls: string[] = [];
const cookies: Record<string, string> = {};

const teamRecord = (): TeamRecord => ({
  id: TEAM,
  name: "Matrix",
  slug: "matrix",
  members: people.filter(([, r]) => r).map(([userId, role]) => ({ userId, role: role!, login: userId.slice(2), name: null, avatarUrl: null })),
  projects: [
    { id: "p-linked", repoFullName: "owner/linked", defaultBranch: "main", testCommand: null },
    { id: "p-raced", repoFullName: "owner/raced", defaultBranch: "main", testCommand: null },
  ],
  environments: [],
  policy: { allowInspect: true, maxParallelPerTask: 3 },
  relayReady: false,
});

beforeAll(async () => {
  gh = startFakeGithub();
  for (const [id] of people) gh.addUser({ id: 1, login: id.slice(2), token: `tok-${id}`, repos: [{ id: 77, fullName: "owner/repo" }] });
  const users = new Map<string, UserRecord>(
    people.map(([id]) => [id, { id, githubId: 1, login: id.slice(2), name: null, avatarUrl: null, email: null, sessionVersion: 1, teamIds: [TEAM] }]),
  );
  const tokenEnc = new Map<string, string>();
  const actors: Partial<ActorGateway> = {
    getUser: async (id) => users.get(id) ?? null,
    getTeam: async (id) => (id === TEAM ? teamRecord() : null),
    getGithubTokenEnc: async (id) => tokenEnc.get(id) ?? null,
    createInvite: async () => void calls.push("createInvite"),
    acceptInvite: async () => acceptResult,
    addUserTeam: async () => void calls.push("addUserTeam"),
    removeMember: async (_t, u) => (calls.push(`removeMember:${u}`), { ok: true, removed: true }),
    removeUserTeam: async () => void calls.push("removeUserTeam"),
    linkProject: async () => (calls.push("linkProject"), { ok: true }),
    unlinkProject: async () => (calls.push("unlinkProject"), true),
    setProjectTestCommand: async (_t, p, cmd) => {
      calls.push(`setProjectTestCommand:${p}:${JSON.stringify(cmd)}`);
      // "p-raced" stands for a project unlinked between the membership read and the write.
      return p === "p-linked" ? { id: p, repoFullName: "owner/linked", defaultBranch: "main", testCommand: cmd } : null;
    },
    setMemberRole: async (_t, u, role) => (calls.push(`setMemberRole:${u}:${role}`), { ok: true, changed: true }),
    renameTeam: async (_t, name) => void calls.push(`renameTeam:${name}`),
    setTeamPolicy: async (_t, patch) => void calls.push(`setTeamPolicy:${JSON.stringify(patch)}`),
    listInvites: async () => [{ id: "inv-1", createdBy: "u-owner", expiresAt: Date.now() + 60_000, uses: 0, maxUses: 1, createdAt: Date.now() }],
    revokeInvite: async (_t, id) => (calls.push(`revokeInvite:${id}`), id === "inv-1"),
  };
  t = await makeTestApp({
    actors: unreachableActors(actors),
    env: { GITHUB_API_URL: gh.url, GITHUB_WEB_URL: gh.url },
    // The owner alone sends dozens of writes here; the default buckets are covered by their own tests.
    build: { rateLimits: { mutation: { capacity: 500, refillPerSecond: 50 } } },
  });
  for (const [id] of people) {
    tokenEnc.set(id, await encryptGithubToken(t.deps, id, `tok-${id}`));
    cookies[id] = `${SESSION_COOKIE}=${await t.deps.sessions.encode({ uid: id, sv: 1, exp: Date.now() + 3_600_000 })}`;
  }
});
afterAll(() => gh.stop());

const call = (who: string, method: string, path: string, body?: unknown) =>
  t.request(path, {
    method,
    csrf: method !== "GET",
    cookie: cookies[who],
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type Row = [label: string, method: string, path: string, body: unknown, expected: Record<string, number>];

describe("authorization matrix", () => {
  const rows: Row[] = [
    ["read team", "GET", `/api/teams/${TEAM}`, undefined, { "u-owner": 200, "u-admin": 200, "u-member": 200, "u-out": 404 }],
    ["create invite", "POST", `/api/teams/${TEAM}/invites`, {}, { "u-owner": 201, "u-admin": 201, "u-member": 403, "u-out": 404 }],
    ["link project", "POST", `/api/teams/${TEAM}/projects`, { repoFullName: "owner/repo", testCommand: "x" }, { "u-owner": 201, "u-admin": 201, "u-member": 403, "u-out": 404 }],
    ["set test command", "PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "bun test" }, { "u-owner": 200, "u-admin": 200, "u-member": 403, "u-out": 404 }],
    ["set test command on unknown project", "PATCH", `/api/teams/${TEAM}/projects/p-ghost`, { testCommand: "bun test" }, { "u-owner": 404, "u-admin": 404, "u-member": 403, "u-out": 404 }],
    ["unlink project", "DELETE", `/api/teams/${TEAM}/projects/p-linked`, undefined, { "u-owner": 204, "u-admin": 204, "u-member": 403, "u-out": 404 }],
    ["remove owner", "DELETE", `/api/teams/${TEAM}/members/u-owner`, undefined, { "u-owner": 403, "u-admin": 403, "u-member": 403, "u-out": 404 }],
    ["remove an admin", "DELETE", `/api/teams/${TEAM}/members/u-admin2`, undefined, { "u-owner": 204, "u-admin": 403, "u-member": 403, "u-out": 404 }],
    ["remove a member", "DELETE", `/api/teams/${TEAM}/members/u-member2`, undefined, { "u-owner": 204, "u-admin": 204, "u-member": 403, "u-out": 404 }],
    ["remove unknown user", "DELETE", `/api/teams/${TEAM}/members/u-ghost`, undefined, { "u-owner": 404, "u-admin": 404, "u-member": 404, "u-out": 404 }],
    ["realtime ticket", "POST", "/api/realtime/ticket", { teamId: TEAM }, { "u-owner": 200, "u-admin": 200, "u-member": 200, "u-out": 404 }],
    ["rename team", "PATCH", `/api/teams/${TEAM}`, { name: "Renamed" }, { "u-owner": 200, "u-admin": 200, "u-member": 403, "u-out": 404 }],
    ["change policy", "PATCH", `/api/teams/${TEAM}/policy`, { allowInspect: false }, { "u-owner": 200, "u-admin": 200, "u-member": 403, "u-out": 404 }],
    ["promote a member", "PATCH", `/api/teams/${TEAM}/members/u-member2`, { role: "admin" }, { "u-owner": 200, "u-admin": 403, "u-member": 403, "u-out": 404 }],
    ["demote an admin", "PATCH", `/api/teams/${TEAM}/members/u-admin2`, { role: "member" }, { "u-owner": 200, "u-admin": 403, "u-member": 403, "u-out": 404 }],
    ["change the owner's role", "PATCH", `/api/teams/${TEAM}/members/u-owner`, { role: "member" }, { "u-owner": 403, "u-admin": 403, "u-member": 403, "u-out": 404 }],
    ["role for unknown user", "PATCH", `/api/teams/${TEAM}/members/u-ghost`, { role: "admin" }, { "u-owner": 404, "u-admin": 403, "u-member": 403, "u-out": 404 }],
    ["list invites", "GET", `/api/teams/${TEAM}/invites`, undefined, { "u-owner": 200, "u-admin": 200, "u-member": 403, "u-out": 404 }],
    ["revoke invite", "DELETE", `/api/teams/${TEAM}/invites/inv-1`, undefined, { "u-owner": 204, "u-admin": 204, "u-member": 403, "u-out": 404 }],
    ["revoke unknown invite", "DELETE", `/api/teams/${TEAM}/invites/inv-ghost`, undefined, { "u-owner": 404, "u-admin": 404, "u-member": 403, "u-out": 404 }],
  ];

  for (const [label, method, path, body, expected] of rows) {
    test(label, async () => {
      for (const [who, status] of Object.entries(expected)) {
        const res = await call(who, method, path, body);
        expect({ who, status: res.status }).toEqual({ who, status });
      }
      // Unauthenticated always 401 (CSRF passes, session does not).
      expect((await t.request(path, { method, csrf: method !== "GET", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } })).status).toBe(401);
    });
  }

  test("leaving: members and admins may remove themselves; the owner may not", async () => {
    expect((await call("u-member", "DELETE", `/api/teams/${TEAM}/members/u-member`)).status).toBe(204);
    expect((await call("u-admin", "DELETE", `/api/teams/${TEAM}/members/u-admin`)).status).toBe(204);
    const res = await call("u-owner", "DELETE", `/api/teams/${TEAM}/members/u-owner`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.message).toBe("The owner cannot leave the team.");
  });

  test("a non-member's team id gives no signal: unknown and foreign teams look the same", async () => {
    const foreign = await call("u-out", "GET", `/api/teams/${TEAM}`);
    const unknown = await call("u-out", "GET", "/api/teams/t-unknown");
    expect(foreign.status).toBe(unknown.status);
    expect((await foreign.json()) as any).toEqual((await unknown.json()) as any);
  });

  test("link project rejects a repo already linked (case-insensitive)", async () => {
    gh.addUser({ id: 1, login: "owner", token: "tok-u-owner", repos: [{ id: 78, fullName: "Owner/Linked" }] });
    expect((await call("u-owner", "POST", `/api/teams/${TEAM}/projects`, { repoFullName: "owner/linked" })).status).toBe(409);
  });
});

describe("team settings writes", () => {
  test("bodies are validated before any actor call", async () => {
    calls.length = 0;
    const bad: Array<[string, string, unknown]> = [
      ["PATCH", `/api/teams/${TEAM}`, { name: "" }],
      ["PATCH", `/api/teams/${TEAM}`, { name: "   " }],
      ["PATCH", `/api/teams/${TEAM}`, { name: "x".repeat(65) }],
      ["PATCH", `/api/teams/${TEAM}`, { name: "two\nlines" }],
      ["PATCH", `/api/teams/${TEAM}`, {}],
      ["PATCH", `/api/teams/${TEAM}/policy`, {}],
      ["PATCH", `/api/teams/${TEAM}/policy`, { maxParallelPerTask: 0 }],
      ["PATCH", `/api/teams/${TEAM}/policy`, { maxParallelPerTask: 6 }],
      ["PATCH", `/api/teams/${TEAM}/policy`, { maxParallelPerTask: 2.5 }],
      ["PATCH", `/api/teams/${TEAM}/policy`, { allowInspect: "yes" }],
      ["PATCH", `/api/teams/${TEAM}/members/u-member2`, { role: "owner" }],
      ["PATCH", `/api/teams/${TEAM}/members/u-member2`, {}],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, {}],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "" }],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "   " }],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "x".repeat(201) }],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "bun test\nrm -rf ~" }],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "bun\rtest" }],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "bun\u0000test" }],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "bun\ttest" }],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "bun test ‮#tset nur" }],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "bun​test" }],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "bun\u0085test" }],
      ["POST", `/api/teams/${TEAM}/projects`, { repoFullName: "owner/repo", testCommand: "a⁦b⁩" }],
      ["PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: 42 }],
      ["POST", `/api/teams/${TEAM}/projects`, { repoFullName: "owner/repo", testCommand: "a\nb" }],
    ];
    for (const [method, path, body] of bad) expect({ path, body, status: (await call("u-owner", method, path, body)).status }).toEqual({ path, body, status: 400 });
    expect(calls).toEqual([]);
  });

  test("writes reach the actor trimmed and as a partial policy patch", async () => {
    calls.length = 0;
    expect((await call("u-admin", "PATCH", `/api/teams/${TEAM}`, { name: "  New name  " })).status).toBe(200);
    expect((await call("u-admin", "PATCH", `/api/teams/${TEAM}/policy`, { maxParallelPerTask: 2 })).status).toBe(200);
    const res = await call("u-owner", "PATCH", `/api/teams/${TEAM}/members/u-member2`, { role: "admin" });
    expect(((await res.json()) as any).viewerRole).toBe("owner");
    expect(calls).toEqual(["renameTeam:New name", 'setTeamPolicy:{"maxParallelPerTask":2}', "setMemberRole:u-member2:admin"]);
  });

  test("test command: trimmed on the way in, null clears it, the reply is the caller's team view", async () => {
    calls.length = 0;
    let res = await call("u-admin", "PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: "  bun run test:ci && echo ok  " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).viewerRole).toBe("admin");
    res = await call("u-owner", "PATCH", `/api/teams/${TEAM}/projects/p-linked`, { testCommand: null });
    expect(((await res.json()) as any).viewerRole).toBe("owner");
    expect((await call("u-owner", "PATCH", `/api/teams/${TEAM}/projects/p-raced`, { testCommand: "make" })).status).toBe(404);
    expect((await call("u-owner", "PATCH", `/api/teams/${TEAM}/projects/bad%20id`, { testCommand: "make" })).status).toBe(404);
    expect(calls).toEqual(['setProjectTestCommand:p-linked:"bun run test:ci && echo ok"', "setProjectTestCommand:p-linked:null", 'setProjectTestCommand:p-raced:"make"']);
  });

  test("PATCH needs the CSRF header like every other write", async () => {
    const res = await t.request(`/api/teams/${TEAM}`, { method: "PATCH", cookie: cookies["u-owner"], headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect(res.status).toBe(403);
    const project = await t.request(`/api/teams/${TEAM}/projects/p-linked`, { method: "PATCH", cookie: cookies["u-owner"], headers: { "content-type": "application/json" }, body: JSON.stringify({ testCommand: "x" }) });
    expect(project.status).toBe(403);
  });

  test("invite list never carries a code or hash", async () => {
    const body = (await (await call("u-owner", "GET", `/api/teams/${TEAM}/invites`)).json()) as any;
    expect(Object.keys(body.invites[0]).sort()).toEqual(["createdAt", "createdBy", "expiresAt", "id", "maxUses", "uses"]);
  });
});

describe("invite acceptance outcomes", () => {
  const token = `${TEAM}.${"A".repeat(43)}`;
  const accept = () => call("u-out", "POST", "/api/invites/accept", { token });

  test("expired, exhausted, invalid, full map to clear errors", async () => {
    acceptResult = { ok: false, reason: "expired" };
    let res = await accept();
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.message).toContain("expired");
    acceptResult = { ok: false, reason: "exhausted" };
    expect((await accept()).status).toBe(409);
    acceptResult = { ok: false, reason: "invalid" };
    expect((await accept()).status).toBe(404);
    acceptResult = { ok: false, reason: "full" };
    expect((await accept()).status).toBe(409);
  });

  test("malformed tokens never reach the actor", async () => {
    calls.length = 0;
    for (const bad of ["x".repeat(20), `${TEAM}.short`, `${TEAM}.${"A".repeat(43)}.`, `bad id.${"A".repeat(43)}`]) {
      expect((await call("u-out", "POST", "/api/invites/accept", { token: bad })).status).toBe(404);
    }
    expect((await call("u-out", "POST", "/api/invites/accept", { token: "short" })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
