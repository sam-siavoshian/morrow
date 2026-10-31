#!/usr/local/bin/bun
// morrow-agent: the stdio MCP server that lets a Morrow worker start subagents on its own machine
// (docs/subagents.md). Installed by the golden image at /opt/morrow/morrow-agent.js and run by Bun.
//
//   bun morrow-agent.js            serve MCP over stdio (the CLI launches this)
//   bun morrow-agent.js register   add this server to the user's Claude Code, Codex, opencode, Cursor Agent and Grok
//                                  configs, and the Relay server to Cursor Agent's and Grok's (their only MCP source)
//
// Every tool call is one Relay direct message to @dispatcher, sent as the worker itself with the agent token the
// broker put in the CLI's environment (RELAY_AGENT_TOKEN). The engine stamps the sender from that token, so nothing
// else on the machine can speak for this worker. The workspace key in the same environment is never read: it can
// register any name. No socket, no re-registration, nothing marked read (that would hide messages from the worker's
// own inbox). Stdout carries only protocol; nothing is logged.
//
// Zero dependencies on purpose: the golden image ships this one file.

import { randomBytes } from "node:crypto"
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const SERVER_NAME = "morrow-agent"
const SERVER_VERSION = "1.0.0"
const DISPATCHER = "dispatcher"
const DEFAULT_BASE_URL = "https://cast.agentrelay.com"
const BUN_PATH = "/usr/local/bin/bun"
const SCRIPT_PATH = "/opt/morrow/morrow-agent.js"

const WORKER_NAME = /^w-[a-z0-9]+(?:-[a-z0-9]+)*-e[1-9][0-9]{0,15}$/
const SUBAGENT_NAME = /-sub-e[1-9][0-9]{0,15}$/
const REF = /^[A-Za-z0-9._-]{1,64}$/
const TASK_ID = /^[A-Za-z0-9._-]{1,128}$/
const TARGETS = ["claude", "codex", "opencode", "cursor", "gemini", "grok"]
const ROLES = ["review", "research", "implementation", "test", "general"]
const FINAL = new Set(["completed", "failed", "cancelled"])

const MAX_TASK_CHARS = 4000
const MAX_RESULT_BYTES = 8192
const MAX_REASON_CHARS = 300
const MAX_OUTPUT_CHARS = 12_000
const DEFAULT_WAIT_MS = 600_000
const MAX_WAIT_MS = 1_800_000

// Tunable for tests only; never set on a real machine.
const REPLY_TIMEOUT_MS = boundedEnvInt("MORROW_AGENT_REPLY_TIMEOUT_MS", 45_000, 200, 120_000)
const ACK_TIMEOUT_MS = boundedEnvInt("MORROW_AGENT_ACK_TIMEOUT_MS", 10_000, 100, 60_000)
const POLL_MIN_MS = boundedEnvInt("MORROW_AGENT_POLL_MIN_MS", 500, 10, 10_000)
const POLL_MAX_MS = boundedEnvInt("MORROW_AGENT_POLL_MAX_MS", 5_000, 10, 30_000)
const HTTP_TIMEOUT_MS = 15_000
/** report_result sends its RESULT at most this many times, waiting a little longer for the ack each time. */
const RESULT_ATTEMPTS = 4

const PLAIN_TEXT_HINT = "You can send the same request as a plain direct message to @dispatcher with your Relay tools (see your brief)."

function boundedEnvInt(name, fallback, min, max) {
    const raw = process.env[name]
    if (raw === undefined || !/^\d{1,9}$/.test(raw)) return fallback
    return Math.min(max, Math.max(min, Number(raw)))
}

// ---------- identity ----------

/** Who this process speaks for. An env value the CLI did not expand (`${NAME}` left as is) counts as missing. */
export function identity(env = process.env) {
    const read = name => {
        const value = (env[name] ?? "").trim()
        return !value || /^\$\{[^}]*\}$/.test(value) || /^\{env:[^}]*\}$/.test(value) ? "" : value
    }
    const name = read("RELAY_AGENT_NAME")
    const token = read("RELAY_AGENT_TOKEN")
    let kind = "none"
    if (WORKER_NAME.test(name)) kind = SUBAGENT_NAME.test(name) ? "subagent" : "worker"
    // Only an agent token. A workspace key (rk_) here would let this process act as anyone: refuse it.
    const tokenOk = /^at_(?:live|test)_[A-Za-z0-9_-]{8,512}$/.test(token)
    let baseUrl = null
    const rawBase = read("RELAY_BASE_URL") || DEFAULT_BASE_URL
    try {
        const url = new URL(rawBase)
        const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
        if ((url.protocol === "https:" || (url.protocol === "http:" && loopback)) && !url.username && !url.password)
            baseUrl = url.origin + url.pathname.replace(/\/+$/, "")
    } catch {}
    return { name, kind, token: tokenOk ? token : "", baseUrl }
}

