// Schema 1 to schema 2 on a real dev server: data written with the old layout (every record in @Persisted fields,
// one emitted `view`) by test/fixtures/workforce-v1.ts, then the real entrypoint started on the same data. The
// upgrade runs before any method logic, keeps every record, the ledger and the watermarks, emits the view in parts,
// and survives another restart.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fingerprint, type Ledger } from "../src/lib/ledger.ts"
import { summarizeOutbox } from "../src/lib/outbox-summary.ts"
import * as wf from "../src/lib/workforce.ts"
import { startTestServer, type TestServer } from "../scripts/test-server.ts"
import type { V1Fields } from "./fixtures/workforce-v1.ts"
import { actors, openSocket, plan, profileInput, socketOptions, taskInput, transportFor, uid, waitFor, workstream } from "./helpers.ts"

const dataDir = mkdtempSync(join(tmpdir(), "morrow-upgrade-"))
const servers: TestServer[] = []

afterAll(async () => {
    for (const server of servers) await server.stop({ keepData: true }).catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
})

/** A team mid-task, built by the state machine: profiles, a planned task, one spawn claimed and one completed. */
function v1State(now: number): { fields: V1Fields; createKey: string; createArgs: unknown } {
    let state: wf.WorkforceState = { profiles: {}, tasks: {}, leases: {}, outbox: {}, epoch: 0 }
    const step = <R>(run: (d: wf.WorkforceDraft) => R): R => {
        const d = new wf.WorkforceDraft(state, now)
        const result = run(d)
        wf.finalize(d)
        state = { profiles: d.profiles, tasks: d.tasks, leases: d.leases, outbox: d.outbox, epoch: d.epoch }
        return result
    }
    for (const id of ["p1", "p2"]) step(d => wf.registerProfile(d, profileInput(id, { maxConcurrent: 2 })))
    const createArgs = taskInput("tk-1")
    const created = step(d => wf.createTask(d, createArgs))
    step(d => wf.recordPlan(d, "tk-1", plan([workstream("ws-api", "api"), workstream("ws-web", "web")])))
    const reserved = step(d => wf.reserveWorkers(d, "tk-1", [{ workstreamId: "ws-api", profileId: "p1" }, { workstreamId: "ws-web", profileId: "p2" }]))
    if (!reserved.ok) throw new Error(JSON.stringify(reserved))
    const claims = step(d => wf.claimOutbox(d, 10))
    step(d => wf.completeOutbox(d, claims[0]!.id, { ok: true, invocationId: "inv-1", sha: null, detail: null }))
    const createKey = "createTask:k-create"
    const processed: Ledger = [{ key: createKey, fp: fingerprint(createArgs), result: created }]
    return {
        fields: { view: wf.buildWorkforceView(state), ...state, processed, notified: { "tk-1": 1 } },
        createKey: "k-create",
        createArgs
    }
}

test("an actor written with schema 1 upgrades on first use and keeps everything", async () => {
    const teamId = uid("t")
    const { fields, createKey, createArgs } = v1State(Date.now())

    const old = await startTestServer({ dataDir, entrypoint: "test/fixtures/workforce-v1.ts" })
    servers.push(old)
    const seeded = await fetch(`${old.url}/v1/projects/local/actors/TeamWorkforce/${teamId}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${old.secret}` },
        body: JSON.stringify({ requestId: crypto.randomUUID(), method: "seed", args: [fields] })
    })
    expect(((await seeded.json()) as { outcome: { type: string } }).outcome.type).toBe("completed")
    await old.stop({ keepData: true })
    servers.pop()

    const server = await startTestServer({ dataDir })
    servers.push(server)

    // First contact is a socket: the snapshot must already carry the upgraded parts, never an empty view.
    const grant = await actors.TeamWorkforce.prepareWebsocket({ actorId: teamId, metadata: { userId: "system.backend" } }, socketOptions(server))
    const socket = await openSocket(grant.websocketUrl)
    const first = await waitFor(() => socket.frames, frames => frames.some(f => f.type === "state"))
    const snapshot = first.find(f => f.type === "state")!.state as Record<string, unknown>
    expect(Object.keys(snapshot).sort()).toEqual(["leasesView", "outboxSummary", "profilesView", "tasksView"])
    expect(snapshot.profilesView).toEqual(fields.view.profiles)
    expect(snapshot.tasksView).toEqual(fields.view.tasks)
    expect(snapshot.leasesView).toEqual(fields.view.leases)
    expect(snapshot.outboxSummary).toEqual(summarizeOutbox(fields.outbox))
    socket.ws.close()

    const stub = actors.TeamWorkforce.get(teamId, transportFor(server))
    const check = async () => {
        expect(await stub.getView()).toEqual(fields.view)
        expect(await stub.getTask("tk-1")).toEqual(wf.taskRecord(fields.tasks["tk-1"]!))
        for (const lease of Object.values(fields.leases)) expect(await stub.getLease(lease.id)).toEqual(lease)
        expect(await stub.getProfile("p1")).toEqual(fields.profiles.p1!)
        expect(await stub.getNotified()).toEqual(fields.notified)
        const internals = await stub.getInternals()
        expect(internals.epoch).toBe(fields.epoch)
        expect(internals.ledgerSize).toBe(1)
        expect(internals.outbox).toEqual(Object.values(fields.outbox).sort((a, b) => a.seq - b.seq))
        // The ledger moved too: the same key replays, a different input under it is refused.
        expect(await stub.createTask(createArgs as never, createKey)).toEqual({ ok: true, taskId: "tk-1" })
    }
    await check()

    // And it keeps working from SQLite, across a restart.
    await server.restart()
    await check()
    const claims = await stub.claimOutbox(Date.now() + wf.WORKFORCE_TIMING.visibilityTimeoutMs.spawn + 1, 10)
    expect(claims.length).toBeGreaterThan(0)
    for (const claim of claims) expect((await stub.completeOutbox(claim.id, { ok: true, invocationId: `inv-${claim.id}`, sha: null, detail: null }, uid("k"))).ok).toBe(true)
}, 300_000)
