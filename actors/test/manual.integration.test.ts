// Manual mode (docs/multi-harness.md, "Manual mode") through the generated client against a real `durable-actors dev`:
// the actor holds every lease of a manual task to its pins, whoever calls it and however. Plus: arguments validated at
// the boundary, pins fixed once started, races, and a task stored before modes existed loading as auto.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskDetail, WorkforceView } from "../../packages/contracts/src/domain.ts"
import * as wf from "../src/lib/workforce.ts"
import type { CreateTaskInput } from "../src/lib/types.ts"
import { startTestServer, type TestServer } from "../scripts/test-server.ts"
import { actors, expectActorError, plan, profileInput, taskInput, transportFor, uid, workstream } from "./helpers.ts"

let server: TestServer

beforeAll(async () => {
    server = await startTestServer()
}, 300_000)

afterAll(async () => {
    await server?.stop()
})

const stub = (teamId = uid("t")) => actors.TeamWorkforce.get(teamId, transportFor(server))
type Stub = ReturnType<typeof stub>

async function planned(wf: Stub, input: Partial<CreateTaskInput>, roles = ["api", "web"]) {
    expect(await wf.createTask(taskInput("tk-1", input), uid("k"))).toEqual({ ok: true, taskId: "tk-1" })
    expect(await wf.recordPlan("tk-1", plan(roles.map(role => workstream(`ws-${role}`, role))), uid("k"))).toMatchObject({ ok: true })
}

async function profiles(wf: Stub, ...ids: string[]) {
    for (const id of ids) expect((await wf.registerProfile(profileInput(id))).ok).toBe(true)
}

