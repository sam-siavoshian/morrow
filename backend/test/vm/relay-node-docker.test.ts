// Proves the Relay node layout end to end on a stand-in VM: ubuntu:24.04 with systemd as PID 1, Agent Relay
// installed by golden-setup.sh's relay step, the node configured by the real configure-node.sh, and a real
// relaycast-engine (on the test host) behind it. Fake claude/codex/opencode CLIs (fixtures/vm-docker/fake-cli.py)
// play curious workers: they record every process and file they can read, then message through the Agent Relay
// MCP server with only their own agent token.
//
// What it shows: no workspace key reaches a worker by any route (environment, arguments, /proc, files); the
// broker runs as its own user and starts each CLI as the engineer directly (no sudo process left in between);
// workers still post to channels, send and receive DMs; a node that ran under the old layout keeps its id.
//
// Needs Docker (privileged, for systemd) and network for the first image build and engine download:
// `VM_DOCKER=1 bun test test/vm/relay-node-docker.test.ts`. Skipped otherwise.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { ServerFrame } from "@morrow/contracts";
import {
  TeamRelayObserver,
  createRelayReader,
  ensureProjectChannel,
  getNodeHealth,
  provisionTeamWorkspace,
  releaseWorker,
  sendDirectMessage,
  spawnWorker,
  type RelayConfig,
  type RelayReader,
  type TeamRelaySecrets,
} from "../../src/integrations/relay/index.ts";
import { startEngine, stopAll, waitFor, type Engine } from "../relay/harness.ts";

const RUN = process.env.VM_DOCKER === "1";
if (!RUN) console.warn("SKIP relay node docker suite: set VM_DOCKER=1 (needs Docker with privileged containers)");

const BACKEND = resolve(import.meta.dir, "../..");
const IMAGE = "morrow-relay-node-test";
const U = "u0123456789ab";
const R = "r0123456789ab";
const WORKTREE = `/home/${U}/work/.worktrees/acme__web/main`;
const NODE = `n-${randomBytes(6).toString("hex")}`;
const CONTAINER = `morrow-relay-node-${randomBytes(4).toString("hex")}`;
const CLIS = ["claude", "codex", "opencode"] as const;

let engine: Engine;
let config: RelayConfig;
let team: TeamRelaySecrets;
let reader: RelayReader;
let channel: string;
let observer: TeamRelayObserver;
let containerEnv: Record<string, string>;
const frames: ServerFrame[] = [];

