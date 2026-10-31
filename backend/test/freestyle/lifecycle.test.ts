import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  disconnectEnvironment,
  driveEnvironment,
  getVmStatus,
  listVmStatuses,
  mintTerminalToken,
  newEnvironmentRecord,
  pauseEnvironment,
  resumeEnvironment,
  type EnvironmentRecord,
} from "../../src/integrations/freestyle/index.ts";
import { baseInput, useMock } from "./helpers.ts";

let ctx: ReturnType<typeof useMock>;
beforeEach(() => {
  ctx = useMock();
});
afterEach(() => ctx.restore());

async function readyEnv(): Promise<EnvironmentRecord> {
  const record = newEnvironmentRecord({ id: "env-1", teamId: "t-abc", ownerUserId: "u-1001" });
  const { record: settled } = await driveEnvironment(record, baseInput({ repos: [] }), { persist: async () => {} });
  const guest = ctx.mock.vms.get(settled.freestyleVmId!)!.guest;
  guest.cliAuth.set(settled.linuxUser, { claude: { installed: true, auth: "ok" } });
  const input = baseInput({ repos: [], profiles: [{ cli: "claude", ready: true }] });
  const { record: ready } = await driveEnvironment(settled, input, { persist: async () => {} });
  expect(ready.phase).toBe("ready");
  return ready;
}

describe("lifecycle", () => {
  test("pause is refused while a live lease uses the VM", async () => {
    const record = await readyEnv();
    await expect(pauseEnvironment(record, { hasLiveLease: true })).rejects.toMatchObject({ kind: "conflict", apiCode: "conflict" });
    expect(ctx.mock.vms.get(record.freestyleVmId!)!.data.state).toBe("running");
    expect(ctx.mock.requestLog.some((r) => r.path.endsWith("/pause"))).toBe(false);
  });

  test("pause then resume returns to the previous phase", async () => {
    const record = await readyEnv();
    const paused = await pauseEnvironment(record, { hasLiveLease: false });
    expect(paused).toMatchObject({ phase: "paused", resumePhase: "ready", vmState: "paused" });
    expect(await getVmStatus(record.freestyleVmId!)).toEqual({ exists: true, state: "paused" });
    expect(await pauseEnvironment(paused, { hasLiveLease: false })).toBe(paused);

    const resumed = await resumeEnvironment(paused, { vmWait: { intervalMs: 5 } });
    expect(resumed).toMatchObject({ phase: "ready", resumePhase: null, vmState: "running" });
    expect(ctx.mock.requestLog.some((r) => r.path.endsWith("/start"))).toBe(true);
  });

  test("pause is refused before the environment is set up", async () => {
    const record = newEnvironmentRecord({ id: "env-2", teamId: "t-abc", ownerUserId: "u-1001" });
    await expect(pauseEnvironment(record, { hasLiveLease: false })).rejects.toMatchObject({ kind: "conflict" });
  });

  test("status polling reports transitional and missing VMs", async () => {
    // The pause response itself is one read, so the next GET still sees "pausing".
    ctx.mock.options.pauseTransitionReads = 2;
    const record = await readyEnv();
    await ctx.client.vms.ref(record.freestyleVmId!).pause();
    expect((await getVmStatus(record.freestyleVmId!)).state).toBe("pausing");
    expect((await getVmStatus(record.freestyleVmId!)).state).toBe("paused");
    const all = await listVmStatuses();
    expect(all.get(record.freestyleVmId!)).toBe("paused");
    expect(await getVmStatus("vm-doesnotexist")).toEqual({ exists: false, state: "unknown" });
  });

  test("disconnect keeping the VM stops the node, deletes the key file, closes the terminal and revokes grants", async () => {
    const record = await readyEnv();
    const vmId = record.freestyleVmId!;
    const minted = await mintTerminalToken({ identityId: null, vmId, linuxUser: record.linuxUser });
    ctx.mock.createPtySession(vmId, { slug: "main", linuxUser: record.linuxUser });
    const paused = await pauseEnvironment(record, { hasLiveLease: false });

    const done = await disconnectEnvironment(paused, { deleteVm: false, identityIds: [minted.identityId] });
    expect(done.phase).toBe("disconnected");
    const vm = ctx.mock.vms.get(vmId)!;
    expect(vm.data.state).toBe("running");
    expect(vm.guest.files.has("/etc/agent-relay/node.env")).toBe(false);
    expect(vm.guest.units.get("morrow-relay-node.service")).toMatchObject({ enabled: false, active: false });
    expect([...vm.pty.values()].some((s) => s.slug === "main")).toBe(false);
    expect(ctx.mock.identities.get(minted.identityId)!.grants.size).toBe(0);

    // Idempotent.
    expect((await disconnectEnvironment(done, { deleteVm: false, identityIds: [minted.identityId] })).phase).toBe("disconnected");
  });

  test("disconnect with delete removes the VM, and tolerates it already being gone", async () => {
    const record = await readyEnv();
    const done = await disconnectEnvironment(record, { deleteVm: true, identityIds: [] });
    expect(done.phase).toBe("disconnected");
    expect(ctx.mock.vms.size).toBe(0);
    expect((await disconnectEnvironment(record, { deleteVm: true, identityIds: [] })).phase).toBe("disconnected");
  });
});
