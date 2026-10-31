// The GitHub layer's routes end to end against the local fake GitHub: authz matrix, pull request list/detail
// mapping, conditional requests, rate limits, every write and how GitHub refusals read, the task pull request,
// branch views, and commit/push from the web app (VM side faked at the GitWorkPort).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { PullDetail, PullListResponse, Role, ServerFrame, WorktreeChanges } from "@morrow/contracts";
import type { ActorGateway, TeamRecord, UserRecord } from "../../src/actors/types.ts";
import { createGithubLayer, type GithubLayer } from "../../src/github/index.ts";
import type { GitWorkPort, WorktreeTarget } from "../../src/github/worktrees.ts";
import { encryptGithubToken } from "../../src/http/githubAccess.ts";
import { SESSION_COOKIE } from "../../src/http/session.ts";
import type { EnvironmentRecord, WorktreeStatus } from "../../src/integrations/freestyle/index.ts";
import { createLogger } from "../../src/lib/logger.ts";
import { integrationBranch } from "../../src/orchestration/names.ts";
import { makeTestApp, unreachableActors, type TestApp } from "../support/app.ts";
import { startFakeGithub, type FakeGithub, type FakePull, type FakeUser } from "../support/fakeGithub.ts";

const TEAM = "t-gh";
const TASK = "tk-abcd1234wxyz";
const TASK2 = "tk-noprnoprnopr";
const WS = "ws-backend";
const BRANCH = "morrow/wxyz/backend";
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const people: Array<[string, Role | null]> = [
  ["u-owner", "owner"],
  ["u-admin", "admin"],
  ["u-creator", "member"],
  ["u-member", "member"],
  ["u-reader", "member"],
  ["u-out", null],
];

let gh: FakeGithub;
let t: TestApp;
let layer: GithubLayer;
let clock = 1_700_000_000_000;
const frames: ServerFrame[] = [];
const logLines: string[] = [];
const cookies: Record<string, string> = {};
const tokenEnc = new Map<string, string>();
const ghUsers = new Map<string, FakeUser>();
let env: EnvironmentRecord;
let leaseState = "running";
let status: WorktreeStatus;
const gitCalls: Array<{ op: string; target: WorktreeTarget; extra?: unknown }> = [];
let commitGate: Promise<void> | null = null;
let unresolved: string[] = [];

const teamRecord = (): TeamRecord => ({
  id: TEAM,
  name: "GH",
  slug: "gh",
  members: people.filter(([, r]) => r).map(([userId, role]) => ({ userId, role: role!, login: userId.slice(2), name: null, avatarUrl: null })),
  projects: [{ id: "p-web", repoFullName: "acme/web", defaultBranch: "main", testCommand: null }],
  environments: [],
  policy: { allowInspect: true, maxParallelPerTask: 3 },
  relayReady: false,
});

const workforceView = () => ({
  profiles: { "prof-1": { id: "prof-1", envId: "env-1" } },
  tasks: {
    [TASK]: { id: TASK, projectId: "p-web", title: "T", createdBy: "u-creator", status: "running", workstreams: [{ id: WS, branch: BRANCH, status: "active", leaseId: "lease-1" }] },
    [TASK2]: { id: TASK2, projectId: "p-web", title: "T2", createdBy: "u-creator", status: "running", workstreams: [{ id: "ws-idle", branch: "morrow/nopr/idle", status: "pending", leaseId: null }] },
  },
  leases: { "lease-1": { id: "lease-1", taskId: TASK, workstreamId: WS, profileId: "prof-1", epoch: 1, state: leaseState } },
});

const fakeGit: GitWorkPort = {
  enabled: () => true,
  status: async (target) => (gitCalls.push({ op: "status", target }), status),
  commitAndPush: async (opts) => {
    gitCalls.push({ op: "commit", target: opts, extra: { message: opts.message, author: opts.author, token: opts.githubToken } });
    if (commitGate) await commitGate;
    if (unresolved.length > 0) return { sha: SHA2, committed: false, unresolved };
    return { sha: SHA2, committed: true, unresolved: [] };
  },
};

