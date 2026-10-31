// One-command local stack: Terse dev server, the backend on :8787 and (optionally) the web app, signing in with real
// GitHub and using real Freestyle VMs and hosted Relay. It creates no teams or other data: sign in and set things up
// through the app.
//
//   bun scripts/dev-stack.ts [--web-port 3000] [--no-web] [--backend-port 8787] [--state <dir>] [--prod]
//
// --prod serves a production build of the web app (`next build`, then `next start`) instead of `next dev`: no hot
// reload, no dev overlay, the same bundles a deploy ships. Code changes need a restart, which rebuilds.
//
// Vendor keys come from dev-stack.env at the repo root (dev-stack.env.example lists them), never from the shell.
// GitHub needs a separate OAuth app for local use with callback URL http://127.0.0.1/api/auth/github/callback:
// GitHub lets a loopback callback return to any port, so the app is served at http://127.0.0.1:<web port>.
// Everything binds to 127.0.0.1. Session keys are generated per run and live only in this process and its children.
// Ctrl-C stops the web, then the backend, then Terse (deleting its temp data dir). A second Ctrl-C forces it.
//
// --state <dir> keeps the stack's state across restarts instead: Terse's data and the session, data-encryption and
// Terse keys live in <dir> (0700, keys in a 0600 file), so teams, sign-ins and environments survive a restart that
// loads new code. Keep that folder outside the repo; anyone who can read it can read the stack's secrets.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const STOP_TIMEOUT_MS = 10_000;

const { values: args } = parseArgs({
  options: {
    "web-port": { type: "string", default: "3000" },
    "no-web": { type: "boolean", default: false },
    "backend-port": { type: "string", default: "8787" },
    state: { type: "string" },
    prod: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log("bun scripts/dev-stack.ts [--web-port 3000] [--no-web] [--backend-port 8787] [--state <dir>] [--prod]");
  process.exit(0);
}

const port = (name: string, raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`--${name} must be a port number`);
  return n;
};
const webPort = port("web-port", args["web-port"]!);
const backendPort = port("backend-port", args["backend-port"]!);
const appOrigin = `http://127.0.0.1:${webPort}`;
const backendUrl = `http://127.0.0.1:${backendPort}`;

function fail(message: string): never {
  console.error(`dev-stack: ${message}`);
  process.exit(1);
}

const log = (name: string, text: string) => {
  for (const line of text.split("\n")) if (line.trim()) console.log(`[${name}] ${line}`);
};

async function assertFree(p: number, what: string): Promise<void> {
  const free = await new Promise<boolean>((done) => {
    const probe = createServer()
      .once("error", () => done(false))
      .once("listening", () => probe.close(() => done(true)))
      .listen(p, "127.0.0.1");
  });
  if (!free) fail(`port ${p} (${what}) is in use. Is another dev stack running? Stop it first.`);
}

const key32 = () => randomBytes(32).toString("base64");

type StackKeys = { terseSecret: string; sessionSecret: string; dataEncryptionKey: string };

/** Refuses a state path anyone but this user can reach into: it holds the stack's secrets. */
function assertPrivate(path: string, mode: number): void {
  const st = statSync(path);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) fail(`${path} is not owned by you`);
  if ((st.mode & 0o077) !== 0) fail(`${path} must not be readable by others (chmod ${mode.toString(8)} ${path})`);
}

/** The state folder's Terse data dir and keys, created on first use. Null without --state: everything per run. */
function persistentState(dir: string | undefined): { dataDir: string; keys: StackKeys } | null {
  if (!dir) return null;
  const root = resolve(dir);
  if (root === ROOT || root.startsWith(`${ROOT}/`)) fail("--state must be outside the repo");
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivate(root, 0o700);
  const dataDir = join(root, "terse");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { mode: 0o700 });
  const keyFile = join(root, "keys.json");
  if (!existsSync(keyFile)) {
    const fresh: StackKeys = { terseSecret: randomBytes(32).toString("hex"), sessionSecret: key32(), dataEncryptionKey: key32() };
    writeFileSync(keyFile, JSON.stringify(fresh), { mode: 0o600, flag: "wx" });
    chmodSync(keyFile, 0o600);
  }
  assertPrivate(keyFile, 0o600);
  const keys = JSON.parse(readFileSync(keyFile, "utf8")) as Partial<StackKeys>;
  if (!keys.terseSecret || !/^[0-9a-f]{64}$/.test(keys.terseSecret) || !keys.sessionSecret || !keys.dataEncryptionKey) {
    fail(`${keyFile} is damaged; move it away to start fresh`);
  }
  return { dataDir, keys: keys as StackKeys };
}

