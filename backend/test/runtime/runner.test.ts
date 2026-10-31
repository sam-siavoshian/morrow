// The environment runner against the Freestyle mock: one driver per environment under parallel calls,
// resume after a backend restart (including a crash between creating the VM and saving its id), the
// probe -> profile health -> node config loop, and the rate-limited broker restart.
import { afterEach, describe, expect, test } from "bun:test";
import type { ProfileView } from "@morrow/contracts";
import { NODE_RESTART_MIN_INTERVAL_MS } from "../../src/runtime/environments.ts";
import { logLines, makeFixture, TEAM, waitFor, type Fixture } from "./helpers.ts";

const open: Fixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

async function fixture(options: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const f = await makeFixture(options);
  open.push(f);
  return f;
}

async function createEnv(f: Fixture) {
  return f.t.deps.runtime.environments.create(TEAM, "u-owner", "Main");
}

const guestOf = async (f: Fixture, envId: string) => {
  const stored = (await f.actors.getEnvironment(TEAM, envId))!;
  return { stored, vm: f.fs.mock.vms.get(stored.freestyleVmId!)! };
};

const vmCreates = (f: Fixture) => f.fs.mock.requestLog.filter((r) => r.method === "POST" && r.path === "/v5/vms").length;

describe("environment runner", () => {
  test("parallel kicks and drives share one driver: one VM, one Linux user, one clone", async () => {
    const f = await fixture();
    const env = await createEnv(f);
    const runner = f.t.deps.runtime.environments;
    await Promise.all([
      ...Array.from({ length: 10 }, () => Promise.resolve(runner.kick(TEAM, env.id))),
      ...Array.from({ length: 5 }, () => runner.drive(TEAM, env.id)),
      runner.reconcileTeam(TEAM, { viewers: true }),
    ]);
    await f.settle(env.id);
    const { stored, vm } = await guestOf(f, env.id);
    expect(stored.phase).toBe("awaiting_login");
    expect(f.fs.mock.vms.size).toBe(1);
    expect(vmCreates(f)).toBe(1);
    expect(vm.guest.useraddCount).toBe(1);
    expect(Object.fromEntries(vm.guest.clones)).toEqual({ "acme/web": 1 });
    expect(vm.data.metadata).toEqual({ app: "morrow", team: TEAM, env: env.id });
  });

  test("a restarted backend resumes mid-provisioning without redoing finished work", async () => {
    const a = await fixture();
    open.splice(open.indexOf(a), 1);
    // "Crash" right after the VM step is saved: the driver stops after its current step.
    let crashed: Promise<void> | null = null;
    a.actors.onUpdate = (_team, _env, patch) => {
      if (patch.phase === "bootstrapping" && !crashed) crashed = a.close({ keepMock: true });
    };
    const env = await createEnv(a);
    await waitFor(() => crashed !== null, 5_000, "bootstrapping");
    await crashed;
    a.actors.onUpdate = null;
    const midway = (await a.actors.getEnvironment(TEAM, env.id))!;
    expect(midway.phase).not.toBe("awaiting_login");

    const b = await fixture({ restartOf: a });
    await b.t.deps.runtime.reconcile();
    await b.settle(env.id);
    const { stored, vm } = await guestOf(b, env.id);
    expect(stored.phase).toBe("awaiting_login");
    expect(b.fs.mock.vms.size).toBe(1);
    expect(vmCreates(b)).toBe(1);
    expect(vm.guest.useraddCount).toBe(1);
    expect(vm.guest.clones.get("acme/web")).toBe(1);
  });

  test("a crash between creating the VM and saving its id finds the VM again by slug", async () => {
    const a = await fixture();
    const env = await createEnv(a);
    await a.settle(env.id);
    const vmId = (await a.actors.getEnvironment(TEAM, env.id))!.freestyleVmId;
    open.splice(open.indexOf(a), 1);
    await a.close({ keepMock: true });
    // What the Team actor would hold if the process died right after the create call.
    a.actors.envs.get(TEAM)!.set(env.id, { ...a.actors.envs.get(TEAM)!.get(env.id)!, phase: "provisioning", freestyleVmId: null, vmState: "unknown" });

    const b = await fixture({ restartOf: a });
    await b.t.deps.runtime.reconcile();
    await b.settle(env.id);
    const stored = (await b.actors.getEnvironment(TEAM, env.id))!;
    expect(stored.freestyleVmId).toBe(vmId);
    expect(stored.phase).toBe("awaiting_login");
    expect(b.fs.mock.vms.size).toBe(1);
  });

  test("an environment parked in error after a restart retries from bootstrapping on resume", async () => {
    const a = await fixture();
    const env = await createEnv(a);
    await a.settle(env.id);
    open.splice(open.indexOf(a), 1);
    await a.close({ keepMock: true });
    a.actors.envs.get(TEAM)!.set(env.id, { ...a.actors.envs.get(TEAM)!.get(env.id)!, phase: "error", lastError: "Setup failed." });

    const b = await fixture({ restartOf: a });
    // The loops leave an errored environment alone.
    expect(await b.t.deps.runtime.environments.reconcileTeam(TEAM, { viewers: true })).toBe(0);
    const res = await b.call("u-owner", "POST", `/api/teams/${TEAM}/environments/${env.id}/resume`);
    expect(res.status).toBe(200);
    await b.settle(env.id);
    const stored = (await b.actors.getEnvironment(TEAM, env.id))!;
    expect(stored.phase).toBe("awaiting_login");
    expect(stored.lastError).toBeNull();
    expect(vmCreates(b)).toBe(1);
  });

  test("login -> ready -> node advertises the profile -> node online; logout flips the profile", async () => {
    const f = await fixture();
    const env = await createEnv(f);
    await f.settle(env.id);
    const res = await f.call("u-owner", "POST", `/api/teams/${TEAM}/environments/${env.id}/profiles`, { cli: "claude", label: "Claude", maxConcurrent: 2 });
    expect(res.status).toBe(201);
    const profile = (await res.json()) as ProfileView;
    const { stored, vm } = await guestOf(f, env.id);
    const profileOf = () => f.actors.profiles.get(TEAM)!.get(profile.id)!;

    // Not logged in yet: the background probe marks the profile auth_required.
    await waitFor(() => profileOf().auth === "auth_required", 5_000, "auth_required");
    expect(vm.guest.units.get("morrow-relay-node.service")?.active ?? false).toBe(false);

    vm.guest.cliAuth.set(stored.linuxUser!, { claude: { installed: true, auth: "ok" } });
    const check = await f.call("u-owner", "POST", `/api/teams/${TEAM}/profiles/${profile.id}/check`);
    expect(check.status).toBe(200);
    await waitFor(async () => (await f.actors.getEnvironment(TEAM, env.id))!.nodeOnline, 5_000, "node online");
    await f.settle(env.id);
    const ready = (await f.actors.getEnvironment(TEAM, env.id))!;
    expect(ready.phase).toBe("ready");
    expect(profileOf()).toMatchObject({ auth: "ok", availability: "ready" });
    const unit = vm.guest.readText("/etc/systemd/system/morrow-relay-node.service")!;
    expect(unit).toContain("AGENT_RELAY_NODE_HARNESSES=claude\n");
    // The node allows the per-profile ceiling for each ready CLI; the actor enforces the profile's own 2.
    expect(unit).toContain("AGENT_RELAY_NODE_MAX_AGENTS=8\n");
    const restarts = vm.guest.units.get("morrow-relay-node.service")!.restarts;

    // Same state again: no rewrite, no restart.
    await f.t.deps.runtime.environments.probe(TEAM, env.id);
    await f.settle(env.id);
    expect(vm.guest.units.get("morrow-relay-node.service")!.restarts).toBe(restarts);

    // Every health write carries its own event id.
    const ids = f.actors.calls.filter((c) => c.startsWith(`updateProfileHealth:${profile.id}`));
    expect(ids.length).toBeGreaterThan(1);

    vm.guest.cliAuth.set(stored.linuxUser!, { claude: { installed: true, auth: "auth_required" } });
    const relog = (await (await f.call("u-owner", "POST", `/api/teams/${TEAM}/profiles/${profile.id}/check`)).json()) as { profile: ProfileView };
    expect(relog.profile.auth).toBe("auth_required");
    await f.settle(env.id);
    expect(vm.guest.units.get("morrow-relay-node.service")!.active).toBe(false);
  });

  test("node config changes wait while a worker runs on the node", async () => {
    const f = await fixture();
    const env = await createEnv(f);
    await f.settle(env.id);
    const { stored, vm } = await guestOf(f, env.id);
    vm.guest.cliAuth.set(stored.linuxUser!, { claude: { installed: true, auth: "ok" }, codex: { installed: true, auth: "ok" } });
    const claude = (await (await f.call("u-owner", "POST", `/api/teams/${TEAM}/environments/${env.id}/profiles`, { cli: "claude", label: "C" })).json()) as ProfileView;
    await waitFor(async () => (await f.actors.getEnvironment(TEAM, env.id))!.nodeOnline, 5_000, "node online");
    await f.settle(env.id);
    const before = vm.guest.units.get("morrow-relay-node.service")!.restarts;

    f.actors.putLease(TEAM, { id: "l-busy", nodeName: stored.nodeName!, profileId: claude.id });
    await f.call("u-owner", "POST", `/api/teams/${TEAM}/environments/${env.id}/profiles`, { cli: "codex", label: "X" });
    await Bun.sleep(100);
    await f.settle(env.id);
    expect(vm.guest.units.get("morrow-relay-node.service")!.restarts).toBe(before);
    expect(vm.guest.readText("/etc/systemd/system/morrow-relay-node.service")).not.toContain("codex");

    f.actors.leases.get(TEAM)!.get("l-busy")!.state = "released";
    await f.t.deps.runtime.reconcile();
    await f.settle(env.id);
    expect(vm.guest.readText("/etc/systemd/system/morrow-relay-node.service")).toContain("AGENT_RELAY_NODE_HARNESSES=claude,codex\n");
    expect(vm.guest.units.get("morrow-relay-node.service")!.restarts).toBe(before + 1);
  });

  test("restartNode: at most once per 2 minutes per environment, every restart logged", async () => {
    let clock = Date.now();
    const f = await fixture({ now: () => clock });
    const env = await createEnv(f);
    await f.settle(env.id);
    const { stored, vm } = await guestOf(f, env.id);
    vm.guest.cliAuth.set(stored.linuxUser!, { claude: { installed: true, auth: "ok" } });
    await f.call("u-owner", "POST", `/api/teams/${TEAM}/environments/${env.id}/profiles`, { cli: "claude", label: "C" });
    await waitFor(async () => (await f.actors.getEnvironment(TEAM, env.id))!.phase === "ready", 5_000, "ready");
    await waitFor(() => vm.guest.units.get("morrow-relay-node.service")?.active === true, 5_000, "unit active");
    await f.settle(env.id);
    const base = vm.guest.units.get("morrow-relay-node.service")!.restarts;
    const runtime = f.t.deps.runtime;

    const [first, second] = await Promise.all([runtime.restartNode(TEAM, env.id, "test"), runtime.restartNode(TEAM, env.id, "test")]);
    expect([first, second].sort()).toEqual([false, true]);
    expect(vm.guest.units.get("morrow-relay-node.service")!.restarts).toBe(base + 1);
    clock += NODE_RESTART_MIN_INTERVAL_MS - 1_000;
    expect(await runtime.restartNode(TEAM, env.id, "test")).toBe(false);
    clock += 2_000;
    expect(await runtime.restartNode(TEAM, env.id, "test")).toBe(true);
    expect(vm.guest.units.get("morrow-relay-node.service")!.restarts).toBe(base + 2);
    expect(logLines.filter((l) => l.includes("relay node restarted") && l.includes(env.id)).length).toBe(2);
    // Unknown environments never restart anything.
    clock += NODE_RESTART_MIN_INTERVAL_MS * 2;
    expect(await runtime.restartNode(TEAM, "e-unknown", "test")).toBe(false);
  });

  test("a ready node that stays offline after a crash gets its broker restarted once", async () => {
    const f = await fixture({ timing: { nodeOfflineGraceMs: 50 } });
    const env = await createEnv(f);
    await f.settle(env.id);
    const { stored, vm } = await guestOf(f, env.id);
    vm.guest.cliAuth.set(stored.linuxUser!, { claude: { installed: true, auth: "ok" } });
    await f.call("u-owner", "POST", `/api/teams/${TEAM}/environments/${env.id}/profiles`, { cli: "claude", label: "C" });
    await waitFor(async () => (await f.actors.getEnvironment(TEAM, env.id))!.nodeOnline, 5_000, "node online");
    await f.settle(env.id);
    const base = vm.guest.units.get("morrow-relay-node.service")!.restarts;

    const offline = { nodeId: "nd_1", nodeName: stored.nodeName, status: "offline" as const, reason: "worker crashed", at: Date.now(), seq: 1 };
    await f.t.deps.bus.emit({ kind: "node.status", teamId: TEAM, event: offline });
    await f.t.deps.bus.emit({ kind: "node.status", teamId: TEAM, event: { ...offline, seq: 2 } });
    expect((await f.actors.getEnvironment(TEAM, env.id))!.nodeOnline).toBe(false);
    await waitFor(() => vm.guest.units.get("morrow-relay-node.service")!.restarts === base + 1, 3_000, "broker restart");
    await Bun.sleep(150);
    expect(vm.guest.units.get("morrow-relay-node.service")!.restarts).toBe(base + 1);

    // Back online before the grace runs out: no restart.
    await f.t.deps.bus.emit({ kind: "node.status", teamId: TEAM, event: { ...offline, status: "online", seq: 3 } });
    await f.t.deps.bus.emit({ kind: "node.status", teamId: TEAM, event: { ...offline, seq: 4 } });
    await f.t.deps.bus.emit({ kind: "node.status", teamId: TEAM, event: { ...offline, status: "online", seq: 5 } });
    await Bun.sleep(150);
    expect(vm.guest.units.get("morrow-relay-node.service")!.restarts).toBe(base + 1);
    expect((await f.actors.getEnvironment(TEAM, env.id))!.nodeOnline).toBe(true);
  });

  test("VM status: a VM paused outside Morrow is reflected, a deleted one parks the environment", async () => {
    const f = await fixture();
    const env = await createEnv(f);
    await f.settle(env.id);
    const { vm } = await guestOf(f, env.id);
    vm.data.state = "suspended";
    await f.t.deps.runtime.environments.applyVmStates(TEAM, null);
    expect((await f.actors.getEnvironment(TEAM, env.id))!.vmState).not.toBe("running");

    f.fs.mock.vms.delete(vm.data.id);
    await f.t.deps.runtime.pollStatus(true);
    await f.settle(env.id);
    const stored = (await f.actors.getEnvironment(TEAM, env.id))!;
    expect(stored.phase).toBe("error");
    expect(stored.lastError).toBeTruthy();
  });
});
