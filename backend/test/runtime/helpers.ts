// Shared fixture for the team runtime: a fixed team at the gateway boundary, the in-memory runtime
// door, the Freestyle mock, and a team whose Relay workspace is already provisioned (sealed with the
// app's own key), so the runner never needs the network for Relay.
import type { Role } from "@morrow/contracts";
import type { ActorGateway, TeamRecord, UserRecord } from "../../src/actors/types.ts";
import { encryptGithubToken } from "../../src/http/githubAccess.ts";
import { environmentRoutes } from "../../src/http/routes/environments.ts";
import { SESSION_COOKIE } from "../../src/http/session.ts";
import { createLogger } from "../../src/lib/logger.ts";
import type { TeamRelayObserverOptions } from "../../src/integrations/relay/index.ts";
import type { ObserverLike } from "../../src/runtime/observers.ts";
import { sealRelaySecrets } from "../../src/runtime/relayWorkspaces.ts";
import type { RuntimeTiming } from "../../src/runtime/teamRuntime.ts";
import type { BuildOptions } from "../../src/server.ts";
import { makeTestApp, unreachableActors, type TestApp } from "../support/app.ts";
import { fakeRuntimeActors, type FakeRuntimeActors } from "../support/fakeRuntimeActors.ts";
import type { FakeGithub } from "../support/fakeGithub.ts";
import { useMock } from "../freestyle/helpers.ts";

export const TEAM = "t-rt";
export const OTHER = "t-other";
export const RELAY_URL = "https://relay.invalid";
export const WORKSPACE_KEY = "rk_live_TESTSECRETworkspacekey0123456789";

/** Loops never fire on their own in tests; each test drives what it needs. */
export const QUIET: Partial<RuntimeTiming> = {
  reconcileMs: 3_600_000,
  statusViewersMs: 3_600_000,
  statusAllMs: 3_600_000,
  probeMs: 3_600_000,
  nodeOfflineGraceMs: 3_600_000,
  // The Freestyle mock runs no follower script; test/runtime/inspect-stream.test.ts plays one.
  inspectStreaming: false,
};

export interface FixtureOptions {
  freestyle?: boolean;
  relay?: boolean;
  people?: Array<[string, Role | null]>;
  timing?: Partial<RuntimeTiming>;
  /** Defaults to an observer that connects nowhere; null uses the real `TeamRelayObserver`. */
  createObserver?: NonNullable<BuildOptions["runtime"]>["createObserver"] | null;
  /** A real Relay engine: the team starts unprovisioned. */
  relayUrl?: string;
  /** A backend restart: same Terse state, same VMs, same keys, fresh process memory. */
  restartOf?: Fixture;
  now?: () => number;
  /** A fake GitHub; every person holds the token `githubTokenOf(userId)` for it. Without it, no one has a GitHub token. */
  github?: FakeGithub;
}

/** The GitHub token a fixture person holds when the fixture has a fake GitHub. */
export const githubTokenOf = (userId: string) => `gho_TESTSECRET_${userId}_0123456789`;

/** Every log line the app writes, for asserting that secrets never reach the logs. */
export const logLines: string[] = [];
const captureLog = createLogger({ level: "debug", write: (line) => void logLines.push(line) });

export const DEFAULT_PEOPLE: Array<[string, Role | null]> = [
  ["u-owner", "owner"],
  ["u-admin", "admin"],
  ["u-member", "member"],
  ["u-out", null],
];

export interface Fixture {
  t: TestApp;
  keys: { SESSION_SECRET: string; DATA_ENCRYPTION_KEY: string };
  actors: FakeRuntimeActors;
  fs: ReturnType<typeof useMock>;
  team: TeamRecord;
  cookies: Record<string, string>;
  call(who: string, method: string, path: string, body?: unknown, opts?: { csrf?: boolean }): Promise<Response>;
  /** Waits until the runner has nothing in flight for this environment. */
  settle(envId: string): Promise<void>;
  close(options?: { keepMock?: boolean }): Promise<void>;
}