// ---------- small helpers ----------

const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new ToolError("The request was cancelled."))
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(new ToolError("The request was cancelled."))
        }
        signal?.addEventListener("abort", onAbort, { once: true })
    })

class ToolError extends Error {}

function newRef() {
    return `m${randomBytes(9).toString("hex")}`
}

/** One per send: Relay keeps idempotency keys per workspace, so a key must never repeat across workers or tries. */
function newIdempotencyKey() {
    return `morrow-${randomBytes(16).toString("hex")}`
}

function clipChars(text, max) {
    if (text.length <= max) return text
    const end = /[\uD800-\uDBFF]/.test(text[max - 2] ?? "") ? max - 2 : max - 1
    return `${text.slice(0, end)}…`
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g
// Format characters (zero-width, direction overrides, tag characters, U+061C, U+00AD) and the Unicode line and
// paragraph separators can hide or reorder text.
const INVISIBLE = /[\p{Cf}\u2028\u2029]/gu
function cleanText(text) {
    return String(text).replace(/\r\n?/g, "\n").replace(INVISIBLE, "").replace(CONTROL, "").trim()
}

const TAG_LINE = /^\[morrow((?: [a-z]+=[A-Za-z0-9._,:-]{1,128})*)\]$/
/** How far up from the end a tag line may sit: Morrow may add a short note after it. */
const TAG_SEARCH_LINES = 3

/**
 * Parses a dispatcher message ending in the tag line `[morrow k=v ...]`. Values are tokens without spaces. The tag is
 * the last line, or one of the last few when a note follows it; the search runs from the end, so a tag-like line
 * quoted earlier in the body never wins over the real one.
 */
export function parseReply(text) {
    const all = String(text).replace(/\r\n?/g, "\n").trimEnd().split("\n")
    let at = -1
    let m = null
    for (let i = all.length - 1; i >= Math.max(0, all.length - TAG_SEARCH_LINES) && !m; i--) {
        m = TAG_LINE.exec(all[i].trim())
        at = i
    }
    if (!m) return null
    const lines = [...all.slice(0, at), ...all.slice(at + 1), all[at]]
    const tag = {}
    for (const part of m[1].trim().split(" ").filter(Boolean)) {
        const eq = part.indexOf("=")
        tag[part.slice(0, eq)] = part.slice(eq + 1)
    }
    const head = (lines[0] ?? "").replace(/^@\S+\s+/, "").trim()
    const body = lines.slice(1, -1).join("\n").trim()
    return { tag, headline: clipChars(cleanText(head), 600), body: clipChars(cleanText(body), MAX_OUTPUT_CHARS) }
}

// ---------- Relay ----------

class Relay {
    constructor(id) {
        this.id = id
        this.conversationId = null
    }

    async #request(method, path, body, idempotencyKey, signal) {
        if (!this.id.token) throw new ToolError(`No Relay agent token in this process, so it cannot speak for you. ${PLAIN_TEXT_HINT}`)
        if (!this.id.baseUrl) throw new ToolError(`RELAY_BASE_URL is not a valid https URL. ${PLAIN_TEXT_HINT}`)
        const headers = { Authorization: `Bearer ${this.id.token}`, Accept: "application/json" }
        if (body !== undefined) headers["Content-Type"] = "application/json"
        if (idempotencyKey) {
            headers["Idempotency-Key"] = idempotencyKey
            headers["X-Idempotency-Key"] = idempotencyKey
        }
        for (let attempt = 0; ; attempt++) {
            let res
            try {
                const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS)
                res = await fetch(`${this.id.baseUrl}${path}`, {
                    method,
                    headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                    redirect: "error"
                })
            } catch {
                if (signal?.aborted) throw new ToolError("The request was cancelled.")
                if (attempt < 2) {
                    await sleep(500 * 2 ** attempt, signal)
                    continue
                }
                throw new ToolError(`Could not reach Relay. ${PLAIN_TEXT_HINT}`)
            }
            if (res.status === 401 || res.status === 403)
                throw new ToolError(`Relay rejected this agent's token (HTTP ${res.status}). ${PLAIN_TEXT_HINT}`)
            if ((res.status === 429 || res.status >= 500) && attempt < 3) {
                const retryAfter = Number(res.headers.get("retry-after"))
                await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 1000 * 2 ** attempt, signal)
                continue
            }
            let json = null
            try {
                json = await res.json()
            } catch {}
            if (!res.ok || !json || json.ok === false) throw new ToolError(`Relay answered HTTP ${res.status}. ${PLAIN_TEXT_HINT}`)
            return json.data ?? json
        }
    }

    async send(text, idempotencyKey, signal) {
        const data = await this.#request("POST", "/v1/dm", { to: DISPATCHER, text, mode: "wait" }, idempotencyKey, signal)
        const conversation = data?.conversation_id ?? data?.conversationId
        if (typeof conversation === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(conversation)) this.conversationId = conversation
        if (!this.conversationId) throw new ToolError("Relay did not say where the message went.")
    }

    /** Dispatcher messages in this worker's direct conversation, newest last. Never marks anything read. */
    async dispatcherMessages(signal) {
        const data = await this.#request("GET", `/v1/dm/${encodeURIComponent(this.conversationId)}/messages?limit=50`, undefined, null, signal)
        const list = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : []
        return list
            .filter(m => m && typeof m.text === "string" && (m.agent_name ?? m.agentName) === DISPATCHER)
            .map(m => ({ id: String(m.id ?? ""), at: String(m.created_at ?? m.createdAt ?? ""), text: m.text.slice(0, 64 * 1024) }))
            .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    }

    /** Polls until `match` accepts a dispatcher message or the deadline passes. */
    async waitFor(match, deadline, signal) {
        let delay = POLL_MIN_MS
        for (;;) {
            for (const message of await this.dispatcherMessages(signal)) {
                const reply = parseReply(message.text)
                if (reply && match(reply)) return reply
            }
            const left = deadline - Date.now()
            if (left <= 0) return null
            await sleep(Math.min(delay, left), signal)
            delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.6))
        }
    }

    /**
     * Sends one request and waits for the dispatcher's answer to its ref. The dispatcher drops requests over its
     * rate limit without answering, so one resend with the same ref (a fresh idempotency key, or Relay would
     * swallow it) follows a silent first try. The ref keeps DELEGATE from starting a second subagent.
     */
    async ask(ref, text, signal, replyTimeoutMs = REPLY_TIMEOUT_MS) {
        for (let attempt = 0; attempt < 2; attempt++) {
            await this.send(text, newIdempotencyKey(), signal)
            const reply = await this.waitFor(r => r.tag.ref === ref, Date.now() + replyTimeoutMs, signal)
            if (reply) return reply
        }
        return null
    }
}