describe("manual mode on the runtime", () => {
    test("create keeps the mode and deduplicated pins; the browser's task detail never carries them", async () => {
        const wf = stub()
        await profiles(wf, "p1", "p2")
        await planned(wf, { mode: "manual", pins: ["p2", "p1", "p2"] })
        const task = await wf.getTask("tk-1")
        expect(task).toMatchObject({ mode: "manual", pins: ["p2", "p1"] })
        const detail = TaskDetail.parse(task)
        expect(detail).not.toHaveProperty("mode")
        expect(detail).not.toHaveProperty("pins")
        // Nor does the live view every member gets.
        const view = await wf.getView()
        expect(WorkforceView.safeParse(view).success).toBe(true)
        expect(JSON.stringify(view.tasks["tk-1"])).not.toContain("manual")
    })

    test("create refuses manual without pins and pins that are not this team's; bad arguments throw", async () => {
        const wf = stub()
        await profiles(wf, "p1")
        expect(await wf.createTask(taskInput("tk-1", { mode: "manual", pins: [] }), uid("k"))).toEqual({ ok: false, reason: "no_pins" })
        expect(await wf.createTask(taskInput("tk-1", { mode: "manual", pins: ["p-other-team"] }), uid("k"))).toEqual({ ok: false, reason: "unknown_pin" })
        await expectActorError(wf.createTask(taskInput("tk-1", { mode: "manual", pins: ["a", "b", "c", "d", "e", "f"] }), uid("k")), /input\.pins/)
        await expectActorError(wf.createTask({ ...taskInput("tk-1"), mode: "everyone" } as never, uid("k")), /input\.mode/)
        await expectActorError(wf.createTask(taskInput("tk-1", { mode: "manual", pins: ["bad id"] }), uid("k")), /input\.pins\.0/)
        expect(await wf.getTask("tk-1")).toBeNull()
    })

    test("a crafted start with an unpinned pick is refused with not_pinned; pinned picks work", async () => {
        const wf = stub()
        await profiles(wf, "p1", "p2", "p3")
        await planned(wf, { mode: "manual", pins: ["p1", "p2"] })
        const refused = await wf.reserveWorkers(
            "tk-1",
            [
                { workstreamId: "ws-api", profileId: "p1" },
                { workstreamId: "ws-web", profileId: "p3" }
            ],
            uid("k")
        )
        expect(refused).toMatchObject({ ok: false, reason: "invalid_picks", picks: [{ ok: true }, { ok: false, reason: "not_pinned" }] })
        expect(Object.keys((await wf.getView()).leases)).toEqual([])
        expect((await wf.getInternals()).epoch).toBe(0)
        const ok = await wf.reserveWorkers(
            "tk-1",
            [
                { workstreamId: "ws-api", profileId: "p1" },
                { workstreamId: "ws-web", profileId: "p2" }
            ],
            uid("k")
        )
        expect(ok).toMatchObject({ ok: true, leases: [{ profileId: "p1" }, { profileId: "p2" }] })
    })

    test("auto is unchanged: an unpinned pick is fine", async () => {
        const wf = stub()
        await profiles(wf, "p1", "p2")
        await planned(wf, { pins: ["p1"] }, ["api"])
        expect(await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p2" }], uid("k"))).toMatchObject({ ok: true })
        expect(await wf.getTask("tk-1")).toMatchObject({ mode: "auto", pins: ["p1"] })
    })

    test("handoff, resolver, compare attempt and subagent on an unpinned profile are all refused", async () => {
        const wf = stub()
        await profiles(wf, "p1", "p2", "p3")
        await wf.registerProfile(profileInput("cx", { envId: "env-p1", nodeName: "n-p1", cli: "codex", maxConcurrent: 4 }))
        await planned(wf, { mode: "manual", pins: ["p1", "p2"] }, ["api"])
        const reserved = await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], uid("k"))
        if (!reserved.ok) throw new Error(JSON.stringify(reserved))
        const lease = reserved.leases[0]!
        await wf.recordSpawnStatus(lease.id, lease.epoch, "running", "inv", uid("e"))

        // Subagent: Codex on p1's machine is not pinned.
        expect(await wf.delegate({ parentLeaseId: lease.id, target: "codex", role: "review", task: "Review it.", clientRequestId: "r1" })).toEqual({ ok: false, reason: "not_pinned" })

        // Handoff after a usage limit: p3 refused, p2 taken.
        await wf.markProfileLimited("p1", Date.now() + 60_000, "quota", "detected", uid("e"))
        expect(await wf.requestHandoff("tk-1", "ws-api", lease.epoch, "p3", uid("k"))).toEqual({ ok: false, reason: "not_pinned" })
        const handoff = await wf.requestHandoff("tk-1", "ws-api", lease.epoch, "p2", uid("k"))
        expect(handoff).toMatchObject({ ok: true, lease: { profileId: "p2" } })
        if (!handoff.ok) return
        await wf.ackHandoff(handoff.lease.id, handoff.lease.epoch, uid("e"))
        await wf.completeWorkstream(handoff.lease.id, handoff.lease.epoch, "abc1234", "done", uid("e"))

        // Resolver: the merge conflict's worker must be pinned too.
        const evidence = { status: "failed" as const, checks: [{ name: "Merges", status: "failed" as const, detail: "conflict", url: null }] }
        const conflict = { branch: "morrow/ws-api/api", workstreamId: "ws-api", integrationBranch: "morrow/tk1/integration", involvedWorkstreamIds: ["ws-api"], files: [], brief: "Merge it." }
        expect(await wf.resolveConflict("tk-1", evidence, conflict, uid("k"))).toMatchObject({ ok: true, status: "resolving" })
        expect(await wf.reserveWorkers("tk-1", [{ workstreamId: wf_RESOLVER, profileId: "p3" }], uid("k"))).toMatchObject({ ok: false, picks: [{ reason: "not_pinned" }] })
        expect(await wf.reserveWorkers("tk-1", [{ workstreamId: wf_RESOLVER, profileId: "p2" }], uid("k"))).toMatchObject({ ok: true })

        // Compare: an attempt on an unpinned profile of its harness.
        const cmp = stub()
        for (const [id, cli] of [
            ["pc", "claude"],
            ["px", "codex"],
            ["px2", "codex"]
        ] as const)
            await cmp.registerProfile(profileInput(id, { cli }))
        await cmp.createTask(taskInput("tk-1", { strategy: "compare", maxAgents: 2, mode: "manual", pins: ["pc", "px"] }), uid("k"))
        const attempts = (["claude", "codex"] as const).map(cli => workstream(`ws-${cli}`, cli, { branch: `morrow/tk1/${cli}`, ownership: ["**"], harness: cli }))
        expect(await cmp.recordPlan("tk-1", plan(attempts, { source: "compare" }), uid("k"))).toMatchObject({ ok: true })
        expect(
            await cmp.reserveWorkers(
                "tk-1",
                [
                    { workstreamId: "ws-claude", profileId: "pc" },
                    { workstreamId: "ws-codex", profileId: "px2" }
                ],
                uid("k")
            )
        ).toMatchObject({ ok: false, picks: [{ ok: true }, { reason: "not_pinned" }] })
    })

    test("a compare plan with a harness none of the pins runs is refused", async () => {
        const wf = stub()
        await wf.registerProfile(profileInput("pc", { cli: "claude" }))
        await wf.registerProfile(profileInput("px", { cli: "codex" }))
        await wf.createTask(taskInput("tk-1", { strategy: "compare", maxAgents: 2, mode: "manual", pins: ["pc"] }), uid("k"))
        const attempts = (["claude", "codex"] as const).map(cli => workstream(`ws-${cli}`, cli, { branch: `morrow/tk1/${cli}`, ownership: ["**"], harness: cli }))
        expect(await wf.recordPlan("tk-1", plan(attempts, { source: "compare" }), uid("k"))).toEqual({ ok: false, reason: "harness_not_pinned" })
    })

    test("pins change only before start; replays return the first answer; a reused key with other pins throws", async () => {
        const wf = stub()
        await profiles(wf, "p1", "p2")
        await planned(wf, {}, ["api"])
        const key = uid("k")
        const first = await wf.setTaskWorkforce("tk-1", "manual", ["p2", "p2"], key)
        expect(first).toEqual({ ok: true, mode: "manual", pins: ["p2"], changed: true })
        expect(await wf.setTaskWorkforce("tk-1", "manual", ["p2", "p2"], key)).toEqual(first)
        await expectActorError(wf.setTaskWorkforce("tk-1", "manual", ["p1"], key), /key/i)
        await expectActorError(wf.setTaskWorkforce("tk-1", "sometimes" as never, [], uid("k")), /mode/)
        await expectActorError(wf.setTaskWorkforce("tk-1", "auto", "p1" as never, uid("k")), /pins/)
        expect(await wf.setTaskWorkforce("tk-1", "manual", [], uid("k"))).toEqual({ ok: false, reason: "no_pins" })

        expect(await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p2" }], uid("k"))).toMatchObject({ ok: true })
        expect(await wf.setTaskWorkforce("tk-1", "auto", [], uid("k"))).toEqual({ ok: false, reason: "task_started" })
        expect(await wf.getTask("tk-1")).toMatchObject({ mode: "manual", pins: ["p2"] })
    })

    test("waiting notes are written once by the actor, survive a restart, and auto tasks cannot get one", async () => {
        const teamId = uid("t")
        let wf = stub(teamId)
        await profiles(wf, "p1")
        await planned(wf, { mode: "manual", pins: ["p1"] }, ["api"])
        expect(await wf.noteWaiting("tk-1", "ws-api", "no_pinned_profile")).toEqual({ ok: true, noted: true })
        expect(await wf.noteWaiting("tk-1", "ws-api", "no_pinned_profile")).toEqual({ ok: true, noted: false })
        await expectActorError(wf.noteWaiting("tk-1", "ws-api", "anything" as never), /reason/)
        await server.restart()
        wf = stub(teamId)
        expect(await wf.noteWaiting("tk-1", "ws-api", "no_pinned_profile")).toEqual({ ok: true, noted: false })
        const task = await wf.getTask("tk-1")
        expect(task!.trace.filter(e => e.kind === "worker.waiting")).toHaveLength(1)
        expect(task).toMatchObject({ mode: "manual", pins: ["p1"] })
    }, 120_000)

    test("removing every pinned profile mid-run: the task keeps going to handoff and waits, nothing breaks", async () => {
        const wf = stub()
        await profiles(wf, "p1", "p2")
        await planned(wf, { mode: "manual", pins: ["p1"] }, ["api"])
        const reserved = await wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], uid("k"))
        if (!reserved.ok) throw new Error(JSON.stringify(reserved))
        await wf.recordSpawnStatus(reserved.leases[0]!.id, reserved.leases[0]!.epoch, "running", "inv", uid("e"))
        expect(await wf.removeProfile("p1")).toMatchObject({ ok: true, removed: true })
        expect(await wf.noteWaiting("tk-1", "ws-api", "no_pinned_profile")).toEqual({ ok: true, noted: true })
        const task = await wf.getTask("tk-1")
        expect(task!.status).toBe("handoff")
        expect(task!.trace.at(-1)!.message).toContain("all of them were removed from the team")
        expect(await wf.requestHandoff("tk-1", "ws-api", reserved.leases[0]!.epoch, "p2", uid("k"))).toEqual({ ok: false, reason: "not_pinned" })
        expect(WorkforceView.safeParse(await wf.getView()).success).toBe(true)
    })
})

