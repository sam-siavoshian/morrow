import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  advanceEnvironment,
  driveEnvironment,
  MAX_STEP_FAILURES,
  newEnvironmentRecord,
  relayUserFor,
  workerLogPath,
  type EnvironmentRecord,
} from "../../src/integrations/freestyle/index.ts";
import { PROFILE_MAX_CONCURRENT } from "@morrow/contracts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desiredNodeConfig, NODE_LAYOUT_DIGEST, nodeConfigHash } from "../../src/integrations/freestyle/node.ts";
import { RUN_SCRIPT_COMMAND } from "../../src/integrations/freestyle/exec.ts";
import type { FreestyleMock } from "../fixtures/freestyle-mock/server.ts";
import { baseInput, GITHUB_TOKEN, RELAY_KEY, useMock } from "./helpers.ts";

let ctx: ReturnType<typeof useMock>;
let mock: FreestyleMock;
beforeEach(() => {
  ctx = useMock();
  mock = ctx.mock;
});
afterEach(() => ctx.restore());

const fresh = () => newEnvironmentRecord({ id: "env-1", teamId: "t-abc", ownerUserId: "u-1001" });

async function driveToSettled(record: EnvironmentRecord, input = baseInput()): Promise<EnvironmentRecord> {
  const result = await driveEnvironment(record, input, { persist: async () => {}, backoffMs: () => 1 });
  return result.record;
}

/** Everything observable on the VM after provisioning, for comparing runs. */
function vmFingerprint(record: EnvironmentRecord) {
  const vm = mock.vms.get(record.freestyleVmId!)!;
  const g = vm.guest;
  return {
    vmCount: mock.vms.size,
    users: [...g.users].sort(),
    useraddCount: g.useraddCount,
    nodeEnv: g.readText("/etc/agent-relay/node.env"),
    unit: g.readText("/etc/systemd/system/morrow-relay-node.service"),
    clones: Object.fromEntries(g.clones),
    credentialFiles: g.credentialFiles(),
    metadata: vm.data.metadata,
    idleTimeoutSeconds: vm.data.idleTimeoutSeconds,
  };
}

describe("desiredNodeConfig", () => {
  test("advertises the ready CLIs with room for each one's ceiling, at most 16, and nothing when none is ready", () => {
    expect(desiredNodeConfig([])).toEqual({ harnesses: [], maxAgents: 0 });
    expect(desiredNodeConfig([{ cli: "codex", ready: false }])).toEqual({ harnesses: [], maxAgents: 0 });
    expect(desiredNodeConfig([{ cli: "claude", ready: true }])).toEqual({ harnesses: ["claude"], maxAgents: PROFILE_MAX_CONCURRENT });
    const three = desiredNodeConfig([{ cli: "opencode", ready: true }, { cli: "claude", ready: true }, { cli: "codex", ready: true }]);
    expect(three.harnesses).toEqual(["claude", "codex", "opencode"]);
    expect(three.maxAgents).toBe(Math.min(16, 3 * PROFILE_MAX_CONCURRENT));
    expect(() => desiredNodeConfig([{ cli: "gpt" as never, ready: true }])).toThrow();
  });
});

