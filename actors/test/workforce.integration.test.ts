// TeamWorkforce against a real `durable-actors dev` through the generated client.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { WorkforceView } from "../../packages/contracts/src/domain.ts"
import { startTestServer, type TestServer } from "../scripts/test-server.ts"
import { actors, expectActorError, openSocket, plan, profileInput, socketOptions, taskInput, transportFor, uid, waitFor, workstream, type Frame } from "./helpers.ts"

let server: TestServer

beforeAll(async () => {
    server = await startTestServer()
}, 90_000)

afterAll(async () => {
    await server?.stop()
})

function workforce(id = uid("t")) {
    return { id, wf: actors.TeamWorkforce.get(id, transportFor(server)) }
}

type Stub = ReturnType<typeof workforce>["wf"]

async function rawInvoke(actor: string, id: string, method: string, args: unknown[]) {
    const response = await fetch(`${server.url}/v1/projects/local/actors/${actor}/${id}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.secret}` },
        body: JSON.stringify({ requestId: crypto.randomUUID(), method, args })
    })
    return { status: response.status, body: (await response.json()) as { outcome?: { type: string; result?: unknown; code?: string; message?: string }; error?: { code: string } } }
}

/** One planned task per role, or one task with all roles. */
async function plannedTask(wf: Stub, taskId: string, roles: string[], maxAgents = 3) {
    expect(await wf.createTask(taskInput(taskId, { maxAgents }), uid("k"))).toEqual({ ok: true, taskId })
    expect(await wf.recordPlan(taskId, plan(roles.map(role => workstream(`ws-${role}`, role))), uid("k"))).toMatchObject({ ok: true })
}

describe("concurrency", () => {
    test("10-way concurrent reserveWorkers on one profile: exactly one winner", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        const tasks = Array.from({ length: 10 }, (_, i) => `tk-race-${i}`)
        for (const taskId of tasks) await plannedTask(wf, taskId, ["api"])
        const results = await Promise.all(tasks.map(taskId => wf.reserveWorkers(taskId, [{ workstreamId: "ws-api", profileId: "p1" }], uid("race"))))
        const winners = results.filter(result => result.ok)
        expect(winners).toHaveLength(1)
        for (const loser of results.filter(result => !result.ok))
            expect(loser).toMatchObject({ ok: false, reason: "invalid_picks", picks: [{ ok: false, reason: "over_capacity" }] })
        const view = await wf.getView()
        expect(Object.keys(view.leases)).toHaveLength(1)
        expect(view.profiles.p1).toMatchObject({ availability: "busy", activeLeases: 1 })
        expect((await wf.getInternals()).epoch).toBe(1)
    })

    test("10-way race for one workstream across ten free profiles: exactly one lease", async () => {
        const { wf } = workforce()
        for (let i = 0; i < 10; i++) await wf.registerProfile(profileInput(`p${i}`))
        await plannedTask(wf, "tk-1", ["api"])
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: `p${i}` }], uid("race"))))
        expect(results.filter(result => result.ok)).toHaveLength(1)
        for (const loser of results.filter(result => !result.ok)) expect(loser).toMatchObject({ picks: [{ reason: "already_leased" }] })
        expect(Object.values((await wf.getView()).profiles).filter(profile => profile.activeLeases > 0)).toHaveLength(1)
    })

    test("concurrent retries with one key apply once and all return the original result", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        await plannedTask(wf, "tk-1", ["api"])
        const key = uid("same")
        const results = await Promise.all(Array.from({ length: 5 }, () => wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], key)))
        for (const result of results) expect(result).toEqual(results[0]!)
        expect(results[0]).toMatchObject({ ok: true, leases: [{ epoch: 1 }] })
        expect((await wf.getInternals()).epoch).toBe(1)
    })
})

