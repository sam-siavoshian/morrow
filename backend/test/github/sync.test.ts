// GitHub sync and the conditional-request cache against the local fake GitHub: baselines, change frames, 304s,
// rate-limit backoff, who reads for a team, comment hand-off to the agent loop, and restart behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "@morrow/contracts";
import type { TeamRecord } from "../../src/actors/types.ts";
import { GithubCache } from "../../src/github/cache.ts";
import { toReviewComment, type PullCommentEvent } from "../../src/github/events.ts";
import { GithubSync } from "../../src/github/sync.ts";
import { GithubClient, GithubError } from "../../src/integrations/github/client.ts";
import { silentLogger } from "../../src/lib/logger.ts";
import { integrationBranch } from "../../src/orchestration/names.ts";
import { startFakeGithub, type FakeGithub, type FakePull } from "../support/fakeGithub.ts";

const TEAM = "t-sync";
const TASK = "tk-sync1234abcd";
const SHA = "a".repeat(40);

let gh: FakeGithub;
let client: GithubClient;
let clock = 1_700_000_000_000;
let viewers: string[] = [];
let active: string[] = [TEAM];
let taskStatus = "running";
const frames: ServerFrame[] = [];
const comments: PullCommentEvent[] = [];

const team = (): TeamRecord => ({
  id: TEAM,
  name: "S",
  slug: "s",
  members: [
    { userId: "u-a", role: "owner", login: "a", name: null, avatarUrl: null },
    { userId: "u-b", role: "member", login: "b", name: null, avatarUrl: null },
  ],
  projects: [{ id: "p-web", repoFullName: "acme/web", defaultBranch: "main", testCommand: null }],
  environments: [],
  policy: { allowInspect: true, maxParallelPerTask: 3 },
  relayReady: false,
});

function makeSync(cache = new GithubCache({ get: (t, p, e) => client.conditionalGet(t, p, e), now: () => clock })) {
  return {
    cache,
    sync: new GithubSync({
      cache,
      actors: { getTeam: async (id) => (id === TEAM ? team() : null) },
      workforce: { getView: async () => ({ profiles: {}, leases: {}, tasks: { [TASK]: { id: TASK, projectId: "p-web", createdBy: "u-b", status: taskStatus, workstreams: [] } } }) as never },
      activeTeamIds: () => active,
      viewerIds: () => viewers,
      publish: (_t, frame) => void frames.push(frame),
      onComment: async (event) => void comments.push(event),
      token: async (userId) => {
        if (userId === "u-a" || userId === "u-b") return `tok-${userId}`;
        throw new Error("no token");
      },
      log: silentLogger,
      now: () => clock,
    }),
  };
}

const pull = (): FakePull => ({
  number: 7,
  title: "Morrow: thing",
  state: "open",
  author: "a",
  head: integrationBranch(TASK),
  headSha: SHA,
  base: "main",
  updatedAt: "2020-02-01T00:00:00Z",
  checkRuns: [{ name: "ci", status: "in_progress", conclusion: null }],
  issueComments: [{ id: 10, user: "b", body: "old comment", createdAt: new Date(clock - 60_000).toISOString() }],
  reviewComments: [],
  reviews: [],
});

beforeAll(() => {
  gh = startFakeGithub();
  for (const id of ["u-a", "u-b"]) gh.addUser({ id: 1, login: id.slice(2), token: `tok-${id}`, repos: [{ id: 1, fullName: "acme/web" }] });
  client = new GithubClient({ apiUrl: gh.url, webUrl: gh.url, clientId: "x", clientSecret: "y" });
});
afterAll(() => gh.stop());

beforeEach(() => {
  clock += 3_600_000;
  const repo = gh.repo("acme/web");
  repo.pulls.clear();
  repo.pulls.set(7, pull());
  repo.pulls.set(8, { number: 8, title: "Human", state: "open", author: "b", head: "feature", headSha: "b".repeat(40), base: "main", updatedAt: "2020-01-01T00:00:00Z" });
  gh.setRateLimit("tok-u-a", null);
  gh.setRateLimit("tok-u-b", null);
  viewers = ["u-a"];
  active = [TEAM];
  taskStatus = "running";
  frames.length = 0;
  comments.length = 0;
});

const changed = () => frames.flatMap((f) => (f.kind === "github.changed" ? [f.data] : []));
const pass = async (sync: GithubSync) => {
  clock += 30_000;
  const before = gh.requests.length;
  await sync.pollOnce();
  return gh.requests.slice(before);
};