const VENDOR_FILE = join(ROOT, "dev-stack.env");
const VENDOR_KEYS = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "FREESTYLE_API_KEY", "FREESTYLE_BASE_SNAPSHOT", "RELAY_BASE_URL"] as const;

/** The vendor keys in dev-stack.env. Only the listed names are read, so nothing else in the file reaches a child. */
async function vendorEnv(): Promise<Record<string, string>> {
  let mode: number;
  try {
    mode = statSync(VENDOR_FILE).mode;
  } catch {
    fail(`${VENDOR_FILE} is missing. Copy dev-stack.env.example to dev-stack.env, fill it in, then chmod 600 it.`);
  }
  if (mode & 0o077) fail(`${VENDOR_FILE} is readable by other users. Run: chmod 600 dev-stack.env`);
  const parsed = parseEnv(await Bun.file(VENDOR_FILE).text());
  const env = Object.fromEntries(VENDOR_KEYS.flatMap((k) => (parsed[k]?.trim() ? [[k, parsed[k]!.trim()]] : [])));
  for (const k of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) if (!env[k]) fail(`${k} is not set in dev-stack.env`);
  return env;
}

/** A minimal environment for children: never pass the parent's shell env (it may hold real vendor keys). */
function baseEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "TERM", "SHELL"];
  return Object.fromEntries(keep.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
}

type Child = { name: string; proc: ChildProcess; exited: Promise<void> };
const children: Child[] = [];

function start(name: string, cmd: string, argv: string[], cwd: string, env: Record<string, string>): Child {
  // detached: each child leads its own process group, so one signal reaches everything it spawns.
  const proc = spawn(cmd, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (b: Buffer) => log(name, b.toString()));
  proc.stderr!.on("data", (b: Buffer) => log(name, b.toString()));
  const exited = new Promise<void>((done) => proc.once("exit", () => done()));
  const child = { name, proc, exited };
  children.push(child);
  proc.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`dev-stack: ${name} exited (${signal ?? code}); shutting down.`);
      void shutdown(1);
    }
  });
  return child;
}

/** Runs a command to completion (the production build), its output in the log. Fails the stack on a non-zero exit. */
async function run(name: string, argv: string[], cwd: string, env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) log(name, new TextDecoder().decode(chunk));
  };
  const [code] = await Promise.all([proc.exited, pump(proc.stdout), pump(proc.stderr)]);
  if (code !== 0) throw new Error(`${name} failed (exit ${code})`);
}

function signalGroup(child: Child, signal: NodeJS.Signals): void {
  if (child.proc.pid === undefined || child.proc.exitCode !== null || child.proc.signalCode !== null) return;
  try {
    process.kill(-child.proc.pid, signal);
  } catch {
    // Group already gone.
  }
}

async function stopChild(child: Child): Promise<void> {
  signalGroup(child, "SIGTERM");
  const timedOut = await Promise.race([child.exited.then(() => false), Bun.sleep(STOP_TIMEOUT_MS).then(() => true)]);
  if (timedOut) signalGroup(child, "SIGKILL");
  await child.exited;
  // Stragglers in the group (next's workers) go too.
  try {
    process.kill(-child.proc.pid!, "SIGKILL");
  } catch {
    // Group already gone.
  }
}

async function waitFor(url: string, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopping) return;
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(200);
  }
  throw new Error(`${what} not ready after ${timeoutMs} ms (${url})`);
}