describe("reservation semantics", () => {
    test("all-or-nothing: a bad pick leaves no lease, no epoch, no outbox item", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        await wf.registerProfile(profileInput("p2", { scopes: ["some-other-project"] }))
        await plannedTask(wf, "tk-1", ["api", "web"])
        const before = await wf.getInternals()
        const result = await wf.reserveWorkers(
            "tk-1",
            [
                { workstreamId: "ws-api", profileId: "p1" },
                { workstreamId: "ws-web", profileId: "p2" }
            ],
            uid("k")
        )
        expect(result).toEqual({
            ok: false,
            reason: "invalid_picks",
            picks: [
                { workstreamId: "ws-api", profileId: "p1", ok: true, reason: null },
                { workstreamId: "ws-web", profileId: "p2", ok: false, reason: "out_of_scope" }
            ]
        })
        const after = await wf.getInternals()
        expect(after.epoch).toBe(before.epoch)
        expect(after.outbox).toEqual(before.outbox)
        const view = await wf.getView()
        expect(view.leases).toEqual({})
        expect(view.tasks["tk-1"]!.workstreams.map(ws => ws.status)).toEqual(["pending", "pending"])
    })

    test("a throwing call leaves no trace (validation fails after earlier picks were fine)", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        await plannedTask(wf, "tk-1", ["api", "web"])
        const before = await wf.getInternals()
        const viewBefore = await wf.getView()
        await expectActorError(
            wf.reserveWorkers(
                "tk-1",
                [
                    { workstreamId: "ws-api", profileId: "p1" },
                    { workstreamId: "ws-web", profileId: "bad id!" }
                ],
                uid("k")
            ),
            /invalid_argument: picks\.1\.profileId/
        )
        expect(await wf.getInternals()).toEqual(before)
        expect(await wf.getView()).toEqual(viewBefore)
    })

    test("idempotent retry returns the original result even after state moved on; key reuse with other args throws", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        await wf.registerProfile(profileInput("p2"))
        await plannedTask(wf, "tk-1", ["api"])
        const key = uid("k")
        const first = await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], key)
        expect(first.ok).toBe(true)
        // A fresh attempt now fails, but the retry of the first attempt still gets the original lease.
        expect((await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], uid("k"))).ok).toBe(false)
        expect(await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], key)).toEqual(first)
        const ledger = (await wf.getInternals()).ledgerSize
        await expectActorError(wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p2" }], key), /idempotency_key_reused/)
        expect((await wf.getInternals()).ledgerSize).toBe(ledger)

        const createKey = uid("k")
        const created = await wf.createTask(taskInput("tk-2"), createKey)
        expect(await wf.createTask(taskInput("tk-2"), createKey)).toEqual(created)
        await expectActorError(wf.createTask(taskInput("tk-2", { title: "changed" }), createKey), /idempotency_key_reused/)
    })

    test("deleteTask: cancels a live task, then removes it; idempotent by key, validated", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        await plannedTask(wf, "tk-1", ["api"])
        const reserved = await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], uid("k"))
        if (!reserved.ok) throw new Error("reserve failed")
        const key = uid("k")
        const first = await wf.deleteTask("tk-1", "u-1001", key)
        expect(first).toEqual({ ok: true, releasedLeaseIds: [reserved.leases[0]!.id] })
        expect(await wf.getTask("tk-1")).toBeNull()
        expect((await wf.getView()).tasks).toEqual({})
        // A retry with the same key gets the first answer; a fresh request finds nothing to delete.
        expect(await wf.deleteTask("tk-1", "u-1001", key)).toEqual(first)
        expect(await wf.deleteTask("tk-1", "u-1001", uid("k"))).toEqual({ ok: false, reason: "unknown_task" })
        await expectActorError(wf.deleteTask("tk-1", "u-1002", key), /idempotency_key_reused/)
        await expectActorError(wf.deleteTask("../tk", "u-1001", uid("k")), /invalid_argument: taskId/)
    })

    test("retryTask: failed -> verifying over RPC, idempotent by key, validated, refused when not failed", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        await plannedTask(wf, "tk-1", ["api"])
        expect(await wf.retryTask("tk-1", "u-1001", uid("k"))).toEqual({ ok: false, reason: "task_not_failed" })
        await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], uid("k"))
        expect(await wf.completeWorkstream("ls-1", 1, "abcdef0", "done", uid("e"))).toEqual({ ok: true })
        const failed = { status: "failed" as const, checks: [{ name: "Tests pass", status: "failed" as const, detail: "exited 1", url: null }] }
        expect(await wf.submitVerification("tk-1", failed, uid("k"))).toEqual({ ok: true, status: "failed" })

        const key = uid("k")
        const first = await wf.retryTask("tk-1", "u-1001", key)
        expect(first).toEqual({ ok: true, mode: "verify", reopenedWorkstreamIds: [] })
        // A replay of the same request is answered from the ledger; a second retry is refused.
        expect(await wf.retryTask("tk-1", "u-1001", key)).toEqual(first)
        expect(await wf.retryTask("tk-1", "u-1001", uid("k"))).toEqual({ ok: false, reason: "task_not_failed" })
        await expectActorError(wf.retryTask("tk-1", "u-other", key), /idempotency_key_reused/)
        await expectActorError(wf.retryTask("tk 1", "u-1001", uid("k")), /invalid_argument: taskId/)
        await expectActorError(wf.retryTask("tk-1", "", uid("k")), /invalid_argument: byUserId/)

        const view = await wf.getView()
        expect(view.tasks["tk-1"]).toMatchObject({ status: "verifying" })
        expect((await wf.getTask("tk-1"))!.verification).toBeNull()
        expect(view.tasks["tk-1"]!.trace.at(-1)).toMatchObject({ kind: "task.retried" })
        expect(WorkforceView.safeParse(view).success).toBe(true)
        expect(await wf.submitVerification("tk-1", { status: "passed", checks: [] }, uid("k"))).toEqual({ ok: true, status: "completed" })
    })
})

