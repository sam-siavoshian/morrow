// Role matrix for the environment, profile, terminal, inspect-ticket and workforce routes, run against
// the real runner and the Freestyle mock. Rows run in order on one environment owned by u-owner, so the
// destructive actions come last and, inside a row, the caller who succeeds goes last.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROFILE_DEFAULT_CONCURRENT, PROFILE_MAX_CONCURRENT, type EnvironmentView, type ProfileCheckResponse, type ProfileView, type WorkforceEnvironmentView, type WorkforceResponse } from "@morrow/contracts";
import { logLines, makeFixture, OTHER, TEAM, WORKSPACE_KEY, type Fixture } from "./helpers.ts";

let f: Fixture;
let env: EnvironmentView;
let profile: ProfileView;
const bodies: string[] = [];

beforeAll(async () => {
  f = await makeFixture();
  const res = await f.call("u-owner", "POST", `/api/teams/${TEAM}/environments`, { name: "Main box" });
  expect(res.status).toBe(201);
  env = (await res.json()) as EnvironmentView;
  await f.settle(env.id);
  // Something in another team that a TEAM member must never reach.
  f.actors.putEnvironment(OTHER, { id: "e-foreign", ownerUserId: "u-out", phase: "ready", nodeName: "n-foreign", linuxUser: "cu-foreign" });
  await f.actors.registerProfile(OTHER, { id: "cp-foreign", envId: "e-foreign", ownerUserId: "u-out", nodeName: "n-foreign", cli: "claude", label: "x", scopes: "all", maxConcurrent: 1 });
  f.actors.putLease(OTHER, { id: "l-foreign", nodeName: "n-foreign", profileId: "cp-foreign" });
});
afterAll(() => f.close());