function taskPullFixture(): FakePull {
  return {
    number: 1,
    title: "Morrow: add the API",
    body: "Built by Morrow.\n\n<script>alert(1)</script>",
    state: "open",
    author: "owner",
    head: integrationBranch(TASK),
    headSha: SHA,
    base: "main",
    updatedAt: "2020-01-02T00:00:00Z",
    files: [
      { filename: "src/api.ts", status: "added", additions: 40, deletions: 0 },
      { filename: "README.md", status: "modified", additions: 2, deletions: 1 },
    ],
    reviews: [
      { id: 501, user: "member", state: "COMMENTED", body: "Looks fine", submittedAt: "2020-01-02T01:00:00Z" },
      { id: 502, user: "admin", state: "CHANGES_REQUESTED", body: "Rename it", submittedAt: "2020-01-02T02:00:00Z" },
    ],
    reviewComments: [
      { id: 601, user: "admin", body: "Typo here", path: "src/api.ts", line: 3, diffHunk: "@@ -0,0 +1,3 @@\n+a\n+b\n+const x = 1;", createdAt: "2020-01-02T02:00:00Z" },
    ],
    issueComments: [{ id: 701, user: "member", body: "Nice **work**", createdAt: "2020-01-02T03:00:00Z" }],
    requestedReviewers: ["reader"],
    checkRuns: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
    ],
    statuses: [{ context: "ci/lint", state: "pending" }],
  };
}

beforeAll(async () => {
  gh = startFakeGithub();
  for (const [id] of people) {
    const login = id.slice(2);
    const user: FakeUser = {
      id: 1000 + people.findIndex(([p]) => p === id),
      login,
      token: `tok-${id}`,
      repos: [{ id: 77, fullName: "acme/web", permissions: id === "u-reader" ? { pull: true } : { push: true, pull: true } }],
    };
    ghUsers.set(id, user);
    gh.addUser(user);
  }
  const users = new Map<string, UserRecord>(
    people.map(([id], i) => [id, { id, githubId: 1000 + i, login: id.slice(2), name: id === "u-admin" ? "Ada <Admin>\nX" : null, avatarUrl: null, email: null, sessionVersion: 1, teamIds: [TEAM] }]),
  );
  const actors: Partial<ActorGateway> = {
    getUser: async (id) => users.get(id) ?? null,
    getTeam: async (id) => (id === TEAM ? teamRecord() : null),
    getGithubTokenEnc: async (id) => tokenEnc.get(id) ?? null,
  };
  const log = createLogger({ level: "debug", write: (line) => void logLines.push(line) });
  t = await makeTestApp({
    actors: unreachableActors(actors),
    env: { GITHUB_API_URL: gh.url, GITHUB_WEB_URL: gh.url },
    now: () => clock,
    log,
    build: { rateLimits: { mutation: { capacity: 1000, refillPerSecond: 100 }, github: { capacity: 1000, refillPerSecond: 100 }, read: { capacity: 1000, refillPerSecond: 100 } } },
    modules: (deps) => {
      layer = createGithubLayer({
        deps: {
          ...deps,
          hub: { viewerIds: () => [], publish: (_teamId, frame) => (frames.push(frame), 1) },
          runtime: { environment: async (_t, envId) => (envId === "env-1" ? env : null), activeTeamIds: () => [TEAM] },
        },
        workforce: { getView: async () => workforceView() as never },
        reviewComment: async () => [],
        options: { git: fakeGit },
      });
      return [layer.routes];
    },
  });
  for (const [id] of people) {
    tokenEnc.set(id, await encryptGithubToken(t.deps, id, `tok-${id}`));
    cookies[id] = `${SESSION_COOKIE}=${await t.deps.sessions.encode({ uid: id, sv: 1, exp: clock + 3_600_000 })}`;
  }
});
afterAll(() => gh.stop());

