// The workstream diff route end to end against the local fake GitHub (authz, mapping, size budgets, the shared
// compare cache entry with the branch route, the github rate bucket, a compare too large to read), plus the pure
// file mapping `toDiffFiles`.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { BRANCH_DIFF_FILES_MAX, BRANCH_DIFF_PATCH_MAX, BRANCH_DIFF_TOTAL_MAX, BranchDiffView, type Role } from "@morrow/contracts";
import type { ActorGateway, TeamRecord, UserRecord } from "../../src/actors/types.ts";
import { createGithubLayer } from "../../src/github/index.ts";
import { toDiffFiles } from "../../src/github/pulls.ts";
import { encryptGithubToken } from "../../src/http/githubAccess.ts";
import { SESSION_COOKIE } from "../../src/http/session.ts";
import { createLogger } from "../../src/lib/logger.ts";
import { makeTestApp, unreachableActors, type TestApp } from "../support/app.ts";
import { startFakeGithub, type FakeGithub, type FakeRepoState, type FakeUser } from "../support/fakeGithub.ts";

const TEAM = "t-diff";
const TASK = "tk-abcd1234wxyz";
const WS = "ws-backend";
const BRANCH = "morrow/wxyz/backend";
const people: Array<[string, Role | null]> = [
  ["u-owner", "owner"],
  ["u-member", "member"],
  ["u-out", null],
];

let gh: FakeGithub;
let t: TestApp;
let clock = 1_700_000_000_000;
const logLines: string[] = [];
const cookies: Record<string, string> = {};

type FakeFile = NonNullable<ReturnType<FakeRepoState["branches"]["get"]>>["files"];

const teamRecord = (): TeamRecord => ({
  id: TEAM,
  name: "Diff",
  slug: "diff",
  members: people.filter(([, r]) => r).map(([userId, role]) => ({ userId, role: role!, login: userId.slice(2), name: null, avatarUrl: null })),
  projects: [{ id: "p-web", repoFullName: "acme/web", defaultBranch: "main", testCommand: null }],
  environments: [],
  policy: { allowInspect: true, maxParallelPerTask: 3 },
  relayReady: false,
});

const workforceView = () => ({
  profiles: {},
  tasks: {
    [TASK]: {
      id: TASK,
      projectId: "p-web",
      title: "T",
      createdBy: "u-owner",
      status: "running",
      workstreams: [
        { id: WS, branch: BRANCH, status: "active", leaseId: null },
        // Never reaches GitHub: not a branch name we accept.
        { id: "ws-badname", branch: "bad..name", status: "active", leaseId: null },
      ],
    },
  },
  leases: {},
});

const memberUser = (id: string): UserRecord => ({ id, githubId: 1, login: id.slice(2), name: null, avatarUrl: null, email: null, sessionVersion: 1, teamIds: [TEAM] });

const setBranch = (files: FakeFile, extra: { aheadBy?: number; behindBy?: number } = {}) =>
  gh.repo("acme/web").branches.set(BRANCH, {
    aheadBy: extra.aheadBy ?? 2,
    behindBy: extra.behindBy ?? 1,
    commits: [
      { sha: "1".repeat(40), message: "first", author: "owner", date: "2020-01-01T00:00:00Z" },
      { sha: "2".repeat(40), message: "second", author: "owner", date: "2020-01-02T00:00:00Z" },
    ],
    files,
  });

beforeAll(async () => {
  gh = startFakeGithub();
  for (const [id] of people) {
    const user: FakeUser = { id: 2000 + people.findIndex(([p]) => p === id), login: id.slice(2), token: `tok-${id}`, repos: [{ id: 77, fullName: "acme/web" }] };
    gh.addUser(user);
  }
  const users = new Map<string, UserRecord>(people.map(([id]) => [id, memberUser(id)]));
  const tokenEnc = new Map<string, string>();
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
    modules: (deps) => [
      createGithubLayer({
        deps: { ...deps, hub: { viewerIds: () => [], publish: () => 0 }, runtime: { environment: async () => null, activeTeamIds: () => [] } },
        workforce: { getView: async () => workforceView() as never },
        reviewComment: async () => [],
      }).routes,
    ],
  });
  for (const [id] of people) {
    tokenEnc.set(id, await encryptGithubToken(t.deps, id, `tok-${id}`));
    cookies[id] = `${SESSION_COOKIE}=${await t.deps.sessions.encode({ uid: id, sv: 1, exp: clock + 3_600_000 })}`;
  }
});
afterAll(() => gh.stop());