async function expectStatuses(method: string, path: string, body: unknown, expected: Record<string, number>): Promise<Record<string, Response>> {
  const out: Record<string, Response> = {};
  for (const [who, status] of Object.entries(expected)) {
    const res = await f.call(who, method, path, body);
    const text = await res.clone().text();
    bodies.push(text);
    expect({ who, path, status: res.status, body: res.status === status ? "" : text }).toEqual({ who, path, status, body: "" });
    out[who] = res;
  }
  // Unauthenticated: always 401.
  const anon = await f.t.request(path, { method, csrf: method !== "GET", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(anon.status).toBe(401);
  return out;
}

const team = (path: string) => `/api/teams/${TEAM}${path}`;

describe("environment routes: authorization matrix", () => {
  test("the owner's environment provisioned in the background to awaiting_login", async () => {
    const stored = await f.actors.getEnvironment(TEAM, env.id);
    expect(stored?.phase).toBe("awaiting_login");
    expect(stored?.freestyleVmId).toBeTruthy();
    expect(env.ownerUserId).toBe("u-owner");
    expect(env.name).toBe("Main box");
  });

  test("reads: any member; an outsider gets 404", async () => {
    const all = { "u-owner": 200, "u-admin": 200, "u-member": 200, "u-out": 404 };
    await expectStatuses("GET", team("/workforce"), undefined, all);
    await expectStatuses("GET", team("/environments"), undefined, all);
    const detail = await expectStatuses("GET", team(`/environments/${env.id}`), undefined, all);
    const view = (await detail["u-member"]!.json()) as WorkforceEnvironmentView;
    expect(view).toMatchObject({ id: env.id, phase: "awaiting_login", profiles: [], liveLeases: 0 });
  });

  test("pool usage: every member reads it on the workforce view; an outsider gets 404; another team's never shows", async () => {
    const usage = { windows: [{ kind: "five_hour" as const, label: "5-hour", usedPercent: 42, resetsAt: null }], observedAt: 1_800_000_000_000, source: "probe" as const };
    await f.actors.registerProfile(TEAM, { id: "cp-usage", envId: env.id, ownerUserId: "u-owner", nodeName: env.nodeName ?? "n-x", cli: "claude", label: "usage", scopes: "all", maxConcurrent: 1 });
    expect(await f.actors.recordProfileUsage(TEAM, "cp-usage", usage)).toEqual({ applied: true });
    await f.actors.recordProfileUsage(OTHER, "cp-foreign", { ...usage, windows: [{ ...usage.windows[0]!, usedPercent: 13.7 }] });
    const res = await expectStatuses("GET", team("/workforce"), undefined, { "u-owner": 200, "u-admin": 200, "u-member": 200, "u-out": 404 });
    for (const who of ["u-owner", "u-admin", "u-member"]) {
      const body = (await res[who]!.json()) as WorkforceResponse;
      const profiles = body.environments.flatMap((e) => e.profiles);
      expect(profiles.find((p) => p.id === "cp-usage")?.usage).toEqual(usage);
      expect(JSON.stringify(body)).not.toContain("13.7");
    }
    expect((await f.call("u-owner", "GET", `/api/teams/${OTHER}/workforce`)).status).toBe(404);
    await f.actors.removeProfile(TEAM, "cp-usage");
  });

  test("open terminal: owner only, never cached", async () => {
    const res = await expectStatuses("POST", team(`/environments/${env.id}/terminal`), undefined, { "u-member": 403, "u-admin": 403, "u-out": 404, "u-owner": 200 });
    expect(res["u-owner"]!.headers.get("cache-control")).toBe("no-store");
    const token = (await res["u-owner"]!.json()) as { token: string; url: string };
    expect(token.token.length).toBeGreaterThan(8);
    expect((await f.actors.getEnvironment(TEAM, env.id))!.freestyleIdentityId).toBeTruthy();
    expect(logLines.some((l) => l.includes(token.token))).toBe(false);
  });

  test("register a CLI profile: owner only; one per CLI per environment", async () => {
    const body = { cli: "claude", label: "Claude Max" };
    const res = await expectStatuses("POST", team(`/environments/${env.id}/profiles`), body, { "u-member": 403, "u-admin": 403, "u-out": 404, "u-owner": 201 });
    profile = (await res["u-owner"]!.json()) as ProfileView;
    expect(profile).toMatchObject({ envId: env.id, ownerUserId: "u-owner", cli: "claude", label: "Claude Max", scopes: "all", maxConcurrent: PROFILE_DEFAULT_CONCURRENT });
    expect((await f.call("u-owner", "POST", team(`/environments/${env.id}/profiles`), body)).status).toBe(409);
    expect((await f.call("u-owner", "POST", team(`/environments/${env.id}/profiles`), { cli: "codex", label: "bad\nlabel" })).status).toBe(400);
  });

  test("register keeps the chosen maxConcurrent (1-8); anything else is a 400", async () => {
    const path = team(`/environments/${env.id}/profiles`);
    for (const maxConcurrent of [0, PROFILE_MAX_CONCURRENT + 1, 2.5, "2", null, -1])
      expect((await f.call("u-owner", "POST", path, { cli: "codex", label: "Codex", maxConcurrent })).status).toBe(400);
    const res = await f.call("u-owner", "POST", path, { cli: "codex", label: "Codex", maxConcurrent: PROFILE_MAX_CONCURRENT });
    expect(res.status).toBe(201);
    const codex = (await res.json()) as ProfileView;
    expect(codex.maxConcurrent).toBe(PROFILE_MAX_CONCURRENT);
    expect((await f.actors.getProfile(TEAM, codex.id))?.maxConcurrent).toBe(PROFILE_MAX_CONCURRENT);
    expect((await f.call("u-owner", "DELETE", team(`/profiles/${codex.id}`))).status).toBe(204);
  });

  test("workers at once: the profile's owner only, 1-8, changed in place and nothing else", async () => {
    const path = team(`/profiles/${profile.id}`);
    const res = await expectStatuses("PATCH", path, { maxConcurrent: 6 }, { "u-member": 403, "u-admin": 403, "u-out": 404, "u-owner": 200 });
    const updated = (await res["u-owner"]!.json()) as ProfileView;
    expect(updated).toMatchObject({ id: profile.id, envId: env.id, ownerUserId: "u-owner", cli: "claude", label: "Claude Max", scopes: "all", maxConcurrent: 6 });
    expect((await f.actors.getProfile(TEAM, profile.id))?.maxConcurrent).toBe(6);
    // The same value again is a no-op that still answers with the profile.
    expect(((await (await f.call("u-owner", "PATCH", path, { maxConcurrent: 6 })).json()) as ProfileView).maxConcurrent).toBe(6);
    for (const maxConcurrent of [0, PROFILE_MAX_CONCURRENT + 1, 2.5, "2", null, -1, undefined])
      expect((await f.call("u-owner", "PATCH", path, { maxConcurrent })).status).toBe(400);
    expect((await f.call("u-owner", "PATCH", path, "not json")).status).toBe(400);
    // Another team's profile, an unknown id or a malformed one: 404, and the other team's is untouched.
    for (const id of ["cp-foreign", "cp-nope", "bad id!"]) expect((await f.call("u-owner", "PATCH", team(`/profiles/${encodeURIComponent(id)}`), { maxConcurrent: 2 })).status).toBe(404);
    expect((await f.actors.getProfile(OTHER, "cp-foreign"))?.maxConcurrent).toBe(1);
    expect((await f.actors.getProfile(TEAM, profile.id))?.maxConcurrent).toBe(6);
    // A node's capacity does not follow this setting, so the change never asks the VM for anything.
    expect((await f.call("u-owner", "PATCH", path, { maxConcurrent: PROFILE_DEFAULT_CONCURRENT })).status).toBe(200);
  });

  test("check a profile: owner only", async () => {
    const res = await expectStatuses("POST", team(`/profiles/${profile.id}/check`), undefined, { "u-member": 403, "u-admin": 403, "u-out": 404, "u-owner": 200 });
    const check = (await res["u-owner"]!.json()) as ProfileCheckResponse;
    expect(check.probe.ok).toBe(true);
    expect(check.profile.id).toBe(profile.id);
  });

  test("inspect ticket: any member while the lease is live; not for a finished one", async () => {
    const stored = (await f.actors.getEnvironment(TEAM, env.id))!;
    f.actors.putLease(TEAM, { id: "l-live", nodeName: stored.nodeName!, profileId: profile.id });
    f.actors.putLease(TEAM, { id: "l-done", nodeName: stored.nodeName!, profileId: profile.id, state: "released" });
    const res = await expectStatuses("POST", team("/inspect/ticket"), { leaseId: "l-live" }, { "u-owner": 200, "u-admin": 200, "u-member": 200, "u-out": 404 });
    const { url } = (await res["u-member"]!.json()) as { url: string };
    expect(url).toMatch(/^ws:\/\/localhost:8787\/realtime\/inspect\/l-live\?ticket=/);
    expect((await f.call("u-member", "POST", team("/inspect/ticket"), { leaseId: "l-done" })).status).toBe(404);
  });

  test("pause: owner or admin; refused while a worker runs on the node", async () => {
    await expectStatuses("POST", team(`/environments/${env.id}/pause`), undefined, { "u-member": 403, "u-out": 404, "u-admin": 409 });
    f.actors.leases.get(TEAM)!.get("l-live")!.state = "released";
    const res = await expectStatuses("POST", team(`/environments/${env.id}/pause`), undefined, { "u-member": 403, "u-out": 404, "u-admin": 200, "u-owner": 200 });
    expect(((await res["u-owner"]!.json()) as EnvironmentView).phase).toBe("paused");
    expect(f.fs.mock.vms.get((await f.actors.getEnvironment(TEAM, env.id))!.freestyleVmId!)!.data.state).not.toBe("running");
    // Paused: no terminal.
    expect((await f.call("u-owner", "POST", team(`/environments/${env.id}/terminal`))).status).toBe(409);
  });

  test("resume: owner only", async () => {
    const res = await expectStatuses("POST", team(`/environments/${env.id}/resume`), undefined, { "u-member": 403, "u-admin": 403, "u-out": 404, "u-owner": 200 });
    expect(((await res["u-owner"]!.json()) as EnvironmentView).phase).not.toBe("paused");
    expect((await f.call("u-owner", "POST", team(`/environments/${env.id}/resume`))).status).toBe(409);
  });

  test("remove a profile: owner only", async () => {
    await expectStatuses("DELETE", team(`/profiles/${profile.id}`), undefined, { "u-member": 403, "u-admin": 403, "u-out": 404, "u-owner": 204 });
    expect((await f.call("u-owner", "DELETE", team(`/profiles/${profile.id}`))).status).toBe(404);
  });

  test("disconnect: owner or admin; deletes the VM; repeatable", async () => {
    const vmId = (await f.actors.getEnvironment(TEAM, env.id))!.freestyleVmId!;
    await expectStatuses("POST", team(`/environments/${env.id}/disconnect`), undefined, { "u-member": 403, "u-out": 404, "u-admin": 200, "u-owner": 200 });
    expect(f.fs.mock.vms.has(vmId)).toBe(false);
    const list = (await (await f.call("u-owner", "GET", team("/environments"))).json()) as { environments: EnvironmentView[] };
    expect(list.environments.find((e) => e.id === env.id)).toBeUndefined();
  });

  test("create: any member, at most 3 live environments each", async () => {
    await expectStatuses("POST", team("/environments"), {}, { "u-member": 201, "u-out": 404 });
    for (let i = 0; i < 3; i++) expect((await f.call("u-admin", "POST", team("/environments"), { name: `box ${i}` })).status).toBe(201);
    const fourth = await f.call("u-admin", "POST", team("/environments"), { name: "box 4" });
    expect(fourth.status).toBe(409);
    expect((await f.call("u-member", "POST", team("/environments"), { name: "bad\u0007name" })).status).toBe(400);
    for (const e of await f.actors.listEnvironments(TEAM)) await f.settle(e.id);
  });
});

describe("environment routes: isolation and request guards", () => {
  test("another team's environment, profile or lease looks exactly like an unknown one", async () => {
    const pairs: Array<[string, string, string, unknown?]> = [
      ["GET", team("/environments/e-foreign"), team("/environments/e-unknown")],
      ["POST", team("/environments/e-foreign/pause"), team("/environments/e-unknown/pause")],
      ["POST", team("/environments/e-foreign/terminal"), team("/environments/e-unknown/terminal")],
      ["POST", team("/environments/e-foreign/disconnect"), team("/environments/e-unknown/disconnect")],
      ["POST", team("/profiles/cp-foreign/check"), team("/profiles/cp-unknown/check")],
      ["DELETE", team("/profiles/cp-foreign"), team("/profiles/cp-unknown")],
    ];
    for (const [method, foreign, unknown] of pairs) {
      const a = await f.call("u-owner", method, foreign);
      const b = await f.call("u-owner", method, unknown);
      expect({ foreign, status: a.status }).toEqual({ foreign, status: 404 });
      expect(await a.json()).toEqual(await b.json());
    }
    const lease = await f.call("u-owner", "POST", team("/inspect/ticket"), { leaseId: "l-foreign" });
    expect(lease.status).toBe(404);
    expect((await f.actors.getEnvironment(OTHER, "e-foreign"))!.phase).toBe("ready");
  });

  test("a member of one team cannot use another team's id in the path", async () => {
    expect((await f.call("u-owner", "GET", `/api/teams/${OTHER}/environments/e-foreign`)).status).toBe(404);
    expect((await f.call("u-owner", "POST", `/api/teams/${OTHER}/environments/e-foreign/disconnect`)).status).toBe(404);
  });

  test("mutations without the CSRF header or from another origin are refused before any work", async () => {
    const before = f.actors.calls.length;
    const noHeader = await f.call("u-owner", "POST", team("/environments"), {}, { csrf: false });
    expect(noHeader.status).toBe(403);
    const crossSite = await f.t.request(team("/environments"), {
      method: "POST",
      cookie: f.cookies["u-owner"],
      headers: { "content-type": "application/json", "x-morrow-csrf": "1", origin: "https://evil.example" },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    expect(f.actors.calls.length).toBe(before);
  });

  test("bad ids and bodies are rejected", async () => {
    expect((await f.call("u-owner", "GET", team("/environments/..%2F..%2Fetc"))).status).toBe(404);
    expect((await f.call("u-owner", "POST", team("/inspect/ticket"), { leaseId: "../x" })).status).toBe(400);
    expect((await f.call("u-owner", "POST", team("/environments"), { name: "x".repeat(500) })).status).toBe(400);
  });

  test("no response or log line carries a Relay secret", async () => {
    const workforce = (await (await f.call("u-owner", "GET", team("/workforce"))).json()) as WorkforceResponse;
    expect(workforce.features).toEqual({ freestyle: true, relay: true });
    for (const text of [...bodies, JSON.stringify(workforce)]) {
      expect(text).not.toContain(WORKSPACE_KEY);
      expect(text).not.toContain("TESTSECRET");
    }
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) expect(line).not.toContain("TESTSECRET");
  });
});

describe("environment routes: features off", () => {
  test("without a Freestyle key, environment actions say so and /api/me reports it", async () => {
    const off = await makeFixture({ freestyle: false });
    try {
      const create = await off.call("u-owner", "POST", team("/environments"), {});
      expect(create.status).toBe(501);
      expect(((await create.json()) as { error: { code: string } }).error.code).toBe("feature_disabled");
      const workforce = (await (await off.call("u-owner", "GET", team("/workforce"))).json()) as WorkforceResponse;
      expect(workforce).toEqual({ environments: [], features: { freestyle: false, relay: true } });
      const me = (await (await off.call("u-owner", "GET", "/api/me")).json()) as { features: { freestyle: boolean } };
      expect(me.features.freestyle).toBe(false);
    } finally {
      await off.close();
    }
  });

  test("without Relay, creating an environment says so", async () => {
    const off = await makeFixture({ relay: false });
    try {
      const create = await off.call("u-owner", "POST", team("/environments"), {});
      expect(create.status).toBe(501);
    } finally {
      await off.close();
    }
  });
});