describe("advanceEnvironment", () => {
  test("provisions to awaiting_login, then ready after login, then advertises ready profiles", async () => {
    let record = await driveToSettled(fresh());
    expect(record.phase).toBe("awaiting_login");
    expect(record.vmState).toBe("running");
    expect(record.progress).toEqual({ user: true, node: true, repos: ["acme/web", "acme/api"], warm: false });
    const fp = vmFingerprint(record);
    expect(fp.vmCount).toBe(1);
    expect(fp.users).toContain(record.linuxUser);
    expect(fp.metadata).toEqual({ app: "morrow", team: "t-abc", env: "env-1" });
    expect(fp.idleTimeoutSeconds).toBe(-1);
    expect(fp.nodeEnv).toBe(`RELAY_WORKSPACE_KEY=${RELAY_KEY}\n`);
    // No ready profile yet: unit written but the node stays stopped.
    const guest = mock.vms.get(record.freestyleVmId!)!.guest;
    expect(guest.units.get("morrow-relay-node.service")).toEqual({ enabled: false, active: false, restarts: 0 });

    // Nobody logged in: probe runs, stays put.
    const idle = await advanceEnvironment(record, baseInput());
    expect(idle.step).toBe("probe");
    expect(idle.more).toBe(false);
    expect(idle.probe?.clis.claude.auth).toBe("auth_required");

    guest.cliAuth.set(record.linuxUser, { claude: { installed: true, auth: "ok" } });
    const login = await advanceEnvironment(record, baseInput());
    expect(login.record.phase).toBe("ready");
    expect(login.more).toBe(true);
    expect(login.probe?.clis.claude.auth).toBe("ok");
    record = login.record;

    const profiles = [{ cli: "claude" as const, ready: true }, { cli: "codex" as const, ready: false }];
    const sync = await advanceEnvironment(record, baseInput({ profiles }));
    expect(sync.step).toBe("sync node");
    record = sync.record;
    const unit = guest.readText("/etc/systemd/system/morrow-relay-node.service")!;
    expect(unit).toContain("AGENT_RELAY_NODE_HARNESSES=claude\n");
    // Room for the ceiling of each ready login, not its current "workers at once": changing that never restarts the broker.
    expect(unit).toContain(`AGENT_RELAY_NODE_MAX_AGENTS=${PROFILE_MAX_CONCURRENT}\n`);
    expect(unit).toContain(`--broker-name ${record.nodeName} --no-spawn`);
    // The broker runs as its own account, never the engineer who runs the CLIs.
    expect(unit).toContain(`User=${relayUserFor(record.linuxUser)}\n`);
    expect(unit).not.toContain(`User=${record.linuxUser}\n`);
    expect(guest.users.has(relayUserFor(record.linuxUser))).toBe(true);
    expect(guest.units.get("morrow-relay-node.service")).toEqual({ enabled: true, active: true, restarts: 1 });
    expect(sync.warning).toBeUndefined();

    // Same inputs: nothing is rewritten, the node is not restarted.
    const execsBefore = mock.execLog.length;
    const again = await advanceEnvironment(record, baseInput({ profiles }));
    expect(again.step).toBeNull();
    expect(again.record).toBe(record);
    expect(mock.execLog.length).toBe(execsBefore);
    expect(guest.units.get("morrow-relay-node.service")!.restarts).toBe(1);
  });

  test("the node gets the CLI bridge script as it is in vm/, and its digest is part of the config hash", async () => {
    const record = await driveToSettled(fresh());
    const configure = mock.execLog.filter((e) => e.script === "configure-node" && e.body.env?.ACTION === "apply");
    expect(configure.length).toBeGreaterThan(0);
    const bridge = readFileSync(join(import.meta.dir, "../../vm/relay-worker.sh"), "utf8");
    for (const exec of configure) expect(Buffer.from(exec.body.env!.RELAY_WORKER_SCRIPT!, "base64").toString("utf8")).toBe(bridge);
    const configureScript = readFileSync(join(import.meta.dir, "../../vm/configure-node.sh"), "utf8");
    expect(NODE_LAYOUT_DIGEST).toBe(new Bun.CryptoHasher("sha256").update(configureScript).update(bridge).digest("hex"));
    // A node synced under an older layout has a different stored hash, so its next sync re-applies.
    const guest = mock.vms.get(record.freestyleVmId!)!.guest;
    guest.cliAuth.set(record.linuxUser, { claude: { installed: true, auth: "ok" } });
    const ready = (await advanceEnvironment(record, baseInput())).record;
    const profiles = [{ cli: "claude" as const, ready: true }];
    const synced = (await advanceEnvironment(ready, baseInput({ profiles }))).record;
    expect(synced.nodeConfigHash).toBe(
      nodeConfigHash({ linuxUser: synced.linuxUser, nodeName: synced.nodeName, config: { harnesses: ["claude"], maxAgents: PROFILE_MAX_CONCURRENT }, relay: baseInput().relay }),
    );
    const resync = await advanceEnvironment({ ...synced, nodeConfigHash: "hash-from-an-older-layout" }, baseInput({ profiles }));
    expect(resync.step).toBe("sync node");
  });

  test("a VM whose /proc cannot hide other users' processes still syncs, with a warning", async () => {
    let record = await driveToSettled(fresh());
    const guest = mock.vms.get(record.freestyleVmId!)!.guest;
    guest.procHidden = false;
    guest.cliAuth.set(record.linuxUser, { claude: { installed: true, auth: "ok" } });
    record = (await advanceEnvironment(record, baseInput())).record;
    const sync = await advanceEnvironment(record, baseInput({ profiles: [{ cli: "claude" as const, ready: true }] }));
    expect(sync.step).toBe("sync node");
    expect(sync.warning).toBe("proc_not_hidden");
    expect(guest.units.get("morrow-relay-node.service")!.active).toBe(true);
  });

  test("worker logs live in the broker's home, not the engineer's", () => {
    expect(relayUserFor("u0123456789ab")).toBe("r0123456789ab");
    expect(workerLogPath("u0123456789ab", "w-1")).toBe("/var/lib/morrow/relay/r0123456789ab/relay-node/.agentworkforce/relay/team/worker-logs/w-1.log");
    for (const bad of ["root", "r0123456789ab", "u0123456789aB", "u/../x"]) expect(() => relayUserFor(bad)).toThrow();
  });

  test("no secret ever appears in a command string; every exec has an explicit timeout", async () => {
    const record = await driveToSettled(fresh());
    await advanceEnvironment(record, baseInput());
    expect(mock.execLog.length).toBeGreaterThanOrEqual(6);
    for (const exec of mock.execLog) {
      expect(exec.body.command).toBe(RUN_SCRIPT_COMMAND);
      expect(typeof exec.body.timeoutMs).toBe("number");
      expect(exec.body.command).not.toContain(RELAY_KEY);
      expect(exec.body.command).not.toContain(GITHUB_TOKEN);
      const stdin = Buffer.from(exec.body.stdin ?? "", "base64").toString("utf8");
      expect(stdin).not.toContain(RELAY_KEY);
      expect(stdin).not.toContain(GITHUB_TOKEN);
      expect(exec.script).not.toBeNull();
    }
    for (const req of mock.requestLog) {
      expect(req.path).not.toContain(RELAY_KEY);
      expect(req.path).not.toContain(GITHUB_TOKEN);
    }
    // The Relay key travels only as env of the root script that writes node.env; the GitHub token never
    // as exec env at all (it goes over the file API into a root-only file).
    const keyCarriers = mock.execLog.filter((e) => Object.values(e.body.env ?? {}).includes(RELAY_KEY)).map((e) => e.script);
    const tokenCarriers = mock.execLog.filter((e) => Object.values(e.body.env ?? {}).includes(GITHUB_TOKEN)).map((e) => e.script);
    expect(new Set(keyCarriers)).toEqual(new Set(["configure-node"]));
    expect(tokenCarriers).toEqual([]);
    expect(JSON.stringify(record)).not.toContain(RELAY_KEY);
    expect(JSON.stringify(record)).not.toContain(GITHUB_TOKEN);
  });

  test("resumes after a lost response at every step and converges to the same VM state", async () => {
    const clean = await driveToSettled(fresh());
    const expected = vmFingerprint(clean);
    const steps = mock.requestLog.filter((r) => r.method === "POST" && (r.path === "/v5/vms" || r.path.endsWith("/exec-await"))).length;
    expect(steps).toBe(6); // create, user, node, clone x2, probe
    await ctx.restore();

    for (let k = 0; k < steps; k++) {
      ctx = useMock();
      mock = ctx.mock;
      // Fail the k-th side effect AFTER it happened (the response is lost).
      let current = fresh();
      const input = baseInput();
      let injected = false;
      for (let i = 0; i < 40; i++) {
        const writes = mock.requestLog.filter((r) => r.method === "POST" && (r.path === "/v5/vms" || r.path.endsWith("/exec-await"))).length;
        if (!injected && writes === k) {
          mock.faults.push({ method: "POST", path: /^\/v5\/vms(\/[^/]+\/exec-await)?$/, mode: "after" });
          injected = true;
        }
        const result = await advanceEnvironment(current, input);
        current = result.record;
        if (!result.more && result.step !== "failed") break;
      }
      expect(injected).toBe(true);
      expect(current.phase).toBe("awaiting_login");
      const fp = vmFingerprint(current);
      expect({ ...fp, metadata: fp.metadata }).toEqual(expected);
      await ctx.restore();
    }
    ctx = useMock();
    mock = ctx.mock;
  });

  test("a crash before persisting any step's result is harmless", async () => {
    const clean = await driveToSettled(fresh());
    const expected = vmFingerprint(clean);
    await ctx.restore();
    for (let k = 0; k < 6; k++) {
      ctx = useMock();
      mock = ctx.mock;
      let persisted = fresh();
      for (let i = 0; i < 40; i++) {
        const result = await advanceEnvironment(persisted, baseInput());
        // Crash on step k: the process dies before writing the new record.
        if (i !== k) persisted = result.record;
        if (i !== k && !result.more) break;
      }
      expect(persisted.phase).toBe("awaiting_login");
      expect(vmFingerprint(persisted)).toEqual(expected);
      await ctx.restore();
    }
    ctx = useMock();
    mock = ctx.mock;
  });

  test("concurrent provisioning of one environment creates exactly one VM (409 race)", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => advanceEnvironment(fresh(), baseInput())));
    const ids = new Set(results.map((r) => r.record.freestyleVmId));
    expect(ids.size).toBe(1);
    expect(mock.vms.size).toBe(1);
    expect(results.every((r) => r.record.phase === "bootstrapping")).toBe(true);
    expect(mock.requestLog.some((r) => r.path === "/v5/vms" && r.status === 409)).toBe(true);
  });

  test("refuses to adopt a VM holding our slug with someone else's metadata", async () => {
    const record = fresh();
    await ctx.client.vms.create({ slug: record.vmSlug, firewall: { rules: [] }, metadata: { app: "other" } });
    const result = await advanceEnvironment(record, baseInput());
    expect(result.record.phase).toBe("error");
    expect(result.record.resumePhase).toBe("provisioning");
    expect(result.record.lastError).toContain("belongs to something else");
  });

  test("exec timeout (statusCode null) mid-clone is retried and leaves no credential file", async () => {
    let record = fresh();
    for (let i = 0; i < 2; i++) record = (await advanceEnvironment(record, baseInput())).record; // vm, user
    const guest = mock.vms.get(record.freestyleVmId!)!.guest;
    guest.faults.killedLeavingCredential = true;
    const failed = await advanceEnvironment(record, baseInput());
    expect(failed.step).toBe("failed");
    expect(failed.record.phase).toBe("bootstrapping");
    expect(failed.record.failures).toBe(1);
    expect(failed.record.lastError).toBe("Clone acme/web timed out on the VM.");
    // The script never ran its trap; the backend removed the file over the file API.
    expect(guest.credentialFiles()).toEqual([]);
    const done = await driveToSettled(failed.record);
    expect(done.phase).toBe("awaiting_login");
    expect(guest.credentialFiles()).toEqual([]);
  });

  test("the GitHub token reaches the VM only as a root-only file, never in exec env or command", async () => {
    const record = await driveToSettled(fresh());
    const guest = mock.vms.get(record.freestyleVmId!)!.guest;
    expect(guest.tokensUsed).toEqual([GITHUB_TOKEN, GITHUB_TOKEN]);
    for (const e of mock.execLog) {
      expect(JSON.stringify(e.body)).not.toContain(GITHUB_TOKEN);
      if (e.script === "git") expect(e.body.linuxUser).toBe("root");
    }
    expect(guest.credentialFiles()).toEqual([]);
  });

  test("a private repo the owner cannot read parks the environment with a clear error", async () => {
    let record = fresh();
    for (let i = 0; i < 2; i++) record = (await advanceEnvironment(record, baseInput())).record; // vm, user
    mock.vms.get(record.freestyleVmId!)!.guest.faults.githubDenied = true;
    const failed = await advanceEnvironment(record, baseInput());
    expect(failed.record.phase).toBe("error");
    expect(failed.record.lastError).toContain("GitHub denied access to acme/web");
  });

  test("parks in error after repeated failures, and only leaves it on explicit retry", async () => {
    let record = fresh();
    for (let i = 0; i < MAX_STEP_FAILURES; i++) {
      mock.faults.push({ method: "GET", path: /^\/v5\/vms\//, mode: "before", status: 503 });
      record = (await advanceEnvironment(record, baseInput())).record;
    }
    expect(record.phase).toBe("error");
    expect(record.resumePhase).toBe("provisioning");
    expect(record.lastError).toContain("unavailable");
    expect((await advanceEnvironment(record, baseInput())).record).toBe(record);
    const retried = await advanceEnvironment(record, baseInput({ retry: true }));
    expect(retried.record.phase).toBe("provisioning");
    expect((await driveToSettled(retried.record)).phase).toBe("awaiting_login");
  });

  test("re-provisions when the VM disappears during bootstrap", async () => {
    let record = fresh();
    record = (await advanceEnvironment(record, baseInput())).record;
    const firstVm = record.freestyleVmId!;
    await ctx.client.vms.delete(firstVm);
    const missing = await advanceEnvironment(record, baseInput());
    expect(missing.record.phase).toBe("provisioning");
    const done = await driveToSettled(missing.record);
    expect(done.phase).toBe("awaiting_login");
    expect(done.freestyleVmId).not.toBe(firstVm);
  });

  test("a slow create answered with 202 is polled to completion", async () => {
    mock.background.push({ method: "POST", path: /^\/v5\/vms$/, delayMs: 300 });
    const result = await advanceEnvironment(fresh(), baseInput());
    expect(result.record.phase).toBe("bootstrapping");
    expect(mock.requestLog.some((r) => r.path === "/v5/vms" && r.status === 202)).toBe(true);
    expect(mock.requestLog.some((r) => r.path.startsWith("/v5/background-requests/") && r.status === 200)).toBe(true);
  }, 15_000);

  test("rejects a tampered record instead of acting on it", async () => {
    const record = { ...fresh(), linuxUser: "root" };
    await expect(advanceEnvironment(record, baseInput())).rejects.toThrow("Invalid Linux user name");
    const other = { ...fresh(), linuxUser: "u000000000000" };
    await expect(advanceEnvironment(other, baseInput())).rejects.toThrow("do not match");
    expect(mock.execLog.length).toBe(0);
  });

  test("waits out transitional VM states before exec", async () => {
    mock.options.startTransitionReads = 2;
    let record = (await advanceEnvironment(fresh(), baseInput())).record;
    await ctx.client.vms.ref(record.freestyleVmId!).pause();
    record = (await advanceEnvironment(record, baseInput())).record;
    expect(record.progress.user).toBe(true);
    expect(record.vmState).toBe("running");
  });
});
