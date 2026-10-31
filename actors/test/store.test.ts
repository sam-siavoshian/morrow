// WorkforceStore (src/lib/store.ts) against SQLite: after every transition of a long, real flow, a fresh store loads
// exactly the state the state machine produced, in the same order; the ledger behaves like the v1 array ledger.
import { describe, expect, test } from "bun:test"
import { fingerprint, LEDGER_LIMIT, ledgerLookup, ledgerRecord, type Ledger } from "../src/lib/ledger.ts"
import { alignment, WorkforceStore, type StoredRecords } from "../src/lib/store.ts"
import type { Task } from "../src/lib/types.ts"
import * as wf from "../src/lib/workforce.ts"
import { plan, profileInput, taskInput, workstream } from "./helpers.ts"
import { memoryDatabase, type MemoryDatabase } from "./sqlite.ts"

const T0 = 1_800_000_000_000

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const child of Object.values(value)) deepFreeze(child)
    }
    return value
}

const records = (state: wf.WorkforceState): StoredRecords => ({ profiles: state.profiles, tasks: state.tasks, leases: state.leases, outbox: state.outbox })

/** The actor's pipeline (sweep, run, finalize, invariants) with every transition written through the store. */
function harness() {
    const db = memoryDatabase()
    const store = new WorkforceStore(db)
    let state: wf.WorkforceState = deepFreeze({ profiles: {}, tasks: {}, leases: {}, outbox: {}, epoch: 0 })
    let now = T0
    let n = 0
    return {
        db,
        store,
        get state() {
            return state
        },
        advance(ms: number) {
            now += ms
        },
        step<R>(run: (d: wf.WorkforceDraft) => R): R {
            const d = new wf.WorkforceDraft(state, now)
            wf.sweep(d)
            const result = run(d)
            wf.finalize(d)
            expect(wf.workforceInvariantViolations(d)).toEqual([])
            const next = deepFreeze({ profiles: d.profiles, tasks: d.tasks, leases: d.leases, outbox: d.outbox, epoch: d.epoch })
            store.write(records(state), records(next))
            state = next
            now += 1_000
            return result
        },
        /** A store opened on the same database (a woken actor) loads exactly the current state, in the same order. */
        expectReloads(on: MemoryDatabase = db) {
            const loaded = new WorkforceStore(on).load()
            expect(loaded).toEqual(records(state))
            for (const field of ["profiles", "tasks", "leases", "outbox"] as const) expect(Object.keys(loaded[field])).toEqual(Object.keys(state[field]))
            for (const task of Object.values(state.tasks)) {
                expect(loaded.tasks[task.id]!.trace).toEqual(task.trace)
                expect(loaded.tasks[task.id]!.workstreams.map(ws => ws.id)).toEqual(task.workstreams.map(ws => ws.id))
            }
        },
        key: () => `k-${++n}`
    }
}

type H = ReturnType<typeof harness>

function startWorker(h: H, taskId: string, workstreamId: string, profileId: string) {
    const reserved = h.step(d => wf.reserveWorkers(d, taskId, [{ workstreamId, profileId }]))
    if (!reserved.ok) throw new Error(`reserve failed: ${JSON.stringify(reserved)}`)
    const lease = reserved.leases[0]!
    for (const claim of h.step(d => wf.claimOutbox(d, 10)))
        h.step(d => wf.completeOutbox(d, claim.id, { ok: true, invocationId: `inv-${claim.leaseId}`, sha: null, detail: null }))
    expect(h.step(d => wf.recordSpawnStatus(d, lease.id, lease.epoch, "running", null))).toEqual({ ok: true })
    return lease
}

