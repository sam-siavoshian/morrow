// Starts a real `durable-actors dev --no-watch` for tests: free port, temp data dir, random secret.
// Importable from other packages (backend tests), so it only depends on Node/Bun built-ins.
//
//   const server = await startTestServer()
//   const transport = createActorTransport({ controlPlaneUrl: server.url, apiKey: server.secret })
//   ...
//   await server.stop()
//
// Run directly (`bun scripts/test-server.ts`) to keep one alive and print its env until Ctrl-C.
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer, type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const ACTORS_DIR = resolve(import.meta.dir, "..")
const CLI = join(ACTORS_DIR, "node_modules", "durable-actors", "bin", "durable-actors.js")
const READY_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 10_000

export type TestServer = {
    /** Control-plane origin, e.g. http://127.0.0.1:53211 */
    readonly url: string
    readonly port: number
    readonly secret: string
    readonly dataDir: string
    /** Env vars a generated client (or `durable-actors generate`) needs to reach this server. */
    readonly env: Record<string, string>
    /** Stops and starts the server on the same port and data dir. Pending alarms are lost, like a real restart. */
    restart(): Promise<void>
    /** Kills the whole process tree and, unless `keepData`, deletes the temp data dir. */
    stop(options?: { keepData?: boolean }): Promise<void>
}

export type StartOptions = {
    /** Reuse an existing data dir (it is not deleted on stop). */
    dataDir?: string
    /** 0 (default) lets the runtime pick a free port. */
    port?: number
    secret?: string
    /** Actor source relative to the actors project (default: src/actors.ts). */
    entrypoint?: string
    /** Echo server output, for debugging. */
    verbose?: boolean
}

const live = new Set<ChildProcess>()

export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
    if (!existsSync(CLI)) throw new Error(`durable-actors is not installed; run \`bun install\` in ${ACTORS_DIR}`)
    const ownsDataDir = options.dataDir === undefined
    const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "morrow-actors-"))
    // Hex, never base64url: the CLI forwards the secret as an argument, and a leading "-" parses as a flag.
    const secret = options.secret ?? randomBytes(32).toString("hex")

    const entrypoint = options.entrypoint ?? "src/actors.ts"
    const verbose = options.verbose ?? false
    let { child, port } = await launch(dataDir, secret, options.port ?? 0, entrypoint, verbose)
    const url = `http://127.0.0.1:${port}`

    const server: TestServer = {
        url,
        port,
        secret,
        dataDir,
        env: {
            DURABLE_ACTORS_CONTROL_PLANE_URL: url,
            DURABLE_ACTORS_SECRET: secret,
            DURABLE_ACTORS_PROJECT_ID: "local"
        },
        async restart() {
            await kill(child)
            ;({ child } = await launch(dataDir, secret, port, entrypoint, verbose))
        },
        async stop(stopOptions = {}) {
            await kill(child)
            if (ownsDataDir && !stopOptions.keepData) rmSync(dataDir, { recursive: true, force: true })
        }
    }
    return server
}

