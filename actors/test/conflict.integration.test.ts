// Merge-conflict resolution on a real `durable-actors dev`: concurrent and replayed conflict reports, a race for the
// resolver's lease, argument validation, and a server restart in the middle of a resolution.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { WorkforceView } from "../../packages/contracts/src/domain.ts"
import { startTestServer, type TestServer } from "../scripts/test-server.ts"
import type { ConflictInput, VerificationView } from "../src/lib/types.ts"
import { actors, expectActorError, plan, profileInput, taskInput, transportFor, uid, workstream } from "./helpers.ts"

let server: TestServer

beforeAll(async () => {
    server = await startTestServer()
}, 90_000)

afterAll(async () => {
    await server?.stop()
})

const INTEGRATION = "morrow/tk1/integration"
const evidence: VerificationView = { status: "failed", checks: [{ name: "Merges cleanly", status: "failed", detail: "morrow/ws-web/web conflicts", url: null }] }
const conflict: ConflictInput = {
    branch: "morrow/ws-web/web",
    workstreamId: "ws-web",
    integrationBranch: INTEGRATION,
    involvedWorkstreamIds: ["ws-web", "ws-api"],
    files: ["src/shared.ts"],
    brief: "Merge it."
}

/** A team whose task has both workstreams done (api by p1, web by p2): verifying. */
async function verifying() {
    const teamId = uid("t")
    const wf = actors.TeamWorkforce.get(teamId, transportFor(server))
    for (const id of ["p1", "p2", "p3", "p4"]) await wf.registerProfile(profileInput(id))
    await wf.createTask(taskInput("tk-1"), uid("k"))
    await wf.recordPlan("tk-1", plan([workstream("ws-api", "api"), workstream("ws-web", "web")]), uid("k"))
    await wf.reserveWorkers(
        "tk-1",
        [
            { workstreamId: "ws-api", profileId: "p1" },
            { workstreamId: "ws-web", profileId: "p2" }
        ],
        uid("k")
    )
    expect(await wf.completeWorkstream("ls-1", 1, "aaaaaaa", "api", uid("e"))).toEqual({ ok: true })
    expect(await wf.completeWorkstream("ls-2", 2, "bbbbbbb", "web", uid("e"))).toEqual({ ok: true })
    expect((await wf.getTask("tk-1"))!.status).toBe("verifying")
    return { teamId, wf }
}

test("concurrent conflict reports open exactly one resolution; a replayed key returns the same answer", async () => {
    const { wf } = await verifying()
    const keys = Array.from({ length: 6 }, () => uid("rc"))
    const results = await Promise.all(keys.map(key => wf.resolveConflict("tk-1", evidence, conflict, key)))
    expect(results.filter(r => r.ok)).toEqual([{ ok: true, status: "resolving", attempt: 1 }])
    expect(results.filter(r => !r.ok)).toHaveLength(5)
    for (const r of results.filter(r => !r.ok)) expect(r).toEqual({ ok: false, reason: "task_not_verifying" })
    const winner = keys[results.findIndex(r => r.ok)]!
    expect(await wf.resolveConflict("tk-1", evidence, conflict, winner)).toEqual({ ok: true, status: "resolving", attempt: 1 })
    // A key reused for different arguments is a bug, not a replay.
    await expectActorError(wf.resolveConflict("tk-1", evidence, { ...conflict, files: [] }, winner), /idempotency_key_reused/)
    const task = (await wf.getTask("tk-1"))!
    expect(task.workstreams.filter(ws => ws.role === "resolver")).toHaveLength(1)
    expect(task.resolutionAttempts).toBe(1)
    const view = await wf.getView()
    expect(WorkforceView.parse(view)).toEqual(view)
    expect(view.tasks["tk-1"]!.status).toBe("resolving")
})

test("four profiles race for the resolver: one lease", async () => {
    const { wf } = await verifying()
    await wf.resolveConflict("tk-1", evidence, conflict, uid("rc"))
    const results = await Promise.all(
        ["p1", "p2", "p3", "p4"].map(profileId => wf.reserveWorkers("tk-1", [{ workstreamId: "ws-resolver", profileId }], uid("race")))
    )
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const view = await wf.getView()
    expect(Object.values(view.leases).filter(l => l.workstreamId === "ws-resolver" && ["reserved", "spawning", "running"].includes(l.state))).toHaveLength(1)
})

test("bad conflict input is rejected before touching state", async () => {
    const { wf } = await verifying()
    await expectActorError(wf.resolveConflict("tk-1", evidence, { ...conflict, integrationBranch: "../evil" }, uid("rc")), /invalid_argument|invalid branch/)
    await expectActorError(wf.resolveConflict("tk-1", evidence, { ...conflict, files: ["a\u0000b"] }, uid("rc")), /invalid_argument|control/)
    await expectActorError(wf.resolveConflict("tk-1", evidence, { ...conflict, brief: "" }, uid("rc")), /invalid_argument|brief/)
    await expectActorError(wf.resolveConflict("tk-1", evidence, { ...conflict, extra: 1 } as ConflictInput, uid("rc")), /invalid_argument|unrecognized/i)
    expect((await wf.getTask("tk-1"))!.status).toBe("verifying")
})

test("a restart mid-resolution keeps the step, the lease and its fencing; the resolver finishes after it", async () => {
    const { teamId, wf: before } = await verifying()
    await before.resolveConflict("tk-1", evidence, conflict, uid("rc"))
    const reserved = await before.reserveWorkers("tk-1", [{ workstreamId: "ws-resolver", profileId: "p2" }], uid("k"))
    expect(reserved).toMatchObject({ ok: true, leases: [{ id: "ls-3", epoch: 3 }] })
    expect(await before.recordSpawnStatus("ls-3", 3, "running", "inv-3", uid("e"))).toEqual({ ok: true })
    const snapshot = await before.getView()

    await server.restart()
    const wf = actors.TeamWorkforce.get(teamId, transportFor(server))
    expect(await wf.getView()).toEqual(snapshot)
    expect(await wf.reconcile(Date.now())).toMatchObject({ expiredLeaseIds: [] })
    // Still exactly one resolver, still resolving; a duplicate reservation after the restart is refused.
    expect(await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-resolver", profileId: "p3" }], uid("k"))).toMatchObject({
        ok: false,
        picks: [{ reason: "already_leased" }]
    })
    expect(await wf.completeWorkstream("ls-3", 2, "ccccccc", "stale", uid("e"))).toEqual({ ok: false, reason: "stale_epoch" })
    expect(await wf.completeWorkstream("ls-3", 3, "ccccccc", "merged", uid("e"))).toEqual({ ok: true })
    const task = (await wf.getTask("tk-1"))!
    expect(task.status).toBe("verifying")
    expect(task.trace.map(e => e.kind)).toContain("task.conflict_resolved")
    expect(await wf.submitVerification("tk-1", { status: "passed", checks: [] }, uid("v"))).toEqual({ ok: true, status: "completed" })
}, 60_000)