const wf_RESOLVER = wf.RESOLVER_WORKSTREAM_ID

describe("races", () => {
    test("10-way race for one workstream of a manual task: exactly one lease, never on an unpinned profile", async () => {
        const wf = stub()
        const ids = Array.from({ length: 10 }, (_, i) => `p${i}`)
        await profiles(wf, ...ids)
        await planned(wf, { mode: "manual", pins: ids.slice(0, 5) }, ["api"])
        const results = await Promise.all(ids.map(id => wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: id }], uid("race"))))
        const winners = results.filter(r => r.ok)
        expect(winners).toHaveLength(1)
        expect(ids.slice(0, 5)).toContain(winners[0]!.ok ? winners[0]!.leases[0]!.profileId : "")
        // Losers see the workstream taken; an unpinned one that ran before the winner sees itself refused instead.
        for (const [i, r] of results.entries()) {
            if (r.ok) continue
            expect(i < 5 ? ["already_leased"] : ["already_leased", "not_pinned"]).toContain(r.picks[0]!.reason!)
        }
        expect(Object.keys((await wf.getView()).leases)).toHaveLength(1)
    })

    test("setTaskWorkforce racing a start: the pins are never changed after a worker is placed", async () => {
        const wf = stub()
        await profiles(wf, "p1", "p2")
        await planned(wf, { mode: "manual", pins: ["p1"] }, ["api"])
        const [widen, reserve] = await Promise.all([
            wf.setTaskWorkforce("tk-1", "auto", [], uid("k")),
            wf.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p1" }], uid("k"))
        ])
        expect(reserve.ok).toBe(true)
        const task = await wf.getTask("tk-1")
        // Either the change landed first (then the start ran under auto) or it was refused: never a widened running task.
        if (widen.ok) expect(task).toMatchObject({ mode: "auto" })
        else expect(widen).toEqual({ ok: false, reason: "task_started" })
        expect(await wf.setTaskWorkforce("tk-1", "manual", ["p1", "p2"], uid("k"))).toEqual({ ok: false, reason: "task_started" })
    })
})