beforeEach(() => {
  clock += 60_000; // past the cache's fresh window: every test reads GitHub (or revalidates)
  const repo = gh.repo("acme/web");
  repo.pulls.clear();
  repo.pulls.set(1, taskPullFixture());
  repo.pulls.set(2, { number: 2, title: "Human PR", state: "open", draft: true, author: "member", head: "feature/x", headSha: "c".repeat(40), base: "main", updatedAt: "2020-01-03T00:00:00Z" });
  repo.pulls.set(3, { number: 3, title: "Old PR", state: "closed", merged: true, mergedBy: "owner", author: "admin", head: "old", headSha: "d".repeat(40), base: "main", updatedAt: "2020-01-04T00:00:00Z" });
  repo.mergeSettings = { merge: true, squash: true, rebase: false };
  repo.branches.clear();
  repo.branches.set(BRANCH, {
    aheadBy: 2,
    behindBy: 1,
    commits: [
      { sha: "1".repeat(40), message: "first\n\nbody", author: "owner", date: "2020-01-01T00:00:00Z" },
      { sha: "2".repeat(40), message: "second", author: "owner", date: "2020-01-02T00:00:00Z" },
    ],
  });
  for (const [id] of people) gh.setRateLimit(`tok-${id}`, null);
  for (const [id] of people) gh.setScopes(`tok-${id}`, "read:user, user:email, repo");
  frames.length = 0;
  gitCalls.length = 0;
  logLines.length = 0;
  leaseState = "running";
  unresolved = [];
  commitGate = null;
  env = {
    id: "env-1",
    teamId: TEAM,
    ownerUserId: "u-owner",
    phase: "ready",
    vmState: "running",
    freestyleVmId: "vm-1",
    vmSlug: "vm",
    linuxUser: "u0123456789ab",
    nodeName: "n",
    progress: { user: true, node: true, repos: [], warm: false },
    nodeConfigHash: null,
    resumePhase: null,
    failures: 0,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
  status = {
    exists: true,
    head: SHA,
    unpushed: 1,
    files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
    truncated: false,
  };
});

const memberUser = (id: string): UserRecord => ({ id, githubId: 1, login: id.slice(2), name: null, avatarUrl: null, email: null, sessionVersion: 1, teamIds: [TEAM] });

const call = (who: string | null, method: string, path: string, body?: unknown, opts: { csrf?: boolean } = {}) =>
  t.request(path, {
    method,
    csrf: opts.csrf ?? method !== "GET",
    cookie: who ? cookies[who] : undefined,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async <T>(res: Response) => (await res.json()) as T;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

const P = `/api/teams/${TEAM}/projects/p-web`;
const W = `/api/teams/${TEAM}/tasks/${TASK}/workstreams/${WS}`;

describe("authorization", () => {
  const rows: Array<[string, string, string, unknown, Record<string, number>]> = [
    ["list pulls", "GET", `${P}/pulls`, undefined, { "u-owner": 200, "u-member": 200, "u-reader": 200, "u-out": 404 }],
    ["pull detail", "GET", `${P}/pulls/1`, undefined, { "u-owner": 200, "u-member": 200, "u-out": 404 }],
    ["task pull", "GET", `/api/teams/${TEAM}/tasks/${TASK}/pull`, undefined, { "u-member": 200, "u-out": 404 }],
    ["branch", "GET", `${W}/branch`, undefined, { "u-member": 200, "u-out": 404 }],
    ["changes", "GET", `${W}/changes`, undefined, { "u-member": 200, "u-out": 404 }],
    ["comment", "POST", `${P}/pulls/1/comments`, { body: "hi" }, { "u-member": 204, "u-out": 404 }],
    ["commit", "POST", `${W}/commit`, { message: "wip" }, { "u-owner": 200, "u-admin": 200, "u-creator": 200, "u-member": 403, "u-out": 404 }],
    ["close", "PATCH", `${P}/pulls/2`, { state: "closed" }, { "u-out": 404 }],
    ["ready", "POST", `${P}/pulls/2/ready`, undefined, { "u-out": 404 }],
    ["merge", "POST", `${P}/pulls/1/merge`, { method: "squash", headSha: SHA }, { "u-out": 404 }],
  ];
  for (const [label, method, path, body, expected] of rows) {
    test(label, async () => {
      for (const [who, code] of Object.entries(expected)) {
        clock += 10_000;
        const res = await call(who, method, path, body);
        expect({ who, status: res.status }).toEqual({ who, status: code });
      }
      expect((await call(null, method, path, body)).status).toBe(401);
      if (method !== "GET") expect((await call("u-owner", method, path, body, { csrf: false })).status).toBe(403);
    });
  }

  test("ids are validated and only the team's own projects are reachable", async () => {
    expect((await call("u-member", "GET", `/api/teams/${TEAM}/projects/p-other/pulls`)).status).toBe(404);
    expect((await call("u-member", "GET", `/api/teams/${TEAM}/projects/bad%2Fid/pulls`)).status).toBe(404);
    for (const n of ["0", "-1", "1.5", "abc", "99999999999", "01"]) expect((await call("u-member", "GET", `${P}/pulls/${n}`)).status).toBe(404);
    expect((await call("u-member", "GET", `${P}/pulls/42`)).status).toBe(404);
    expect((await call("u-member", "GET", `/api/teams/${TEAM}/tasks/tk-ghost/pull`)).status).toBe(404);
    expect((await call("u-member", "GET", `/api/teams/${TEAM}/tasks/${TASK}/workstreams/ws-ghost/branch`)).status).toBe(404);
    expect((await call("u-member", "GET", `${P}/pulls?state=weird`)).status).toBe(400);
    // Nothing reached GitHub for a path we refused.
    expect(gh.requests.some((r) => r.path.includes("p-other") || r.path.includes("bad"))).toBe(false);
  });

  test("the github bucket rate-limits these routes", async () => {
    const limited = await makeTestApp({
      actors: unreachableActors({ getTeam: async () => teamRecord(), getUser: async (id) => memberUser(id), getGithubTokenEnc: async () => null }),
      env: { GITHUB_API_URL: gh.url, GITHUB_WEB_URL: gh.url },
      build: { rateLimits: { github: { capacity: 2, refillPerSecond: 0.001 } } },
      modules: (deps) => [
        createGithubLayer({
          deps: { ...deps, hub: { viewerIds: () => [], publish: () => 0 }, runtime: { environment: async () => null, activeTeamIds: () => [] } },
          workforce: { getView: async () => workforceView() as never },
          reviewComment: async () => [],
          options: { git: fakeGit },
        }).routes,
      ],
    });
    const cookie = `${SESSION_COOKIE}=${await limited.deps.sessions.encode({ uid: "u-member", sv: 1, exp: Date.now() + 60_000 })}`;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await limited.request(`${P}/pulls`, { cookie })).status);
    // No GitHub token: the first two ask to reconnect, the third is refused before any work.
    expect(statuses).toEqual([401, 401, 429]);
  });
});

describe("pull requests", () => {
  test("list: open first, Morrow pull requests carry their task, filters work", async () => {
    const res = await call("u-member", "GET", `${P}/pulls?state=all`);
    expect(res.status).toBe(200);
    const body = await json<PullListResponse>(res);
    expect(body.pulls.map((p) => [p.number, p.state, p.taskId])).toEqual([
      [2, "draft", null],
      [1, "open", TASK],
      [3, "merged", null],
    ]);
    expect(body.repoFullName).toBe("acme/web");
    expect(body.freshness.stale).toBe(false);
    const open = await json<PullListResponse>(await call("u-member", "GET", `${P}/pulls`));
    expect(open.pulls.map((p) => p.number)).toEqual([2, 1]);
    const closed = await json<PullListResponse>(await call("u-member", "GET", `${P}/pulls?state=closed`));
    expect(closed.pulls.map((p) => p.number)).toEqual([3]);
  });

  test("detail: checks, reviews, files, conversation and what the viewer may do", async () => {
    const res = await call("u-owner", "GET", `${P}/pulls/1`);
    expect(res.status).toBe(200);
    const pr = await json<PullDetail>(res);
    expect(pr).toMatchObject({ number: 1, state: "open", taskId: TASK, headSha: SHA, mergeable: "clean", additions: 42, deletions: 1, changedFiles: 2 });
    expect(pr.body).toContain("<script>"); // raw markdown; the web renders it as text
    expect(pr.checks.state).toBe("failed");
    expect(pr.checks.items.map((c) => [c.name, c.state]).sort()).toEqual([["build", "passed"], ["ci/lint", "pending"], ["test", "failed"]]);
    expect(pr.reviewDecision).toBe("changes_requested");
    expect(pr.reviewers.map((r) => [r.login, r.state]).sort()).toEqual([["admin", "changes_requested"], ["member", "commented"], ["reader", "requested"]]);
    expect(pr.files.map((f) => f.path)).toEqual(["src/api.ts", "README.md"]);
    expect(pr.conversation.map((c) => [c.kind, c.id])).toEqual([["review", 501], ["review", 502], ["review_comment", 601], ["comment", 701]]);
    const rc = pr.conversation.find((c) => c.kind === "review_comment");
    expect(rc).toMatchObject({ path: "src/api.ts", line: 3, codeLine: "+const x = 1;" });
    expect(pr.conversation[0]!.author?.avatarUrl).toStartWith("https://avatars.githubusercontent.com/");
    expect(pr.mergeMethods).toEqual(["merge", "squash"]);
    expect(pr.viewerCanWrite).toBe(true);

    // A member without write access on GitHub sees no merge methods and cannot write.
    const reader = await json<PullDetail>(await call("u-reader", "GET", `${P}/pulls/1`));
    expect(reader.mergeMethods).toEqual([]);
    expect(reader.viewerCanWrite).toBe(false);
  });

  test("conditional requests: a revalidation is a 304, and a burst is answered from memory", async () => {
    await call("u-member", "GET", `${P}/pulls/1`);
    const before = gh.requests.length;
    await call("u-member", "GET", `${P}/pulls/1`); // inside the fresh window: no GitHub call at all
    expect(gh.requests.length).toBe(before);
    clock += 10_000;
    await call("u-member", "GET", `${P}/pulls/1`);
    const after = gh.requests.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.status === 304)).toBe(true);
    // Per member: another member's copy is never served to them.
    const otherBefore = gh.requests.length;
    await call("u-owner", "GET", `${P}/pulls/1`);
    expect(gh.requests.slice(otherBefore).some((r) => r.auth === "Bearer tok-u-owner")).toBe(true);
  });

  test("rate limited: the last copy is served as stale; with no copy the error says when it resets", async () => {
    await call("u-admin", "GET", `${P}/pulls`);
    gh.setRateLimit("tok-u-admin", 0);
    clock += 10_000;
    const stale = await json<PullListResponse>(await call("u-admin", "GET", `${P}/pulls`));
    expect(stale.freshness.stale).toBe(true);
    expect(stale.freshness.rateLimitedUntil).toBeGreaterThan(clock);
    const res = await call("u-admin", "GET", `${P}/pulls/2`);
    expect(res.status).toBe(429);
    expect((await errorOf(res)).message).toMatch(/^Your GitHub rate limit is used up\. It resets in about/);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });

  test("an expired GitHub token or a missing scope asks to reconnect", async () => {
    tokenEnc.set("u-member", await encryptGithubToken(t.deps, "u-member", "tok-revoked"));
    try {
      const res = await call("u-member", "GET", `${P}/pulls`);
      expect(res.status).toBe(401);
      expect((await errorOf(res)).message).toContain("Reconnect GitHub");
    } finally {
      tokenEnc.set("u-member", await encryptGithubToken(t.deps, "u-member", "tok-u-member"));
    }
    gh.setScopes("tok-u-reader", "read:user");
    await call("u-reader", "GET", `${P}/pulls`);
    const res = await call("u-reader", "POST", `${P}/pulls/1/merge`, { method: "squash", headSha: SHA });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).message).toContain("Reconnect GitHub");
  });
});