export async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const people = options.people ?? DEFAULT_PEOPLE;
  const fs = options.restartOf?.fs ?? useMock();
  const actors = options.restartOf?.actors ?? fakeRuntimeActors();
  const keys = options.restartOf?.keys ?? { SESSION_SECRET: randomKey(), DATA_ENCRYPTION_KEY: randomKey() };
  const team: TeamRecord = {
    id: TEAM,
    name: "Runtime",
    slug: "runtime",
    members: people.filter(([, r]) => r).map(([userId, role]) => ({ userId, role: role!, login: userId.slice(2), name: null, avatarUrl: null })),
    projects: [{ id: "p-web", repoFullName: "acme/web", defaultBranch: "main", testCommand: null }],
    environments: [],
    policy: { allowInspect: true, maxParallelPerTask: 3 },
    relayReady: true,
  };
  const other: TeamRecord = { ...team, id: OTHER, slug: "other", members: [{ userId: "u-out", role: "owner", login: "out", name: null, avatarUrl: null }] };
  const users = new Map<string, UserRecord>(
    people.map(([id, role]) => [
      id,
      { id, githubId: 1, login: id.slice(2), name: null, avatarUrl: null, email: null, sessionVersion: 1, teamIds: role ? [TEAM] : [OTHER] },
    ]),
  );
  for (const [id, role] of people) {
    if (!actors.users.has(id)) actors.users.set(id, { id, login: id.slice(2), teamIds: role ? [TEAM] : [OTHER], relayHumanTokens: {}, freestyleIdentityId: null });
  }
  const tokenEnc = new Map<string, string>();
  const gateway: Partial<ActorGateway> = {
    getUser: async (id) => users.get(id) ?? null,
    getTeam: async (id) => (id === TEAM ? structuredClone(team) : id === OTHER ? structuredClone(other) : null),
    getGithubTokenEnc: async (id) => tokenEnc.get(id) ?? null,
    bumpSessionVersion: async (id) => {
      const user = users.get(id)!;
      user.sessionVersion += 1;
      return user.sessionVersion;
    },
  };
  const env: Record<string, string | undefined> = {
    RELAY_BASE_URL: options.relay === false ? "disabled" : (options.relayUrl ?? RELAY_URL),
    FREESTYLE_API_KEY: options.freestyle === false ? undefined : fs.mock.apiKey,
    FREESTYLE_BASE_SNAPSHOT: "freestyle/ubuntu",
    ...(options.github ? { GITHUB_API_URL: options.github.url, GITHUB_WEB_URL: options.github.url } : {}),
    ...keys,
  };
  const t = await makeTestApp({
    actors: unreachableActors(gateway),
    env,
    log: captureLog,
    now: options.now,
    modules: [environmentRoutes],
    build: {
      runtimeActors: actors,
      rateLimits: { terminal: { capacity: 100, refillPerSecond: 100 }, ticket: { capacity: 100, refillPerSecond: 100 }, mutation: { capacity: 100, refillPerSecond: 100 } },
      runtime: {
        freestyleClient: () => fs.client,
        timing: { ...QUIET, ...options.timing },
        createObserver: options.createObserver === null ? undefined : (options.createObserver ?? idleObserver),
        vmWait: { intervalMs: 5, timeoutMs: 2_000 },
        backoffMs: () => 5,
        reprobeDelayMs: 10,
      },
    },
  });
  if (options.relay !== false && !options.relayUrl) {
    for (const teamId of [TEAM, OTHER]) {
      if (actors.relays.has(teamId)) continue;
      const sealed = await sealRelaySecrets(t.deps.keys.data, teamId, {
        workspaceId: `ws_${teamId}`,
        baseUrl: RELAY_URL,
        workspaceKey: WORKSPACE_KEY,
        dispatcherToken: "at_live_TESTSECRETdispatcher0123456789",
        observer: { id: "tok_obs", token: "at_live_TESTSECRETobserver0123456789", expiresAt: null },
      });
      actors.relays.set(teamId, { ...sealed, cursor: null });
    }
  }
  if (options.github) for (const [id] of people) tokenEnc.set(id, await encryptGithubToken(t.deps, id, githubTokenOf(id)));
  const cookies: Record<string, string> = {};
  for (const [id] of people) cookies[id] = `${SESSION_COOKIE}=${await t.deps.sessions.encode({ uid: id, sv: 1, exp: Date.now() + 3_600_000 })}`;

  return {
    t,
    keys,
    actors,
    fs,
    team,
    cookies,
    call: (who, method, path, body, opts = {}) =>
      t.request(path, {
        method,
        csrf: opts.csrf ?? method !== "GET",
        cookie: cookies[who],
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    async settle(envId) {
      // `drive` is single-flight: it joins the loop in flight, or runs one until the environment settles.
      await t.deps.runtime.environments.drive(TEAM, envId);
    },
    async close({ keepMock = false } = {}) {
      await t.deps.runtime.stop();
      if (!keepMock) await fs.restore();
    },
  };
}

/** An observer that connects nowhere; records what the manager asked of it. */
export interface FakeObserver extends ObserverLike {
  options: TeamRelayObserverOptions;
  starts: number;
  stops: number;
  tokens: string[];
}

export function idleObserver(options: TeamRelayObserverOptions): FakeObserver {
  const o: FakeObserver = {
    options,
    starts: 0,
    stops: 0,
    tokens: [],
    async start() {
      o.starts++;
    },
    async stop() {
      o.stops++;
    },
    async replaceToken(token: string) {
      o.tokens.push(token);
    },
    health: () => ({ running: o.starts > o.stops, cursor: 0, queueDepth: 0, lastEventAt: null, lastErrorAt: null, authFailed: false, resubscribes: 0 }),
  };
  return o;
}

function randomKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}