// ---------- tools ----------

const TOOL_DEFS = {
    subagent_options: {
        description: "List the coding CLIs you can start as subagents on your machine right now, and the roles.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    delegate_task: {
        description:
            "Start a subagent on another coding CLI on your machine (for example Codex to review your work). It works in your worktree on your task. Use it only when it clearly helps or the user asked; at most 2 at a time.",
        inputSchema: {
            type: "object",
            properties: {
                target: { type: "string", enum: TARGETS, description: "Which CLI runs the subagent." },
                role: { type: "string", enum: ROLES, description: "review and research make no edits." },
                task: { type: "string", minLength: 1, maxLength: MAX_TASK_CHARS, description: "What the subagent should do, self-contained." },
                mode: { type: "string", enum: ["wait", "async"], default: "wait", description: "wait returns the result; async returns at once." },
                timeoutMs: { type: "integer", minimum: 1000, maximum: MAX_WAIT_MS, default: DEFAULT_WAIT_MS, description: "wait mode only. A timeout does not stop the subagent." },
                clientRequestId: { type: "string", pattern: REF.source, description: "Reuse to retry without starting a second subagent." }
            },
            required: ["target", "role", "task"],
            additionalProperties: false
        }
    },
    task_status: {
        description: "Get a subagent's status, and its result once it has ended.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", pattern: TASK_ID.source },
                waitMs: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS, description: "Wait up to this long for it to end." }
            },
            required: ["taskId"],
            additionalProperties: false
        }
    },
    task_cancel: {
        description: "Stop one of your subagents.",
        inputSchema: {
            type: "object",
            properties: { taskId: { type: "string", pattern: TASK_ID.source }, reason: { type: "string", maxLength: MAX_REASON_CHARS } },
            required: ["taskId"],
            additionalProperties: false
        }
    },
    report_result: {
        description: "Report your result to the agent that started you. Call it once, when you are done; you are stopped right after.",
        inputSchema: {
            type: "object",
            properties: {
                status: { type: "string", enum: ["completed", "failed"] },
                result: { type: "string", minLength: 1, maxLength: MAX_RESULT_BYTES, description: "Your findings or what you changed, up to 8 KB." }
            },
            required: ["status", "result"],
            additionalProperties: false
        }
    }
}