beforeEach(() => {
  clock += 60_000; // past the cache's fresh window: every test reads GitHub (or revalidates)
  gh.repo("acme/web").branches.clear();
  setBranch([
    { filename: "src/api.ts", status: "added", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c" },
    { filename: "README.md", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
    { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", additions: 0, deletions: 0 },
    { filename: "gone.txt", status: "removed", additions: 0, deletions: 4, patch: "@@ -1,4 +0,0 @@\n-1\n-2\n-3\n-4" },
  ]);
  logLines.length = 0;
});

const call = (who: string | null, path: string) => t.request(path, { method: "GET", cookie: who ? cookies[who] : undefined });
const W = `/api/teams/${TEAM}/tasks/${TASK}/workstreams/${WS}`;
const view = async (res: Response) => {
  expect(res.status).toBe(200);
  return BranchDiffView.parse(await res.json());
};
const compareCalls = (from: number) => gh.requests.slice(from).filter((r) => r.path.startsWith("/repos/acme/web/compare/"));

/** A patch of `lines` added lines, each "+line NNNNN". */
const bigPatch = (lines: number) => `@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${String(i).padStart(5, "0")}`).join("\n")}`;

describe("authorization", () => {
  test("member 200, non-member 404, signed out 401", async () => {
    expect((await call("u-owner", `${W}/diff`)).status).toBe(200);
    expect((await call("u-member", `${W}/diff`)).status).toBe(200);
    expect((await call("u-out", `${W}/diff`)).status).toBe(404);
    expect((await call(null, `${W}/diff`)).status).toBe(401);
  });

  test("unknown or malformed task and workstream ids are 404 and never reach GitHub", async () => {
    const before = gh.requests.length;
    expect((await call("u-member", `/api/teams/${TEAM}/tasks/tk-ghost/workstreams/${WS}/diff`)).status).toBe(404);
    expect((await call("u-member", `/api/teams/${TEAM}/tasks/${TASK}/workstreams/ws-ghost/diff`)).status).toBe(404);
    expect((await call("u-member", `/api/teams/${TEAM}/tasks/bad%2Fid/workstreams/${WS}/diff`)).status).toBe(404);
    expect((await call("u-member", `/api/teams/${TEAM}/tasks/${TASK}/workstreams/bad%2Fid/diff`)).status).toBe(404);
    expect((await call("u-member", `/api/teams/${TEAM}/tasks/${TASK}/workstreams/ws-badname/diff`)).status).toBe(404);
    expect((await call("u-member", `/api/teams/t-other/tasks/${TASK}/workstreams/${WS}/diff`)).status).toBe(404);
    expect(gh.requests.length).toBe(before);
  });

  test("the github bucket rate-limits the diff route", async () => {
    const limited = await makeTestApp({
      actors: unreachableActors({ getTeam: async () => teamRecord(), getUser: async (id) => memberUser(id), getGithubTokenEnc: async () => null }),
      env: { GITHUB_API_URL: gh.url, GITHUB_WEB_URL: gh.url },
      build: { rateLimits: { github: { capacity: 2, refillPerSecond: 0.001 } } },
      modules: (deps) => [
        createGithubLayer({
          deps: { ...deps, hub: { viewerIds: () => [], publish: () => 0 }, runtime: { environment: async () => null, activeTeamIds: () => [] } },
          workforce: { getView: async () => workforceView() as never },
          reviewComment: async () => [],
        }).routes,
      ],
    });
    const cookie = `${SESSION_COOKIE}=${await limited.deps.sessions.encode({ uid: "u-member", sv: 1, exp: Date.now() + 60_000 })}`;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await limited.request(`${W}/diff`, { cookie })).status);
    // No GitHub token: the first two ask to reconnect, the third is refused before any work.
    expect(statuses).toEqual([401, 401, 429]);
  });
});

describe("diff", () => {
  test("maps statuses, renames, totals, head and ahead/behind", async () => {
    const body = await view(await call("u-member", `${W}/diff`));
    expect(body).toMatchObject({
      branch: BRANCH,
      base: "main",
      exists: true,
      tooLarge: false,
      headSha: "2".repeat(40),
      aheadBy: 2,
      behindBy: 1,
      additions: 4,
      deletions: 5,
      changedFiles: 4,
      filesTruncated: false,
    });
    expect(body.files).toEqual([
      { path: "src/api.ts", previousPath: null, status: "added", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c", patchTruncated: false },
      { path: "README.md", previousPath: null, status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new", patchTruncated: false },
      { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0, patch: null, patchTruncated: false },
      { path: "gone.txt", previousPath: null, status: "removed", additions: 0, deletions: 4, patch: "@@ -1,4 +0,0 @@\n-1\n-2\n-3\n-4", patchTruncated: false },
    ]);
    expect(body.freshness.stale).toBe(false);
    expect(compareCalls(0).at(-1)!.path).toBe(`/repos/acme/web/compare/main...${BRANCH}`);
  });

  test("a branch not pushed yet", async () => {
    gh.repo("acme/web").branches.clear();
    const body = await view(await call("u-member", `${W}/diff`));
    expect(body).toMatchObject({ exists: false, tooLarge: false, headSha: null, aheadBy: 0, behindBy: 0, additions: 0, deletions: 0, changedFiles: 0, files: [], filesTruncated: false });
  });

  test("a compare without a files list reads as no changes", async () => {
    setBranch(undefined, { aheadBy: 0, behindBy: 0 });
    const body = await view(await call("u-member", `${W}/diff`));
    expect(body).toMatchObject({ exists: true, changedFiles: 0, files: [], filesTruncated: false });
  });

  test("binary file and a file too big for GitHub to diff come without a patch", async () => {
    setBranch([
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
      { filename: "data.json", status: "modified", additions: 9000, deletions: 10 },
    ]);
    const body = await view(await call("u-member", `${W}/diff`));
    expect(body.files.map((f) => [f.path, f.patch, f.patchTruncated])).toEqual([
      ["logo.png", null, false],
      ["data.json", null, true],
    ]);
  });

  test("a long patch is cut at a line break and marked truncated", async () => {
    const patch = bigPatch(3_000); // ~36k chars
    setBranch([{ filename: "big.ts", status: "added", additions: 3_000, deletions: 0, patch }]);
    const [file] = (await view(await call("u-member", `${W}/diff`))).files;
    expect(file!.patchTruncated).toBe(true);
    expect(file!.patch!.length).toBeLessThanOrEqual(BRANCH_DIFF_PATCH_MAX);
    expect(file!.patch!.length).toBeGreaterThan(BRANCH_DIFF_PATCH_MAX - 20);
    expect(patch.startsWith(file!.patch!)).toBe(true);
    expect(patch[file!.patch!.length]).toBe("\n"); // ends on a whole line
  });

  test("past the total budget, later files come without a patch", async () => {
    const patch = bigPatch(1_900); // ~22.8k chars, under the per-file limit
    const files = Array.from({ length: 20 }, (_, i) => ({ filename: `f${i}.ts`, status: "added", additions: 1_900, deletions: 0, patch }));
    setBranch(files);
    const body = await view(await call("u-member", `${W}/diff`));
    const fit = Math.floor(BRANCH_DIFF_TOTAL_MAX / patch.length);
    expect(fit).toBeLessThan(20);
    expect(body.files.slice(0, fit).every((f) => f.patch === patch && !f.patchTruncated)).toBe(true);
    expect(body.files.slice(fit).every((f) => f.patch === null && f.patchTruncated)).toBe(true);
    expect(body.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0)).toBeLessThanOrEqual(BRANCH_DIFF_TOTAL_MAX);
    expect(body.additions).toBe(20 * 1_900);
  });

  test("more than 100 files: 100 listed, totals over all", async () => {
    setBranch(Array.from({ length: 150 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified", additions: 1, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" })));
    const body = await view(await call("u-member", `${W}/diff`));
    expect(body.files.length).toBe(BRANCH_DIFF_FILES_MAX);
    expect(body).toMatchObject({ filesTruncated: true, changedFiles: 150, additions: 150, deletions: 300 });
  });

  test("patches are plain text: NULs dropped, markup passed through verbatim as JSON", async () => {
    const markup = '@@ -0,0 +1,2 @@\n+<script>alert(1)</script>\n+<img src=x onerror="alert(2)">';
    setBranch([
      { filename: "nul.txt", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+a\u0000b\u0000" },
      { filename: "x.html", status: "added", additions: 2, deletions: 0, patch: markup },
    ]);
    const res = await call("u-member", `${W}/diff`);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    const body = await view(res);
    expect(body.files[0]!.patch).toBe("@@ -0,0 +1 @@\n+ab");
    expect(body.files[1]!.patch).toBe(markup);
    // Patch content is repo data: never in the logs.
    expect(logLines.join("\n")).not.toContain("alert(1)");
  });

  test("the response never carries a GitHub token", async () => {
    for (const path of [`${W}/diff`, `/api/teams/${TEAM}/tasks/${TASK}/workstreams/ws-ghost/diff`]) {
      const text = await (await call("u-member", path)).text();
      expect(text).not.toContain("tok-");
    }
    gh.repo("acme/web").branches.clear();
    clock += 10_000;
    expect(await (await call("u-member", `${W}/diff`)).text()).not.toContain("tok-");
    expect(logLines.join("\n")).not.toContain("tok-u-");
  });

  test("diff and branch share one GitHub compare inside the fresh window", async () => {
    let from = gh.requests.length;
    await view(await call("u-member", `${W}/diff`));
    expect((await call("u-member", `${W}/branch`)).status).toBe(200);
    expect(compareCalls(from).length).toBe(1);
    clock += 60_000;
    from = gh.requests.length;
    expect((await call("u-member", `${W}/branch`)).status).toBe(200);
    await view(await call("u-member", `${W}/diff`));
    expect(compareCalls(from).length).toBe(1);
    // Per member: another member's read goes to GitHub with their own token.
    from = gh.requests.length;
    await view(await call("u-owner", `${W}/diff`));
    expect(compareCalls(from).map((r) => r.auth)).toEqual(["Bearer tok-u-owner"]);
  });

  test("a compare over the client's size cap reads as too large", async () => {
    setBranch([{ filename: "huge.txt", status: "added", additions: 1, deletions: 0, patch: `+${"x".repeat(2 * 1024 * 1024 + 10)}` }]);
    const res = await call("u-member", `${W}/diff`);
    const body = await view(res);
    expect(body).toMatchObject({
      exists: true,
      tooLarge: true,
      headSha: null,
      aheadBy: 0,
      behindBy: 0,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      files: [],
      filesTruncated: false,
    });
    expect(body.freshness).toEqual({ fetchedAt: clock, stale: false, rateLimitedUntil: null });
  });

  test("GitHub down: the last good copy comes back marked stale", async () => {
    await view(await call("u-member", `${W}/diff`));
    clock += 10_000;
    gh.failWith(503);
    try {
      const body = await view(await call("u-member", `${W}/diff`));
      expect(body.freshness.stale).toBe(true);
      expect(body.files.length).toBe(4);
    } finally {
      gh.failWith(null);
    }
  });
});

describe("toDiffFiles", () => {
  const limits = { files: 3, patch: 20, total: 40 };
  const file = (name: string, patch?: string, extra: Record<string, unknown> = {}) => ({ filename: name, status: "modified", additions: 1, deletions: 1, ...(patch === undefined ? {} : { patch }), ...extra });

  test("not a list, or malformed items, are dropped", () => {
    expect(toDiffFiles(undefined)).toEqual({ additions: 0, deletions: 0, changedFiles: 0, files: [], filesTruncated: false });
    expect(toDiffFiles({ files: [] })).toEqual({ additions: 0, deletions: 0, changedFiles: 0, files: [], filesTruncated: false });
    const out = toDiffFiles([file("a"), { filename: 3 }, null, file("b", undefined, { additions: -1 })]);
    expect(out.files.map((f) => f.path)).toEqual(["a"]);
    expect(out.changedFiles).toBe(1);
  });

  test("unknown statuses read as changed", () => {
    expect(toDiffFiles([file("a", "x", { status: "weird" })]).files[0]!.status).toBe("changed");
  });

  test("a patch exactly at the limit is kept whole", () => {
    const patch = "@@ x @@\n" + "+".repeat(12); // 20 chars
    expect(toDiffFiles([file("a", patch)], limits).files[0]).toMatchObject({ patch, patchTruncated: false });
  });

  test("a longer patch is cut at the last line break inside the limit", () => {
    const patch = "@@ x @@\n+12345\n+abcdefghij\n+z"; // breaks at 7 and 14
    expect(toDiffFiles([file("a", patch)], limits).files[0]).toMatchObject({ patch: "@@ x @@\n+12345", patchTruncated: true });
    // A break right at the limit is kept.
    const exact = `${"a".repeat(20)}\nmore`;
    expect(toDiffFiles([file("a", exact)], limits).files[0]).toMatchObject({ patch: "a".repeat(20), patchTruncated: true });
  });

  test("one line longer than the limit is left out whole", () => {
    expect(toDiffFiles([file("a", "+".repeat(50))], limits).files[0]).toMatchObject({ patch: null, patchTruncated: true });
  });

  test("NULs are dropped before measuring", () => {
    const patch = `${"a".repeat(20)}\u0000\u0000`;
    expect(toDiffFiles([file("a", patch)], limits).files[0]).toMatchObject({ patch: "a".repeat(20), patchTruncated: false });
  });

  test("the total budget stops patches for the file that would pass it and every later one", () => {
    const p15 = "x".repeat(15);
    const out = toDiffFiles([file("a", p15), file("b", p15), file("c", "short")], { files: 10, patch: 20, total: 40 });
    expect(out.files.map((f) => [f.path, f.patch, f.patchTruncated])).toEqual([
      ["a", p15, false],
      ["b", p15, false],
      ["c", "short", false],
    ]);
    const over = toDiffFiles([file("a", p15), file("b", p15), file("c", p15), file("d", "s"), file("e")], { files: 10, patch: 20, total: 40 });
    expect(over.files.map((f) => [f.path, f.patch, f.patchTruncated])).toEqual([
      ["a", p15, false],
      ["b", p15, false],
      ["c", null, true],
      ["d", null, true],
      // No patch from GitHub: by its own rule, not the budget.
      ["e", null, true],
    ]);
  });

  test("no patch: truncated only when GitHub counted changed lines", () => {
    const out = toDiffFiles([
      file("bin.png", undefined, { additions: 0, deletions: 0, status: "added" }),
      file("moved.ts", undefined, { additions: 0, deletions: 0, status: "renamed", previous_filename: "old.ts" }),
      file("huge.sql", undefined, { additions: 10, deletions: 0 }),
    ]);
    expect(out.files.map((f) => [f.path, f.previousPath, f.patch, f.patchTruncated])).toEqual([
      ["bin.png", null, null, false],
      ["moved.ts", "old.ts", null, false],
      ["huge.sql", null, null, true],
    ]);
  });

  test("file cap: listed vs totals, and GitHub's own 300-file cap", () => {
    const out = toDiffFiles([file("a"), file("b"), file("c"), file("d")], limits);
    expect(out).toMatchObject({ changedFiles: 4, additions: 4, deletions: 4, filesTruncated: true });
    expect(out.files.length).toBe(3);
    const many = (n: number) => Array.from({ length: n }, (_, i) => file(`f${i}`));
    expect(toDiffFiles(many(299), { files: 1_000, patch: 20, total: 40 }).filesTruncated).toBe(false);
    expect(toDiffFiles(many(300), { files: 1_000, patch: 20, total: 40 }).filesTruncated).toBe(true);
  });
});