describe("GithubSync", () => {
  test("first pass is a baseline; a quiet pass costs only 304s", async () => {
    const { sync } = makeSync();
    const first = await pass(sync);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((r) => r.auth === "Bearer tok-u-a")).toBe(true);
    expect(changed()).toEqual([]);
    expect(comments).toEqual([]);
    const quiet = await pass(sync);
    expect(quiet.length).toBeGreaterThan(0);
    expect(quiet.every((r) => r.status === 304)).toBe(true);
    expect(changed()).toEqual([]);
  });

  test("a pull request change, a new pull request and a checks change each send a frame", async () => {
    const { sync } = makeSync();
    await pass(sync);
    const p8 = gh.repo("acme/web").pulls.get(8)!;
    p8.title = "Renamed";
    p8.updatedAt = "2020-03-01T00:00:00Z";
    await pass(sync);
    expect(changed()).toEqual([{ projectId: "p-web", pulls: [8], list: true, at: clock }]);

    frames.length = 0;
    gh.repo("acme/web").pulls.set(9, { number: 9, title: "New", state: "open", author: "b", head: "n", headSha: "c".repeat(40), base: "main", updatedAt: "2020-03-02T00:00:00Z" });
    await pass(sync);
    expect(changed()).toEqual([{ projectId: "p-web", pulls: [9], list: true, at: clock }]);

    frames.length = 0;
    gh.repo("acme/web").pulls.get(7)!.checkRuns = [{ name: "ci", status: "completed", conclusion: "success" }];
    await pass(sync);
    expect(changed()).toEqual([{ projectId: "p-web", pulls: [7], list: false, at: clock }]);
  });

  test("new comments on the task's pull request go to the agent loop once, oldest first", async () => {
    const { sync } = makeSync();
    await pass(sync);
    const p = gh.repo("acme/web").pulls.get(7)!;
    p.issueComments!.push({ id: 11, user: "b", body: "please rename", createdAt: new Date(clock).toISOString() });
    p.reviewComments!.push({ id: 20, user: "a", body: "nit", path: "src/x.ts", line: 4, diffHunk: "@@\n+x", createdAt: new Date(clock + 1).toISOString() });
    p.reviews!.push({ id: 30, user: "a", state: "APPROVED", submittedAt: new Date(clock + 2).toISOString() });
    p.updatedAt = "2020-03-01T00:00:00Z";
    await pass(sync);
    expect(comments.map((c) => [c.comment.kind, c.comment.id])).toEqual([
      ["comment", 11],
      ["review_comment", 20],
      ["review", 30],
    ]);
    expect(comments[0]).toMatchObject({ teamId: TEAM, projectId: "p-web", taskId: TASK, pullNumber: 7, headRef: integrationBranch(TASK) });
    expect(comments.map(toReviewComment)).toEqual([
      { teamId: TEAM, taskId: TASK, commentId: "comment-11", author: "b", path: null, line: null, body: "please rename", url: expect.stringContaining("#issuecomment-11") },
      { teamId: TEAM, taskId: TASK, commentId: "review_comment-20", author: "a", path: "src/x.ts", line: 4, body: "nit", url: expect.any(String) },
      { teamId: TEAM, taskId: TASK, commentId: "review-30", author: "a", path: null, line: null, body: "(approved the pull request, no text)", url: expect.any(String) },
    ]);
    // Not again.
    p.updatedAt = "2020-03-02T00:00:00Z";
    await pass(sync);
    expect(comments.length).toBe(3);
  });

  test("a restart sets a new baseline: comments from before it are not replayed", async () => {
    const first = makeSync();
    await pass(first.sync);
    gh.repo("acme/web").pulls.get(7)!.issueComments!.push({ id: 12, user: "b", body: "while down", createdAt: new Date(clock).toISOString() });
    gh.repo("acme/web").pulls.get(7)!.updatedAt = "2020-03-01T00:00:00Z";
    const restarted = makeSync();
    await pass(restarted.sync);
    expect(comments).toEqual([]);
    expect(changed()).toEqual([]);
  });

  test("who reads: a connected viewer, else the creator of unfinished work, else nobody", async () => {
    viewers = [];
    const { sync } = makeSync();
    let reqs = await pass(sync);
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.auth === "Bearer tok-u-b")).toBe(true);

    taskStatus = "completed";
    viewers = ["u-stranger"]; // not a member: never used
    reqs = await pass(sync);
    expect(reqs).toEqual([]);
    expect(sync.stats().skippedNoReader).toBe(1);

    active = [];
    viewers = ["u-a"];
    expect(await pass(sync)).toEqual([]);
  });

  test("a member whose budget is low is left alone; the next candidate reads instead", async () => {
    viewers = ["u-a", "u-b"];
    const { sync, cache } = makeSync();
    gh.setRateLimit("tok-u-a", 150);
    await pass(sync);
    expect(cache.budgetLow("u-a")).toBe(true);
    const reqs = await pass(sync);
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.auth === "Bearer tok-u-b")).toBe(true);
  });

  test("rate limited mid-run: no frames from stale data, no crash, and polling continues after", async () => {
    const { sync } = makeSync();
    await pass(sync);
    gh.setRateLimit("tok-u-a", 0);
    gh.repo("acme/web").pulls.get(8)!.updatedAt = "2020-03-01T00:00:00Z";
    await pass(sync);
    expect(changed()).toEqual([]);
    gh.setRateLimit("tok-u-a", null);
    clock += 3_600_000;
    await pass(sync);
    expect(changed()).toEqual([{ projectId: "p-web", pulls: [8], list: true, at: clock }]);
  });

  test("overlapping passes join instead of running twice", async () => {
    const { sync } = makeSync();
    const a = sync.pollOnce();
    const b = sync.pollOnce();
    expect(a).toBe(b);
    await a;
    expect(sync.stats().passes).toBe(1);
  });

  test("noteChanged publishes at once (writes and, later, webhooks)", () => {
    const { sync } = makeSync();
    sync.noteChanged(TEAM, "p-web", [3], false);
    expect(changed()).toEqual([{ projectId: "p-web", pulls: [3], list: false, at: clock }]);
  });
});