export function toolNames(kind) {
    if (kind === "worker") return ["subagent_options", "delegate_task", "task_status", "task_cancel"]
    if (kind === "subagent") return ["report_result"]
    return []
}

function arg(args, key, check, message) {
    const value = args?.[key]
    if (!check(value)) throw new ToolError(message)
    return value
}

function optional(args, key, check, message) {
    return args?.[key] === undefined || args?.[key] === null ? undefined : arg(args, key, check, message)
}

const isInt = (min, max) => v => Number.isInteger(v) && v >= min && v <= max

function noAnswer() {
    return new ToolError(`No answer from @dispatcher. ${PLAIN_TEXT_HINT}`)
}

function errorOf(reply) {
    return reply.tag.error ? { status: "failed", error: reply.tag.error, message: reply.headline, details: reply.body || undefined } : null
}

function describe(reply) {
    const t = reply.tag
    return {
        taskId: t.task,
        status: t.status,
        agent: t.agent,
        target: t.target,
        role: t.role,
        message: reply.headline,
        result: FINAL.has(t.status) ? reply.body || undefined : undefined
    }
}

/** Waits for a subagent to end: any dispatcher message tagged with its task id and a final status. */
async function waitForEnd(relay, taskId, waitMs, signal) {
    const reply = await relay.waitFor(r => r.tag.task === taskId && FINAL.has(r.tag.status) && !r.tag.error, Date.now() + waitMs, signal)
    return reply
}

const ASYNC_NEXT = "Its result arrives as a message from @dispatcher. Keep working or end your turn; do not poll it."
const TIMED_OUT_NEXT = "It is still running and was not stopped. Its result arrives as a message from @dispatcher; do not poll it."

