// Manual mode (docs/multi-harness.md, "Manual mode") as a pure state machine: every step runs the actor's pipeline
// (sweep, run, finalize, invariants) against a deep-frozen state, like lib-workforce.test.ts. A manual task's every
// lease must be on one of its pinned profiles; an auto task is unchanged.
import { describe, expect, test } from "bun:test"
import { TaskDetail as ContractTaskDetail, WorkforceView as ContractWorkforceView } from "../../packages/contracts/src/domain.ts"
import type { CliKind, ConflictInput, CreateTaskInput, Lease, PlanWorkstreamInput, Task, VerificationView } from "../src/lib/types.ts"
import * as v from "../src/lib/validation.ts"
import * as wf from "../src/lib/workforce.ts"
import { plan, profileInput, taskInput, workstream } from "./helpers.ts"

const T0 = 1_800_000_000_000

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value)
        for (const child of Object.values(value)) deepFreeze(child)
    }
    return value
}

function harness() {
    let state: wf.WorkforceState = deepFreeze({ profiles: {}, tasks: {}, leases: {}, outbox: {}, epoch: 0 })
    let now = T0
    const h = {
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
            state = deepFreeze({ profiles: d.profiles, tasks: d.tasks, leases: d.leases, outbox: d.outbox, epoch: d.epoch })
            return result
        },
        task(id = "tk-1"): Task {
            return state.tasks[id]!
        },
        lease(id: string): Lease {
            return state.leases[id]!
        },
        ws(id: string, taskId = "tk-1") {
            return h.task(taskId).workstreams.find(w => w.id === id)!
        },
        profiles(...ids: string[]) {
            for (const id of ids) expect(h.step(d => wf.registerProfile(d, profileInput(id))).ok).toBe(true)
        },
        /** A planned split task with the given roles. */
        planned(input: Partial<CreateTaskInput>, roles = ["api", "web"], workstreams?: PlanWorkstreamInput[]) {
            expect(h.step(d => wf.createTask(d, taskInput("tk-1", input)))).toEqual({ ok: true, taskId: "tk-1" })
            expect(h.step(d => wf.recordPlan(d, "tk-1", plan(workstreams ?? roles.map(role => workstream(`ws-${role}`, role)))))).toMatchObject({ ok: true })
        },
        reserve(picks: [string, string][], taskId = "tk-1") {
            return h.step(d => wf.reserveWorkers(d, taskId, picks.map(([workstreamId, profileId]) => ({ workstreamId, profileId }))))
        },
        run(leaseId: string) {
            expect(h.step(d => wf.recordSpawnStatus(d, leaseId, h.lease(leaseId).epoch, "running", "inv"))).toEqual({ ok: true })
        },
        waits(taskId = "tk-1") {
            return h.task(taskId).trace.filter(e => e.kind === "worker.waiting")
        }
    }
    return h
}

const manual = (pins: string[]): Partial<CreateTaskInput> => ({ mode: "manual", pins })

