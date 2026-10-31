// What TeamWorkforce stores, and what one transition writes, at the caps: schema v1 (every record map in one
// `@Persisted` field) against schema v2 (records in SQLite rows, src/lib/store.ts).
//
// Two costs matter, both paid on the real runtime:
//  - Bytes written per transition. A `@Persisted` assignment writes the field's whole JSON; a v2 transition writes
//    the rows it changed.
//  - Bytes read per call. The runtime reads every `@Persisted` field before and after every call, reads included
//    (durable-actors host/actor-runtime.ts, `database.fields()`), to diff the emitted ones. v2 keeps only the
//    emitted views and a few small fields there.
// The worst case is every written field at its validation limit (./worst-case.ts). A realistic case uses the sizes
// the latency benchmark used (1.5 KB prompt, five 1.5 KB briefs, one-line trace and checkpoint messages).
import { describe, expect, test } from "bun:test"
import { fingerprint, LEDGER_LIMIT, type Ledger } from "../src/lib/ledger.ts"
import { WorkforceStore, type StoredRecords } from "../src/lib/store.ts"
import type { OutboxItem, PlanInput, Task, TraceEntry } from "../src/lib/types.ts"
import * as wf from "../src/lib/workforce.ts"
import { profileInput } from "./helpers.ts"
import { memoryDatabase } from "./sqlite.ts"
import { BIG_EPOCH, bytes, fill, MAX, NOW, slug, worstState } from "./worst-case.ts"

type Sizes = { prompt: (n: number) => string; brief: (n: number) => string; message: (n: number) => string }
const WORST: Sizes = { prompt: fill, brief: fill, message: fill }
const ascii = (n: number) => "x".repeat(n)
const REALISTIC: Sizes = { prompt: () => ascii(1500), brief: () => ascii(1500), message: () => ascii(120) }

const records = (s: wf.WorkforceState): StoredRecords => ({ profiles: s.profiles, tasks: s.tasks, leases: s.leases, outbox: s.outbox })

/**
 * One team with a running worker on a task whose every text field, trace and checkpoint list is full, plus `extra`
 * finished tasks of the same size. Built with the real state machine, then the history it would accumulate is added.
 */
function team(sizes: Sizes, extra: number) {
    const db = memoryDatabase()
    const store = new WorkforceStore(db)
    let state: wf.WorkforceState = { profiles: {}, tasks: {}, leases: {}, outbox: {}, epoch: 0 }
    let now = NOW
    const step = <R>(run: (d: wf.WorkforceDraft) => R): { result: R; before: wf.WorkforceState } => {
        const d = new wf.WorkforceDraft(state, now)
        wf.sweep(d)
        const result = run(d)
        wf.finalize(d)
        expect(wf.workforceInvariantViolations(d)).toEqual([])
        const before = state
        state = { profiles: d.profiles, tasks: d.tasks, leases: d.leases, outbox: d.outbox, epoch: d.epoch }
        store.write(records(before), records(state))
        now += 1_000
        return { result, before }
    }
    const big = sizes === WORST
    step(d => wf.registerProfile(d, profileInput(slug("cp-", 0), { maxConcurrent: 4 })))
    const taskId = slug("tk-", 0)
    step(d =>
        wf.createTask(d, {
            id: taskId,
            projectId: slug("p-", 0),
            title: big ? fill(MAX.title) : "Add a team settings page",
            prompt: sizes.prompt(MAX.prompt),
            acceptance: big ? Array.from({ length: MAX.criteria }, () => fill(MAX.criterion)) : ["works", "tested"],
            createdBy: `u-${"9".repeat(12)}`,
            maxAgents: 5
        })
    )
    const roles = Array.from({ length: MAX.workstreams }, (_, i) => `${big ? "r".repeat(MAX.role - 1) : "role"}${i}`)
    const planInput: PlanInput = {
        source: "fallback",
        profileId: null,
        rationale: big ? fill(MAX.rationale) : ascii(600),
        warnings: big ? Array.from({ length: MAX.warnings }, () => fill(MAX.warning)) : [],
        workstreams: roles.map(role => ({
            id: `ws-${role}`,
            role,
            title: big ? fill(MAX.title) : `${role} part`,
            brief: sizes.brief(MAX.brief),
            why: big ? fill(MAX.why) : ascii(200),
            branch: `morrow/${"s".repeat(8)}/${role}`,
            dependsOn: [],
            ownership: big ? Array.from({ length: MAX.ownerships }, () => fill(MAX.ownership)) : [`src/${role}/**`]
        }))
    }
    expect(step(d => wf.recordPlan(d, taskId, planInput)).result.ok).toBe(true)
    const reserved = step(d => wf.reserveWorkers(d, taskId, [{ workstreamId: `ws-${roles[0]}`, profileId: slug("cp-", 0) }])).result
    if (!reserved.ok) throw new Error("reserve failed")
    const lease = reserved.leases[0]!
    for (const claim of step(d => wf.claimOutbox(d, 10)).result) step(d => wf.completeOutbox(d, claim.id, { ok: true, invocationId: "inv-1", sha: null, detail: null }))
    expect(step(d => wf.recordSpawnStatus(d, lease.id, lease.epoch, "running", null)).result).toEqual({ ok: true })

    // The history a long-running task accumulates: a full trace, a full checkpoint list, a failed verification run.
    const entry = (i: number): TraceEntry => ({ at: NOW + i, kind: "task.checkpointed", message: sizes.message(wf.WORKFORCE_LIMITS.traceMessageChars), leaseId: lease.id, profileId: slug("cp-", 0), epoch: lease.epoch })
    const full: Task = {
        ...state.tasks[taskId]!,
        trace: Array.from({ length: wf.WORKFORCE_LIMITS.traceEntries }, (_, i) => entry(i)),
        traceCount: 10_000,
        checkpoints: Array.from({ length: wf.WORKFORCE_LIMITS.taskCheckpoints }, (_, i) => ({ workstreamId: `ws-${roles[0]}`, sha: "f".repeat(40), summary: sizes.message(2000), epoch: lease.epoch, at: NOW + i })),
        verification: {
            status: "failed",
            checks: Array.from({ length: big ? MAX.checks : 3 }, () => ({ name: big ? fill(MAX.checkName) : "bun test", status: "failed" as const, detail: big ? fill(MAX.checkDetail) : ascii(400), url: null }))
        }
    }
    const tasks: Record<string, Task> = { [taskId]: full }
    for (let i = 1; i <= extra; i++) tasks[slug("tk-", i)] = { ...full, id: slug("tk-", i), status: "cancelled", workstreams: full.workstreams.map(ws => ({ ...ws, status: "pending", leaseId: null })) }
    const before = state
    state = { ...state, tasks }
    store.write(records(before), records(state))
    return { db, store, step, lease, taskId, sizes, get state() { return state } }
}