describe("writes", () => {
  test("comment and reply: posted as the member, viewers told, body never logged", async () => {
    const secret = "my private review text 7f3a";
    expect((await call("u-member", "POST", `${P}/pulls/1/comments`, { body: secret })).status).toBe(204);
    const pull = gh.repo("acme/web").pulls.get(1)!;
    expect(pull.issueComments!.at(-1)).toMatchObject({ user: "member", body: secret });
    expect((await call("u-admin", "POST", `${P}/pulls/1/comments`, { body: "fixed", inReplyTo: 601 })).status).toBe(204);
    expect(pull.reviewComments!.at(-1)).toMatchObject({ user: "admin", inReplyTo: 601 });
    expect(frames.filter((f) => f.kind === "github.changed").map((f) => f.kind === "github.changed" && f.data)).toEqual([
      { projectId: "p-web", pulls: [1], list: true, at: clock },
      { projectId: "p-web", pulls: [1], list: true, at: clock },
    ]);
    expect(logLines.join("\n")).not.toContain(secret);
    expect(logLines.join("\n")).not.toContain("tok-u-");
    // The new comment shows on the next read (the write dropped the cached copy).
    const pr = await json<PullDetail>(await call("u-member", "GET", `${P}/pulls/1`));
    expect(pr.conversation.some((c) => c.body === secret)).toBe(true);
  });

  test("comment validation", async () => {
    expect((await call("u-member", "POST", `${P}/pulls/1/comments`, { body: "   " })).status).toBe(400);
    expect((await call("u-member", "POST", `${P}/pulls/1/comments`, { body: "x".repeat(60_001) })).status).toBe(400);
    expect((await call("u-member", "POST", `${P}/pulls/1/comments`, { body: "x".repeat(70_000) })).status).toBe(413);
    expect((await call("u-member", "POST", `${P}/pulls/1/comments`, { body: "x\u0000y" })).status).toBe(400);
    expect((await call("u-member", "POST", `${P}/pulls/1/comments`, { body: "ok", inReplyTo: -3 })).status).toBe(400);
    expect((await call("u-member", "POST", `${P}/pulls/1/comments`, { body: "ok", inReplyTo: 999 })).status).toBe(404);
  });

  test("merge: success, then every refusal reads clearly", async () => {
    // Method the repo does not allow: refused before GitHub is asked.
    let res = await call("u-owner", "POST", `${P}/pulls/1/merge`, { method: "rebase", headSha: SHA });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe("This repository does not allow rebase merging. Pick another merge method.");
    // Someone pushed since the page loaded.
    res = await call("u-owner", "POST", `${P}/pulls/1/merge`, { method: "squash", headSha: SHA2 });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toContain("New commits were pushed");
    // Protected branch / failing required checks.
    gh.repo("acme/web").pulls.get(1)!.mergeRefusal = { status: 405, message: "Required status check \"test\" is failing." };
    res = await call("u-owner", "POST", `${P}/pulls/1/merge`, { method: "squash", headSha: SHA });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe('GitHub would not merge this pull request. GitHub says: Required status check "test" is failing.');
    // No push access on GitHub.
    res = await call("u-reader", "POST", `${P}/pulls/1/merge`, { method: "squash", headSha: SHA });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toContain("GitHub says: Must have push access");
    // Bad body.
    expect((await call("u-owner", "POST", `${P}/pulls/1/merge`, { method: "squash", headSha: "abc" })).status).toBe(400);
    expect((await call("u-owner", "POST", `${P}/pulls/1/merge`, { method: "octopus", headSha: SHA })).status).toBe(400);

    res = await call("u-owner", "POST", `${P}/pulls/1/merge`, { method: "squash", headSha: SHA });
    expect(res.status).toBe(204);
    const pr = await json<PullDetail>(await call("u-owner", "GET", `${P}/pulls/1`));
    expect(pr.state).toBe("merged");
    expect(pr.mergedBy?.login).toBe("owner");
  });

  test("draft to ready, close and reopen", async () => {
    let res = await call("u-member", "POST", `${P}/pulls/1/ready`);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe("This pull request is not a draft.");
    res = await call("u-member", "POST", `${P}/pulls/2/ready`);
    expect(res.status).toBe(204);
    expect(gh.repo("acme/web").pulls.get(2)!.draft).toBe(false);
    expect(gh.requests.some((r) => r.path === "/graphql" && r.method === "POST")).toBe(true);

    expect((await call("u-member", "PATCH", `${P}/pulls/2`, { state: "closed" })).status).toBe(204);
    expect(gh.repo("acme/web").pulls.get(2)!.state).toBe("closed");
    expect((await call("u-member", "PATCH", `${P}/pulls/2`, { state: "open" })).status).toBe(204);
    expect(gh.repo("acme/web").pulls.get(2)!.state).toBe("open");
    expect((await call("u-member", "PATCH", `${P}/pulls/2`, { state: "merged" })).status).toBe(400);
    // A merged pull request cannot be reopened.
    res = await call("u-member", "PATCH", `${P}/pulls/3`, { state: "open" });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toContain("GitHub refused to reopen");
  });
});