describe("create", () => {
    test("stores the mode and pins; the defaults are auto with none", () => {
        const h = harness()
        h.profiles("p1", "p2")
        h.planned(manual(["p2"]))
        expect(h.task()).toMatchObject({ mode: "manual", pins: ["p2"] })
        expect(wf.taskRecord(h.task())).toMatchObject({ mode: "manual", pins: ["p2"] })
        expect(h.step(d => wf.createTask(d, taskInput("tk-2")))).toEqual({ ok: true, taskId: "tk-2" })
        expect(h.task("tk-2")).toMatchObject({ mode: "auto", pins: [] })
    })

    test("refuses manual with no pins, and any pin that is not a profile of this team, in either mode", () => {
        const h = harness()
        h.profiles("p1")
        expect(h.step(d => wf.createTask(d, taskInput("tk-1", manual([]))))).toEqual({ ok: false, reason: "no_pins" })
        expect(h.step(d => wf.createTask(d, taskInput("tk-1", { mode: "manual" })))).toEqual({ ok: false, reason: "no_pins" })
        expect(h.step(d => wf.createTask(d, taskInput("tk-1", manual(["p1", "elsewhere"]))))).toEqual({ ok: false, reason: "unknown_pin" })
        expect(h.step(d => wf.createTask(d, taskInput("tk-1", { mode: "auto", pins: ["elsewhere"] })))).toEqual({ ok: false, reason: "unknown_pin" })
        expect(h.state.tasks).toEqual({})
    })

    test("validation drops duplicate pins, caps them at 5 and refuses bad ids or modes", () => {
        expect(v.parse(v.CreateTaskInput, taskInput("tk-1", manual(["p1", "p2", "p1"])), "input").pins).toEqual(["p1", "p2"])
        expect(() => v.parse(v.CreateTaskInput, taskInput("tk-1", manual(["a", "b", "c", "d", "e", "f"])), "input")).toThrow("input.pins")
        expect(() => v.parse(v.CreateTaskInput, taskInput("tk-1", manual(["../x"])), "input")).toThrow("input.pins.0")
        expect(() => v.parse(v.CreateTaskInput, taskInput("tk-1", manual(["__proto__"])), "input")).toThrow("input.pins.0")
        expect(() => v.parse(v.CreateTaskInput, { ...taskInput("tk-1"), mode: "pinned" }, "input")).toThrow("input.mode")
        expect(() => v.parse(v.Pins, "p1", "pins")).toThrow("pins")
    })
})