describe("tasks stored before modes existed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "morrow-pre-modes-"))
    const servers: TestServer[] = []
    afterAll(async () => {
        for (const s of servers) await s.stop({ keepData: true }).catch(() => {})
        rmSync(dataDir, { recursive: true, force: true })
    })

    test("load as auto with no pins and take any profile", async () => {
        const teamId = uid("t")
        // The records as the previous version wrote them: built by the state machine, then stripped of the new fields.
        let state: wf.WorkforceState = { profiles: {}, tasks: {}, leases: {}, outbox: {}, epoch: 0 }
        const step = <R>(run: (d: wf.WorkforceDraft) => R): R => {
            const d = new wf.WorkforceDraft(state, Date.now())
            const result = run(d)
            wf.finalize(d)
            state = { profiles: d.profiles, tasks: d.tasks, leases: d.leases, outbox: d.outbox, epoch: d.epoch }
            return result
        }
        for (const id of ["p1", "p2"]) step(d => wf.registerProfile(d, profileInput(id)))
        step(d => wf.createTask(d, taskInput("tk-1")))
        step(d => wf.recordPlan(d, "tk-1", plan([workstream("ws-api", "api")])))
        const { mode: _m, pins: _p, ...old } = state.tasks["tk-1"]!

        const legacy = await startTestServer({ dataDir, entrypoint: "test/fixtures/workforce-pre-modes.ts" })
        servers.push(legacy)
        const seeded = await fetch(`${legacy.url}/v1/projects/local/actors/TeamWorkforce/${teamId}/invoke`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${legacy.secret}` },
            body: JSON.stringify({ requestId: crypto.randomUUID(), method: "seed", args: [{ ...state, tasks: { "tk-1": old } }, state.epoch] })
        })
        expect(((await seeded.json()) as { outcome: { type: string } }).outcome.type).toBe("completed")
        await legacy.stop({ keepData: true })
        servers.pop()

        const current = await startTestServer({ dataDir })
        servers.push(current)
        const wf2 = actors.TeamWorkforce.get(teamId, transportFor(current))
        const task = await wf2.getTask("tk-1")
        expect(task).toMatchObject({ id: "tk-1", status: "planned", mode: "auto", pins: [] })
        expect(await wf2.reserveWorkers("tk-1", [{ workstreamId: "ws-api", profileId: "p2" }], uid("k"))).toMatchObject({ ok: true })
        // And it can still be made manual before start, like any task (here it has started, so it is refused).
        expect(await wf2.setTaskWorkforce("tk-1", "manual", ["p1"], uid("k"))).toEqual({ ok: false, reason: "task_started" })
    }, 300_000)
})