describe("fencing", () => {
    async function runningLease(wf: Stub) {
        await wf.registerProfile(profileInput("p1"))
        await wf.registerProfile(profileInput("p2"))
        await plannedTask(wf, "tk-1", ["api"])
        const reserved = await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], uid("k"))
        if (!reserved.ok) throw new Error("reserve failed")
        const lease = reserved.leases[0]!
        expect(await wf.recordSpawnStatus(lease.id, lease.epoch, "running", "inv-1", uid("e"))).toEqual({ ok: true })
        return lease
    }

    test("stale epochs are rejected for checkpoint, complete and ack", async () => {
        const { wf } = workforce()
        const lease = await runningLease(wf)
        expect(await wf.reportCheckpoint(lease.id, lease.epoch + 1, "abc1234", "x", uid("e"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(await wf.completeWorkstream(lease.id, lease.epoch + 1, "abc1234", "x", uid("e"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(await wf.ackHandoff(lease.id, lease.epoch + 1, uid("e"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(await wf.reportCheckpoint("ls-999", 999, "abc1234", "x", uid("e"))).toEqual({ ok: false, reason: "unknown_lease" })

        // Limit + handoff: the old worker reappears with its old epoch and is fenced out.
        await wf.markProfileLimited("p1", Date.now() + 60_000, "usage limit", "detected", uid("e"))
        const handoff = await wf.requestHandoff("tk-1", "ws-api", lease.epoch, "p2", uid("k"))
        if (!handoff.ok) throw new Error(`handoff failed: ${handoff.reason}`)
        const fresh = handoff.lease
        expect(fresh.epoch).toBeGreaterThan(lease.epoch)
        expect(await wf.reportCheckpoint(lease.id, lease.epoch, "abc1234", "late", uid("e"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(await wf.completeWorkstream(lease.id, lease.epoch, "abc1234", "late", uid("e"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(await wf.ackHandoff(lease.id, lease.epoch, uid("e"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(await wf.completeWorkstream(fresh.id, fresh.epoch, "abc1234", "early", uid("e"))).toEqual({ ok: false, reason: "handoff_not_acked" })
        expect(await wf.ackHandoff(fresh.id, fresh.epoch, uid("e"))).toEqual({ ok: true })
        expect(await wf.completeWorkstream(fresh.id, fresh.epoch, "abc1234", "done", uid("e"))).toEqual({ ok: true })
        const task = await wf.getTask("tk-1")
        expect(task?.status).toBe("verifying")
        expect(task?.workstreams[0]?.lastCheckpoint).toMatchObject({ sha: "abc1234", epoch: fresh.epoch })
    })

    test("duplicate event ids return the original result", async () => {
        const { wf } = workforce()
        const lease = await runningLease(wf)
        const eventId = uid("e")
        expect(await wf.reportCheckpoint(lease.id, lease.epoch, "abc1234", "first", eventId)).toEqual({ ok: true })
        const traceLength = (await wf.getTask("tk-1"))!.trace.length
        expect(await wf.reportCheckpoint(lease.id, lease.epoch, "def5678", "replayed", eventId)).toEqual({ ok: true })
        const task = (await wf.getTask("tk-1"))!
        expect(task.trace.length).toBe(traceLength)
        expect(task.workstreams[0]!.lastCheckpoint!.sha).toBe("abc1234")
    })
})

describe("limits, cooldown and the alarm", () => {
    test("markProfileLimited: only that profile, workstreams to handoff, source labelled, duplicate event ignored", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        // Same environment and node as p1, different CLI account.
        await wf.registerProfile(profileInput("p1-codex", { envId: "env-p1", nodeName: "n-p1", cli: "codex" }))
        await plannedTask(wf, "tk-1", ["api", "web"])
        const reserved = await wf.reserveWorkers(
            "tk-1",
            [
                { workstreamId: "ws-api", profileId: "p1" },
                { workstreamId: "ws-web", profileId: "p1-codex" }
            ],
            uid("k")
        )
        expect(reserved.ok).toBe(true)
        const until = Date.now() + 60_000
        const eventId = uid("limit")
        const first = await wf.markProfileLimited("p1", until, "Claude usage limit reached", "detected", eventId)
        expect(first).toEqual({ ok: true, cooldownUntil: until, expiredLeaseIds: ["ls-1"] })
        const viewAfterFirst = await wf.getView()
        // Same event id again, even with a later deadline, is a no-op returning the original result.
        expect(await wf.markProfileLimited("p1", until + 999_000, "dup", "detected", eventId)).toEqual(first)
        expect(await wf.getView()).toEqual(viewAfterFirst)

        const view = viewAfterFirst
        expect(view.profiles.p1).toMatchObject({ availability: "limited", cooldownUntil: until, limitedSource: "detected", activeLeases: 0 })
        expect(view.profiles["p1-codex"]).toMatchObject({ availability: "busy", cooldownUntil: null, activeLeases: 1 })
        expect(view.leases["ls-1"]!.state).toBe("expired")
        expect(view.leases["ls-2"]!.state).toBe("reserved")
        const task = view.tasks["tk-1"]!
        expect(task.status).toBe("handoff")
        expect(task.workstreams.map(ws => ws.status)).toEqual(["handoff", "active"])
        expect(task.trace.filter(entry => entry.kind === "worker.quota_limited")).toHaveLength(1)
        expect(task.trace.at(-1)!.message).toContain("[detected]")
        expect((await wf.getInternals()).alarmAt).toBe(until)
    })

    test("reconcile restores a cooldown only after its deadline (injected now) and re-arms for the next one", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        await wf.registerProfile(profileInput("p2"))
        const now = Date.now()
        await wf.markProfileLimited("p1", now + 60_000, "limit", "detected", uid("e"))
        await wf.markProfileLimited("p2", now + 120_000, "limit", "detected", uid("e"))
        expect((await wf.getInternals()).alarmAt).toBe(now + 60_000)

        const viewBefore = await wf.getView()
        expect(await wf.reconcile(now + 59_999)).toEqual({ restoredProfileIds: [], expiredLeaseIds: [], nextAlarmAt: now + 60_000 })
        expect(await wf.getView()).toEqual(viewBefore)

        expect(await wf.reconcile(now + 60_000)).toEqual({ restoredProfileIds: ["p1"], expiredLeaseIds: [], nextAlarmAt: now + 120_000 })
        expect((await wf.getInternals()).alarmAt).toBe(now + 120_000)
        const view = await wf.getView()
        expect(view.profiles.p1).toMatchObject({ availability: "ready", cooldownUntil: null, limitedReason: null, limitedSource: null })
        expect(view.profiles.p2!.availability).toBe("limited")
        // Idempotent: nothing more is due.
        expect(await wf.reconcile(now + 60_001)).toEqual({ restoredProfileIds: [], expiredLeaseIds: [], nextAlarmAt: now + 120_000 })

        expect((await wf.reconcile(now + 120_000)).restoredProfileIds).toEqual(["p2"])
        expect((await wf.getInternals()).alarmAt).toBeNull()
        await expectActorError(wf.reconcile(Date.now() + 11 * 60_000), /invalid_argument: now/)
    })

    test("the alarm itself restores capacity on time; a spurious onAlarm changes nothing and keeps the alarm", async () => {
        const { id, wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        await wf.registerProfile(profileInput("p2"))
        const later = Date.now() + 10 * 60_000
        await wf.markProfileLimited("p2", later, "limit", "detected", uid("e"))
        const viewBefore = await wf.getView()
        const spurious = await rawInvoke("TeamWorkforce", id, "onAlarm", [])
        expect(spurious.body.outcome?.type).toBe("completed")
        expect(await wf.getView()).toEqual(viewBefore)
        expect((await wf.getInternals()).alarmAt).toBe(later)

        await wf.markProfileLimited("p1", Date.now() + 1_500, "limit", "detected", uid("e"))
        const view = await waitFor(
            () => wf.getView(),
            v => v.profiles.p1?.availability === "ready",
            10_000
        )
        expect(view.profiles.p2!.availability).toBe("limited")
        expect((await wf.getInternals()).alarmAt).toBe(later)
    }, 20_000)
})

describe("outbox", () => {
    test("claim hides a spawn for its 6 min visibility timeout; a crashed dispatcher's item comes back; completion is idempotent", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        await plannedTask(wf, "tk-1", ["api"])
        await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], uid("k"))
        const now = Date.now()
        const claims = await wf.claimOutbox(now, 10)
        expect(claims).toHaveLength(1)
        const claim = claims[0]!
        expect(claim).toMatchObject({ kind: "spawn", leaseId: "ls-1", attempts: 1 })
        if (claim.kind !== "spawn") throw new Error("expected spawn")
        expect(claim.payload).toMatchObject({ agentName: "w-tk1-api-e1", nodeName: "n-p1", cli: "claude", handoff: false })
        expect(await wf.claimOutbox(now + 6 * 60_000 - 1, 10)).toEqual([])
        const reclaimed = await wf.claimOutbox(now + 6 * 60_000, 10)
        expect(reclaimed.map(item => [item.id, item.attempts])).toEqual([[claim.id, 2]])

        const key = uid("done")
        const done = await wf.completeOutbox(claim.id, { ok: true, invocationId: "inv-42", sha: null, detail: null }, key)
        expect(done).toEqual({ ok: true, state: "done" })
        expect(await wf.completeOutbox(claim.id, { ok: true, invocationId: "inv-42", sha: null, detail: null }, key)).toEqual(done)
        expect(await wf.completeOutbox(claim.id, { ok: false, error: "late duplicate", retryable: true }, uid("k"))).toEqual({ ok: true, state: "done" })
        expect(await wf.getLease("ls-1")).toMatchObject({ state: "spawning", spawnInvocationId: "inv-42" })
        expect(await wf.completeOutbox("ob-nope", { ok: true, invocationId: null, sha: null, detail: null }, uid("k"))).toEqual({ ok: false, reason: "unknown_item" })
    })
})

describe("validation", () => {
    test("bad ids, oversized strings and wrong types are rejected before any write", async () => {
        const { id, wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        const before = await wf.getInternals()
        const anyWf = wf as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
        const cases: [string, unknown[], RegExp][] = [
            ["createTask", [taskInput("bad id!"), "k1"], /input\.id: invalid id/],
            ["createTask", [taskInput("x".repeat(129)), "k1"], /input\.id/],
            ["createTask", [taskInput("__proto__"), "k1"], /input\.id: reserved id/],
            ["createTask", [taskInput("tk-1", { prompt: "x".repeat(8001) }), "k1"], /input\.prompt/],
            ["createTask", [taskInput("tk-1", { title: "" }), "k1"], /input\.title/],
            ["createTask", [taskInput("tk-1", { maxAgents: 6 }), "k1"], /input\.maxAgents/],
            ["createTask", [{ ...taskInput("tk-1"), extra: true }, "k1"], /input/],
            ["createTask", [taskInput("tk-1"), 42], /key/],
            ["createTask", [taskInput("tk-1")], /key/],
            ["registerProfile", [{ ...profileInput("p2"), maxConcurrent: "1" }], /input\.maxConcurrent/],
            ["registerProfile", [{ ...profileInput("p2"), cli: "gpt" }], /input\.cli/],
            ["registerProfile", [{ ...profileInput("p2"), nodeName: "Bad Node" }], /input\.nodeName/],
            ["registerProfile", [{ ...profileInput("p2"), label: "x".repeat(49) }], /input\.label/],
            ["reserveWorkers", ["tk-1", [], "k1"], /picks/],
            ["reserveWorkers", ["tk-1", "p1", "k1"], /picks/],
            ["reportCheckpoint", ["ls-1", 1, "not-a-sha", "s", "e1"], /sha/],
            ["reportCheckpoint", ["ls-1", 0, "abc1234", "s", "e1"], /epoch/],
            ["reportCheckpoint", ["ls-1", 1.5, "abc1234", "s", "e1"], /epoch/],
            ["reportCheckpoint", ["ls-1", 1, "abc1234", "x".repeat(2001), "e1"], /summary/],
            ["markProfileLimited", ["p1", -1, "r", "detected", "e1"], /until/],
            ["markProfileLimited", ["p1", Date.now() + 8 * 24 * 3600_000, "r", "detected", "e1"], /until/],
            ["markProfileLimited", ["p1", Date.now(), "r", "guessed", "e1"], /source/],
            ["markProfileLimited", ["p1", Date.now(), "r", "simulated", "e1"], /source/],
            ["markProfileLimited", ["p1", Date.now(), "", "detected", "e1"], /reason/],
            ["recordSpawnStatus", ["ls-1", 1, "zombie", null, "e1"], /status/],
            ["claimOutbox", [Date.now(), 0], /limit/],
            ["claimOutbox", [Date.now(), 51], /limit/],
            ["claimOutbox", ["now", 1], /now/],
            ["completeOutbox", ["ob-1", { ok: true }, "k"], /result/],
            ["submitVerification", ["tk-1", { status: "skipped", checks: [] }, "k"], /evidence\.status/],
            ["updateProfileHealth", ["p1", { auth: "ok", online: "yes", observedAt: 1 }, "e1"], /health\.online/],
            ["recordPlan", ["tk-1", plan([workstream("a", "api"), workstream("b", "web", { dependsOn: ["a"] }), workstream("c", "x", { dependsOn: ["c"] })]), "k"], /plan\.workstreams/]
        ]
        for (const [method, args, message] of cases) await expectActorError(anyWf[method]!(...args), message)
        expect(await wf.getInternals()).toEqual(before)

        // Raw HTTP, bypassing the typed client entirely.
        const raw = await rawInvoke("TeamWorkforce", id, "reserveWorkers", [{ evil: true }, "not-an-array", null])
        expect(raw.body.outcome).toMatchObject({ type: "failed", code: "actor_error" })
        expect(raw.body.outcome?.message).toMatch(/^invalid_argument: taskId/)
        // Private helpers are not RPC methods.
        for (const method of ["run", "transition", "refreshView"]) {
            const probe = await rawInvoke("TeamWorkforce", id, method, [])
            expect(probe.body.outcome?.message ?? "").toMatch(/was not found/)
        }
    })
})

describe("worker update watermark", () => {
    test("is durable, moves forward only and validates its input", async () => {
        const { wf } = workforce()
        await plannedTask(wf, "tk-mark", ["api"])
        expect(await wf.getNotified()).toEqual({})
        const task = (await wf.getTask("tk-mark"))!
        const total = task.traceTotal ?? task.trace.length
        expect(await wf.markNotified("tk-mark", total)).toEqual({ ok: true, through: total })
        expect(await wf.markNotified("tk-mark", 0)).toEqual({ ok: true, through: total })
        expect(await wf.markNotified("tk-mark", total + 100)).toEqual({ ok: true, through: total })
        expect(await wf.markNotified("tk-none", 1)).toEqual({ ok: false, reason: "unknown_task" })
        expect(await wf.getNotified()).toEqual({ "tk-mark": total })
        const anyWf = wf as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
        await expectActorError(anyWf.markNotified!("tk-mark", -1), /through/)
        await expectActorError(anyWf.markNotified!("tk-mark", 1.5), /through/)
        await expectActorError(anyWf.markNotified!("bad id!", 1), /taskId/)
        expect(await wf.getNotified()).toEqual({ "tk-mark": total })
    })
})

describe("ledger", () => {
    test("is pruned to the last 500 entries; older keys are forgotten, recent ones still dedupe", async () => {
        const { wf } = workforce()
        await wf.registerProfile(profileInput("p1"))
        const firstKey = uid("first")
        expect(await wf.createTask(taskInput("tk-1"), firstKey)).toEqual({ ok: true, taskId: "tk-1" })
        const base = Date.now()
        const events = Array.from({ length: 505 }, (_, i) => ({ id: `ev-${i}`, observedAt: base + i }))
        // Calls inside a batch race, so ordering (and "applied") is not fixed. Keep each first result.
        const firstResults = new Map<string, Awaited<ReturnType<typeof wf.updateProfileHealth>>>()
        for (let i = 0; i < events.length; i += 25)
            await Promise.all(events.slice(i, i + 25).map(async event => {
                firstResults.set(event.id, await wf.updateProfileHealth("p1", { auth: "ok", online: true, observedAt: event.observedAt }, event.id))
            }))
        expect((await wf.getInternals()).ledgerSize).toBe(500)
        // ev-300 is still remembered: its first stored result comes back unchanged.
        expect(await wf.updateProfileHealth("p1", { auth: "ok", online: true, observedAt: base + 300 }, "ev-300")).toEqual(firstResults.get("ev-300")!)
        // The task's create key fell out of the ledger, so a retry is evaluated afresh.
        expect(await wf.createTask(taskInput("tk-1"), firstKey)).toEqual({ ok: false, reason: "task_exists" })
        expect((await wf.getInternals()).ledgerSize).toBe(500)
    }, 60_000)
})

describe("emitted view and sockets", () => {
    test("socket gets a state snapshot and updates that match WorkforceView after a full flow", async () => {
        const { id, wf } = workforce()
        const grant = await actors.TeamWorkforce.prepareWebsocket({ actorId: id, metadata: { userId: "system.backend" } }, socketOptions(server))
        const socket = await openSocket(grant.websocketUrl)
        try {
            await waitFor(
                () => socket.frames.length,
                n => n > 0
            )
            const first = socket.frames[0]!
            expect(first.type).toBe("state")
            expect(Object.keys((first as Frame & { state: object }).state).sort()).toEqual(["leasesView", "outboxSummary", "profilesView", "tasksView"])

            await wf.registerProfile(profileInput("p1"))
            await wf.registerProfile(profileInput("p2", { cli: "codex", maxConcurrent: 2 }))
            await wf.registerProfile(profileInput("p3"))
            await wf.updateProfileHealth("p1", { auth: "ok", online: true, observedAt: Date.now() }, uid("e"))
            await plannedTask(wf, "tk-1", ["api", "web"])
            await wf.createTask(taskInput("tk-2", { title: "Docs" }), uid("k"))
            const reserved = await wf.reserveWorkers(
                "tk-1",
                [
                    { workstreamId: "ws-api", profileId: "p1" },
                    { workstreamId: "ws-web", profileId: "p2" }
                ],
                uid("k")
            )
            if (!reserved.ok) throw new Error("reserve failed")
            const [api, web] = reserved.leases as [(typeof reserved.leases)[number], (typeof reserved.leases)[number]]
            for (const claim of await wf.claimOutbox(Date.now(), 10))
                await wf.completeOutbox(claim.id, { ok: true, invocationId: `inv-${claim.leaseId}`, sha: null, detail: null }, uid("k"))
            await wf.recordSpawnStatus(api.id, api.epoch, "running", null, uid("e"))
            await wf.recordSpawnStatus(web.id, web.epoch, "running", null, uid("e"))
            await wf.reportCheckpoint(api.id, api.epoch, "a1b2c3d", "models done", uid("e"))
            await wf.markProfileLimited("p1", Date.now() + 30 * 60_000, "usage limit", "detected", uid("e"))
            const handoff = await wf.requestHandoff("tk-1", "ws-api", api.epoch, "p3", uid("k"))
            if (!handoff.ok) throw new Error("handoff failed")
            await wf.ackHandoff(handoff.lease.id, handoff.lease.epoch, uid("e"))
            await wf.completeWorkstream(handoff.lease.id, handoff.lease.epoch, "d4e5f6a", "api done", uid("e"))
            await wf.completeWorkstream(web.id, web.epoch, "0a1b2c3", "web done", uid("e"))
            await wf.submitVerification("tk-1", { status: "passed", checks: [{ name: "bun test", status: "passed", detail: "42 pass", url: "https://ci.example/run/1" }] }, uid("k"))
            await wf.cancelTask("tk-2", "u-1001", uid("k"))

            const finalView = await wf.getView()
            expect(WorkforceView.parse(finalView)).toEqual(finalView)
            expect(finalView.tasks["tk-1"]!.status).toBe("completed")
            expect(finalView.tasks["tk-2"]!.status).toBe("cancelled")
            // The whole trace is on getTask; the view carries its newest entries and the count.
            const full = (await wf.getTask("tk-1"))!
            const kinds = full.trace.map(entry => entry.kind)
            for (const kind of ["task.created", "task.planned", "worker.reserved", "worker.ready", "task.checkpointed", "worker.quota_limited", "task.handoff_requested", "task.handoff_acked", "task.verified"] as const)
                expect(kinds).toContain(kind)
            const shown = finalView.tasks["tk-1"]!
            expect(full.trace.length).toBeGreaterThan(shown.trace.length)
            expect(shown.trace).toEqual(full.trace.slice(-shown.trace.length))
            expect(shown.traceTotal).toBe(full.trace.length)
            expect(shown.workstreams[0]).not.toHaveProperty("brief")
            expect(full.workstreams[0]!.brief.length).toBeGreaterThan(0)

            // The snapshot plus every state_update, put back together the way the backend does, is exactly the actor's view.
            const composed = () => {
                const state: Record<string, unknown> = { ...(first as Frame & { state: Record<string, unknown> }).state }
                for (const frame of socket.frames) if (frame.type === "state_update") Object.assign(state, (frame as Frame & { changes: Record<string, unknown> }).changes)
                return { profiles: state.profilesView, tasks: state.tasksView, leases: state.leasesView }
            }
            const latest = await waitFor(composed, view => Bun.deepEquals(view, finalView))
            expect(WorkforceView.parse(latest)).toEqual(finalView)
            const json = JSON.stringify(socket.frames)
            // outboxSummary carries a count and a time; the outbox itself never leaves the actor.
            for (const internal of ["processed", '"outbox"', "planningHold", "spawnInvocationId", "inv-ls-"]) expect(json).not.toContain(internal)
        } finally {
            socket.ws.close()
        }
    })

    test("onConnect rejects every socket but the backend's with 4003", async () => {
        const { id } = workforce()
        for (const metadata of [{}, { userId: "" }, { userId: "has space" }, { userId: "u-1" }]) {
            const grant = await actors.TeamWorkforce.prepareWebsocket({ actorId: id, metadata: metadata as { userId: string } }, socketOptions(server))
            const socket = await openSocket(grant.websocketUrl)
            const closed = await socket.closed
            expect(closed.code).toBe(4003)
            expect(socket.frames.filter(frame => frame.type === "state")).toHaveLength(0)
        }
    })

    test("the keepalive ping gets the gateway's pong", async () => {
        const { id } = workforce()
        const grant = await actors.TeamWorkforce.prepareWebsocket({ actorId: id, metadata: { userId: "system.backend" } }, socketOptions(server))
        const socket = await openSocket(grant.websocketUrl)
        try {
            await waitFor(() => socket.frames.some(frame => frame.type === "state"), Boolean)
            socket.ws.send('{"type":"ping"}')
            // Answered by the gateway with exactly the configured text: the actor has no onMessage to fall back on.
            const pong = await waitFor(() => socket.frames.find(frame => frame.type === "pong"), Boolean)
            expect(pong).toEqual({ type: "pong" })
        } finally {
            socket.ws.close()
        }
    })
})