describe("every lease of a manual task is on a pinned profile", () => {
    test("start: an unpinned pick is refused with not_pinned and nothing is reserved; pinned picks work", () => {
        const h = harness()
        h.profiles("p1", "p2", "p3")
        h.planned(manual(["p1", "p2"]))
        const refused = h.reserve([
            ["ws-api", "p1"],
            ["ws-web", "p3"]
        ])
        expect(refused).toEqual({
            ok: false,
            reason: "invalid_picks",
            picks: [
                { workstreamId: "ws-api", profileId: "p1", ok: true, reason: null },
                { workstreamId: "ws-web", profileId: "p3", ok: false, reason: "not_pinned" }
            ]
        })
        expect(h.state.leases).toEqual({})
        expect(h.state.epoch).toBe(0)
        // An unknown profile is also simply not pinned.
        expect(h.reserve([["ws-web", "ghost"]])).toMatchObject({ picks: [{ reason: "not_pinned" }] })
        expect(
            h.reserve([
                ["ws-api", "p1"],
                ["ws-web", "p2"]
            ])
        ).toMatchObject({ ok: true, leases: [{ profileId: "p1" }, { profileId: "p2" }] })
    })

    test("a dependent workstream placed later is held to the pins too", () => {
        const h = harness()
        h.profiles("p1", "p2")
        h.planned(manual(["p1"]), [], [workstream("ws-api", "api"), workstream("ws-web", "web", { dependsOn: ["ws-api"] })])
        expect(h.reserve([["ws-api", "p1"]]).ok).toBe(true)
        h.run("ls-1")
        h.step(d => wf.completeWorkstream(d, "ls-1", 1, "aaaaaaa", "api"))
        expect(h.reserve([["ws-web", "p2"]])).toMatchObject({ ok: false, picks: [{ reason: "not_pinned" }] })
        expect(h.reserve([["ws-web", "p1"]])).toMatchObject({ ok: true, leases: [{ profileId: "p1", workstreamId: "ws-web" }] })
    })

    test("handoff: the replacement must be pinned", () => {
        const h = harness()
        h.profiles("p1", "p2", "p3")
        h.planned(manual(["p1", "p2"]), ["api"])
        h.reserve([["ws-api", "p1"]])
        h.run("ls-1")
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "quota", "detected"))
        expect(h.ws("ws-api").status).toBe("handoff")
        expect(h.step(d => wf.requestHandoff(d, "tk-1", "ws-api", 1, "p3"))).toEqual({ ok: false, reason: "not_pinned" })
        expect(h.step(d => wf.requestHandoff(d, "tk-1", "ws-api", 1, "p2"))).toMatchObject({ ok: true, lease: { profileId: "p2" } })
    })

    test("merge-conflict resolver: only a pinned profile may resolve", () => {
        const h = harness()
        h.profiles("p1", "p2", "p3")
        h.planned(manual(["p1", "p2"]))
        h.reserve([
            ["ws-api", "p1"],
            ["ws-web", "p2"]
        ])
        h.step(d => wf.completeWorkstream(d, "ls-1", 1, "aaaaaaa", "api"))
        h.step(d => wf.completeWorkstream(d, "ls-2", 2, "bbbbbbb", "web"))
        const evidence: VerificationView = { status: "failed", checks: [{ name: "Merges cleanly", status: "failed", detail: "conflict", url: null }] }
        const conflict: ConflictInput = {
            branch: "morrow/ws-web/web",
            workstreamId: "ws-web",
            integrationBranch: "morrow/tk1/integration",
            involvedWorkstreamIds: ["ws-web", "ws-api"],
            files: ["src/shared.ts"],
            brief: "Merge it."
        }
        expect(h.step(d => wf.resolveConflict(d, "tk-1", evidence, conflict))).toMatchObject({ ok: true, status: "resolving" })
        expect(h.reserve([[wf.RESOLVER_WORKSTREAM_ID, "p3"]])).toMatchObject({ ok: false, picks: [{ reason: "not_pinned" }] })
        expect(h.reserve([[wf.RESOLVER_WORKSTREAM_ID, "p2"]])).toMatchObject({ ok: true, leases: [{ profileId: "p2" }] })
    })

    test("planning: a manual task's planner call holds only a pinned profile", () => {
        const h = harness()
        h.profiles("p1", "p2")
        expect(h.step(d => wf.createTask(d, taskInput("tk-1", manual(["p2"]))))).toMatchObject({ ok: true })
        expect(h.step(d => wf.beginPlanning(d, "tk-1", "p1"))).toEqual({ ok: false, reason: "not_pinned" })
        expect(h.task().status).toBe("draft")
        expect(h.step(d => wf.beginPlanning(d, "tk-1", "p2")).ok).toBe(true)
    })

    test("auto is unchanged: any eligible profile, pinned or not", () => {
        const h = harness()
        h.profiles("p1", "p2", "p3")
        h.planned({ mode: "auto", pins: ["p1"] })
        expect(
            h.reserve([
                ["ws-api", "p3"],
                ["ws-web", "p2"]
            ])
        ).toMatchObject({ ok: true })
        expect(wf.pinRejection(h.task(), "p3")).toBeNull()
    })
})

describe("compare", () => {
    const attempt = (cli: CliKind) => workstream(`ws-${cli}`, cli, { branch: `morrow/tk1/${cli}`, ownership: ["**"], harness: cli })
    const comparePlan = (clis: CliKind[]) => plan(clis.map(attempt), { source: "compare" })
    function setup(pins: string[]) {
        const h = harness()
        for (const [id, cli] of [
            ["pc", "claude"],
            ["px", "codex"],
            ["px2", "codex"]
        ] as const)
            h.step(d => wf.registerProfile(d, profileInput(id, { cli })))
        expect(h.step(d => wf.createTask(d, taskInput("tk-1", { strategy: "compare", maxAgents: 2, ...manual(pins) })))).toMatchObject({ ok: true })
        return h
    }

    test("a compare plan with a harness none of the pins runs is refused", () => {
        const h = setup(["pc"])
        expect(h.step(d => wf.recordPlan(d, "tk-1", comparePlan(["claude", "codex"])))).toEqual({ ok: false, reason: "harness_not_pinned" })
        expect(h.task().status).toBe("draft")
    })

    test("each attempt runs only on a pinned profile of its harness", () => {
        const h = setup(["pc", "px"])
        expect(h.step(d => wf.recordPlan(d, "tk-1", comparePlan(["claude", "codex"])))).toMatchObject({ ok: true })
        expect(
            h.reserve([
                ["ws-claude", "pc"],
                ["ws-codex", "px2"]
            ])
        ).toMatchObject({ ok: false, picks: [{ ok: true }, { reason: "not_pinned" }] })
        // The harness binding still applies inside the pins.
        expect(h.reserve([["ws-codex", "pc"]])).toMatchObject({ ok: false, picks: [{ reason: "wrong_harness" }] })
        expect(
            h.reserve([
                ["ws-claude", "pc"],
                ["ws-codex", "px"]
            ])
        ).toMatchObject({ ok: true })
    })
})