async function callTool(relay, kind, name, args, signal) {
    if (!toolNames(kind).includes(name)) throw new ToolError(`Unknown tool ${name}.`)
    if (!relay.id.token) throw new ToolError(`No Relay agent token in this process, so it cannot speak for you. ${PLAIN_TEXT_HINT}`)

    if (name === "subagent_options") {
        const ref = newRef()
        const reply = await relay.ask(ref, `SUBAGENT_OPTIONS ${ref}`, signal)
        if (!reply) throw noAnswer()
        return errorOf(reply) ?? { ready: reply.tag.ready ? reply.tag.ready.split(",") : [], message: reply.headline, details: reply.body }
    }

    if (name === "delegate_task") {
        const target = arg(args, "target", v => TARGETS.includes(v), `target must be one of ${TARGETS.join(", ")}.`)
        const role = arg(args, "role", v => ROLES.includes(v), `role must be one of ${ROLES.join(", ")}.`)
        const task = cleanText(arg(args, "task", v => typeof v === "string", "task is required."))
        if (!task || task.length > MAX_TASK_CHARS) throw new ToolError(`task must be 1 to ${MAX_TASK_CHARS} characters.`)
        const mode = optional(args, "mode", v => v === "wait" || v === "async", "mode must be wait or async.") ?? "wait"
        const timeoutMs = optional(args, "timeoutMs", isInt(1000, MAX_WAIT_MS), `timeoutMs must be 1000 to ${MAX_WAIT_MS}.`) ?? DEFAULT_WAIT_MS
        const ref = optional(args, "clientRequestId", v => typeof v === "string" && REF.test(v), "clientRequestId must be 1 to 64 of A-Z a-z 0-9 . _ -") ?? newRef()
        const started = Date.now()
        const reply = await relay.ask(ref, `DELEGATE ${ref} ${target} ${role}\n${task}`, signal)
        if (!reply) throw noAnswer()
        const refused = errorOf(reply)
        if (refused) return { ...refused, clientRequestId: ref }
        const out = { ...describe(reply), clientRequestId: ref }
        if (!out.taskId) throw new ToolError("The dispatcher answered without a task id.")
        if (FINAL.has(out.status)) return out
        if (mode === "async") return { ...out, next: ASYNC_NEXT }
        const done = await waitForEnd(relay, out.taskId, Math.max(0, timeoutMs - (Date.now() - started)), signal)
        if (!done) return { ...out, status: "running", waitTimedOut: true, next: TIMED_OUT_NEXT }
        return { ...describe(done), clientRequestId: ref, waitTimedOut: false }
    }

    if (name === "task_status") {
        const taskId = arg(args, "taskId", v => typeof v === "string" && TASK_ID.test(v), "taskId is the id delegate_task returned.")
        const waitMs = optional(args, "waitMs", isInt(0, MAX_WAIT_MS), `waitMs must be 0 to ${MAX_WAIT_MS}.`) ?? 0
        const started = Date.now()
        const ref = newRef()
        const reply = await relay.ask(ref, `TASK_STATUS ${ref} ${taskId}`, signal)
        if (!reply) throw noAnswer()
        const refused = errorOf(reply)
        if (refused) return refused
        const out = describe(reply)
        if (FINAL.has(out.status) || waitMs === 0) return out.status === "running" ? { ...out, next: ASYNC_NEXT } : out
        const done = await waitForEnd(relay, taskId, Math.max(0, waitMs - (Date.now() - started)), signal)
        return done ? { ...describe(done), waitTimedOut: false } : { ...out, waitTimedOut: true, next: TIMED_OUT_NEXT }
    }

    if (name === "task_cancel") {
        const taskId = arg(args, "taskId", v => typeof v === "string" && TASK_ID.test(v), "taskId is the id delegate_task returned.")
        const reason = optional(args, "reason", v => typeof v === "string", "reason must be text.")
        const why = reason ? clipChars(cleanText(reason).replace(/\s+/g, " "), MAX_REASON_CHARS) : ""
        const ref = newRef()
        const reply = await relay.ask(ref, `TASK_CANCEL ${ref} ${taskId}${why ? `\n${why}` : ""}`, signal)
        if (!reply) throw noAnswer()
        return errorOf(reply) ?? describe(reply)
    }

    // report_result. A message can be dropped on the way (a Relay blip, Morrow busy), and a lost result would leave
    // this subagent holding its slot, so the same RESULT goes again under the same ref until Morrow acks it. Morrow
    // records one result per subagent, so a resend never counts twice. Once recorded, Morrow stops this process; the
    // ack may then never be read here, which is fine.
    const status = arg(args, "status", v => v === "completed" || v === "failed", "status must be completed or failed.")
    const result = cleanText(arg(args, "result", v => typeof v === "string", "result is required."))
    if (!result) throw new ToolError("result must not be empty.")
    if (Buffer.byteLength(result, "utf8") > MAX_RESULT_BYTES) throw new ToolError(`result is over ${MAX_RESULT_BYTES} bytes; shorten it and call again.`)
    const ref = newRef()
    const text = `RESULT ${ref} ${status}\n${result}`
    for (let attempt = 0; attempt < RESULT_ATTEMPTS; attempt++) {
        await relay.send(text, newIdempotencyKey(), signal)
        const ack = await relay.waitFor(r => r.tag.ref === ref, Date.now() + ACK_TIMEOUT_MS * (attempt + 1), signal)
        if (ack?.tag.error) return { recorded: false, error: ack.tag.error, message: ack.headline }
        if (ack) return { recorded: true, status, message: "Your result was recorded. You are done; stop here." }
    }
    throw new ToolError(`Morrow did not confirm your result after ${RESULT_ATTEMPTS} tries. ${PLAIN_TEXT_HINT}`)
}

// ---------- MCP over stdio ----------

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

