import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { canPush, GithubClient, GithubError, toRepoSummary } from "../src/integrations/github/client.ts";
import { startFakeGithub, type FakeGithub, type FakeUser } from "./support/fakeGithub.ts";

let gh: FakeGithub;
let client: GithubClient;
const alice: FakeUser = {
  id: 42,
  login: "alice",
  name: "Alice",
  avatarUrl: "https://avatars.example.com/u/42",
  token: "gho_alice",
  emails: [
    { email: "old@example.com", primary: false, verified: true },
    { email: "alice@example.com", primary: true, verified: true },
  ],
  repos: Array.from({ length: 7 }, (_, i) => ({ id: i + 1, fullName: `alice/repo-${i}`, rootFiles: ["package.json"], packageJson: '{"scripts":{"test":"x"}}' })),
};

beforeAll(() => {
  gh = startFakeGithub();
  gh.addUser(alice);
  client = new GithubClient({ clientId: gh.clientId, clientSecret: gh.clientSecret, apiUrl: gh.url, webUrl: gh.url, timeoutMs: 2000 });
});
afterAll(() => gh.stop());

describe("GithubClient", () => {
  test("authorize URL carries client id, scopes, state, redirect", () => {
    const url = new URL(client.authorizeUrl("st", "http://app/cb"));
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: gh.clientId, scope: "read:user user:email repo", state: "st", redirect_uri: "http://app/cb" });
  });

  test("code exchange: success, bad code, wrong client secret", async () => {
    const code = gh.issueCode(alice);
    expect(await client.exchangeCode(code, "http://app/cb")).toEqual({ accessToken: "gho_alice", scopes: ["read:user", "user:email", "repo"] });
    await expect(client.exchangeCode(code, "http://app/cb")).rejects.toMatchObject({ kind: "unauthorized" });
    const wrong = new GithubClient({ clientId: gh.clientId, clientSecret: "nope", apiUrl: gh.url, webUrl: gh.url });
    await expect(wrong.exchangeCode(gh.issueCode(alice), "http://app/cb")).rejects.toBeInstanceOf(GithubError);
  });

  test("user fetch picks the primary verified email and sends the token as a bearer header", async () => {
    expect(await client.getUser("gho_alice")).toEqual({ id: 42, login: "alice", name: "Alice", avatarUrl: "https://avatars.example.com/u/42", email: "alice@example.com" });
    const last = gh.requests.at(-1)!;
    expect(last.auth).toBe("Bearer gho_alice");
    expect(last.path).toBe("/user/emails");
  });

  test("no verified primary email -> null", async () => {
    gh.addUser({ id: 7, login: "bob", token: "gho_bob", emails: [{ email: "b@x", primary: true, verified: false }] });
    expect((await client.getUser("gho_bob")).email).toBeNull();
  });

  test("bad token is classified unauthorized", async () => {
    await expect(client.getUser("gho_nope")).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
  });

  test("repo listing pages via Link header and maps to RepoSummary", async () => {
    const p1 = await client.listRepos("gho_alice", 1, 5);
    expect(p1.repos).toHaveLength(5);
    expect(p1.hasMore).toBe(true);
    const p2 = await client.listRepos("gho_alice", 2, 5);
    expect(p2.repos).toHaveLength(2);
    expect(p2.hasMore).toBe(false);
    expect(toRepoSummary(p1.repos[0]!)).toEqual({ id: 1, fullName: "alice/repo-0", private: false, defaultBranch: "main", description: null, pushedAt: "2020-01-01T00:00:00Z" });
  });

  test("getRepo, push permission, contents", async () => {
    const repo = await client.getRepo("gho_alice", "alice/repo-3");
    expect(canPush(repo)).toBe(true);
    expect(canPush({ ...repo, permissions: { pull: true } })).toBe(false);
    expect(canPush({ ...repo, permissions: undefined })).toBe(false);
    await expect(client.getRepo("gho_alice", "alice/missing")).rejects.toMatchObject({ kind: "not_found" });
    expect(await client.listRootFiles("gho_alice", "alice/repo-3", "main")).toEqual(["package.json"]);
    expect(await client.readSmallFile("gho_alice", "alice/repo-3", "package.json", "main")).toBe('{"scripts":{"test":"x"}}');
    expect(await client.readSmallFile("gho_alice", "alice/repo-3", "nope.json", "main")).toBeNull();
  });

  test("rate limit and outage classification", async () => {
    gh.failWith(429);
    await expect(client.getUser("gho_alice")).rejects.toMatchObject({ kind: "rate_limited" });
    gh.failWith(502);
    await expect(client.getUser("gho_alice")).rejects.toMatchObject({ kind: "unavailable" });
    gh.failWith(null);
    const down = new GithubClient({ clientId: "x", clientSecret: "y", apiUrl: "http://127.0.0.1:9", webUrl: "http://127.0.0.1:9", timeoutMs: 500 });
    await expect(down.getUser("t")).rejects.toMatchObject({ kind: "unavailable" });
  });
});