describe("subagents of a manual task", () => {
    /** p1 (Claude Code) runs ws-api; cx (Codex) and cx2 (Codex) share p1's machine. */
    function started(input: Partial<CreateTaskInput>) {
        const h = harness()
        h.profiles("p1")
        h.step(d => wf.registerProfile(d, profileInput("cx", { envId: "env-p1", nodeName: "n-p1", cli: "codex", maxConcurrent: 4 })))
        h.step(d => wf.registerProfile(d, profileInput("cx2", { envId: "env-p1", nodeName: "n-p1", cli: "codex", maxConcurrent: 4 })))
        h.planned(input, ["api"])
        h.reserve([["ws-api", "p1"]])
        h.run("ls-1")
        return h
    }
    const ask = (clientRequestId = "req-1") => ({ parentLeaseId: "ls-1", target: "codex" as const, role: "review" as const, task: "Review it.", clientRequestId })

    test("a CLI on the machine that is not pinned is refused with not_pinned", () => {
        const h = started(manual(["p1"]))
        expect(h.step(d => wf.delegate(d, ask()))).toEqual({ ok: false, reason: "not_pinned" })
        expect(Object.keys(h.state.leases)).toEqual(["ls-1"])
        expect(h.task().subagents ?? []).toEqual([])
    })

    test("only the pinned one of two runs it", () => {
        const h = started(manual(["p1", "cx2"]))
        expect(h.step(d => wf.delegate(d, ask()))).toMatchObject({ ok: true, subagent: { profileId: "cx2" } })
    })

    test("a pinned one that is busy says why, not not_pinned", () => {
        const h = started(manual(["p1", "cx"]))
        h.step(d => wf.markProfileLimited(d, "cx", T0 + 60_000, "quota", "detected"))
        expect(h.step(d => wf.delegate(d, ask()))).toEqual({ ok: false, reason: "profile_limited" })
    })

    test("auto: any CLI on the machine, as before", () => {
        const h = started({ pins: ["p1"] })
        expect(h.step(d => wf.delegate(d, ask()))).toMatchObject({ ok: true, subagent: { profileId: "cx" } })
    })
})

