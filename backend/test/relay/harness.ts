/**
 * Real Relay infrastructure for tests: a self-hosted `relaycast-engine` (the version `agent-relay@14.0.0`
 * pins) on a random loopback port, and real `agent-relay node up` brokers that advertise only the fake
 * `fakeagent` harness. Every broker gets a temp HOME and its own cwd, so nothing touches the real home
 * directory or any coding CLI config. Every process started here is killed by `stopAll()` and on exit.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentRelay } from "@agent-relay/sdk";

export const ENGINE_VERSION = "11.1.0";
/**
 * Engine and broker suites download a pinned engine and spawn real brokers, so they run only when asked:
 * `RELAY_E2E=1 bun test test/relay` (or with RELAYCAST_ENGINE_BIN pointing at a local engine binary).
 */
export const RELAY_E2E = process.env.RELAY_E2E === "1" || Boolean(process.env.RELAYCAST_ENGINE_BIN);
/** Pinned digests of the published release binaries we have verified. Other platforms use the release's .sha256. */
const PINNED_SHA256: Record<string, string> = {
  "darwin-arm64": "1de21520561a9e24cc9489a953fbf54fce143eb04f17a64b0e6d2f65be264433",
};

const BACKEND = resolve(import.meta.dir, "../..");
const AGENT_RELAY_BIN = join(BACKEND, "node_modules/.bin/agent-relay");
const FAKE_HARNESS_DIR = join(BACKEND, "test/fixtures/relay/bin");
export const FAKE_HARNESS = "fakeagent";

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const nodeNames = new Set<string>();

export const runTag = randomBytes(3).toString("hex");

function platformTag(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  return `${os}-${arch}`;
}

async function ensureEngineBinary(): Promise<string> {
  const fromEnv = process.env.RELAYCAST_ENGINE_BIN;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`RELAYCAST_ENGINE_BIN does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const tag = platformTag();
  const file = `relaycast-engine-${ENGINE_VERSION}-${tag}`;
  const dir = join(tmpdir(), "morrow-relaycast-engine");
  const path = join(dir, file);
  if (existsSync(path)) return path;
  mkdirSync(dir, { recursive: true });
  const base = `https://github.com/AgentWorkforce/relaycast/releases/download/v${ENGINE_VERSION}`;
  const res = await fetch(`${base}/${file}`);
  if (!res.ok) throw new Error(`engine download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let expected = PINNED_SHA256[tag];
  if (!expected) {
    const sum = await fetch(`${base}/${file}.sha256`);
    if (!sum.ok) throw new Error(`engine checksum download failed: HTTP ${sum.status}`);
    expected = (await sum.text()).trim().split(/\s+/)[0]!;
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`engine checksum mismatch for ${file}`);
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, bytes);
  chmodSync(partial, 0o755);
  renameSync(partial, path);
  return path;
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

export function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `morrow-relay-${label}-`));
  tempDirs.add(dir);
  return dir;
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${(lastError as Error).message}` : ""}`);
}
export { waitFor };

export interface Engine {
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startEngine(): Promise<Engine> {
  const bin = await ensureEngineBinary();
  const port = await freePort();
  const dir = tempDir("engine");
  const log = openSync(join(dir, "engine.log"), "a");
  const child = spawn(bin, ["--db", join(dir, "relaycast.db"), "--port", String(port)], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    stdio: ["ignore", log, log],
    detached: true,
  });
  children.add(child);
  const baseUrl = `http://localhost:${port}`;
  await waitFor("engine", async () => (await fetch(`${baseUrl}/v1/workspace`)).status > 0, 20_000);
  return { baseUrl, stop: () => killTree(child) };
}

export async function createWorkspaceRaw(baseUrl: string, name: string): Promise<{ workspaceKey: string; workspaceId: string }> {
  const relay = await AgentRelay.createWorkspace({ name, baseUrl });
  const info = await relay.workspace.info();
  return { workspaceKey: relay.workspaceKey!, workspaceId: String(info.id) };
}

function node22BinDir(): string {
  const dir = process.env.NODE22_BIN_DIR ?? join(homedir(), ".nvm/versions/node/v22.21.1/bin");
  if (!existsSync(join(dir, "node"))) throw new Error(`Node 22 not found at ${dir} (set NODE22_BIN_DIR)`);
  const version = spawnSync(join(dir, "node"), ["--version"], { encoding: "utf8" }).stdout.trim();
  const major = Number(/^v(\d+)/.exec(version)?.[1] ?? 0);
  if (major < 22) throw new Error(`agent-relay needs Node >= 22, found ${version}`);
  return dir;
}