function write(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`)
}

function toolResult(value, isError = false) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
    return { content: [{ type: "text", text: clipChars(text, MAX_OUTPUT_CHARS + 2000) }], isError }
}

export function serve() {
    const id = identity()
    const relay = new Relay(id)
    const inflight = new Map()
    let buffer = ""

    const handle = async message => {
        if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return
        const { id: rpcId, method, params } = message
        const isRequest = rpcId !== undefined && rpcId !== null
        if (method === "notifications/cancelled") {
            inflight.get(params?.requestId)?.abort()
            return
        }
        if (!isRequest) return
        const reply = result => write({ jsonrpc: "2.0", id: rpcId, result })
        const fail = (code, msg) => write({ jsonrpc: "2.0", id: rpcId, error: { code, message: msg } })
        switch (method) {
            case "initialize": {
                const asked = params?.protocolVersion
                reply({
                    protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                    instructions:
                        id.kind === "subagent"
                            ? "You are a Morrow subagent. When you are done, call report_result once."
                            : id.kind === "worker"
                              ? "Morrow subagents: start another coding CLI on your machine to review, research or test alongside you."
                              : undefined
                })
                return
            }
            case "ping":
                reply({})
                return
            case "tools/list":
                reply({ tools: toolNames(id.kind).map(name => ({ name, ...TOOL_DEFS[name] })) })
                return
            case "tools/call": {
                const name = params?.name
                if (typeof name !== "string" || !toolNames(id.kind).includes(name)) {
                    if (id.kind === "none") reply(toolResult("Morrow subagent tools only work inside a Morrow worker.", true))
                    else fail(-32602, "Unknown tool")
                    return
                }
                const controller = new AbortController()
                inflight.set(rpcId, controller)
                try {
                    reply(toolResult(await callTool(relay, id.kind, name, params?.arguments ?? {}, controller.signal)))
                } catch (error) {
                    reply(toolResult(error instanceof ToolError ? error.message : "The request failed.", true))
                } finally {
                    inflight.delete(rpcId)
                }
                return
            }
            default:
                fail(-32601, "Method not found")
        }
    }

    process.stdin.setEncoding("utf8")
    process.stdin.on("data", chunk => {
        buffer += chunk
        if (buffer.length > 4 * 1024 * 1024) buffer = "" // a runaway line; the client will time out on it
        let newline
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (!line) continue
            let message
            try {
                message = JSON.parse(line)
            } catch {
                write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
                continue
            }
            for (const one of Array.isArray(message) ? message : [message]) handle(one).catch(() => {})
        }
    })
    // On EOF the process ends by itself once the answers in flight are written.
    process.stdin.on("end", () => {
        for (const controller of inflight.values()) controller.abort()
    })
}

// ---------- register ----------

/** Reads a config file, refusing a symlink: nothing is ever written through one. */
function readConfig(path) {
    let stat
    try {
        stat = lstatSync(path)
    } catch (error) {
        if (error?.code === "ENOENT") return null
        throw error
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} is not a regular file; not touching it`)
    return readFileSync(path, "utf8")
}

function writeAtomic(path, text) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.morrow-${randomBytes(6).toString("hex")}.tmp`
    const fd = openSync(temp, "wx", 0o600)
    try {
        writeSync(fd, text)
        fsyncSync(fd)
    } finally {
        closeSync(fd)
    }
    try {
        renameSync(temp, path)
    } catch (error) {
        try {
            unlinkSync(temp)
        } catch {}
        throw error
    }
}

function parseJsonObject(text, path) {
    if (text === null || text.trim() === "") return {}
    const value = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} is not a JSON object`)
    return value
}

const CODEX_BEGIN = "# morrow-agent begin (managed by Morrow, replaced on update)"
const CODEX_END = "# morrow-agent end"

export function codexBlock() {
    return [
        CODEX_BEGIN,
        `[mcp_servers.${SERVER_NAME}]`,
        `command = "${BUN_PATH}"`,
        `args = ["${SCRIPT_PATH}"]`,
        // Codex starts MCP servers with a cleared environment: name what this one needs. Values stay in the env.
        `env_vars = ["RELAY_AGENT_NAME", "RELAY_AGENT_TOKEN", "RELAY_BASE_URL"]`,
        "startup_timeout_sec = 20",
        // delegate_task waits up to 30 minutes; Codex's default tool timeout is a minute.
        "tool_timeout_sec = 1900",
        `default_tools_approval_mode = "approve"`,
        CODEX_END
    ].join("\n")
}

/**
 * Reads a TOML dotted key (`a.b`, `"a".'b'`, spaces around dots) from the start of `src`. Returns the key's parts
 * and what follows, or null when `src` does not start with a key.
 */
function tomlKey(src) {
    const parts = []
    let rest = src
    for (;;) {
        rest = rest.replace(/^[ \t]+/, "")
        let m
        if ((m = /^[A-Za-z0-9_-]+/.exec(rest))) parts.push(m[0])
        else if ((m = /^"(?:[^"\\\n]|\\.)*"/.exec(rest))) {
            try {
                parts.push(JSON.parse(m[0]))
            } catch {
                return null
            }
        } else if ((m = /^'[^'\n]*'/.exec(rest))) parts.push(m[0].slice(1, -1))
        else return null
        rest = rest.slice(m[0].length).replace(/^[ \t]+/, "")
        if (!rest.startsWith(".")) return { parts, rest }
        rest = rest.slice(1)
    }
}