describe("task pull request and branches", () => {
  test("the task's pull request, or null before the verifier opened one", async () => {
    const res = await json<{ projectId: string; pull: PullDetail | null }>(await call("u-member", "GET", `/api/teams/${TEAM}/tasks/${TASK}/pull`));
    expect(res.projectId).toBe("p-web");
    expect(res.pull?.number).toBe(1);
    const none = await json<{ pull: PullDetail | null }>(await call("u-member", "GET", `/api/teams/${TEAM}/tasks/${TASK2}/pull`));
    expect(none.pull).toBeNull();
    const head = gh.requests.find((r) => r.path === "/repos/acme/web/pulls" && r.search.includes("head="));
    expect(decodeURIComponent(head!.search)).toContain(`head=acme:${integrationBranch(TASK)}`);
  });

  test("branch: ahead/behind and newest commits first; a branch not on GitHub yet", async () => {
    const res = await json<{ exists: boolean; aheadBy: number; behindBy: number; headSha: string | null; commits: Array<{ sha: string; message: string }> }>(
      await call("u-member", "GET", `${W}/branch`),
    );
    expect(res).toMatchObject({ exists: true, aheadBy: 2, behindBy: 1, headSha: "2".repeat(40) });
    expect(res.commits.map((c) => c.sha)).toEqual(["2".repeat(40), "1".repeat(40)]);
    gh.repo("acme/web").branches.clear();
    clock += 10_000;
    const missing = await json<{ exists: boolean; commits: unknown[] }>(await call("u-member", "GET", `${W}/branch`));
    expect(missing).toMatchObject({ exists: false, commits: [] });
  });
});