export interface Broker {
  nodeName: string;
  /** A real directory on the "node" usable as worker_cwd. */
  workDir: string;
  brokerPid(): number | null;
  /** SIGKILL the broker process only (simulates a VM/network death). */
  killBroker(): void;
  /** Kill the harness process of one worker (simulates the coding CLI crashing). */
  killWorker(agentName: string): boolean;
  stop(): Promise<void>;
}

export async function startBroker(input: { baseUrl: string; workspaceKey: string; nodeName?: string; harnesses?: string }): Promise<Broker> {
  const nodeName = input.nodeName ?? `n-t${runTag}${randomBytes(2).toString("hex")}`;
  nodeNames.add(nodeName);
  const root = tempDir("node");
  const home = join(root, "home");
  const cwd = join(root, "node");
  const workDir = join(root, "work");
  for (const d of [home, cwd, workDir]) mkdirSync(d, { recursive: true });
  const log = openSync(join(root, "broker.log"), "a");
  const child = spawn(AGENT_RELAY_BIN, ["node", "up", "--broker-name", nodeName, "--no-spawn"], {
    cwd,
    env: {
      HOME: home,
      TMPDIR: join(root, "tmp"),
      PATH: `${FAKE_HARNESS_DIR}:${node22BinDir()}:/usr/bin:/bin:/usr/sbin:/sbin`,
      RELAY_WORKSPACE_KEY: input.workspaceKey,
      RELAY_BASE_URL: input.baseUrl,
      AGENT_RELAY_NODE_HARNESSES: input.harnesses ?? FAKE_HARNESS,
      AGENT_RELAY_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
    },
    stdio: ["ignore", log, log],
    detached: true,
  });
  mkdirSync(join(root, "tmp"), { recursive: true });
  children.add(child);
  const relay = new AgentRelay({ workspaceKey: input.workspaceKey, baseUrl: input.baseUrl });
  await waitFor(
    `node ${nodeName} online`,
    async () => {
      const node = await relay.nodes.get(nodeName).catch(() => null);
      return node?.status === "online" && node.live === true && node.handlersLive === true;
    },
    45_000,
    500,
  );
  const brokerPid = () => pids(`instance-name ${nodeName}`)[0] ?? null;
  return {
    nodeName,
    workDir,
    brokerPid,
    killBroker() {
      const pid = brokerPid();
      if (pid) process.kill(pid, "SIGKILL");
    },
    killWorker(agentName) {
      const ptyPids = pids(`pty --agent-name ${agentName} `);
      const targets = ptyPids.flatMap((pid) => childPids(pid));
      for (const pid of targets) process.kill(pid, "SIGKILL");
      return targets.length > 0;
    },
    async stop() {
      await killTree(child);
      sweepNode(nodeName);
    },
  };
}

function pids(pattern: string): number[] {
  const out = spawnSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" }).stdout;
  return out.split(/\s+/).filter(Boolean).map(Number).filter((n) => n !== process.pid);
}

function childPids(pid: number): number[] {
  const out = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout;
  return out.split(/\s+/).filter(Boolean).map(Number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killTree(child: ChildProcess): Promise<void> {
  children.delete(child);
  const pid = child.pid;
  if (!pid) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Group already gone.
    }
    const deadline = Date.now() + 3000;
    while (alive(pid) && Date.now() < deadline) await Bun.sleep(100);
    if (!alive(pid)) return;
  }
}

/** Brokers spawn PTY workers in their own sessions; find them by name and kill them and their children. */
function sweepNode(nodeName: string): void {
  for (const pid of pids(`instance-name ${nodeName}`)) {
    for (const c of childPids(pid)) {
      for (const g of childPids(c)) tryKill(g);
      tryKill(c);
    }
    tryKill(pid);
  }
  nodeNames.delete(nodeName);
}

/** Test worker names start with `w-t<runTag>` (see `testTaskShort`), so this only ever matches our own. */
function sweepWorkers(): void {
  for (const pid of pids(`agent-relay-broker pty --agent-name w-t${runTag}`)) {
    for (const c of childPids(pid)) tryKill(c);
    tryKill(pid);
  }
}

export function testTaskShort(suffix: string): string {
  return `t${runTag}${suffix}`;
}

function tryKill(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export async function stopAll(): Promise<void> {
  sweepWorkers();
  for (const child of [...children]) await killTree(child);
  for (const name of [...nodeNames]) sweepNode(name);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}

process.on("exit", () => {
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const name of nodeNames) sweepNode(name);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