/**
 * Whether a config.toml already says anything about mcp_servers.<name> outside our block: its table in any quoting,
 * a subtable or array of it, a dotted key into it, or an inline `mcp_servers` table (which a later
 * `[mcp_servers.<name>]` cannot extend). Any of these would clash with the managed block or change what it runs.
 * Lines inside multi-line strings are skipped.
 */
function definesServer(text, name = SERVER_NAME) {
    const target = ["mcp_servers", name]
    const startsWith = (path, prefix) => prefix.every((part, i) => path[i] === part)
    let table = []
    let open = null
    for (const raw of text.split(/\r?\n/)) {
        if (open) {
            if (raw.includes(open)) open = null
            continue
        }
        const line = raw.trimStart()
        if (!line || line.startsWith("#")) continue
        if (line.startsWith("[")) {
            const key = tomlKey(line.slice(line.startsWith("[[") ? 2 : 1))
            if (!key) continue
            table = key.parts
            if (startsWith(table, target)) return true
            continue
        }
        const key = tomlKey(line)
        if (!key || !key.rest.startsWith("=")) continue
        const path = [...table, ...key.parts]
        if (startsWith(path, target) || startsWith(target, path)) return true
        const value = key.rest.slice(1)
        for (const quote of ['"""', "'''"]) if (value.split(quote).length % 2 === 0) open = quote
    }
    return false
}

/** Replaces our managed block in a config.toml (or appends it), refusing a hand-written table for any of `names`. */
function mergeManagedToml(existing, { begin, end, block, names }) {
    let text = existing ?? ""
    const at = text.indexOf(begin)
    if (at >= 0) {
        const stop = text.indexOf(end, at)
        if (stop < 0) throw new Error(`config.toml has a ${begin.slice(2)} marker without its end`)
        text = text.slice(0, at) + text.slice(stop + end.length).replace(/^\n/, "")
    }
    for (const name of names)
        if (definesServer(text, name)) throw new Error(`config.toml already defines mcp_servers.${name} outside the managed block`)
    text = text.replace(/\s*$/, "")
    return `${text ? `${text}\n\n` : ""}${block}\n`
}

export function mergeCodexToml(existing) {
    return mergeManagedToml(existing, { begin: "# morrow-agent begin", end: CODEX_END, block: codexBlock(), names: [SERVER_NAME] })
}

// ---------- Cursor Agent and Grok ----------
// Neither CLI has a per-process MCP config, and the Relay broker only sets them up when it can put the workspace key
// in their config, so Morrow starts them under another name (relay-worker.sh) and they find both servers here.
// Values stay in the worker's environment: each CLI expands the ${...} placeholders when it starts the server. Run
// outside a worker (the engineer's own terminal), the placeholders stay empty and the servers do not connect.

const RELAY_SERVER = "agent-relay"
const RELAY_WORKER = "/opt/morrow/bin/relay-worker"

function placeholderEnv() {
    return {
        RELAY_AGENT_NAME: "${RELAY_AGENT_NAME}",
        RELAY_AGENT_TOKEN: "${RELAY_AGENT_TOKEN}",
        RELAY_BASE_URL: "${RELAY_BASE_URL:-" + DEFAULT_BASE_URL + "}"
    }
}

/** What agent-relay writes for a worker's Relay server, with the agent token in place of the workspace key. */
function relayEnv() {
    return { ...placeholderEnv(), RELAY_AGENT_TYPE: "agent", RELAY_STRICT_AGENT_NAME: "1", RELAY_SKIP_BOOTSTRAP: "1" }
}

export function cursorServers() {
    return {
        [RELAY_SERVER]: { command: RELAY_WORKER, args: ["mcp"], env: relayEnv() },
        [SERVER_NAME]: { command: BUN_PATH, args: [SCRIPT_PATH], env: placeholderEnv() }
    }
}

const GROK_BEGIN = "# morrow begin (managed by Morrow, replaced on update)"
const GROK_END = "# morrow end"

const tomlTable = env =>
    Object.entries(env)
        .map(([name, value]) => `${name} = ${JSON.stringify(value)}`)
        .join("\n")

export function grokBlock() {
    return [
        GROK_BEGIN,
        `[mcp_servers.${RELAY_SERVER}]`,
        `command = "${RELAY_WORKER}"`,
        `args = ["mcp"]`,
        "",
        `[mcp_servers.${RELAY_SERVER}.env]`,
        tomlTable(relayEnv()),
        "",
        `[mcp_servers.${SERVER_NAME}]`,
        `command = "${BUN_PATH}"`,
        `args = ["${SCRIPT_PATH}"]`,
        // delegate_task waits up to 30 minutes.
        "tool_timeout_sec = 1900",
        "",
        `[mcp_servers.${SERVER_NAME}.env]`,
        tomlTable(placeholderEnv()),
        GROK_END
    ].join("\n")
}