async function sh(cmd: string[], opts: { env?: Record<string, string>; allowFail?: boolean } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts.env } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${cmd.slice(0, 4).join(" ")} failed (${code}): ${stderr.slice(-3000)}`);
  return stdout;
}

/** One scenario step in the container, as root; returns its last stdout line parsed as JSON. */
async function step<T = Record<string, unknown>>(args: string[], env: Record<string, string> = {}): Promise<T> {
  const envArgs = Object.entries({ ...containerEnv, ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const out = await sh(["docker", "exec", ...envArgs, CONTAINER, "bash", "/t/relay-node-scenario.sh", ...args]);
  const last = out.trim().split("\n").at(-1) ?? "null";
  return JSON.parse(last) as T;
}

const nodeOnline = () => waitFor(`node ${NODE} healthy`, async () => (await getNodeHealth(reader, NODE)).healthy, 90_000, 500);
const messages = () => frames.flatMap((f) => (f.kind === "relay.event" && f.data.type === "message" ? [f.data] : []));
const workerName = (cli: string) => `w-e2e${cli.slice(0, 2)}-be-e1`;

/**
 * Throws unless every spawn started or came back unconfirmed. Under parallel spawns the agent-relay 14.0.0 broker
 * sometimes launches a worker yet answers name-in-use or never reports a result; spawn.ts maps both to unconfirmed and
 * the monitor settles them from live presence, never by retrying. The caller's live checks prove each worker runs.
 */
function expectLaunched(outcomes: Awaited<ReturnType<typeof spawnWorker>>[], label: string): void {
  for (const [i, outcome] of outcomes.entries()) {
    if (outcome.outcome !== "started" && outcome.outcome !== "unconfirmed") throw new Error(`${label}${CLIS[i]} spawn not started: ${JSON.stringify(outcome)}`);
  }
}

beforeAll(async () => {
  if (!RUN) return;
  // The image caches golden-setup's relay step; rebuilds only when the script changes.
  await sh(["docker", "build", "-q", "-t", IMAGE, "-f", `${BACKEND}/test/fixtures/vm-docker/relay-node.Dockerfile`, `${BACKEND}/vm`]);
  engine = await startEngine();
  config = { baseUrl: engine.baseUrl };
  team = await provisionTeamWorkspace({ config, teamId: `t-e2e${randomBytes(3).toString("hex")}`, store: { save: async () => {} } });
  reader = createRelayReader(config, team.observer.token);
  ({ channel } = await ensureProjectChannel({ config, dispatcherToken: team.dispatcherToken, projectShort: "e2e" }));
  observer = new TeamRelayObserver({
    teamId: "t-e2e",
    config,
    observerToken: team.observer.token,
    cursorStore: { load: async () => null, save: async () => {} },
    publish: (_team, frame) => void frames.push(ServerFrame.parse(frame)),
    callbacks: {},
  });
  await observer.start();

  const port = new URL(engine.baseUrl).port;
  containerEnv = {
    E2E_BASE_URL: `http://host.docker.internal:${port}`,
    E2E_KEY: team.workspaceKey,
    E2E_NODE: NODE,
  };
  await sh([
    "docker", "run", "-d", "--name", CONTAINER, "--privileged", "--cgroupns=private",
    "--tmpfs", "/run", "--tmpfs", "/run/lock", "--add-host", "host.docker.internal:host-gateway",
    "-v", `${BACKEND}/vm:/vm:ro`, "-v", `${BACKEND}/test/fixtures/vm-docker:/t:ro`, IMAGE,
  ]);
  await waitFor(
    "systemd up",
    async () => /^(running|degraded)/.test(await sh(["docker", "exec", CONTAINER, "systemctl", "is-system-running"], { allowFail: true })),
    60_000,
    500,
  );
  await step(["setup"]);
}, 900_000);

afterAll(async () => {
  if (!RUN) return;
  await observer?.stop();
  if (process.env.KEEP_CONTAINER !== "1") await sh(["docker", "rm", "-f", CONTAINER], { allowFail: true });
  await stopAll();
}, 60_000);