describe("WorkforceStore", () => {
    test("every transition of a long flow reloads to the same state: trace and checkpoints past their caps, handoff, cancel", () => {
        const h = harness()
        for (const id of ["p1", "p2", "p3"]) h.step(d => wf.registerProfile(d, profileInput(id, { maxConcurrent: 2 })))
        h.expectReloads()
        h.step(d => wf.createTask(d, taskInput("tk-1")))
        h.step(d => wf.recordPlan(d, "tk-1", plan([workstream("ws-api", "api"), workstream("ws-web", "web")])))
        h.expectReloads()
        const api = startWorker(h, "tk-1", "ws-api", "p1")
        const web = startWorker(h, "tk-1", "ws-web", "p2")
        h.expectReloads()

        // Past both caps (200 trace entries, 100 checkpoints): rows are appended at the end and pruned at the front.
        for (let i = 0; i < 260; i++) {
            expect(h.step(d => wf.reportCheckpoint(d, api.id, api.epoch, (0x1000000 + i).toString(16), `progress ${i}`))).toEqual({ ok: true })
            if (i % 37 === 0) h.expectReloads()
        }
        const task = h.state.tasks["tk-1"]!
        expect(task.trace).toHaveLength(wf.WORKFORCE_LIMITS.traceEntries)
        expect(task.checkpoints).toHaveLength(wf.WORKFORCE_LIMITS.taskCheckpoints)
        h.expectReloads()
        const rows = (list: string) => Number(h.db.exec<{ n: number }>("SELECT COUNT(*) AS n FROM wf_task_item WHERE task_id = 'tk-1' AND list = ?", list)[0]!.n)
        expect(rows("trace")).toBe(wf.WORKFORCE_LIMITS.traceEntries)
        expect(rows("checkpoints")).toBe(wf.WORKFORCE_LIMITS.taskCheckpoints)
        expect(rows("workstreams")).toBe(2)

        // A cooldown hands the api workstream to p3; the web worker finishes; the task is cancelled.
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 3_600_000, "limit", "detected"))
        const handoff = h.step(d => wf.requestHandoff(d, "tk-1", "ws-api", api.epoch, "p3"))
        expect(handoff.ok).toBe(true)
        h.expectReloads()
        h.step(d => wf.completeWorkstream(d, web.id, web.epoch, "abcdef1", "web done"))
        h.step(d => wf.cancelTask(d, "tk-1", "u-1001"))
        for (const claim of h.step(d => wf.claimOutbox(d, 50))) h.step(d => wf.completeOutbox(d, claim.id, { ok: true, invocationId: null, sha: null, detail: null }))
        h.expectReloads()
        // A woken actor can keep going from what it loaded: same writes, same result.
        const woken = new WorkforceStore(h.db)
        expect(woken.load()).toEqual(records(h.state))
    })

    test("stored tasks past the cap are pruned with their rows", () => {
        const h = harness()
        h.step(d => wf.registerProfile(d, profileInput("p1")))
        const total = wf.WORKFORCE_LIMITS.storedTasks + 20
        for (let i = 0; i < total; i++) {
            const id = `tk-${String(i).padStart(4, "0")}`
            h.step(d => wf.createTask(d, taskInput(id)))
            h.step(d => wf.cancelTask(d, id, "u-1001"))
        }
        expect(Object.keys(h.state.tasks)).toHaveLength(wf.WORKFORCE_LIMITS.storedTasks)
        const count = (sql: string) => Number(h.db.exec<{ n: number }>(sql)[0]!.n)
        expect(count("SELECT COUNT(*) AS n FROM wf_task")).toBe(wf.WORKFORCE_LIMITS.storedTasks)
        expect(count("SELECT COUNT(DISTINCT task_id) AS n FROM wf_task_field")).toBe(wf.WORKFORCE_LIMITS.storedTasks)
        expect(count("SELECT COUNT(*) AS n FROM wf_task_item WHERE task_id = 'tk-0000'")).toBe(0)
        h.expectReloads()
    })

    test("a write touches only what changed", () => {
        const h = harness()
        h.step(d => wf.registerProfile(d, profileInput("p1")))
        h.step(d => wf.createTask(d, taskInput("tk-1")))
        h.step(d => wf.recordPlan(d, "tk-1", plan([workstream("ws-api", "api"), workstream("ws-web", "web")])))
        const lease = startWorker(h, "tk-1", "ws-api", "p1")
        h.db.resetCounters()
        h.step(d => wf.reportCheckpoint(d, lease.id, lease.epoch, "abc1234", "one more"))
        // The task's moved fields (updatedAt, traceCount), the api workstream (its last checkpoint), one trace entry and
        // one checkpoint. Nothing else: not the web workstream, not the prompt or plan, no other record.
        const written = h.db.writes.map(w => (w.table === "wf_task_item" ? `${w.bindings[1]}#${w.bindings[2]}` : w.table === "wf_task_field" ? `field:${w.bindings[1]}` : w.table))
        expect(written.sort()).toEqual(["checkpoints#0", "field:traceCount", "field:updatedAt", "trace#" + (h.state.tasks["tk-1"]!.trace.length - 1), "workstreams#0"].sort())
    })

    test("lists that do not line up are rewritten, shorter position lists drop their tail, removed fields are deleted", () => {
        const h = harness()
        h.step(d => wf.createTask(d, taskInput("tk-1")))
        h.step(d => wf.recordPlan(d, "tk-1", plan([workstream("ws-api", "api"), workstream("ws-web", "web"), workstream("ws-db", "db")])))
        const before = h.state.tasks["tk-1"]!
        // Hand-made next states the state machine does not produce today; the store must still match them.
        const odd: Task = {
            ...before,
            trace: [{ ...before.trace[0]!, message: "rewritten" }, ...before.trace.slice(1).reverse()],
            workstreams: before.workstreams.slice(0, 1),
            plan: undefined as unknown as Task["plan"]
        }
        h.store.write(records(h.state), { ...records(h.state), tasks: { "tk-1": odd } })
        const loaded = new WorkforceStore(h.db).load().tasks["tk-1"]!
        expect(loaded.trace).toEqual(odd.trace)
        expect(loaded.workstreams).toEqual(odd.workstreams)
        expect("plan" in loaded).toBe(false)
    })

    test("replaceAll is repeatable and leaves exactly the given records", () => {
        const h = harness()
        h.step(d => wf.registerProfile(d, profileInput("p1")))
        h.step(d => wf.createTask(d, taskInput("tk-1")))
        h.step(d => wf.createTask(d, taskInput("tk-2")))
        const target = records(h.state)
        const db = memoryDatabase()
        const store = new WorkforceStore(db)
        store.replaceAll(target)
        store.replaceAll(target)
        expect(new WorkforceStore(db).load()).toEqual(target)
        const fewer = { ...target, tasks: { "tk-2": target.tasks["tk-2"]! }, profiles: {} }
        store.replaceAll(fewer)
        expect(new WorkforceStore(db).load()).toEqual(fewer)
    })
})