async function launch(
    dataDir: string,
    secret: string,
    port: number,
    entrypoint: string,
    verbose: boolean
): Promise<{ child: ChildProcess; port: number }> {
    const env = {
        DURABLE_ACTORS_ENTRYPOINT: entrypoint,
        DURABLE_ACTORS_SECRET: secret,
        DURABLE_ACTORS_PROJECT_ID: "local",
        NO_COLOR: "1",
        FORCE_COLOR: "0"
    }
    const docker = process.env.DURABLE_ACTORS_TEST_DOCKER === "1"
    if (docker) sweepOrphans()
    const hostPort = docker ? port || (await freePort()) : 0
    // detached: the child leads its own process group, so one signal reaches the CLI and the native runtime it spawns.
    const child = docker
        ? spawn("docker", dockerArgs(dataDir, hostPort, env), { detached: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(process.execPath, [CLI, "dev", "--no-watch", "--port", String(port)], {
              cwd: ACTORS_DIR,
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, ...env, DURABLE_ACTORS_PROJECT: ACTORS_DIR, DURABLE_ACTORS_DATA_DIR: dataDir }
          })
    if (docker) containers.set(child, containerName(hostPort))
    live.add(child)
    child.once("exit", () => live.delete(child))

    let output = ""
    // A container first installs dependencies (cached across runs after the first).
    const readyTimeout = docker ? DOCKER_READY_TIMEOUT_MS : READY_TIMEOUT_MS
    const readyPort = await new Promise<number>((resolvePort, reject) => {
        const timer = setTimeout(() => fail(new Error(`durable-actors dev not ready after ${readyTimeout} ms:\n${output}`)), readyTimeout)
        const onData = (chunk: Buffer) => {
            const text = chunk.toString()
            output += text
            if (verbose) process.stderr.write(text)
            // Strip ANSI in case the CLI ignores NO_COLOR.
            const match = output.replace(/\u001b\[[0-9;]*m/g, "").match(/Ready\s+http:\/\/127\.0\.0\.1:(\d+)/)
            if (match) {
                clearTimeout(timer)
                // In a container the banner names the in-container port; the host reaches the published one.
                resolvePort(docker ? hostPort : Number(match[1]))
            }
        }
        const fail = (error: Error) => {
            clearTimeout(timer)
            void kill(child)
            reject(error)
        }
        child.stdout!.on("data", onData)
        child.stderr!.on("data", onData)
        child.once("exit", code => fail(new Error(`durable-actors dev exited with code ${code}:\n${output}`)))
    })
    await waitForInvoke(`http://127.0.0.1:${readyPort}`, secret)
    return { child, port: readyPort }
}

// The Ready banner can precede the actor host finishing its first load; wait until an invoke is actually served.
async function waitForInvoke(url: string, secret: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    let last = ""
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${url}/v1/projects/local/deployment/contract`, {
                headers: { authorization: `Bearer ${secret}` }
            })
            if (response.ok) return
            last = `HTTP ${response.status}`
        } catch (error) {
            last = String(error)
        }
        await Bun.sleep(100)
    }
    throw new Error(`durable-actors dev never served the contract: ${last}`)
}

// ---------- Docker mode ----------
//
// DURABLE_ACTORS_TEST_DOCKER=1 runs the runtime in a Linux container, for hosts where the native runtime cannot
// start (it refuses to boot when /etc/resolv.conf lists a scoped IPv6 nameserver such as `fe80::1%en0`, which
// some phone hotspots hand out). Same contract as the native path: a free host port, the same data dir, restart().

const DOCKER_IMAGE = "oven/bun:1.4.4"
const DOCKER_READY_TIMEOUT_MS = 300_000
/** Linux dependencies and the downloaded runtime, kept across runs so only the first one downloads. */
const DOCKER_CACHE = join(tmpdir(), "morrow-terse-docker-cache")
const containers = new Map<ChildProcess, string>()

const containerName = (hostPort: number) => `morrow-terse-${hostPort}`
/** Each container records the pid of the test process that owns it, so a later run can find orphans. */
const OWNER_LABEL = "morrow.terse.owner"
let swept = false

/**
 * A test process killed with SIGKILL never runs its cleanup, and its container keeps running. Before starting
 * a container, remove any whose owner process is gone.
 */
function sweepOrphans(): void {
    if (swept) return
    swept = true
    const listed = spawnSync("docker", ["ps", "-a", "--filter", `label=${OWNER_LABEL}`, "--format", `{{.Names}} {{.Label "${OWNER_LABEL}"}}`], { encoding: "utf8" })
    if (listed.status !== 0) return
    for (const line of listed.stdout.split("\n")) {
        const [name, owner] = line.trim().split(" ")
        if (!name || !owner || !/^\d+$/.test(owner) || isAlive(Number(owner))) continue
        spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" })
    }
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

function dockerArgs(dataDir: string, hostPort: number, env: Record<string, string>): string[] {
    // Inside, the runtime listens on the host port number too: it hands out URLs (actor sockets) naming its own
    // port, and those must resolve on the host. Its loopback-only listener is reached through the forwarder.
    const forwardPort = hostPort === 7101 ? 7102 : 7101
    const forward = `const net=require("node:net");net.createServer(c=>{const u=net.connect(${hostPort},"127.0.0.1");c.pipe(u);u.pipe(c);const end=()=>{c.destroy();u.destroy()};c.on("error",end);u.on("error",end);c.on("close",end);u.on("close",end)}).listen(${forwardPort},"0.0.0.0")`
    const script = [
        "set -e",
        // A Linux copy of the project: the host's node_modules hold macOS binaries.
        "mkdir -p /w && tar -C /src -cf - --exclude=./node_modules --exclude=./.durable-actors . | tar -C /w -xf -",
        "cd /w && bun install --frozen-lockfile >/dev/null",
        `bun -e '${forward}' &`,
        `exec bun node_modules/durable-actors/bin/durable-actors.js dev --no-watch --port ${hostPort}`
    ].join("\n")
    for (const dir of ["bun", "runtime"]) mkdirSync(join(DOCKER_CACHE, dir), { recursive: true })
    return [
        "run", "--rm", "--name", containerName(hostPort), "--label", `${OWNER_LABEL}=${process.pid}`,
        "-p", `127.0.0.1:${hostPort}:${forwardPort}`,
        "-v", `${ACTORS_DIR}:/src:ro`,
        "-v", `${dataDir}:/data`,
        "-v", `${join(DOCKER_CACHE, "bun")}:/root/.bun/install/cache`,
        "-v", `${join(DOCKER_CACHE, "runtime")}:/root/.cache/durable-actors`,
        ...Object.entries({ ...env, DURABLE_ACTORS_PROJECT: "/w", DURABLE_ACTORS_DATA_DIR: "/data" }).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        DOCKER_IMAGE, "sh", "-c", script
    ]
}

function freePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
        const probe = createServer()
        probe.once("error", reject)
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as AddressInfo
            probe.close(() => resolvePort(port))
        })
    })
}

/** Killing the `docker run` client does not always stop the container; remove it by name. */
function removeContainer(child: ChildProcess): void {
    const name = containers.get(child)
    if (!name) return
    containers.delete(child)
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" })
}

async function kill(child: ChildProcess): Promise<void> {
    try {
        await killProcess(child)
    } finally {
        removeContainer(child)
    }
}

async function killProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
    const exited = new Promise<void>(done => child.once("exit", () => done()))
    signalGroup(child.pid, "SIGTERM")
    const timedOut = await Promise.race([exited.then(() => false), Bun.sleep(STOP_TIMEOUT_MS).then(() => true)])
    if (timedOut) {
        signalGroup(child.pid, "SIGKILL")
        await exited
    }
    // The native runtime may outlive the CLI for a moment; make sure the group is gone.
    signalGroup(child.pid, "SIGKILL")
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal)
    } catch {
        // Group already gone.
    }
}

function killAllSync(): void {
    for (const child of live) if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL")
    for (const child of [...containers.keys()]) removeContainer(child)
}

process.once("exit", killAllSync)
for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
        killAllSync()
        process.exit(130)
    })

if (import.meta.main) {
    const server = await startTestServer({ verbose: true })
    console.log(Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join("\n"))
    console.log(`data dir: ${server.dataDir} (deleted on exit)`)
    await new Promise<void>(done => process.once("SIGINT", done))
    await server.stop()
}