/** v1 cost of a field: its whole JSON. v2 cost: the rows written plus the `@Persisted` view parts that changed. */
function measure(t: ReturnType<typeof team>, run: (d: wf.WorkforceDraft) => unknown) {
    t.db.resetCounters()
    const { before } = t.step(run)
    const after = t.state
    const rows = t.db.writtenBytes
    const viewBefore = wf.buildWorkforceView(before)
    const viewAfter = wf.buildWorkforceView(after)
    const parts = (["profiles", "tasks", "leases"] as const).filter(part => JSON.stringify(viewBefore[part]) !== JSON.stringify(viewAfter[part]))
    const v2 = rows + parts.reduce((n, part) => n + bytes(viewAfter[part]), 0)
    const changed = (["profiles", "tasks", "leases", "outbox"] as const).filter(field => before[field] !== after[field])
    return { changed, v2Rows: rows, v2ViewParts: parts, v2 }
}

/** v1 field sizes at the caps, from one record of each kind (records of a kind are the same size at the caps). */
function v1AtCaps(t: ReturnType<typeof team>, ledgerResult: unknown) {
    const task = t.state.tasks[t.taskId]!
    const spawn = Object.values(t.state.outbox).find((item): item is OutboxItem => item.kind === "spawn")!
    const keyed = (count: number, one: unknown, id: string) => count * (bytes(one) + bytes(id) + 2) + 2
    const ledger: Ledger = Array.from({ length: LEDGER_LIMIT }, (_, i) => ({ key: `reserveWorkers:${"k".repeat(128 - String(i).length)}${i}`, fp: fingerprint(i), result: ledgerResult }))
    return {
        tasks: keyed(wf.WORKFORCE_LIMITS.storedTasks, task, task.id),
        // The finished items kept, plus one open item per live lease slot (100 profiles at 4).
        outbox: keyed(wf.WORKFORCE_LIMITS.finishedOutboxKept + wf.WORKFORCE_LIMITS.profiles * 4, spawn, spawn.id),
        processed: bytes(ledger),
        leases: keyed(wf.WORKFORCE_LIMITS.profiles * 4 + wf.WORKFORCE_LIMITS.terminalLeasesKept, t.state.leases[t.lease.id], t.lease.id),
        profiles: keyed(wf.WORKFORCE_LIMITS.profiles, t.state.profiles[slug("cp-", 0)], slug("cp-", 0))
    }
}