describe("alignment", () => {
    const [a, b, c, d] = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]
    test.each([
        ["append", [a, b], [a, b, c], 0],
        ["drop front and append", [a, b, c], [b, c, d], 1],
        ["drop everything", [a, b], [], 2],
        ["from empty", [], [a], 0],
        ["unchanged", [a, b], [a, b], 0],
        ["drop the tail", [a, b, c], [a, b], 0],
        ["replaced in the middle", [a, b, c], [a, d, c], null],
        ["unrelated", [a, b], [c, d], null]
    ] as const)("%s", (_name, before, after, expected) => {
        expect(alignment(before, after)).toBe(expected)
    })
})

describe("ledger rows behave like the v1 array ledger", () => {
    test("lookup, re-record moves to newest, the oldest go first past the limit", () => {
        const store = new WorkforceStore(memoryDatabase())
        let legacy: Ledger = []
        const limit = 25
        let seed = 7
        const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
        for (let i = 0; i < 400; i++) {
            const key = `m:${Math.floor(random() * 60)}`
            const entry = { key, fp: fingerprint([i]), result: { ok: true, i } }
            legacy = ledgerRecord(legacy, entry, limit)
            store.ledgerPut(entry, limit)
            const probe = `m:${Math.floor(random() * 60)}`
            expect(store.ledgerGet(probe)).toEqual(ledgerLookup(legacy, probe))
        }
        expect(store.ledgerSize()).toBe(legacy.length)
        for (const entry of legacy) expect(store.ledgerGet(entry.key)).toEqual(entry)
    })

    test("replaceLedger imports a v1 ledger in order and keeps the default limit afterwards", () => {
        const store = new WorkforceStore(memoryDatabase())
        const v1: Ledger = Array.from({ length: LEDGER_LIMIT }, (_, i) => ({ key: `k:${i}`, fp: "", result: i }))
        store.replaceLedger(v1)
        expect(store.ledgerSize()).toBe(LEDGER_LIMIT)
        store.ledgerPut({ key: "k:new", fp: "", result: null })
        expect(store.ledgerSize()).toBe(LEDGER_LIMIT)
        expect(store.ledgerGet("k:0")).toBeUndefined()
        expect(store.ledgerGet("k:1")).toEqual({ key: "k:1", fp: "", result: 1 })
        expect(store.ledgerGet("k:new")).toEqual({ key: "k:new", fp: "", result: null })
    })
})