describe("changing the mode and pins before start", () => {
    test("updates them while the task has not started, and says whether anything changed", () => {
        const h = harness()
        h.profiles("p1", "p2")
        h.planned({})
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-1", "manual", ["p2"]))).toEqual({ ok: true, mode: "manual", pins: ["p2"], changed: true })
        expect(h.task()).toMatchObject({ mode: "manual", pins: ["p2"] })
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-1", "manual", ["p2"]))).toEqual({ ok: true, mode: "manual", pins: ["p2"], changed: false })
        expect(h.reserve([["ws-api", "p1"]])).toMatchObject({ ok: false, picks: [{ reason: "not_pinned" }] })
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-1", "auto", []))).toMatchObject({ ok: true, changed: true })
        expect(h.reserve([["ws-api", "p1"]]).ok).toBe(true)
    })

    test("refused once any worker was placed, so a running manual task is never widened", () => {
        const h = harness()
        h.profiles("p1", "p2")
        h.planned(manual(["p1"]))
        h.reserve([["ws-api", "p1"]])
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-1", "auto", []))).toEqual({ ok: false, reason: "task_started" })
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-1", "manual", ["p1", "p2"]))).toEqual({ ok: false, reason: "task_started" })
        // Still refused after the worker is gone and the task is planned again by a retry.
        h.step(d => wf.cancelTask(d, "tk-1", "u-1"))
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-1", "auto", []))).toEqual({ ok: false, reason: "task_started" })
        expect(h.task()).toMatchObject({ mode: "manual", pins: ["p1"] })
    })

    test("refuses no pins in manual, unknown pins, a compare harness without a pin, and unknown tasks", () => {
        const h = harness()
        h.profiles("p1")
        h.step(d => wf.registerProfile(d, profileInput("px", { cli: "codex" })))
        h.planned({})
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-1", "manual", []))).toEqual({ ok: false, reason: "no_pins" })
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-1", "manual", ["nope"]))).toEqual({ ok: false, reason: "unknown_pin" })
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-9", "auto", []))).toEqual({ ok: false, reason: "unknown_task" })
        const attempts = (["claude", "codex"] as const).map(cli => workstream(`ws-${cli}`, cli, { branch: `morrow/tk2/${cli}`, ownership: ["**"], harness: cli }))
        h.step(d => wf.createTask(d, taskInput("tk-2", { strategy: "compare", maxAgents: 2 })))
        h.step(d => wf.recordPlan(d, "tk-2", plan(attempts, { source: "compare" })))
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-2", "manual", ["p1"]))).toEqual({ ok: false, reason: "harness_not_pinned" })
        expect(h.step(d => wf.setTaskWorkforce(d, "tk-2", "manual", ["p1", "px"]))).toMatchObject({ ok: true })
    })
})

