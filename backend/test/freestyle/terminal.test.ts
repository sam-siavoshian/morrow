import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Freestyle, FreestyleApiError } from "freestyle";
import { TerminalTokenResponse } from "@morrow/contracts";
import { mintTerminalToken, revokeTerminalAccess, TERMINAL_TOKEN_TTL_MS } from "../../src/integrations/freestyle/index.ts";
import { useMock } from "./helpers.ts";

const USER = "u0123456789ab";
const OTHER = "ubbbbbbbbbbbb";

let ctx: ReturnType<typeof useMock>;
beforeEach(() => {
  ctx = useMock();
});
afterEach(() => ctx.restore());

async function vm(): Promise<string> {
  const { vmId } = await ctx.client.vms.create({ firewall: { rules: [] } });
  const guest = ctx.mock.vms.get(vmId)!.guest;
  guest.users.add(USER);
  guest.users.add(OTHER);
  return vmId;
}

async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof FreestyleApiError) return error.status;
    throw error;
  }
}

describe("mintTerminalToken", () => {
  test("returns a contract-valid response with a 15 minute TTL and a grant limited to one Linux user", async () => {
    const vmId = await vm();
    const now = Date.now();
    const minted = await mintTerminalToken({ identityId: null, vmId, linuxUser: USER, now });
    expect(TerminalTokenResponse.parse(minted.response)).toEqual(minted.response);
    expect(minted.response).toMatchObject({ vmId, linuxUser: USER, session: "main", expiresAt: now + TERMINAL_TOKEN_TTL_MS });
    const identity = ctx.mock.identities.get(minted.identityId)!;
    expect(identity.grants.get(vmId)!.allowedLinuxUsers).toEqual([USER]);
    const stored = [...identity.tokens.values()][0]!;
    expect(Date.parse(stored.expiresAt!)).toBe(now + 15 * 60_000);
  });

  test("the token reaches exec/PTY on that VM as that user, and nothing else", async () => {
    const vmId = await vm();
    const otherVm = await vm();
    const { response } = await mintTerminalToken({ identityId: null, vmId, linuxUser: USER });
    const browser = new Freestyle({ identityAccessToken: response.token, baseUrl: ctx.mock.url });

    expect(await status(browser.vms.ref(vmId).linuxUser(USER).exec({ command: "true", timeoutMs: 5_000 }))).toBe("ok");
    expect(await status(browser.vms.ref(vmId).linuxUser(OTHER).exec({ command: "true", timeoutMs: 5_000 }))).toBe(403);
    expect(await status(browser.vms.ref(vmId).linuxUser("root").exec({ command: "true", timeoutMs: 5_000 }))).toBe(403);
    expect(await status(browser.vms.ref(vmId).exec({ command: "true", timeoutMs: 5_000 }))).toBe(403);
    expect(await status(browser.vms.ref(otherVm).linuxUser(USER).exec({ command: "true", timeoutMs: 5_000 }))).toBe(403);
    expect(await status(browser.vms.list())).toBe(403);
    expect(await status(browser.vms.ref(vmId).fs.readTextFile("/etc/passwd"))).toBe(403);
    expect(await status(browser.identities.create())).toBe(403);

    const session = await browser.vms.ref(vmId).linuxUser(USER).pty.open({ slug: "main", exec: "env TERM=xterm-256color bash -l" });
    expect(session.state).toBe("connected");
    session.detach();
    await expect(browser.vms.ref(vmId).linuxUser(OTHER).pty.open({ slug: "other" })).rejects.toBeDefined();
  });

  test("an expired token is rejected", async () => {
    const vmId = await vm();
    const { response } = await mintTerminalToken({ identityId: null, vmId, linuxUser: USER, now: Date.now() - TERMINAL_TOKEN_TTL_MS - 1_000 });
    const browser = new Freestyle({ identityAccessToken: response.token, baseUrl: ctx.mock.url });
    expect(await status(browser.vms.ref(vmId).linuxUser(USER).exec({ command: "true", timeoutMs: 5_000 }))).toBe(401);
  });

  test("reuses the identity and narrows a broader existing grant", async () => {
    const vmId = await vm();
    const first = await mintTerminalToken({ identityId: null, vmId, linuxUser: USER });
    const identity = ctx.client.identities.ref(first.identityId);
    await identity.permissions.vm.update(vmId, null);
    const second = await mintTerminalToken({ identityId: first.identityId, vmId, linuxUser: USER });
    expect(second.identityId).toBe(first.identityId);
    expect(ctx.mock.identities.size).toBe(1);
    expect((await identity.permissions.vm.get(vmId)).allowedLinuxUsers).toEqual([USER]);
  });

  test("revoke cuts new access and is idempotent", async () => {
    const vmId = await vm();
    const minted = await mintTerminalToken({ identityId: null, vmId, linuxUser: USER });
    await revokeTerminalAccess({ identityId: minted.identityId, vmId });
    await revokeTerminalAccess({ identityId: minted.identityId, vmId });
    const browser = new Freestyle({ identityAccessToken: minted.response.token, baseUrl: ctx.mock.url });
    expect(await status(browser.vms.ref(vmId).linuxUser(USER).exec({ command: "true", timeoutMs: 5_000 }))).toBe(403);
  });

  test("validates inputs before touching the API", async () => {
    await expect(mintTerminalToken({ identityId: null, vmId: "vm-1", linuxUser: "root" })).rejects.toThrow("Invalid Linux user");
    await expect(mintTerminalToken({ identityId: null, vmId: "../x", linuxUser: USER })).rejects.toThrow("Invalid VM id");
    await expect(mintTerminalToken({ identityId: null, vmId: "vm-1", linuxUser: USER, ttlMs: 60 * 60_000 })).rejects.toThrow("lifetime");
    expect(ctx.mock.requestLog.length).toBe(0);
  });
});