let stopping = false;
let terse: { stop(): Promise<void> } | null = null;

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("dev-stack: stopping...");
  // Web first (it proxies to the backend), then the backend (it drains against Terse), then Terse.
  for (const child of [...children].reverse()) await stopChild(child);
  await terse?.stop().catch((e) => console.error(`dev-stack: terse stop failed: ${e}`));
  console.log("dev-stack: stopped.");
  process.exit(code);
}

// test-server.ts installs exit-on-signal handlers meant for test runs. Replace them with the ordered shutdown above;
// its `exit` hook stays as a safety net that SIGKILLs Terse.
const { startTestServer } = await import("../actors/scripts/test-server.ts");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.removeAllListeners(signal);
  process.on(signal, () => {
    if (stopping) {
      for (const child of children) signalGroup(child, "SIGKILL");
      process.exit(130);
    }
    void shutdown(0);
  });
}
process.on("exit", () => {
  for (const child of children) signalGroup(child, "SIGKILL");
});

try {
  const vendor = await vendorEnv();
  await assertFree(backendPort, "backend");
  if (!args["no-web"]) await assertFree(webPort, "web");

  console.log("dev-stack: starting Terse...");
  const state = persistentState(args.state);
  const server = await startTestServer(state ? { dataDir: state.dataDir, secret: state.keys.terseSecret } : {});
  terse = server;

  start("backend", process.execPath, ["src/index.ts"], join(ROOT, "backend"), {
    ...baseEnv(),
    APP_ORIGIN: appOrigin,
    REALTIME_URL: `ws://127.0.0.1:${backendPort}`,
    PORT: String(backendPort),
    HOST: "127.0.0.1",
    SESSION_SECRET: state?.keys.sessionSecret ?? key32(),
    DATA_ENCRYPTION_KEY: state?.keys.dataEncryptionKey ?? key32(),
    ...server.env,
    ...vendor,
    // 0, not 1: Next's /api rewrite forwards the browser's X-Forwarded-For verbatim and appends nothing, so no
    // entry in it is trustworthy here. Pre-auth limits key on the socket peer (Next) in this stack.
    TRUSTED_PROXY_HOPS: "0",
    LOG_LEVEL: "info",
  });
  await waitFor(`${backendUrl}/readyz`, "backend", 30_000);

  if (!args["no-web"]) {
    const webEnv = {
      ...baseEnv(),
      BACKEND_URL: backendUrl,
      NEXT_PUBLIC_REALTIME_URL: `ws://127.0.0.1:${backendPort}`,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    if (args.prod) {
      // Both URLs are baked into the build, so it is rebuilt on every start rather than reused.
      console.log("dev-stack: building the web app (next build)...");
      await run("build", [process.execPath, "run", "build"], join(ROOT, "web"), { ...webEnv, NODE_ENV: "production" });
    }
    const mode = args.prod ? "start" : "dev";
    start("web", process.execPath, ["run", mode, "--port", String(webPort), "--hostname", "127.0.0.1"], join(ROOT, "web"), {
      ...webEnv,
      ...(args.prod ? { NODE_ENV: "production" } : {}),
    });
    await waitFor(`http://127.0.0.1:${webPort}/login`, "web", 120_000);
  }

  console.log(
    [
      "",
      "dev-stack ready",
      `  backend      ${backendUrl}   (healthz, readyz, /api/*)`,
      `  vms          ${vendor.FREESTYLE_API_KEY ? "Freestyle" : "off (no FREESTYLE_API_KEY in dev-stack.env)"}`,
      `  relay        ${vendor.RELAY_BASE_URL === "disabled" ? "off" : (vendor.RELAY_BASE_URL ?? "hosted Relaycast")}`,
      `  terse        ${server.url}`,
      args["no-web"] ? "  web          not started (--no-web)" : `  web          ${appOrigin}   (${args.prod ? "production build" : "next dev"})`,
      `  sign in      ${appOrigin}  with GitHub`,
      "",
      "Ctrl-C to stop.",
    ].join("\n"),
  );
} catch (error) {
  console.error(`dev-stack: ${(error as Error).message}`);
  await shutdown(1);
}