describe("waiting for a pinned profile", () => {
    test("a wait is noted once in plain words; a repeat is a no-op; auto tasks are refused", () => {
        const h = harness()
        h.profiles("p1", "p2")
        h.planned(manual(["p1"]), ["api"])
        expect(h.step(d => wf.noteWaiting(d, "tk-1", "ws-api", "no_pinned_profile"))).toEqual({ ok: true, noted: true })
        expect(h.waits()).toHaveLength(1)
        expect(h.waits()[0]!.message).toBe('Waiting for a pinned profile: none of them is free. "api work" starts when one is.')
        h.advance(1_000)
        expect(h.step(d => wf.noteWaiting(d, "tk-1", "ws-api", "no_pinned_profile"))).toEqual({ ok: true, noted: false })
        expect(h.waits()).toHaveLength(1)
        expect(h.step(d => wf.noteWaiting(d, "tk-1", "ws-nope", "no_pinned_profile"))).toEqual({ ok: false, reason: "unknown_workstream" })
        expect(h.step(d => wf.noteWaiting(d, "tk-9", "ws-api", "no_pinned_profile"))).toEqual({ ok: false, reason: "unknown_task" })
        expect(h.step(d => wf.createTask(d, taskInput("tk-2")))).toMatchObject({ ok: true })
        h.step(d => wf.recordPlan(d, "tk-2", plan([workstream("ws-api", "api")])))
        expect(h.step(d => wf.noteWaiting(d, "tk-2", "ws-api", "no_pinned_profile"))).toEqual({ ok: false, reason: "not_manual" })
        // The view's one-line preview carries it like any trace entry.
        expect(h.task().trace.at(-1)!.kind).toBe("worker.waiting")
        expect(() => ContractWorkforceView.parse(wf.buildWorkforceView(h.state))).not.toThrow()
    })

    test("a workstream that has a live worker is not waiting", () => {
        const h = harness()
        h.profiles("p1")
        h.planned(manual(["p1"]), ["api"])
        h.reserve([["ws-api", "p1"]])
        expect(h.step(d => wf.noteWaiting(d, "tk-1", "ws-api", "no_pinned_profile"))).toEqual({ ok: true, noted: false })
        expect(h.waits()).toEqual([])
    })

    test("every pinned profile removed mid-run: no crash, the workstream waits and the note says they are gone", () => {
        const h = harness()
        h.profiles("p1", "p2", "p3")
        h.planned(manual(["p1", "p2"]), ["api"])
        h.reserve([["ws-api", "p1"]])
        h.run("ls-1")
        h.step(d => wf.removeProfile(d, "p1"))
        expect(h.ws("ws-api").status).toBe("handoff")
        expect(h.step(d => wf.noteWaiting(d, "tk-1", "ws-api", "no_pinned_profile"))).toEqual({ ok: true, noted: true })
        expect(h.waits().at(-1)!.message).toContain("none of them is free")
        h.step(d => wf.removeProfile(d, "p2"))
        expect(h.step(d => wf.noteWaiting(d, "tk-1", "ws-api", "no_pinned_profile"))).toEqual({ ok: true, noted: true })
        expect(h.waits().at(-1)!.message).toBe(
            'Waiting for a pinned profile: all of them were removed from the team. "api work" cannot start until the task is cancelled and started again with other profiles.'
        )
        // Still never on an unpinned profile, and the task is still open and readable.
        expect(h.step(d => wf.requestHandoff(d, "tk-1", "ws-api", 1, "p3"))).toEqual({ ok: false, reason: "not_pinned" })
        expect(h.task().status).toBe("handoff")
        expect(() => ContractTaskDetail.parse(wf.taskRecord(h.task()))).not.toThrow()
        // Cancelling ends it cleanly.
        expect(h.step(d => wf.cancelTask(d, "tk-1", "u-1")).ok).toBe(true)
    })

    test("a worker placed and lost since the last note makes the next wait worth noting again", () => {
        const h = harness()
        h.profiles("p1")
        h.planned(manual(["p1"]), ["api"])
        h.step(d => wf.noteWaiting(d, "tk-1", "ws-api", "no_pinned_profile"))
        h.advance(1_000)
        h.reserve([["ws-api", "p1"]])
        h.run("ls-1")
        h.advance(1_000)
        h.step(d => wf.markProfileLimited(d, "p1", h.task().updatedAt + 60_000, "quota", "detected"))
        expect(h.step(d => wf.noteWaiting(d, "tk-1", "ws-api", "no_pinned_profile"))).toEqual({ ok: true, noted: true })
        expect(h.waits()).toHaveLength(2)
    })
})

describe("tasks stored before modes existed", () => {
    test("read as auto with no pins and take any profile", () => {
        const h = harness()
        h.profiles("p1", "p2")
        h.planned({}, ["api"])
        // Strip the fields, as a task written by the previous version has none.
        const { mode: _m, pins: _p, ...legacy } = h.task()
        const old = legacy as Task
        expect(wf.modeOf(old)).toBe("auto")
        expect(wf.pinsOf(old)).toEqual([])
        expect(wf.pinRejection(old, "p2")).toBeNull()
        expect(wf.taskRecord(old)).toMatchObject({ mode: "auto", pins: [] })
        h.step(d => d.putTask(old))
        expect(h.reserve([["ws-api", "p2"]])).toMatchObject({ ok: true })
    })
})

describe("the invariant backs it up", () => {
    test("a live lease of a manual task on an unpinned profile is a violation", () => {
        const h = harness()
        h.profiles("p1", "p2")
        h.planned(manual(["p1"]), ["api"])
        h.reserve([["ws-api", "p1"]])
        const lease = h.lease("ls-1")
        const forged: wf.WorkforceState = { ...h.state, leases: { ...h.state.leases, "ls-1": { ...lease, profileId: "p2" } } }
        expect(wf.workforceInvariantViolations(forged)).toContain("live lease ls-1 of manual task tk-1 is on unpinned p2")
    })
})