describe.skipIf(!RUN)("Relay node layout on a systemd VM", () => {
  let oldNodeId: string | undefined;

  test("a node that ran as the engineer moves to the broker's own user and keeps its id", async () => {
    await step(["old-layout"]);
    await nodeOnline();
    oldNodeId = (await reader.getNode(NODE))?.id;
    expect(oldNodeId).toBeTruthy();
    const old = await step<{ tokens: string[] }>(["old-identity"]);
    expect(old.tokens).toEqual([`${oldNodeId}.json`]);

    const applied = await step(["apply"], { E2E_HARNESSES: CLIS.join(","), E2E_MAX: "8" });
    expect(applied).toMatchObject({ changed: true, active: true, procHidden: true });
    await nodeOnline();
    expect((await reader.getNode(NODE))?.id).toBe(oldNodeId);
    expect((await getNodeHealth(reader, NODE)).harnesses).toEqual(expect.arrayContaining([...CLIS]));

    const layout = await step<Record<string, any>>(["layout"]);
    expect(layout.unit).toContain(`User=${R}\n`);
    expect(layout.unit).toContain(`SupplementaryGroups=${U}\n`);
    expect(layout.unit).toContain("ProtectProc=invisible\n");
    expect(layout.unit).not.toContain(team.workspaceKey);
    expect(layout.engineer_relay_files).toEqual([]);
    expect(layout.node_id_pin).toBe(oldNodeId);
    // The old broker's registration proof moved with it, root-only.
    expect(layout.identity_key_pin).toMatch(/^node-[0-9a-f]{64}$/);
    expect(layout.env_has_identity_key).toBe(true);
    expect(layout.engineer_reads_identity_key.rc).not.toBe(0);
    expect(layout.broker_state_files).toEqual(expect.arrayContaining(["connection.json"]));
    expect(layout.relay_tokens).toEqual([`${oldNodeId}.json`]);
    expect(layout.relay_home_owner).toBe(R);
    expect(layout.relay_home_mode).toBe("0o700");
    // The broker's account belongs to no group but its own; the unit alone adds the engineer's.
    expect(layout.relay_groups).toEqual([]);
  }, 300_000);

  test("re-applying the same config changes nothing and does not restart the broker", async () => {
    const before = await step<{ pid: number }>(["main-pid"]);
    const again = await step(["apply"], { E2E_HARNESSES: CLIS.join(","), E2E_MAX: "8" });
    expect(again).toMatchObject({ changed: false, active: true, procHidden: true });
    expect((await step<{ pid: number }>(["main-pid"])).pid).toBe(before.pid);
  }, 120_000);

  test("sudo, /proc and file permissions keep the engineer away from the broker", async () => {
    const layout = await step<Record<string, any>>(["layout"]);
    expect(layout.visudo.rc).toBe(0);
    expect(layout.proc_mount).toMatch(/hidepid=(2|invisible)/);
    expect(layout.sudoers).toContain(`${R} ALL=(${U}) NOPASSWD: /opt/morrow/bin/relay-worker exec *`);
    expect(layout.sudo_list.out).toContain("/opt/morrow/bin/relay-worker exec *");
    // The rule allows that one command as that one user: no shell, no root.
    expect(layout.sudo_shell_as_engineer.rc).not.toBe(0);
    expect(layout.sudo_as_root.rc).not.toBe(0);
    expect(layout.sudo_from_engineer.rc).not.toBe(0);
    expect(layout.engineer_reads_env.rc).not.toBe(0);
    expect(layout.engineer_lists_relay_home.rc).not.toBe(0);
    // The engineer's view of the process table holds only their own processes.
    expect(new Set(layout.engineer_ps.out.split("\n").map((l: string) => l.trim()).filter(Boolean))).toEqual(new Set([U]));
    // The bridge fails closed.
    for (const label of ["exec_refuses_key_env", "exec_refuses_key_arg", "exec_refuses_wrong_user", "launch_refuses_engineer"]) {
      expect(layout[label].rc).toBe(78);
    }
  }, 120_000);

  test("workers start as the engineer, see no workspace key anywhere, and still message", async () => {
    const outcomes = await Promise.all(
      CLIS.map((cli) =>
        spawnWorker({
          config,
          dispatcherToken: team.dispatcherToken,
          reader,
          request: {
            name: workerName(cli),
            node: NODE,
            cli,
            task: `Say hello. E2E-CHANNEL:${channel}`,
            channels: [channel],
            workerCwd: WORKTREE,
          },
        }),
      ),
    );
    expectLaunched(outcomes, "");

    // Sanity: the key is really on the box, readable by root from the broker's environment, so a leak
    // would be visible to the same string search.
    const procs = await step<Array<{ user: string; pid: number; ppid: number; args: string }>>(["procs"]);
    const broker = procs.find((p) => p.user === R && /agent-relay-broker/.test(p.args) && !/ pty /.test(p.args));
    expect(broker).toBeTruthy();
    expect((await step<{ environ: string }>(["environ", String(broker!.pid)])).environ).toContain(team.workspaceKey);

    for (const cli of CLIS) {
      const name = workerName(cli);
      const report = await waitFor(`${name} report`, async () => step<Record<string, any> | null>(["report", name]), 60_000, 500);
      const raw = JSON.stringify(report);
      expect(raw).not.toContain(team.workspaceKey);
      // Any workspace key, not just this team's. relay-worker itself names the bare prefix to refuse it.
      expect(raw).not.toMatch(/rk_live_[A-Za-z0-9]{8,}/);
      expect(report.cli).toBe(cli);
      expect(report.user).toBe(U);
      expect(report.cwd).toBe(WORKTREE);
      for (const v of ["RELAY_API_KEY", "RELAY_WORKSPACE_KEY", "AGENT_RELAY_WORKSPACE_KEY", "RELAY_WORKSPACES_JSON", "RELAY_AGENT_IDENTITY_KEY", "AGENT_RELAY_PROJECT"]) expect(report.env[v]).toBeUndefined();
      expect(report.env.RELAY_AGENT_NAME).toBe(name);
      expect(report.env.RELAY_AGENT_TOKEN).toMatch(/^at_live_/);
      expect(report.env.HOME).toBe(`/home/${U}`);
      expect(String(report.env.PATH)).not.toContain("relay-shims");
      // Every process the worker can see is the engineer's own; the broker side is invisible.
      expect(report.processes.length).toBeGreaterThan(0);
      for (const p of report.processes) expect(p.uid).toBe(report.uid);
      expect(report.parent_visible).toBe(false);
      for (const [path, readable] of Object.entries(report.probes)) expect([path, readable]).toEqual([path, false]);
      expect(report.sudo.as_root).not.toBe(0);
      expect(report.sudo.as_broker).not.toBe(0);

      // Broker PTY process (r) -> sudo running exactly the one allowed command -> the CLI (u). sudo stays
      // in between on purpose: it carries the broker's real uid, so the broker's signals reach the CLI.
      const now = await step<typeof procs>(["procs"]);
      const self = now.find((p) => p.pid === report.pid);
      expect(self?.user).toBe(U);
      const sudo = now.find((p) => p.pid === self!.ppid);
      expect(sudo?.user).toBe("root");
      expect(sudo?.args).toStartWith(`/usr/bin/sudo -n -u ${U} -- /opt/morrow/bin/relay-worker exec ${cli} `);
      const pty = now.find((p) => p.pid === sudo!.ppid);
      expect(pty?.user).toBe(R);
      expect(pty?.args).toContain(`pty --agent-name ${name}`);

      if (cli === "claude") expect(report.argv).toContain("--mcp-config");
      if (cli === "opencode") {
        expect(report.argv.slice(0, 2)).toEqual(["--agent", "agent-relay"]);
        expect(JSON.parse(report.env.OPENCODE_CONFIG_CONTENT).mcp["agent-relay"].command).toEqual(["/opt/morrow/bin/relay-worker", "mcp"]);
      }
    }
    // The broker wrote no opencode.json (or anything else) into the worktree.
    expect(await step<string[]>(["worktree"])).toEqual(["README.md"]);

    for (const cli of CLIS) {
      const name = workerName(cli);
      const mcp = await waitFor(`${name} MCP run`, async () => step<Record<string, any> | null>(["report", name, "mcp.json"]), 120_000, 500);
      expect(JSON.stringify(mcp)).not.toContain(team.workspaceKey);
      expect(mcp.error).toBeUndefined();
      expect(mcp.server.command).toBe("/opt/morrow/bin/relay-worker");
      expect(mcp.server.args).toEqual(["mcp"]);
      expect(mcp.initialized).toBe(true);
      expect(mcp.tools).toEqual(expect.arrayContaining(["post_message", "send_dm", "check_inbox"]));
      expect(mcp.post_message.ok).toBe(true);
      // agent-relay 14.0.0's send_dm checks the recipient against the workspace directory, which needs the
      // workspace key. Without it every DM is queued but reported as isError "recipient_unresolved". The DM
      // still arrives (checked below); if this changes upstream, this assertion says so.
      // (Some CLIs' tool text adds a pending-messages trailer after the receipt, so match its fields.)
      expect(mcp.send_dm.text).toMatch(/"id": "\d+"/);
      expect(mcp.send_dm.text).toMatch(/"status": "recipient_unresolved"/);
      expect(mcp.check_inbox.ok).toBe(true);
      // Workspace-wide tools need the key the worker no longer holds.
      expect(mcp.list_agents.ok).toBe(false);
      await waitFor(`${name} channel post`, async () => messages().some((m) => m.text === `channel hello from ${name}` && m.from.name === name), 20_000);
      await waitFor(`${name} DM`, async () => messages().some((m) => m.text === `dm hello from ${name}` && m.from.name === name), 20_000);

      // And the other way: a DM to the worker reaches its terminal.
      const ping = `ping-${randomBytes(4).toString("hex")}`;
      await sendDirectMessage({ config, speaker: { token: team.dispatcherToken, kind: "system" }, to: name, text: ping, idempotencyKey: ping });
      await waitFor(`${name} got the DM`, async () => (await sh(["docker", "exec", CONTAINER, "cat", `/home/${U}/e2e/${name}.in`], { allowFail: true })).includes(ping), 30_000, 500);
    }
  }, 600_000);

  test("read-only subagents start with their own limits and still get no key", async () => {
    const ro = (cli: string) => `w-e2ero${cli.slice(0, 2)}-be-e1`;
    const outcomes = await Promise.all(
      CLIS.map((cli) =>
        spawnWorker({
          config,
          dispatcherToken: team.dispatcherToken,
          reader,
          request: { name: ro(cli), node: NODE, cli, task: "Review only.", channels: [], workerCwd: WORKTREE, readOnly: true },
        }),
      ),
    );
    // Released even when an assertion fails, so a leftover read-only Codex CLI cannot be mistaken for the worker the
    // next test releases.
    let released = false;
    try {
      expectLaunched(outcomes, "read-only ");
      const reports: Record<string, Record<string, any>> = {};
      for (const cli of CLIS) {
        const report = await waitFor(`${ro(cli)} report`, async () => step<Record<string, any> | null>(["report", ro(cli)]), 60_000, 500);
        const raw = JSON.stringify(report);
        expect(raw).not.toContain(team.workspaceKey);
        // Any workspace key, not just this team's. relay-worker itself names the bare prefix to refuse it.
        expect(raw).not.toMatch(/rk_live_[A-Za-z0-9]{8,}/);
        expect(report.user).toBe(U);
        reports[cli] = report;
      }
      expect(reports.claude!.argv).toEqual(expect.arrayContaining(["--tools", "Read,Grep,Glob,WebFetch,WebSearch", "--mcp-config"]));
      // Codex refuses its read-only sandbox next to the bypass flag the broker adds, so the bridge drops it here...
      expect(reports.codex!.argv).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ask-for-approval", "never"]));
      expect(reports.codex!.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      // ...and only here: a normal Codex worker keeps it.
      expect((await step<Record<string, any>>(["report", workerName("codex")])).argv).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(reports.opencode!.argv.slice(0, 2)).toEqual(["--agent", "agent-relay-readonly"]);
      const agent = JSON.parse(reports.opencode!.env.OPENCODE_CONFIG_CONTENT).agent["agent-relay-readonly"];
      expect(agent.permission).toEqual({ edit: "deny", bash: "deny" });
      expect(agent.tools).toEqual({ "agent-relay_*": true, "morrow-agent_*": true });
      expect(await step<string[]>(["worktree"])).toEqual(["README.md"]);
      for (const cli of CLIS) {
        await releaseWorker({ config, workspaceKey: team.workspaceKey, reader, agentName: ro(cli), nodeName: NODE, reason: "e2e done" });
      }
      released = true;
    } finally {
      // Best effort: a worker that never came up must not hide the assertion that failed.
      if (!released) {
        for (const cli of CLIS) {
          await releaseWorker({ config, workspaceKey: team.workspaceKey, reader, agentName: ro(cli), nodeName: NODE, reason: "e2e cleanup" }).catch(() => undefined);
        }
      }
    }
  }, 300_000);

  test("releasing a worker stops its CLI even though the CLI runs as another user", async () => {
    const name = workerName("codex");
    const before = await step<Array<{ user: string; pid: number; args: string }>>(["procs"]);
    const cliPid = before.find((p) => p.user === U && p.args.includes("/usr/local/bin/codex"))?.pid;
    expect(cliPid).toBeTruthy();
    const released = await releaseWorker({ config, workspaceKey: team.workspaceKey, reader, agentName: name, nodeName: NODE, reason: "e2e done" });
    expect(released.gone).toBe(true);
    await waitFor("codex CLI gone", async () => !(await step<typeof before>(["procs"])).some((p) => p.pid === cliPid), 30_000, 500);
    await nodeOnline();
  }, 120_000);
});
