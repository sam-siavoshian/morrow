// Per-account cost caps (M2): signup allowlist, owned-team cap, environment cap across teams.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EnvironmentView } from "@morrow/contracts";
import type { TeamRecord, UserRecord } from "../src/actors/types.ts";
import { EnvError, loadEnv, signupAllowed } from "../src/env.ts";
import { OAUTH_STATE_COOKIE } from "../src/http/routes/auth.ts";
import { USER_LIMITS, withEnvironmentQuota, withTeamQuota } from "../src/http/quotas.ts";
import { cookiesFrom, makeTestApp, unreachableActors } from "./support/app.ts";
import { testEnvSource } from "./support/env.ts";
import { startFakeGithub, type FakeGithub } from "./support/fakeGithub.ts";

describe("SIGNUP_ALLOWLIST", () => {
  test("unset or blank means open; logins are trimmed and case-insensitive", () => {
    expect(loadEnv(testEnvSource()).signupAllowlist).toBeNull();
    expect(loadEnv(testEnvSource({ SIGNUP_ALLOWLIST: "  " })).signupAllowlist).toBeNull();
    const env = loadEnv(testEnvSource({ SIGNUP_ALLOWLIST: " Ada, linus ,," }));
    expect([...env.signupAllowlist!]).toEqual(["ada", "linus"]);
    expect(signupAllowed(env, "ADA")).toBe(true);
    expect(signupAllowed(env, "grace")).toBe(false);
    expect(signupAllowed({ signupAllowlist: null }, "anyone")).toBe(true);
  });

  test("anything that is not a GitHub login fails boot", () => {
    for (const bad of ["ada,<script>", "a b", "x".repeat(40), ","]) expect(() => loadEnv(testEnvSource({ SIGNUP_ALLOWLIST: bad }))).toThrow(EnvError);
  });

  describe("OAuth callback", () => {
    let gh: FakeGithub;
    beforeAll(() => {
      gh = startFakeGithub();
      gh.addUser({ id: 11, login: "Ada", token: "tok-ada" });
      gh.addUser({ id: 12, login: "mallory", token: "tok-mallory" });
    });
    afterAll(() => gh.stop());

    async function signIn(login: "Ada" | "mallory") {
      const upserts: string[] = [];
      const t = await makeTestApp({
        env: { SIGNUP_ALLOWLIST: "ada", GITHUB_API_URL: gh.url, GITHUB_WEB_URL: gh.url, GITHUB_CLIENT_ID: gh.clientId, GITHUB_CLIENT_SECRET: gh.clientSecret },
        actors: unreachableActors({
          upsertUserFromGithub: async (profile) => {
            upserts.push(profile.login);
            return { id: `u-${profile.githubId}`, githubId: profile.githubId, login: profile.login, name: null, avatarUrl: null, email: null, sessionVersion: 1, teamIds: [] };
          },
        }),
      });
      const start = await t.request("/api/auth/github?returnTo=/t/x");
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const cookie = `${OAUTH_STATE_COOKIE}=${cookiesFrom(start)[OAUTH_STATE_COOKIE]!.value}`;
      const code = gh.issueCode(login === "Ada" ? { id: 11, login: "Ada", token: "tok-ada" } : { id: 12, login: "mallory", token: "tok-mallory" });
      const res = await t.request(`/api/auth/github/callback?code=${code}&state=${encodeURIComponent(state)}`, { cookie });
      return { res, upserts };
    }

    test("a listed login signs in", async () => {
      const { res, upserts } = await signIn("Ada");
      expect(res.headers.get("location")).toEndWith("/t/x");
      expect(cookiesFrom(res).morrow_session).toBeDefined();
      expect(upserts).toEqual(["Ada"]);
    });

    test("anyone else lands on /login?error=not_allowed, with no session and no user record", async () => {
      const { res, upserts } = await signIn("mallory");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toEndWith("/login?error=not_allowed");
      expect(cookiesFrom(res).morrow_session).toBeUndefined();
      expect(upserts).toEqual([]);
    });
  });
});

describe("per-user caps", () => {
  const env = (id: string, ownerUserId: string, phase: EnvironmentView["phase"] = "ready"): EnvironmentView => ({
    id, ownerUserId, name: id, linuxUser: null, nodeName: null, phase, vmState: "running", nodeOnline: true, lastError: null, createdAt: 0,
  });
  const team = (id: string, ownerId: string, environments: EnvironmentView[] = []): TeamRecord => ({
    id, name: id, slug: id, members: [{ userId: ownerId, login: "o", name: null, avatarUrl: null, role: "owner" }, { userId: "u-me", login: "me", name: null, avatarUrl: null, role: "member" }],
    projects: [], environments, policy: { allowInspect: true, maxParallelPerTask: 3 }, relayReady: false,
  });

  function world(teams: TeamRecord[]) {
    const store = new Map(teams.map((t) => [t.id, t]));
    const user = (): UserRecord => ({ id: "u-me", githubId: 1, login: "me", name: null, avatarUrl: null, email: null, sessionVersion: 1, teamIds: [...store.keys()] });
    return {
      store,
      actors: { getUser: async (id: string) => (id === "u-me" ? user() : null), getTeam: async (id: string) => store.get(id) ?? null },
    };
  }

  test("environments: counted across every team, disconnected ones free, a burst cannot pass the cap", async () => {
    const w = world([team("t-a", "u-other", [env("e-1", "u-me"), env("e-x", "u-other"), env("e-gone", "u-me", "disconnected")]), team("t-b", "u-other")]);
    let next = 0;
    const create = (teamId: string) => () =>
      Bun.sleep(5).then(() => {
        const t = w.store.get(teamId)!;
        w.store.set(teamId, { ...t, environments: [...t.environments, env(`e-new${next++}`, "u-me")] });
        return teamId;
      });
    const results = await Promise.allSettled(["t-a", "t-b", "t-b", "t-a", "t-b"].map((id) => withEnvironmentQuota(w.actors, "u-me", create(id))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(USER_LIMITS.environments - 1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 409, message: "You can run at most 3 environments across all your teams. Disconnect one first." });
    const live = [...w.store.values()].flatMap((t) => t.environments).filter((e) => e.ownerUserId === "u-me" && e.phase !== "disconnected");
    expect(live).toHaveLength(USER_LIMITS.environments);
  });

  test("teams: only owned teams count; a burst cannot pass the cap; a create that throws frees its turn", async () => {
    const w = world([team("t-joined", "u-other"), ...Array.from({ length: 3 }, (_, i) => team(`t-own${i}`, "u-me"))]);
    const create = (id: string) => () =>
      Bun.sleep(5).then(() => {
        w.store.set(id, team(id, "u-me"));
        return id;
      });
    await expect(withTeamQuota(w.actors, "u-me", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const results = await Promise.allSettled(["t-n1", "t-n2", "t-n3", "t-n4"].map((id) => withTeamQuota(w.actors, "u-me", create(id))));
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "rejected"]);
    expect([...w.store.values()].filter((t) => t.members.some((m) => m.userId === "u-me" && m.role === "owner"))).toHaveLength(USER_LIMITS.teamsOwned);
  });
});