describe("commit and push from the web app", () => {
  test("changes: what the worktree holds, read on the right VM as the right user", async () => {
    const res = await json<WorktreeChanges>(await call("u-member", "GET", `${W}/changes`));
    expect(res).toMatchObject({ state: "ready", headSha: SHA, unpushed: 1, agentLive: true, truncated: false });
    expect(res.files).toEqual([{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }]);
    expect(gitCalls[0]!.target).toEqual({ vmId: "vm-1", linuxUser: "u0123456789ab", repoFullName: "acme/web", branch: BRANCH });
    status = { exists: false };
    expect(await json<WorktreeChanges>(await call("u-member", "GET", `${W}/changes`))).toMatchObject({ state: "missing", files: [] });
  });

  test("commit: authored by the person clicking, pushed with the environment owner's token", async () => {
    const res = await call("u-admin", "POST", `${W}/commit`, { message: "  Fix the API\n\nDetails  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: SHA2, committed: true });
    const commit = gitCalls.find((c) => c.op === "commit")!;
    expect(commit.extra).toEqual({
      message: "Fix the API\n\nDetails",
      author: { name: "Ada AdminX", email: "1001+admin@users.noreply.github.com" },
      token: "tok-u-owner",
    });
    expect(frames.some((f) => f.kind === "github.changed" && f.data.list)).toBe(true);
    expect(logLines.join("\n")).not.toContain("tok-u-owner");
  });

  test("commit refusals: conflicts, missing owner access, paused VM, no lease, busy", async () => {
    unresolved = ["src/a.ts", "src/b.ts"];
    let res = await call("u-creator", "POST", `${W}/commit`, { message: "m" });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe("Nothing was pushed: src/a.ts, src/b.ts still have merge conflicts. Resolve them first.");
    unresolved = [];

    env = { ...env, ownerUserId: "u-nobody" };
    res = await call("u-creator", "POST", `${W}/commit`, { message: "m" });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toContain("environment owner's GitHub sign-in");

    env = { ...env, ownerUserId: "u-owner", vmState: "paused" };
    res = await call("u-creator", "POST", `${W}/commit`, { message: "m" });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toContain("paused");
    expect((await call("u-member", "GET", `${W}/changes`)).status).toBe(409);
    env = { ...env, vmState: "running" };

    res = await call("u-creator", "GET", `/api/teams/${TEAM}/tasks/${TASK2}/workstreams/ws-idle/changes`);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe("No agent has worked on this workstream yet, so it has no worktree.");

    expect((await call("u-creator", "POST", `${W}/commit`, { message: "" })).status).toBe(400);
    expect((await call("u-creator", "POST", `${W}/commit`, { message: "x".repeat(2_001) })).status).toBe(400);

    let release!: () => void;
    commitGate = new Promise((r) => (release = r));
    const first = call("u-creator", "POST", `${W}/commit`, { message: "one" });
    await Bun.sleep(20);
    const second = await call("u-owner", "POST", `${W}/commit`, { message: "two" });
    expect(second.status).toBe(409);
    expect((await errorOf(second)).message).toContain("already running");
    release();
    expect((await first).status).toBe(200);
    // Free again afterwards.
    commitGate = null;
    expect((await call("u-owner", "POST", `${W}/commit`, { message: "three" })).status).toBe(200);
  });

  test("Agent environments off: an honest disabled answer", async () => {
    const off = await makeTestApp({
      actors: unreachableActors({ getTeam: async () => teamRecord(), getUser: async (id) => memberUser(id), getGithubTokenEnc: async () => null }),
      env: { GITHUB_API_URL: gh.url, GITHUB_WEB_URL: gh.url },
      modules: (deps) => [
        createGithubLayer({
          deps: { ...deps, hub: { viewerIds: () => [], publish: () => 0 }, runtime: { environment: async () => env, activeTeamIds: () => [] } },
          workforce: { getView: async () => workforceView() as never },
          reviewComment: async () => [],
          options: { git: { ...fakeGit, enabled: () => false } },
        }).routes,
      ],
    });
    const cookie = `${SESSION_COOKIE}=${await off.deps.sessions.encode({ uid: "u-member", sv: 1, exp: Date.now() + 60_000 })}`;
    const res = await off.request(`${W}/changes`, { cookie });
    expect(res.status).toBe(501);
    expect((await errorOf(res)).code).toBe("feature_disabled");
  });
});