export function mergeGrokToml(existing) {
    return mergeManagedToml(existing, { begin: "# morrow begin", end: GROK_END, block: grokBlock(), names: [RELAY_SERVER, SERVER_NAME] })
}

/**
 * Adds the servers to every CLI's user config. Gemini CLI is not here: its workers get both servers from a
 * root-owned settings file (configure-node.sh). Each config is its own step, so one the user broke does not keep the
 * others from being set up; any failure is reported.
 */
export function register(env = process.env) {
    const home = env.HOME || homedir()
    if (!home || !home.startsWith("/")) throw new Error("HOME is not set")
    const done = []
    const failed = []
    const step = (name, write) => {
        try {
            write()
            done.push(name)
        } catch (error) {
            failed.push(`${name}: ${error instanceof Error ? error.message : "unknown error"}`)
        }
    }

    // Claude Code, user scope. The env block names the broker's variables; Claude Code expands them when it starts
    // the server, so no value is ever written here.
    step("claude", () => {
        const claudePath = join(home, ".claude.json")
        const claude = parseJsonObject(readConfig(claudePath), claudePath)
        const servers = claude.mcpServers && typeof claude.mcpServers === "object" && !Array.isArray(claude.mcpServers) ? claude.mcpServers : {}
        claude.mcpServers = { ...servers, [SERVER_NAME]: { type: "stdio", command: BUN_PATH, args: [SCRIPT_PATH], env: placeholderEnv() } }
        writeAtomic(claudePath, `${JSON.stringify(claude, null, 2)}\n`)
    })

    step("codex", () => {
        const codexHome = env.CODEX_HOME && env.CODEX_HOME.startsWith("/") ? env.CODEX_HOME : join(home, ".codex")
        const codexPath = join(codexHome, "config.toml")
        writeAtomic(codexPath, mergeCodexToml(readConfig(codexPath)))
    })

    step("opencode", () => {
        const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith("/") ? env.XDG_CONFIG_HOME : join(home, ".config")
        const opencodePath = join(configHome, "opencode", "opencode.json")
        const opencode = parseJsonObject(readConfig(opencodePath), opencodePath)
        const mcp = opencode.mcp && typeof opencode.mcp === "object" && !Array.isArray(opencode.mcp) ? opencode.mcp : {}
        // opencode passes its own environment to local servers, so no variable is named here.
        opencode.mcp = { ...mcp, [SERVER_NAME]: { type: "local", command: [BUN_PATH, SCRIPT_PATH], enabled: true } }
        if (!opencode.$schema) opencode.$schema = "https://opencode.ai/config.json"
        writeAtomic(opencodePath, `${JSON.stringify(opencode, null, 2)}\n`)
    })

    // Cursor Agent reads ~/.cursor/mcp.json from the home directory, whatever its config dir variables say.
    step("cursor", () => {
        const cursorPath = join(home, ".cursor", "mcp.json")
        const cursor = parseJsonObject(readConfig(cursorPath), cursorPath)
        const servers = cursor.mcpServers && typeof cursor.mcpServers === "object" && !Array.isArray(cursor.mcpServers) ? cursor.mcpServers : {}
        cursor.mcpServers = { ...servers, ...cursorServers() }
        writeAtomic(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`)
    })

    step("grok", () => {
        const grokHome = env.GROK_HOME && env.GROK_HOME.startsWith("/") ? env.GROK_HOME : join(home, ".grok")
        const grokPath = join(grokHome, "config.toml")
        writeAtomic(grokPath, mergeGrokToml(readConfig(grokPath)))
    })

    if (failed.length > 0) throw new Error(`${failed.join("; ")}${done.length > 0 ? ` (registered: ${done.join(", ")})` : ""}`)
    return done
}

if (import.meta.main) {
    if (process.argv[2] === "register") {
        try {
            const done = register()
            process.stdout.write(`${JSON.stringify({ ok: true, registered: done })}\n`)
        } catch (error) {
            process.stderr.write(`[morrow-agent] register failed: ${error instanceof Error ? error.message : "unknown error"}\n`)
            process.exit(1)
        }
    } else if (process.argv.length > 2) {
        process.stderr.write("usage: morrow-agent.js [register]\n")
        process.exit(2)
    } else serve()
}
