// Cutting access: one Freestyle identity per environment for terminal tokens, sign-out everywhere,
// and a removed member's environments (event path and the reconcile backstop). Real runner, Freestyle
// mock; tokens are tried for real with an identity-token SDK client, as the browser uses them.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TerminalTokenResponse } from "@morrow/contracts";
import { Freestyle } from "freestyle";
import { mintTerminalToken } from "../../src/integrations/freestyle/index.ts";
import type { StoredEnvironment } from "../../src/runtime/actors.ts";
import { logLines, makeFixture, TEAM, waitFor, type Fixture } from "./helpers.ts";

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
});
afterEach(() => f.close());

async function readyEnv(owner: string, name: string): Promise<StoredEnvironment> {
  const env = await f.t.deps.runtime.environments.create(TEAM, owner, name);
  await f.settle(env.id);
  const stored = (await f.actors.getEnvironment(TEAM, env.id))!;
  expect(stored.phase).toBe("awaiting_login");
  return stored;
}

async function execStatus(token: string, vmId: string, linuxUser: string): Promise<"ok" | number> {
  const browser = new Freestyle({ identityAccessToken: token, baseUrl: f.fs.mock.url });
  try {
    await browser.vms.ref(vmId).linuxUser(linuxUser).exec({ command: "true", timeoutMs: 5_000 });
    return "ok";
  } catch (error) {
    return (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status ?? -1;
  }
}

const runner = () => f.t.deps.runtime.environments;
const identityOf = async (envId: string) => (await f.actors.getEnvironment(TEAM, envId))!.freestyleIdentityId ?? null;
const grantsOf = (identityId: string) => [...f.fs.mock.identities.get(identityId)!.grants.values()].map((g) => [g.vmId, g.allowedLinuxUsers]);

async function terminalRoute(who: string, envId: string): Promise<TerminalTokenResponse> {
  const res = await f.call(who, "POST", `/api/teams/${TEAM}/environments/${envId}/terminal`);
  expect(res.status).toBe(200);
  return (await res.json()) as TerminalTokenResponse;
}

/** A user-wide identity as the old terminal route left it: granted on `env`'s VM and stored on the User. */
async function legacyIdentity(userId: string, env: StoredEnvironment): Promise<{ id: string; token: string }> {
  const minted = await mintTerminalToken({ identityId: null, vmId: env.freestyleVmId!, linuxUser: env.linuxUser!, client: f.fs.client });
  f.actors.users.get(userId)!.freestyleIdentityId = minted.identityId;
  return { id: minted.identityId, token: minted.response.token };
}

describe("terminal identities", () => {
  test("the terminal route mints from each environment's own identity; a token for A cannot open B", async () => {
    const a = await readyEnv("u-member", "A");
    const b = await readyEnv("u-member", "B");
    const tokenA = await terminalRoute("u-member", a.id);
    const tokenB = await terminalRoute("u-member", b.id);
    const idA = await identityOf(a.id);
    const idB = await identityOf(b.id);
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
    // Grant level: A's identity holds exactly one grant, on A's VM, as A's Linux user. Same for B.
    expect(grantsOf(idA!)).toEqual([[a.freestyleVmId!, [a.linuxUser!]]]);
    expect(grantsOf(idB!)).toEqual([[b.freestyleVmId!, [b.linuxUser!]]]);
    expect(f.fs.mock.identities.get(idA!)!.tokens.size).toBe(1);
    // No user-wide identity is created any more.
    expect(f.actors.users.get("u-member")!.freestyleIdentityId).toBeNull();

    expect(await execStatus(tokenA.token, a.freestyleVmId!, a.linuxUser!)).toBe("ok");
    expect(await execStatus(tokenA.token, b.freestyleVmId!, b.linuxUser!)).toBe(403);
    expect(await execStatus(tokenB.token, a.freestyleVmId!, a.linuxUser!)).toBe(403);
    expect(await execStatus(tokenA.token, a.freestyleVmId!, "root")).toBe(403);

    // The next mint reuses the environment's identity.
    const identitiesBefore = f.fs.mock.identities.size;
    await terminalRoute("u-member", a.id);
    expect(f.fs.mock.identities.size).toBe(identitiesBefore);
    expect(await identityOf(a.id)).toBe(idA);
  });

  test("migration: an older user-wide identity loses its grant on each VM at that VM's first mint", async () => {
    const a = await readyEnv("u-owner", "A");
    const b = await readyEnv("u-owner", "B");
    const legacy = await legacyIdentity("u-owner", a);
    await mintTerminalToken({ identityId: legacy.id, vmId: b.freestyleVmId!, linuxUser: b.linuxUser!, client: f.fs.client });
    expect(await execStatus(legacy.token, a.freestyleVmId!, a.linuxUser!)).toBe("ok");

    const fresh = await terminalRoute("u-owner", a.id);
    expect(grantsOf(legacy.id)).toEqual([[b.freestyleVmId!, [b.linuxUser!]]]);
    expect(await execStatus(legacy.token, a.freestyleVmId!, a.linuxUser!)).toBe(403);
    expect(await execStatus(fresh.token, a.freestyleVmId!, a.linuxUser!)).toBe("ok");
    // B is untouched until its own first mint, so an open terminal there keeps working meanwhile.
    expect(await execStatus(legacy.token, b.freestyleVmId!, b.linuxUser!)).toBe("ok");
    await terminalRoute("u-owner", b.id);
    expect(grantsOf(legacy.id)).toEqual([]);
  });

  test("two first mints at once create one identity", async () => {
    const a = await readyEnv("u-member", "A");
    const before = f.fs.mock.identities.size;
    const tokens = await Promise.all([terminalRoute("u-member", a.id), terminalRoute("u-member", a.id), terminalRoute("u-member", a.id)]);
    expect(f.fs.mock.identities.size).toBe(before + 1);
    for (const t of tokens) expect(await execStatus(t.token, a.freestyleVmId!, a.linuxUser!)).toBe("ok");
  });

  test("an identity the Team actor refuses to store is deleted again", async () => {
    const a = await readyEnv("u-member", "A");
    const before = new Set(f.fs.mock.identities.keys());
    const real = f.actors.updateEnvironment.bind(f.actors);
    f.actors.updateEnvironment = async (teamId, envId, patch) => {
      if (patch.freestyleIdentityId !== undefined) throw new Error("patch: unrecognized key");
      return real(teamId, envId, patch);
    };
    await expect(runner().mintTerminal(TEAM, a.id)).rejects.toThrow();
    f.actors.updateEnvironment = real;
    expect([...f.fs.mock.identities.keys()].filter((id) => !before.has(id))).toEqual([]);
    expect(await identityOf(a.id)).toBeNull();
  });

  test("no token before the VM is up, and none after disconnect; disconnect deletes the identity", async () => {
    f.actors.putEnvironment(TEAM, { id: "e-early", ownerUserId: "u-member", phase: "provisioning" });
    await expect(runner().mintTerminal(TEAM, "e-early")).rejects.toMatchObject({ code: "conflict" });

    const a = await readyEnv("u-member", "A");
    const { token } = await runner().mintTerminal(TEAM, a.id);
    const id = (await identityOf(a.id))!;
    await runner().disconnect(TEAM, a.id, []);
    expect(f.fs.mock.identities.has(id)).toBe(false);
    expect(await execStatus(token, a.freestyleVmId!, a.linuxUser!)).not.toBe("ok");
    await expect(runner().mintTerminal(TEAM, a.id)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("sign-out everywhere", () => {
  test("cuts every terminal grant and token the user holds, user-wide and per environment", async () => {
    const a = await readyEnv("u-member", "A");
    const b = await readyEnv("u-member", "B");
    const theirs = await readyEnv("u-admin", "Admin box");
    const { id: legacyId, token: legacyToken } = await legacyIdentity("u-member", a);
    const tokenB = (await terminalRoute("u-member", b.id)).token;
    const adminToken = (await runner().mintTerminal(TEAM, theirs.id)).token;

    expect((await f.call("u-member", "POST", "/api/auth/logout?everywhere=1")).status).toBe(204);

    for (const id of [legacyId, (await identityOf(b.id))!]) {
      const identity = f.fs.mock.identities.get(id)!;
      expect({ grants: identity.grants.size, tokens: identity.tokens.size }).toEqual({ grants: 0, tokens: 0 });
    }
    expect(await execStatus(legacyToken, a.freestyleVmId!, a.linuxUser!)).not.toBe("ok");
    expect(await execStatus(tokenB, b.freestyleVmId!, b.linuxUser!)).not.toBe("ok");
    // Someone else's terminal is untouched; the old cookie is dead.
    expect(await execStatus(adminToken, theirs.freestyleVmId!, theirs.linuxUser!)).toBe("ok");
    expect((await f.call("u-member", "GET", `/api/teams/${TEAM}/environments`)).status).toBe(401);
  });

  test("a Freestyle outage does not fail the sign-out", async () => {
    const a = await readyEnv("u-member", "A");
    await runner().mintTerminal(TEAM, a.id);
    f.fs.mock.faults.push({ method: "GET", path: /^\/v5\/identities\/[^/]+\/permissions\/vm$/, mode: "before", status: 503 });
    const logged = logLines.length;
    expect((await f.call("u-member", "POST", "/api/auth/logout?everywhere=1")).status).toBe(204);
    expect((await f.call("u-member", "GET", `/api/teams/${TEAM}/environments`)).status).toBe(401);
    expect(logLines.slice(logged).some((l) => l.includes("terminal revoke failed"))).toBe(true);
  });
});

describe("member removal", () => {
  test("the removed member's environments are disconnected; their leases expire into handoff; others stay", async () => {
    const mine = await readyEnv("u-member", "Mine");
    const owners = await readyEnv("u-owner", "Owner box");
    const { token } = await runner().mintTerminal(TEAM, mine.id);
    const identity = (await identityOf(mine.id))!;
    await f.actors.registerProfile(TEAM, { id: "cp-mine", envId: mine.id, ownerUserId: "u-member", nodeName: mine.nodeName!, cli: "claude", label: "x", scopes: "all", maxConcurrent: 1 });
    f.actors.putLease(TEAM, { id: "l-mine", nodeName: mine.nodeName!, profileId: "cp-mine" });

    f.team.members = f.team.members.filter((m) => m.userId !== "u-member");
    // Fired and not awaited, as the members route does. The Relay steps after it (observer rotation,
    // member identity) fail slowly against relay.invalid and are covered in relay.e2e.test.ts.
    const cleanup = f.t.deps.teamEvents.emitMemberRemoved({ teamId: TEAM, userId: "u-member", removedBy: "u-owner" });
    await waitFor(async () => (await f.actors.getEnvironment(TEAM, mine.id))!.phase === "disconnected", 5_000, "disconnected");

    expect((await f.actors.getEnvironment(TEAM, mine.id))!.phase).toBe("disconnected");
    expect(f.fs.mock.vms.has(mine.freestyleVmId!)).toBe(false);
    expect(f.fs.mock.identities.has(identity)).toBe(false);
    expect(await execStatus(token, mine.freestyleVmId!, mine.linuxUser!)).not.toBe("ok");
    expect(await f.actors.getProfile(TEAM, "cp-mine")).toBeNull();
    expect((await f.actors.getLease(TEAM, "l-mine"))!.state).toBe("expired");

    expect((await f.actors.getEnvironment(TEAM, owners.id))!.phase).toBe("awaiting_login");
    expect(f.fs.mock.vms.has(owners.freestyleVmId!)).toBe(true);
    await cleanup;
  }, 30_000);

  test("reconcile disconnects what a failed cleanup left behind", async () => {
    const mine = await readyEnv("u-admin", "Mine");
    const owners = await readyEnv("u-owner", "Owner box");
    // Removed while the backend was down: no event ever ran. Boot finds the team by its VMs.
    f.team.members = f.team.members.filter((m) => m.userId !== "u-admin");
    await f.t.deps.runtime.pollStatus(true);
    await f.t.deps.runtime.reconcile();

    expect((await f.actors.getEnvironment(TEAM, mine.id))!.phase).toBe("disconnected");
    expect(f.fs.mock.vms.has(mine.freestyleVmId!)).toBe(false);
    expect((await f.actors.getEnvironment(TEAM, owners.id))!.phase).toBe("awaiting_login");
  });
});