const VIEW_AT_CAPS = wf.buildWorkforceView(worstState())
const MB = (n: number) => `${(n / 1e6).toFixed(2)} MB`
const KB = (n: number) => `${(n / 1e3).toFixed(1)} KB`

describe.each([
    ["worst case", WORST],
    ["realistic", REALISTIC]
] as const)("stored state, %s", (label, sizes) => {
    const small = team(sizes, 0)
    const large = team(sizes, 20)
    const reserveResult = small.step(d => wf.reserveWorkers(d, small.taskId, [{ workstreamId: "ws-nope", profileId: slug("cp-", 0) }])).result
    const v1 = v1AtCaps(large, reserveResult)
    const v1Total = Object.values(v1).reduce((a, b) => a + b, 0)

    test("v2 writes per transition do not grow with stored tasks", () => {
        const sha = (t: typeof small) => (0x1000000 + Object.keys(t.state.tasks).length).toString(16)
        const checkpoint = (t: typeof small) => measure(t, d => wf.reportCheckpoint(d, t.lease.id, t.lease.epoch, sha(t), t.sizes.message(2000)))
        const a = checkpoint(small)
        const b = checkpoint(large)
        expect(a.changed).toEqual(["tasks"])
        expect(b.v2Rows).toBe(a.v2Rows)
    })

    test("one checkpoint, one outbox claim, one usage reading: v1 against v2 bytes written", () => {
        const t = team(sizes, 5)
        const checkpoint = measure(t, d => wf.reportCheckpoint(d, t.lease.id, t.lease.epoch, "abcdef0", t.sizes.message(2000)))
        // A release queued by a cooldown, then claimed.
        t.step(d => wf.markProfileLimited(d, slug("cp-", 0), NOW + 3_600_000, "limit", "detected"))
        const claim = measure(t, d => wf.claimOutbox(d, 1))
        const usage = measure(t, d =>
            wf.recordProfileUsage(d, slug("cp-", 0), { windows: [{ kind: "five_hour", label: "5h", usedPercent: 42, resetsAt: NOW + 3_600_000 }], observedAt: NOW + 60_000, source: "worker" })
        )
        // Every keyed call also rewrote the whole v1 ledger; v2 writes one ledger row.
        const ledgerRow = bytes({ key: "k".repeat(140), fp: "0123456789a", result: reserveResult })
        const v1Write = (fields: readonly (keyof typeof v1)[]) => fields.reduce((n, f) => n + v1[f], 0)
        const rows = {
            checkpoint: { v1: v1Write(["tasks", "processed"]), v2: checkpoint.v2 + ledgerRow },
            claimOutbox: { v1: v1Write(claim.changed as (keyof typeof v1)[]), v2: claim.v2 },
            recordUsage: { v1: v1Write(usage.changed as (keyof typeof v1)[]), v2: usage.v2 }
        }
        console.log(
            `${label}: bytes written per transition at the caps (v1 also rewrites the emitted view, not counted here)\n` +
                Object.entries(rows)
                    .map(([name, r]) => `  ${name.padEnd(11)} v1 ${MB(r.v1).padStart(11)}   v2 ${KB(r.v2).padStart(9)}   (${(r.v1 / r.v2).toFixed(0)}x less)`)
                    .join("\n")
        )
        expect(claim.changed).toContain("outbox")
        expect(usage.changed).toEqual(["profiles"])
        for (const r of Object.values(rows)) expect(r.v2 * 20).toBeLessThan(r.v1)
    })

    test("bytes read per call: every persisted field, twice", () => {
        // Both keep the emitted view (the largest one the limits allow, view-budget.test.ts). v2 keeps it in three
        // parts plus the outbox summary, the epoch, the notified marks and the schema version; v1 keeps everything.
        const view = bytes(VIEW_AT_CAPS)
        const notified = bytes(Object.fromEntries(Array.from({ length: wf.WORKFORCE_LIMITS.storedTasks }, (_, i) => [slug("tk-", i), 10_000])))
        const v2Read = view + bytes({ open: 999, nextDueAt: BIG_EPOCH }) + notified + 64
        const v1Read = view + v1Total + notified
        console.log(
            `${label}: v1 fields at the caps: ${Object.entries(v1)
                .map(([k, n]) => `${k} ${MB(n)}`)
                .join(", ")}. Read per call (twice): v1 ${MB(v1Read)}, v2 ${MB(v2Read)}`
        )
        expect(v2Read).toBeLessThan(1_000_000)
        expect(v2Read * 10).toBeLessThan(v1Read)
    })
})
