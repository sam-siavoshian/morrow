// A real dev-server restart: persisted state survives, pending alarms do not (local dev keeps them in memory),
// and reconcile() restores what the lost alarm would have.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { WorkforceView } from "../../packages/contracts/src/domain.ts"
import { startTestServer, type TestServer } from "../scripts/test-server.ts"
import { actors, plan, profileInput, taskInput, transportFor, uid, workstream } from "./helpers.ts"

let server: TestServer

beforeAll(async () => {
    server = await startTestServer()
}, 90_000)

afterAll(async () => {
    await server?.stop()
})

test("state survives a restart and reconcile restores a cooldown whose alarm was lost", async () => {
    const teamId = uid("t")
    let wf = actors.TeamWorkforce.get(teamId, transportFor(server))
    await wf.registerProfile(profileInput("p1"))
    await wf.registerProfile(profileInput("p2"))
    await wf.registerProfile(profileInput("p3"))
    await wf.createTask(taskInput("tk-1"), uid("k"))
    await wf.recordPlan("tk-1", plan([workstream("ws-api", "api"), workstream("ws-web", "web")]), uid("k"))
    const reserved = await wf.reserveWorkers(
        "tk-1",
        [
            { workstreamId: "ws-api", profileId: "p1" },
            { workstreamId: "ws-web", profileId: "p2" }
        ],
        uid("k")
    )
    expect(reserved.ok).toBe(true)
    const reserveKey = uid("k")
    await wf.createTask(taskInput("tk-2"), reserveKey)

    // Long enough that a restart under load finishes first: the alarm must be lost, not fired.
    const shortDeadline = Date.now() + 12_000
    const longDeadline = Date.now() + 20 * 60_000
    await wf.markProfileLimited("p1", shortDeadline, "limit", "detected", uid("e"))
    await wf.markProfileLimited("p3", longDeadline, "limit", "detected", uid("e"))
    const before = { view: await wf.getView(), internals: await wf.getInternals() }
    expect(before.internals.alarmAt).toBe(shortDeadline)

    await server.restart()
    wf = actors.TeamWorkforce.get(teamId, transportFor(server))

    const after = await wf.getInternals()
    expect(await wf.getView()).toEqual(before.view)
    expect(after.epoch).toBe(before.internals.epoch)
    expect(after.outbox).toEqual(before.internals.outbox)
    expect(after.ledgerSize).toBe(before.internals.ledgerSize)
    expect(after.alarmAt).toBeNull()
    // The idempotency ledger survived too.
    expect(await wf.createTask(taskInput("tk-2"), reserveKey)).toEqual({ ok: true, taskId: "tk-2" })

    // Past the deadline the profile is still limited: nothing fired.
    await Bun.sleep(Math.max(0, shortDeadline - Date.now()) + 1_500)
    expect((await wf.getView()).profiles.p1!.availability).toBe("limited")
    expect((await wf.getInternals()).alarmAt).toBeNull()

    // The next deadline is the earlier of p3's cooldown and ls-2's start timeout (it never reached running).
    const startDeadline = (await wf.getLease("ls-2"))!.expiresAt!
    const nextDeadline = Math.min(startDeadline, longDeadline)
    const reconciled = await wf.reconcile(Date.now())
    expect(reconciled).toEqual({ restoredProfileIds: ["p1"], expiredLeaseIds: [], nextAlarmAt: nextDeadline })
    const view = await wf.getView()
    expect(view.profiles.p1).toMatchObject({ availability: "ready", cooldownUntil: null })
    expect(view.profiles.p3!.availability).toBe("limited")
    expect(WorkforceView.parse(view)).toEqual(view)
    // The lost alarm is re-armed for the remaining deadline.
    expect((await wf.getInternals()).alarmAt).toBe(nextDeadline)
    // Fencing still works on restored leases.
    expect(await wf.reportCheckpoint("ls-2", 1, "abc1234", "stale", uid("e"))).toEqual({ ok: false, reason: "stale_epoch" })
    expect(await wf.reportCheckpoint("ls-2", 2, "abc1234", "current", uid("e"))).toEqual({ ok: true })
}, 60_000)

test("subagents survive a restart: the record, the live child, idempotent retries and the parent cascade", async () => {
    const teamId = uid("t")
    let wf = actors.TeamWorkforce.get(teamId, transportFor(server))
    await wf.registerProfile(profileInput("p1"))
    await wf.registerProfile(profileInput("cx", { envId: "env-p1", nodeName: "n-p1", cli: "codex", maxConcurrent: 2 }))
    await wf.createTask(taskInput("tk-1"), uid("k"))
    await wf.recordPlan("tk-1", plan([workstream("ws-api", "api")]), uid("k"))
    expect((await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], uid("k"))).ok).toBe(true)
    const parent = (await wf.getTask("tk-1"))!.workstreams[0]!.leaseId!
    const input = { parentLeaseId: parent, target: "codex" as const, role: "review" as const, task: "Review the diff.", clientRequestId: "r1" }
    const started = await wf.delegate(input)
    expect(started).toMatchObject({ ok: true, created: true, subagent: { status: "running", cli: "codex" } })
    const childId = started.ok ? started.subagent.leaseId : ""
    // Concurrent retries of the same request make one child.
    const retries = await Promise.all([wf.delegate(input), wf.delegate(input), wf.delegate(input)])
    expect(retries.every(r => r.ok && !r.created && r.subagent.leaseId === childId)).toBe(true)

    await server.restart()
    wf = actors.TeamWorkforce.get(teamId, transportFor(server))
    const view = await wf.getView()
    expect(view.leases[childId]).toMatchObject({ parentLeaseId: parent, state: "reserved" })
    expect(await wf.delegate(input)).toMatchObject({ ok: true, created: false, subagent: { leaseId: childId } })
    expect(() => WorkforceView.parse(view)).not.toThrow()
    expect((await wf.getTask("tk-1"))!.subagents).toHaveLength(1)

    expect(await wf.cancelTask("tk-1", "u-1001", uid("k"))).toMatchObject({ ok: true })
    expect((await wf.getLease(childId))!.state).toBe("released")
    expect((await wf.getTask("tk-1"))!.subagents![0]).toMatchObject({ status: "cancelled" })
}, 90_000)