describe("GithubCache", () => {
  const ok = (body: unknown, etag = `W/"${JSON.stringify(body)}"`) => ({ status: 200 as const, etag, body, bytes: JSON.stringify(body).length, link: null, rate: { remaining: 4000, resetAt: null, scopes: ["repo"] } });

  test("single-flight, fresh window, 304 revalidation, per-user keys", async () => {
    let now = 0;
    const calls: Array<[string, string, string | null]> = [];
    const cache = new GithubCache({
      now: () => now,
      get: async (token, path, etag) => {
        calls.push([token, path, etag]);
        await Bun.sleep(5);
        return etag ? { status: 304, rate: { remaining: 4000, resetAt: null, scopes: ["repo"] } } : ok({ n: 1 });
      },
    });
    const [a, b] = await Promise.all([cache.read("u1", "t1", "/x"), cache.read("u1", "t1", "/x")]);
    expect(a).toBe(b);
    expect(calls.length).toBe(1);
    await cache.read("u1", "t1", "/x");
    expect(calls.length).toBe(1);
    now += 10_000;
    const again = await cache.read("u1", "t1", "/x");
    expect(again.body).toEqual({ n: 1 });
    expect(calls.at(-1)![2]).toBe('W/"{"n":1}"');
    await cache.read("u2", "t2", "/x");
    expect(calls.at(-1)).toEqual(["t2", "/x", null]);
    expect(cache.scopesOf("u1")).toEqual(["repo"]);
  });

  test("bounded: oldest entries go first when entries or bytes overflow", async () => {
    const cache = new GithubCache({ now: () => 0, maxEntries: 3, get: async (_t, path) => ok({ path }) });
    for (const p of ["/a", "/b", "/c", "/d"]) await cache.read("u", "t", p);
    expect(cache.stats().entries).toBe(3);
    const big = new GithubCache({ now: () => 0, maxBytes: 800, get: async (_t, path) => ok({ path, pad: "x".repeat(60) }) });
    for (let i = 0; i < 20; i++) await big.read("u", "t", `/p${i}`);
    expect(big.stats().bytes).toBeLessThanOrEqual(800);
  });

  test("lost access drops the copy; GitHub down serves it stale", async () => {
    let now = 0;
    let fail: GithubError | null = null;
    const cache = new GithubCache({ now: () => now, get: async () => { if (fail) throw fail; return ok({ v: 1 }); } });
    await cache.read("u", "t", "/r");
    now += 10_000;
    fail = new GithubError("unavailable", "down", 502);
    expect((await cache.read("u", "t", "/r")).stale).toBe(true);
    fail = new GithubError("forbidden", "no", 403);
    await expect(cache.read("u", "t", "/r")).rejects.toBeInstanceOf(GithubError);
    fail = new GithubError("unavailable", "down", 502);
    await expect(cache.read("u", "t", "/r")).rejects.toBeInstanceOf(GithubError);
  });

  test("invalidate drops a path prefix for every member", async () => {
    let n = 0;
    const cache = new GithubCache({ now: () => 0, get: async () => ok({ n: ++n }) });
    await cache.read("u1", "t", "/repos/a/pulls/1");
    await cache.read("u2", "t", "/repos/a/pulls/1/files");
    await cache.read("u1", "t", "/repos/a/pulls/10");
    cache.invalidate("/repos/a/pulls/1");
    expect(cache.stats().entries).toBe(0);
  });
});
