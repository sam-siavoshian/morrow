// Pure state-machine tests for src/lib/workforce.ts. Every step runs the same pipeline as the actor (sweep, run,
// finalize, invariants) against a deep-frozen state, so any in-place mutation of persisted objects throws.
import { describe, expect, test } from "bun:test"
import { WorkforceView as ContractWorkforceView } from "../../packages/contracts/src/domain.ts"
import type { CliProfile, ConflictInput, Lease, OutboxItem, Task, UsageWindow, VerificationView } from "../src/lib/types.ts"
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
        get now() {
            return now
        },
        advance(ms: number) {
            now += ms
        },
        step<R>(run: (d: wf.WorkforceDraft) => R, at = now): R {
            const d = new wf.WorkforceDraft(state, at)
            wf.sweep(d)
            const result = run(d)
            wf.finalize(d)
            expect(wf.workforceInvariantViolations(d)).toEqual([])
            state = deepFreeze({ profiles: d.profiles, tasks: d.tasks, leases: d.leases, outbox: d.outbox, epoch: d.epoch })
            return result
        },
        task(id: string): Task {
            return state.tasks[id]!
        },
        lease(id: string): Lease {
            return state.leases[id]!
        },
        profile(id: string): CliProfile {
            return state.profiles[id]!
        },
        items(filter: Partial<Pick<OutboxItem, "kind" | "leaseId" | "state">> = {}): OutboxItem[] {
            return Object.values(state.outbox).filter(item => Object.entries(filter).every(([k, v]) => (item as Record<string, unknown>)[k] === v))
        },
        view() {
            return wf.buildWorkforceView(state)
        },
        /** Registers profiles and a planned task with the given workstream roles. */
        setup(options: { profiles?: string[]; roles?: string[]; maxConcurrent?: number; maxAgents?: number; taskId?: string } = {}) {
            const taskId = options.taskId ?? "tk-1"
            for (const id of options.profiles ?? ["p1", "p2"])
                expect(h.step(d => wf.registerProfile(d, profileInput(id, { maxConcurrent: options.maxConcurrent ?? 1 }))).ok).toBe(true)
            expect(h.step(d => wf.createTask(d, taskInput(taskId, { maxAgents: options.maxAgents ?? 3 })))).toEqual({ ok: true, taskId })
            const roles = options.roles ?? ["api", "web"]
            expect(h.step(d => wf.recordPlan(d, taskId, plan(roles.map(role => workstream(`ws-${role}`, role)))))).toEqual({ ok: true, generation: 1 })
            return taskId
        },
        reserve(taskId: string, picks: [string, string][]) {
            return h.step(d => wf.reserveWorkers(d, taskId, picks.map(([workstreamId, profileId]) => ({ workstreamId, profileId }))))
        },
        run(leaseId: string) {
            const lease = h.lease(leaseId)
            expect(h.step(d => wf.recordSpawnStatus(d, leaseId, lease.epoch, "running", "inv-1"))).toEqual({ ok: true })
        }
    }
    return h
}

describe("profiles", () => {
    test("register creates a ready profile and re-register updates it without touching status", () => {
        const h = harness()
        const created = h.step(d => wf.registerProfile(d, profileInput("p1")))
        expect(created.ok && created.profile.availability).toBe("ready")
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "quota", "detected"))
        const updated = h.step(d => wf.registerProfile(d, profileInput("p1", { label: "Renamed", maxConcurrent: 2 })))
        expect(updated.ok && updated.profile).toMatchObject({ label: "Renamed", maxConcurrent: 2, availability: "limited" })
    })

    test("register refuses an owner or environment change and caps the pool", () => {
        const h = harness()
        h.step(d => wf.registerProfile(d, profileInput("p1")))
        expect(h.step(d => wf.registerProfile(d, profileInput("p1", { ownerUserId: "u-evil" })))).toEqual({ ok: false, reason: "profile_owner_mismatch" })
        expect(h.step(d => wf.registerProfile(d, profileInput("p1", { envId: "env-other" })))).toEqual({ ok: false, reason: "profile_owner_mismatch" })
        for (let i = 1; i < wf.WORKFORCE_LIMITS.profiles; i++) h.step(d => wf.registerProfile(d, profileInput(`q${i}`)))
        expect(h.step(d => wf.registerProfile(d, profileInput("one-too-many")))).toEqual({ ok: false, reason: "too_many_profiles" })
    })

    test("health updates: out-of-order observations ignored, offline traced, limited stays limited", () => {
        const h = harness()
        const taskId = h.setup()
        const reserved = h.reserve(taskId, [["ws-api", "p1"]])
        expect(reserved.ok).toBe(true)
        expect(h.step(d => wf.updateProfileHealth(d, "p1", { auth: "ok", online: true, observedAt: T0 + 10 }))).toEqual({ ok: true, applied: true })
        expect(h.step(d => wf.updateProfileHealth(d, "p1", { auth: "auth_required", online: false, observedAt: T0 + 5 }))).toEqual({ ok: true, applied: false })
        expect(h.profile("p1").auth).toBe("ok")
        h.step(d => wf.updateProfileHealth(d, "p1", { auth: "ok", online: false, observedAt: T0 + 20 }))
        expect(h.profile("p1").availability).toBe("offline")
        expect(h.task(taskId).trace.at(-1)!.kind).toBe("worker.offline")
        h.step(d => wf.markProfileLimited(d, "p2", T0 + 60_000, "quota", "manual"))
        h.step(d => wf.updateProfileHealth(d, "p2", { auth: "ok", online: true, observedAt: T0 + 30 }))
        expect(h.profile("p2").availability).toBe("limited")
        expect(h.step(d => wf.updateProfileHealth(d, "nope", { auth: "ok", online: true, observedAt: 1 }))).toEqual({ ok: false, reason: "unknown_profile" })
    })

    describe("usage readings", () => {
        const fiveHour = (usedPercent: number): UsageWindow => ({ kind: "five_hour", label: "5-hour", usedPercent, resetsAt: T0 + 3_600_000 })
        const weekly = (usedPercent: number): UsageWindow => ({ kind: "weekly", label: "Weekly", usedPercent, resetsAt: T0 + 86_400_000 })
        const probe = (observedAt: number, windows: UsageWindow[]) => ({ windows, observedAt, source: "probe" as const })

        test("a new profile has no reading; the first one lands in the view", () => {
            const h = harness()
            h.step(d => wf.registerProfile(d, profileInput("p1")))
            expect(h.view().profiles.p1!.usage).toBeNull()
            const reading = probe(T0 + 10, [fiveHour(42), weekly(10)])
            expect(h.step(d => wf.recordProfileUsage(d, "p1", reading))).toEqual({ ok: true, applied: true })
            expect(h.view().profiles.p1!.usage).toEqual(reading)
            expect(ContractWorkforceView.safeParse(h.view()).success).toBe(true)
        })

        test("monotonic: an older or equal observedAt is ignored", () => {
            const h = harness()
            h.step(d => wf.registerProfile(d, profileInput("p1")))
            h.step(d => wf.recordProfileUsage(d, "p1", probe(T0 + 100, [fiveHour(50)])))
            expect(h.step(d => wf.recordProfileUsage(d, "p1", probe(T0 + 50, [fiveHour(5)])))).toEqual({ ok: true, applied: false })
            expect(h.step(d => wf.recordProfileUsage(d, "p1", probe(T0 + 100, [fiveHour(7)])))).toEqual({ ok: true, applied: false })
            expect(h.profile("p1").usage!.windows[0]!.usedPercent).toBe(50)
        })

        test("a probe reading replaces every window; a worker reading replaces only the windows it names", () => {
            const h = harness()
            h.step(d => wf.registerProfile(d, profileInput("p1")))
            h.step(d => wf.recordProfileUsage(d, "p1", probe(T0 + 1, [fiveHour(20), weekly(30)])))
            h.step(d => wf.recordProfileUsage(d, "p1", { windows: [fiveHour(85)], observedAt: T0 + 2, source: "worker" }))
            expect(h.profile("p1").usage).toEqual({ windows: [fiveHour(85), weekly(30)], observedAt: T0 + 2, source: "worker" })
            h.step(d => wf.recordProfileUsage(d, "p1", probe(T0 + 3, [fiveHour(1)])))
            expect(h.profile("p1").usage!.windows).toEqual([fiveHour(1)])
        })

        test("an unchanged reading is rewritten at most every usageRewriteMs; a changed one at once", () => {
            const h = harness()
            h.step(d => wf.registerProfile(d, profileInput("p1")))
            h.step(d => wf.recordProfileUsage(d, "p1", probe(T0, [fiveHour(10)])))
            expect(h.step(d => wf.recordProfileUsage(d, "p1", probe(T0 + 60_000, [fiveHour(10)])))).toEqual({ ok: true, applied: false })
            expect(h.step(d => wf.recordProfileUsage(d, "p1", probe(T0 + 61_000, [fiveHour(11)])))).toEqual({ ok: true, applied: true })
            const later = T0 + 61_000 + wf.WORKFORCE_TIMING.usageRewriteMs
            expect(h.step(d => wf.recordProfileUsage(d, "p1", probe(later, [fiveHour(11)])))).toEqual({ ok: true, applied: true })
            expect(h.profile("p1").usage!.observedAt).toBe(later)
        })

        test("unknown profile; registering again keeps the reading; removal drops it", () => {
            const h = harness()
            expect(h.step(d => wf.recordProfileUsage(d, "nope", probe(T0, [])))).toEqual({ ok: false, reason: "unknown_profile" })
            h.step(d => wf.registerProfile(d, profileInput("p1")))
            h.step(d => wf.recordProfileUsage(d, "p1", probe(T0, [fiveHour(10)])))
            h.step(d => wf.registerProfile(d, profileInput("p1", { label: "renamed" })))
            expect(h.profile("p1").usage!.windows).toEqual([fiveHour(10)])
            h.step(d => wf.removeProfile(d, "p1"))
            expect(h.view().profiles.p1).toBeUndefined()
        })

        test("a profile stored before usage existed reads as null in the view", () => {
            const h = harness()
            h.step(d => wf.registerProfile(d, profileInput("p1")))
            const { usage: _, ...legacy } = h.profile("p1")
            expect(wf.profileView(legacy, 0).usage).toBeNull()
        })
    })

    test("removing a profile with a live lease expires it and hands the workstream off", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        h.run("ls-1")
        expect(h.step(d => wf.removeProfile(d, "p1"))).toEqual({ ok: true, removed: true, expiredLeaseIds: ["ls-1"] })
        expect(h.state.profiles.p1).toBeUndefined()
        expect(h.lease("ls-1").state).toBe("expired")
        expect(h.task(taskId).workstreams[0]!.status).toBe("handoff")
        expect(h.step(d => wf.removeProfile(d, "p1"))).toEqual({ ok: true, removed: false, expiredLeaseIds: [] })
    })
})

describe("tasks and planning", () => {
    test("create, duplicate and active cap", () => {
        const h = harness()
        expect(h.step(d => wf.createTask(d, taskInput("tk-1")))).toEqual({ ok: true, taskId: "tk-1" })
        expect(h.task("tk-1")).toMatchObject({ status: "draft", generation: 0 })
        expect(h.task("tk-1").trace[0]!.kind).toBe("task.created")
        expect(h.step(d => wf.createTask(d, taskInput("tk-1")))).toEqual({ ok: false, reason: "task_exists" })
        for (let i = 2; i <= wf.WORKFORCE_LIMITS.activeTasks; i++) h.step(d => wf.createTask(d, taskInput(`tk-${i}`)))
        expect(h.step(d => wf.createTask(d, taskInput("tk-over")))).toEqual({ ok: false, reason: "too_many_active_tasks" })
    })

    test("recordPlan replaces workstreams, bumps generation and enforces maxAgents", () => {
        const h = harness()
        h.step(d => wf.createTask(d, taskInput("tk-1", { maxAgents: 2 })))
        expect(h.step(d => wf.recordPlan(d, "tk-1", plan([workstream("a", "api"), workstream("b", "web"), workstream("c", "tests")])))).toEqual({
            ok: false,
            reason: "too_many_workstreams"
        })
        expect(h.step(d => wf.recordPlan(d, "tk-1", plan([workstream("a", "api")])))).toEqual({ ok: true, generation: 1 })
        expect(h.step(d => wf.recordPlan(d, "tk-1", plan([workstream("a", "api"), workstream("b", "web")])))).toEqual({ ok: true, generation: 2 })
        expect(h.task("tk-1")).toMatchObject({ status: "planned", generation: 2 })
        expect(h.task("tk-1").workstreams.map(ws => [ws.id, ws.status, ws.leaseId])).toEqual([
            ["a", "pending", null],
            ["b", "pending", null]
        ])
        expect(h.step(d => wf.recordPlan(d, "nope", plan([workstream("a", "api")])))).toEqual({ ok: false, reason: "unknown_task" })
    })

    test("planning traces name the planner, a fallback says why, and feedback marks a re-plan", () => {
        const h = harness()
        h.step(d => wf.registerProfile(d, profileInput("p1")))
        h.step(d => wf.createTask(d, taskInput("tk-1")))
        h.step(d => wf.beginPlanning(d, "tk-1", "p1"))
        expect(h.task("tk-1").trace.at(-1)).toMatchObject({ kind: "task.planning", profileId: "p1", message: "Planning with Profile p1 (claude) on n-p1" })
        h.step(d => wf.recordPlan(d, "tk-1", plan([workstream("a", "api")], { source: "cli", profileId: "p1" })))
        expect(h.task("tk-1").trace.map(e => e.kind)).toEqual(["task.created", "task.planning", "task.planned"])

        h.step(d => wf.beginPlanning(d, "tk-1", null))
        h.step(d => wf.recordPlan(d, "tk-1", plan([workstream("a", "api")], { warnings: ["Planner fallback: the planner call failed"], feedback: "Keep  it\nsmall." })))
        const [fallback, planned] = h.task("tk-1").trace.slice(-2)
        expect(fallback).toMatchObject({ kind: "task.planner_fallback", message: "Planner fallback: the planner call failed", profileId: null })
        expect(planned!.kind).toBe("task.planned")
        expect(planned!.message).toStartWith('Re-planned with feedback: "Keep it small.". Plan v2 from the fallback planner')
        // A planning hold without a profile writes no planning trace.
        expect(h.task("tk-1").trace.filter(e => e.kind === "task.planning")).toHaveLength(1)
    })

    test("cannot re-plan once started", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        expect(h.step(d => wf.recordPlan(d, taskId, plan([workstream("a", "api")])))).toEqual({ ok: false, reason: "task_not_plannable" })
        expect(h.step(d => wf.beginPlanning(d, taskId, null))).toEqual({ ok: false, reason: "task_not_plannable" })
    })

    test("a planning hold takes a slot until the plan lands or the hold expires", () => {
        const h = harness()
        h.step(d => wf.registerProfile(d, profileInput("p1")))
        h.step(d => wf.createTask(d, taskInput("tk-1")))
        h.step(d => wf.createTask(d, taskInput("tk-2")))
        expect(h.step(d => wf.beginPlanning(d, "tk-1", "p1"))).toEqual({ ok: true, until: T0 + wf.WORKFORCE_TIMING.planningHoldMs })
        expect(h.task("tk-1").status).toBe("planning")
        expect(h.step(d => wf.beginPlanning(d, "tk-2", "p1"))).toEqual({ ok: false, reason: "over_capacity" })
        expect(wf.nextDeadline(h.state)).toBe(T0 + wf.WORKFORCE_TIMING.planningHoldMs)
        h.step(d => wf.recordPlan(d, "tk-1", plan([workstream("a", "api")], { source: "cli", profileId: "p1" })))
        expect(h.profile("p1").planningHold).toBeNull()
        expect(h.task("tk-1").plan).toEqual({ source: "cli", profileId: "p1", rationale: "Separable work.", warnings: [] })

        expect(h.step(d => wf.beginPlanning(d, "tk-2", "p1"))).toMatchObject({ ok: true })
        h.advance(wf.WORKFORCE_TIMING.planningHoldMs)
        h.step(() => undefined)
        expect(h.profile("p1").planningHold).toBeNull()
        expect(h.task("tk-2").status).toBe("draft")
        expect(h.task("tk-2").trace.at(-1)!.kind).toBe("worker.blocked")
    })
})

describe("reserveWorkers", () => {
    test("issues fenced leases, spawn outbox items and agent names", () => {
        const h = harness()
        const taskId = h.setup()
        const result = h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p2"]
        ])
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.leases.map(lease => [lease.id, lease.epoch, lease.agentName, lease.state])).toEqual([
            ["ls-1", 1, "w-tk1-api-e1", "reserved"],
            ["ls-2", 2, "w-tk1-web-e2", "reserved"]
        ])
        expect(h.state.epoch).toBe(2)
        expect(h.task(taskId).status).toBe("starting")
        expect(h.task(taskId).workstreams.map(ws => [ws.status, ws.leaseId])).toEqual([
            ["active", "ls-1"],
            ["active", "ls-2"]
        ])
        const spawns = h.items({ kind: "spawn" })
        expect(spawns.map(item => item.id)).toEqual(["ob-ls-1-spawn", "ob-ls-2-spawn"])
        expect(spawns[0]!.payload).toMatchObject({ agentName: "w-tk1-api-e1", nodeName: "n-p1", cli: "claude", branch: "morrow/ws-api/api", handoff: false })
        expect(h.view().profiles.p1).toMatchObject({ availability: "busy", activeLeases: 1 })
        expect(h.task(taskId).trace.filter(entry => entry.kind === "worker.reserved")).toHaveLength(2)
    })

    test("all-or-nothing: one bad pick reserves nothing and every pick says why", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2", "p3"] })
        h.step(d => wf.markProfileLimited(d, "p2", T0 + 60_000, "quota", "detected"))
        const before = h.state
        const result = h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p2"]
        ])
        expect(result).toEqual({
            ok: false,
            reason: "invalid_picks",
            picks: [
                { workstreamId: "ws-api", profileId: "p1", ok: true, reason: null },
                { workstreamId: "ws-web", profileId: "p2", ok: false, reason: "profile_limited" }
            ]
        })
        expect(h.state).toEqual(before)
        expect(h.state.epoch).toBe(0)
    })

    test("rejection reasons", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2", "p3", "p4", "p5"], roles: ["api", "web", "tests"] })
        h.step(d => wf.updateProfileHealth(d, "p2", { auth: "ok", online: false, observedAt: T0 }))
        h.step(d => wf.updateProfileHealth(d, "p3", { auth: "auth_required", online: true, observedAt: T0 }))
        h.step(d => wf.registerProfile(d, profileInput("p4", { scopes: ["other-project"] })))
        const reasons = (picks: [string, string][]) => {
            const result = h.reserve(taskId, picks)
            return result.ok ? "ok" : result.picks.map(pick => pick.reason)
        }
        expect(reasons([["ws-api", "nope"]])).toEqual(["unknown_profile"])
        expect(reasons([["ws-api", "p2"]])).toEqual(["profile_offline"])
        expect(reasons([["ws-api", "p3"]])).toEqual(["profile_auth_required"])
        expect(reasons([["ws-api", "p4"]])).toEqual(["out_of_scope"])
        expect(reasons([["ws-zzz", "p1"]])).toEqual(["unknown_workstream"])
        expect(reasons([
            ["ws-api", "p1"],
            ["ws-web", "p1"]
        ])).toEqual([null, "over_capacity"])
        expect(reasons([
            ["ws-api", "p1"],
            ["ws-api", "p5"]
        ])).toEqual([null, "duplicate_workstream"])
        expect(reasons([["ws-api", "p1"]])).toBe("ok")
        expect(reasons([["ws-api", "p5"]])).toEqual(["already_leased"])
        expect(reasons([["ws-web", "p5"]])).toBe("ok")
        expect(reasons([["ws-web", "p1"]])).toEqual(["already_leased"])
        expect(h.step(d => wf.reserveWorkers(d, "tk-none", [{ workstreamId: "ws-api", profileId: "p1" }]))).toMatchObject({
            ok: false,
            picks: [{ reason: "unknown_task" }]
        })
        h.step(d => wf.createTask(d, taskInput("tk-draft")))
        expect(h.step(d => wf.reserveWorkers(d, "tk-draft", [{ workstreamId: "x", profileId: "p1" }]))).toMatchObject({
            ok: false,
            picks: [{ reason: "task_not_startable" }]
        })
    })

    test("maxConcurrent > 1 allows parallel leases on one profile; busy only when full", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1"], maxConcurrent: 2 })
        expect(h.reserve(taskId, [["ws-api", "p1"]]).ok).toBe(true)
        expect(h.view().profiles.p1).toMatchObject({ availability: "ready", activeLeases: 1 })
        expect(h.reserve(taskId, [["ws-web", "p1"]]).ok).toBe(true)
        expect(h.view().profiles.p1).toMatchObject({ availability: "busy", activeLeases: 2 })
    })
})

describe("addWorkstream", () => {
    const add = (profileId: string | string[], overrides: Partial<{ title: string; brief: string; byUserId: string; maxLive: number }> = {}) => ({
        profileIds: typeof profileId === "string" ? [profileId] : profileId,
        title: "Add tests",
        brief: "ada added you to this task. Add tests for the API.",
        byUserId: "u-1001",
        maxLive: 5,
        ...overrides
    })

    test("adds a workstream, its lease and its spawn in one step on a running task", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2"] })
        expect(h.reserve(taskId, [["ws-api", "p1"]]).ok).toBe(true)
        const result = h.step(d => wf.addWorkstream(d, taskId, add("p2")))
        expect(result).toEqual({
            ok: true,
            workstreamId: "ws-helper",
            lease: expect.objectContaining({ id: "ls-2", epoch: 2, agentName: "w-tk1-helper-e2", profileId: "p2", workstreamId: "ws-helper", state: "reserved" })
        })
        const added = h.task(taskId).workstreams.find(ws => ws.id === "ws-helper")!
        expect(added).toMatchObject({
            role: "helper",
            title: "Add tests",
            brief: "ada added you to this task. Add tests for the API.",
            branch: "morrow/tk1/helper",
            dependsOn: [],
            ownership: ["**"],
            status: "active",
            leaseId: "ls-2"
        })
        const spawn = h.items({ kind: "spawn", leaseId: "ls-2" })
        expect(spawn).toHaveLength(1)
        expect(spawn[0]!.payload).toMatchObject({ agentName: "w-tk1-helper-e2", workstreamId: "ws-helper", branch: "morrow/tk1/helper", brief: added.brief, handoff: false })
        expect(h.task(taskId).trace.at(-1)).toMatchObject({ kind: "worker.reserved", leaseId: "ls-2", profileId: "p2" })
        expect(h.task(taskId).trace.at(-1)!.message).toContain("u-1001 added Profile p2 (claude)")
        expect(h.view().tasks[taskId]!.workstreams.map(ws => ws.id)).toEqual(["ws-api", "ws-web", "ws-helper"])
    })

    test("never reuses a role, id or branch", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2", "p3"], roles: ["api", "helper"] })
        expect(h.reserve(taskId, [["ws-api", "p1"]]).ok).toBe(true)
        expect(h.step(d => wf.addWorkstream(d, taskId, add("p2")))).toMatchObject({ ok: true, workstreamId: "ws-helper2" })
        expect(h.step(d => wf.addWorkstream(d, taskId, add("p3")))).toMatchObject({ ok: true, workstreamId: "ws-helper3" })
        const branches = h.task(taskId).workstreams.map(ws => ws.branch)
        expect(new Set(branches).size).toBe(branches.length)
    })

    test("the added worker holds verification back until it is done", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2"], roles: ["api"] })
        expect(h.reserve(taskId, [["ws-api", "p1"]]).ok).toBe(true)
        h.run("ls-1")
        expect(h.step(d => wf.addWorkstream(d, taskId, add("p2"))).ok).toBe(true)
        h.run("ls-2")
        expect(h.step(d => wf.completeWorkstream(d, "ls-1", 1, "abc1234", "api done"))).toEqual({ ok: true })
        expect(h.task(taskId).status).toBe("running")
        expect(h.step(d => wf.completeWorkstream(d, "ls-2", 2, "def5678", "tests done"))).toEqual({ ok: true })
        expect(h.task(taskId).status).toBe("verifying")
    })

    test("caps: the team's live cap and the workstream ceiling, not the task's maxAgents", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2", "p3", "p4"], maxAgents: 2 })
        expect(h.reserve(taskId, [["ws-api", "p1"]]).ok).toBe(true)
        expect(h.step(d => wf.addWorkstream(d, taskId, add("p2", { maxLive: 1 })))).toEqual({ ok: false, reason: "task_at_capacity" })
        expect(h.reserve(taskId, [["ws-web", "p2"]]).ok).toBe(true)
        // Two live workers on a task whose maxAgents is 2: maxAgents only sized the plan, so the team's cap decides.
        expect(h.step(d => wf.addWorkstream(d, taskId, add("p3", { maxLive: 2 })))).toEqual({ ok: false, reason: "task_at_capacity" })
        expect(h.step(d => wf.addWorkstream(d, taskId, add("p3", { maxLive: 3 }))).ok).toBe(true)

        const full = harness()
        const fullId = full.setup({ profiles: ["p1", "p2"], maxAgents: 5, roles: ["a", "b", "c", "d", "e"] })
        expect(full.reserve(fullId, [["ws-a", "p1"]]).ok).toBe(true)
        const before = full.state
        expect(full.step(d => wf.addWorkstream(d, fullId, add("p2")))).toEqual({ ok: false, reason: "too_many_workstreams" })
        expect(full.state).toEqual(before)
    })

    test("profile rules and task state", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2", "p3", "p4"] })
        const reason = (id: string, profileId: string) => {
            const result = h.step(d => wf.addWorkstream(d, id, add(profileId)))
            return result.ok ? "ok" : result.reason
        }
        // Planned, not started: the plan is still up for review.
        expect(reason(taskId, "p2")).toBe("task_not_running")
        expect(h.reserve(taskId, [["ws-api", "p1"]]).ok).toBe(true)
        h.step(d => wf.updateProfileHealth(d, "p2", { auth: "ok", online: false, observedAt: T0 }))
        h.step(d => wf.updateProfileHealth(d, "p3", { auth: "auth_required", online: true, observedAt: T0 }))
        h.step(d => wf.registerProfile(d, profileInput("p4", { scopes: ["other-project"] })))
        expect(reason(taskId, "nope")).toBe("unknown_profile")
        expect(reason(taskId, "p1")).toBe("over_capacity")
        expect(reason(taskId, "p2")).toBe("profile_offline")
        expect(reason(taskId, "p3")).toBe("profile_auth_required")
        expect(reason(taskId, "p4")).toBe("out_of_scope")
        h.step(d => wf.markProfileLimited(d, "p4", T0 + 60_000, "quota", "detected"))
        expect(reason(taskId, "p4")).toBe("profile_limited")
        expect(reason("tk-none", "p1")).toBe("unknown_task")

        h.step(d => wf.createTask(d, taskInput("tk-cmp", { strategy: "compare", maxAgents: 2 })))
        expect(reason("tk-cmp", "p1")).toBe("not_split")

        h.step(d => wf.cancelTask(d, taskId, "u-1001"))
        expect(reason(taskId, "p1")).toBe("task_not_running")
    })

    test("several candidates (a VM): the best one that can take it, or no_eligible_profile", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2", "p3", "p4"], maxConcurrent: 2 })
        expect(h.reserve(taskId, [["ws-api", "p2"]]).ok).toBe(true)
        h.step(d => wf.updateProfileHealth(d, "p1", { auth: "ok", online: false, observedAt: T0 }))
        h.step(d => wf.updateProfileHealth(d, "p3", { auth: "unknown", online: true, observedAt: T0 }))
        h.step(d => wf.updateProfileHealth(d, "p4", { auth: "ok", online: true, observedAt: T0 }))
        h.step(d => wf.updateProfileHealth(d, "p2", { auth: "ok", online: true, observedAt: T0 }))
        // p1 is offline; p4 beats p2 (more free slots) and p3 (not known to be signed in).
        expect(h.step(d => wf.addWorkstream(d, taskId, add(["p1", "p2", "p3", "p4"])))).toMatchObject({ ok: true, lease: { profileId: "p4" } })
        h.step(d => wf.markProfileLimited(d, "p2", T0 + 60_000, "quota", "detected"))
        h.step(d => wf.markProfileLimited(d, "p3", T0 + 60_000, "quota", "detected"))
        h.step(d => wf.markProfileLimited(d, "p4", T0 + 60_000, "quota", "detected"))
        expect(h.step(d => wf.addWorkstream(d, taskId, add(["p1", "p2", "p3", "p4"])))).toEqual({ ok: false, reason: "no_eligible_profile" })
    })

    test("a manual task only takes one of its pins", () => {
        const h = harness()
        for (const id of ["p1", "p2", "p3"]) h.step(d => wf.registerProfile(d, profileInput(id)))
        h.step(d => wf.createTask(d, taskInput("tk-man", { mode: "manual", pins: ["p1", "p3"] })))
        h.step(d => wf.recordPlan(d, "tk-man", plan([workstream("ws-api", "api")])))
        expect(h.reserve("tk-man", [["ws-api", "p1"]]).ok).toBe(true)
        expect(h.step(d => wf.addWorkstream(d, "tk-man", add("p2")))).toEqual({ ok: false, reason: "not_pinned" })
        expect(h.step(d => wf.addWorkstream(d, "tk-man", add("p3"))).ok).toBe(true)
    })
})

describe("spawn status and outbox", () => {
    test("running, failed and exited reports move lease, workstream and task", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2", "p3"], roles: ["api", "web", "tests"] })
        h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p2"],
            ["ws-tests", "p3"]
        ])
        h.run("ls-1")
        expect(h.lease("ls-1")).toMatchObject({ state: "running", expiresAt: null, spawnInvocationId: "inv-1" })
        expect(h.task(taskId).status).toBe("running")
        expect(h.step(d => wf.recordSpawnStatus(d, "ls-2", 2, "failed", null))).toEqual({ ok: true })
        expect(h.lease("ls-2").state).toBe("failed")
        expect(h.task(taskId).workstreams[1]!.status).toBe("pending")
        expect(h.items({ leaseId: "ls-2", kind: "spawn" })[0]!.state).toBe("cancelled")
        expect(h.items({ leaseId: "ls-2", kind: "release" })).toHaveLength(0)
        h.run("ls-3")
        expect(h.step(d => wf.recordSpawnStatus(d, "ls-3", 3, "exited", null))).toEqual({ ok: true })
        expect(h.lease("ls-3").state).toBe("expired")
        expect(h.task(taskId).workstreams[2]!.status).toBe("handoff")
        expect(h.task(taskId).status).toBe("handoff")
        const release = h.items({ leaseId: "ls-3", kind: "release" })[0]!
        const checkpoint = h.items({ leaseId: "ls-3", kind: "checkpoint" })[0]!
        expect(checkpoint.blockedBy).toBe(release.id)
        expect(checkpoint.hardBlock).toBe(false)
        expect(h.step(d => wf.recordSpawnStatus(d, "ls-3", 3, "running", null))).toEqual({ ok: false, reason: "lease_not_active" })
    })

    test("an ended lease keeps why it ended; the backend's detail reaches the lease and the trace, never the view", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2", "p3"], roles: ["api", "web", "tests"] })
        h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p2"],
            ["ws-tests", "p3"]
        ])
        // A live lease has no end reason.
        h.run("ls-1")
        expect(h.lease("ls-1").endReason ?? null).toBeNull()
        expect(h.step(d => wf.recordSpawnStatus(d, "ls-1", 1, "exited", null, "CLI not signed in (login expired)"))).toEqual({ ok: true })
        expect(h.lease("ls-1")).toMatchObject({ state: "expired", endReason: "agent exited: CLI not signed in (login expired)" })
        expect(h.task(taskId).trace.at(-1)).toMatchObject({
            kind: "worker.offline",
            leaseId: "ls-1",
            message: expect.stringContaining("exited before finishing (CLI not signed in (login expired)); its workstream needs a handoff")
        })
        // Without a detail (older backends send five arguments) the reason is still kept.
        expect(h.step(d => wf.recordSpawnStatus(d, "ls-2", 2, "failed", null))).toEqual({ ok: true })
        expect(h.lease("ls-2")).toMatchObject({ state: "failed", endReason: "spawn failed" })
        expect(h.task(taskId).trace.at(-1)!.message).toMatch(/failed to start$/)
        // A dispatcher failure records the error it saw, clipped to one line.
        const spawn = h.items({ leaseId: "ls-3", kind: "spawn" })[0]!
        h.step(d => wf.claimOutbox(d, 10))
        h.step(d => wf.completeOutbox(d, spawn.id, { ok: false, error: "Start worker: Claude Code is not signed in.\nRun claude /login", retryable: false }))
        expect(h.lease("ls-3")).toMatchObject({ state: "failed", endReason: "spawn failed: Start worker: Claude Code is not signed in. Run claude /login" })
        // Clipped to the limit, and never in the emitted view.
        h.step(d => wf.cancelTask(d, taskId, "u-1"))
        expect(h.lease("ls-1").endReason).toBe("agent exited: CLI not signed in (login expired)")
        for (const lease of Object.values(h.state.leases)) {
            expect(lease.endReason).toBeString()
            expect(lease.endReason!.length).toBeLessThanOrEqual(wf.WORKFORCE_LIMITS.leaseEndReasonChars)
        }
        for (const view of Object.values(h.view().leases)) expect(view).not.toHaveProperty("endReason")
    })

    test("claim hides items for the visibility timeout; completion is idempotent", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        const first = h.step(d => wf.claimOutbox(d, 10))
        expect(first.map(claim => [claim.id, claim.attempts])).toEqual([["ob-ls-1-spawn", 1]])
        expect(h.step(d => wf.claimOutbox(d, 10))).toEqual([])
        h.advance(wf.WORKFORCE_TIMING.visibilityTimeoutMs.spawn - 1)
        expect(h.step(d => wf.claimOutbox(d, 10))).toEqual([])
        h.advance(1)
        const again = h.step(d => wf.claimOutbox(d, 10))
        expect(again.map(claim => [claim.id, claim.attempts])).toEqual([["ob-ls-1-spawn", 2]])
        const ok = { ok: true as const, invocationId: "inv-9", sha: null, detail: null }
        expect(h.step(d => wf.completeOutbox(d, "ob-ls-1-spawn", ok))).toEqual({ ok: true, state: "done" })
        expect(h.lease("ls-1")).toMatchObject({ state: "spawning", spawnInvocationId: "inv-9" })
        expect(h.step(d => wf.completeOutbox(d, "ob-ls-1-spawn", { ok: false, error: "late", retryable: false }))).toEqual({ ok: true, state: "done" })
        expect(h.step(d => wf.completeOutbox(d, "nope", ok))).toEqual({ ok: false, reason: "unknown_item" })
    })

    test("respects the claim limit and oldest-first order", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2"] })
        h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p2"]
        ])
        expect(h.step(d => wf.claimOutbox(d, 1)).map(claim => claim.id)).toEqual(["ob-ls-1-spawn"])
        expect(h.step(d => wf.claimOutbox(d, 5)).map(claim => claim.id)).toEqual(["ob-ls-2-spawn"])
    })

    test("pending items cannot be completed; retryable failures back off exponentially; attempts are capped", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        const id = "ob-ls-1-spawn"
        expect(h.step(d => wf.completeOutbox(d, id, { ok: true, invocationId: null, sha: null, detail: null }))).toEqual({ ok: false, reason: "not_claimed" })
        const delays: number[] = []
        for (let attempt = 1; attempt < wf.WORKFORCE_TIMING.outboxMaxAttempts; attempt++) {
            expect(h.step(d => wf.claimOutbox(d, 1)).map(claim => claim.attempts)).toEqual([attempt])
            expect(h.step(d => wf.completeOutbox(d, id, { ok: false, error: "relay 503", retryable: true }))).toEqual({ ok: true, state: "pending" })
            const item = h.items({ kind: "spawn" })[0]!
            delays.push(item.nextAt - h.now)
            expect(h.step(d => wf.claimOutbox(d, 1))).toEqual([])
            h.advance(item.nextAt - h.now)
        }
        expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000])
        expect(h.step(d => wf.claimOutbox(d, 1)).map(claim => claim.attempts)).toEqual([8])
        expect(h.step(d => wf.completeOutbox(d, id, { ok: false, error: "relay 503", retryable: true }))).toEqual({ ok: true, state: "failed" })
        expect(h.lease("ls-1").state).toBe("failed")
        expect(h.task(taskId).workstreams[0]).toMatchObject({ status: "pending", leaseId: "ls-1" })
        expect(h.task(taskId).status).toBe("planned")
        expect(h.task(taskId).trace.at(-1)).toMatchObject({ kind: "worker.blocked", leaseId: "ls-1", epoch: 1 })
        // The workstream can be started again with a fresh epoch.
        const retry = h.reserve(taskId, [["ws-api", "p1"]])
        expect(retry.ok && retry.leases[0]!.epoch).toBe(2)
    })

    test("a dispatcher that keeps crashing: the unstarted lease times out, then its release gives up after max attempts", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        // Crashed spawn claims come back after the spawn visibility timeout, but the lease start timeout ends first.
        expect(h.step(d => wf.claimOutbox(d, 1))).toHaveLength(1)
        h.advance(wf.WORKFORCE_TIMING.leaseStartTimeoutMs)
        const afterTimeout = h.step(d => wf.claimOutbox(d, 10))
        expect(afterTimeout.map(claim => claim.kind)).toEqual(["release"])
        expect(h.items({ kind: "spawn" })[0]!.state).toBe("cancelled")
        expect(["expired", "failed"]).toContain(h.lease("ls-1").state)
        // The release keeps crashing too: it is retried on its own visibility timeout until attempts run out.
        for (let i = 1; i < wf.WORKFORCE_TIMING.outboxMaxAttempts; i++) {
            h.advance(wf.WORKFORCE_TIMING.visibilityTimeoutMs.release)
            expect(h.step(d => wf.claimOutbox(d, 10)).map(claim => claim.kind)).toEqual(["release"])
        }
        h.advance(wf.WORKFORCE_TIMING.visibilityTimeoutMs.release)
        expect(h.step(d => wf.claimOutbox(d, 10))).toEqual([])
        expect(h.items({ kind: "release" })[0]).toMatchObject({ state: "failed" })
    })

    test("non-retryable failure fails at once", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        h.step(d => wf.claimOutbox(d, 1))
        expect(h.step(d => wf.completeOutbox(d, "ob-ls-1-spawn", { ok: false, error: "bad node", retryable: false }))).toEqual({ ok: true, state: "failed" })
        expect(h.lease("ls-1").state).toBe("failed")
    })

    test("a lease that ends while its spawn is in flight gets released once the spawn lands", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        h.step(d => wf.claimOutbox(d, 1))
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "quota", "detected"))
        const release = h.items({ kind: "release" })[0]!
        expect(release.blockedBy).toBe("ob-ls-1-spawn")
        expect(h.items({ kind: "spawn" })[0]!.state).toBe("inflight")
        expect(h.step(d => wf.claimOutbox(d, 10))).toEqual([])
        h.step(d => wf.completeOutbox(d, "ob-ls-1-spawn", { ok: true, invocationId: "inv", sha: null, detail: null }))
        expect(h.lease("ls-1").state).toBe("expired")
        expect(h.step(d => wf.claimOutbox(d, 10)).map(claim => claim.kind)).toEqual(["release"])
    })

    test("a pending spawn for a dead lease is cancelled, never dispatched", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        h.step(d => wf.cancelTask(d, taskId, "u-1001"))
        expect(h.items({ kind: "spawn" })[0]!.state).toBe("cancelled")
        expect(h.items({ kind: "release" })).toHaveLength(0)
        expect(h.step(d => wf.claimOutbox(d, 10))).toEqual([])
    })

    test("re-claiming an in-flight spawn after its lease died cancels it and frees the release", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        h.step(d => wf.claimOutbox(d, 1))
        h.step(d => wf.cancelTask(d, taskId, "u-1001"))
        h.advance(wf.WORKFORCE_TIMING.visibilityTimeoutMs.spawn)
        expect(h.step(d => wf.claimOutbox(d, 10)).map(claim => claim.kind)).toEqual(["release"])
        expect(h.items({ kind: "spawn" })[0]!.state).toBe("cancelled")
        // A late success for the cancelled spawn still queues another release.
        h.step(d => wf.completeOutbox(d, "ob-ls-1-release", { ok: true, invocationId: null, sha: null, detail: null }))
        expect(h.step(d => wf.completeOutbox(d, "ob-ls-1-spawn", { ok: true, invocationId: null, sha: null, detail: null }))).toEqual({ ok: true, state: "cancelled" })
        expect(h.items({ kind: "release", state: "pending" }).map(item => item.id)).toEqual(["ob-ls-1-release-2"])
    })
})

describe("limits, handoff and fencing", () => {
    function started() {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2", "p3"] })
        // p3 lives on p1's environment: a limit on p1 must not touch it.
        h.step(d => wf.registerProfile(d, profileInput("p3", { envId: "env-p1", nodeName: "n-p1", cli: "codex" })))
        h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p3"]
        ])
        h.run("ls-1")
        h.run("ls-2")
        return { h, taskId }
    }

    test("markProfileLimited cools down only that profile and hands off its workstreams", () => {
        const { h, taskId } = started()
        const result = h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "5-hour limit reached", "detected"))
        expect(result).toEqual({ ok: true, cooldownUntil: T0 + 60_000, expiredLeaseIds: ["ls-1"] })
        expect(h.profile("p1")).toMatchObject({ availability: "limited", cooldownUntil: T0 + 60_000, limitedSource: "detected", limitedReason: "5-hour limit reached" })
        expect(h.profile("p3").availability).toBe("ready")
        expect(h.lease("ls-2").state).toBe("running")
        expect(h.lease("ls-1").state).toBe("expired")
        expect(h.task(taskId).workstreams.map(ws => ws.status)).toEqual(["handoff", "active"])
        expect(h.task(taskId).status).toBe("handoff")
        const trace = h.task(taskId).trace.at(-1)!
        expect(trace).toMatchObject({ kind: "worker.quota_limited", leaseId: "ls-1", profileId: "p1", epoch: 1 })
        expect(trace.message).toContain("[detected]")
        expect(h.items({ leaseId: "ls-1" }).map(item => [item.kind, item.state])).toEqual([
            ["spawn", "cancelled"],
            ["release", "pending"],
            ["checkpoint", "pending"]
        ])
        expect(h.view().profiles.p1).toMatchObject({ availability: "limited", limitedSource: "detected", activeLeases: 0 })
        expect(wf.nextDeadline(h.state)).toBe(T0 + 60_000)
    })

    test("a later limit extends the cooldown, an earlier one does not shorten it", () => {
        const { h } = started()
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "a", "detected"))
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 30_000, "b", "detected"))
        expect(h.profile("p1").cooldownUntil).toBe(T0 + 60_000)
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 90_000, "c", "manual"))
        expect(h.profile("p1")).toMatchObject({ cooldownUntil: T0 + 90_000, limitedSource: "manual" })
    })

    test("the sweep restores a due cooldown and traces it; the worker is not reintroduced", () => {
        const { h, taskId } = started()
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "quota", "detected"))
        h.advance(59_999)
        expect(h.step(d => wf.sweep(d))).toEqual({ restored: [], expired: [] })
        h.advance(1)
        expect(h.step(d => wf.sweep(d)).restored).toEqual([])
        expect(h.profile("p1")).toMatchObject({ availability: "ready", cooldownUntil: null, limitedReason: null, limitedSource: null })
        expect(h.task(taskId).trace.some(entry => entry.kind === "worker.capacity_restored")).toBe(true)
        expect(h.task(taskId).workstreams[0]!.status).toBe("handoff")
    })

    test("handoff: checkpoint from the dead lease, one replacement, ack, completion", () => {
        const { h, taskId } = started()
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "quota", "detected"))
        // Backend checkpoints the stopped worker's tree under its (still current) old epoch.
        expect(h.step(d => wf.reportCheckpoint(d, "ls-1", 1, "abc1234", "wip"))).toEqual({ ok: true })
        expect(h.task(taskId).workstreams[0]!.lastCheckpoint).toMatchObject({ sha: "abc1234", epoch: 1 })

        expect(h.step(d => wf.requestHandoff(d, taskId, "ws-api", 0, "p2"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(h.step(d => wf.requestHandoff(d, taskId, "ws-web", 2, "p2"))).toEqual({ ok: false, reason: "not_in_handoff" })
        expect(h.step(d => wf.requestHandoff(d, taskId, "ws-api", 1, "p1"))).toEqual({ ok: false, reason: "profile_limited" })
        const handoff = h.step(d => wf.requestHandoff(d, taskId, "ws-api", 1, "p2"))
        expect(handoff.ok && handoff.lease).toMatchObject({ id: "ls-3", epoch: 3, agentName: "w-tk1-api-e3", profileId: "p2" })
        // A second, differently keyed request for the same dead epoch is stale: no duplicate replacement.
        expect(h.step(d => wf.requestHandoff(d, taskId, "ws-api", 1, "p2"))).toEqual({ ok: false, reason: "stale_epoch" })

        const brief = h.items({ leaseId: "ls-3", kind: "handoff_brief" })[0]!
        const spawn = h.items({ leaseId: "ls-3", kind: "spawn" })[0]!
        expect(brief.blockedBy).toBe("ob-ls-1-checkpoint")
        expect(spawn).toMatchObject({ blockedBy: brief.id, hardBlock: true })
        expect(spawn.payload).toMatchObject({ handoff: true })
        expect(h.task(taskId).workstreams[0]).toMatchObject({ status: "handoff", leaseId: "ls-3" })

        // Old epoch is fenced out everywhere now.
        expect(h.step(d => wf.reportCheckpoint(d, "ls-1", 1, "def5678", "late"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(h.step(d => wf.completeWorkstream(d, "ls-1", 1, "def5678", "late"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(h.step(d => wf.ackHandoff(d, "ls-1", 1))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(h.step(d => wf.ackHandoff(d, "ls-3", 2))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(h.step(d => wf.ackHandoff(d, "ls-404", 3))).toEqual({ ok: false, reason: "unknown_lease" })
        expect(h.step(d => wf.completeWorkstream(d, "ls-3", 3, "fff0000", "too early"))).toEqual({ ok: false, reason: "handoff_not_acked" })

        // Dispatch order: release -> checkpoint -> brief -> spawn.
        const order: string[] = []
        for (let i = 0; i < 6; i++) {
            const claims = h.step(d => wf.claimOutbox(d, 10)).filter(claim => claim.leaseId === "ls-1" || claim.leaseId === "ls-3")
            for (const claim of claims) {
                order.push(claim.kind)
                h.step(d => wf.completeOutbox(d, claim.id, { ok: true, invocationId: null, sha: claim.kind === "checkpoint" ? "abc1234" : null, detail: null }))
            }
        }
        expect(order).toEqual(["release", "checkpoint", "handoff_brief", "spawn"])

        expect(h.step(d => wf.ackHandoff(d, "ls-3", 3))).toEqual({ ok: true })
        expect(h.step(d => wf.ackHandoff(d, "ls-3", 3))).toEqual({ ok: true })
        expect(h.lease("ls-3").state).toBe("running")
        expect(h.task(taskId).status).toBe("running")
        expect(h.step(d => wf.completeWorkstream(d, "ls-3", 3, "fedcba9", "api done"))).toEqual({ ok: true })
        expect(h.step(d => wf.completeWorkstream(d, "ls-3", 3, "fedcba9", "again"))).toEqual({ ok: false, reason: "workstream_done" })
        expect(h.lease("ls-3").state).toBe("released")
        expect(h.items({ leaseId: "ls-3", kind: "release" })).toHaveLength(1)
        expect(h.step(d => wf.completeWorkstream(d, "ls-2", 2, "0123abc", "web done"))).toEqual({ ok: true })
        expect(h.task(taskId).status).toBe("verifying")
        const kinds = h.task(taskId).trace.map(entry => entry.kind)
        for (const kind of ["worker.quota_limited", "task.checkpointed", "task.handoff_requested", "task.handoff_acked"] as const) expect(kinds).toContain(kind)
    })

    test("a failed handoff brief fails the replacement; a new handoff can then follow the failed epoch", () => {
        const { h, taskId } = started()
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "quota", "detected"))
        h.step(d => wf.requestHandoff(d, taskId, "ws-api", 1, "p2"))
        // The old worker's release and checkpoint both fail (VM gone); they only delay the brief.
        for (let round = 0; round < 2; round++)
            for (const claim of h.step(d => wf.claimOutbox(d, 10)).filter(claim => claim.leaseId === "ls-1"))
                h.step(d => wf.completeOutbox(d, claim.id, { ok: false, error: "vm paused", retryable: false }))
        const claims = h.step(d => wf.claimOutbox(d, 10)).filter(claim => claim.leaseId === "ls-3")
        expect(claims.map(claim => claim.kind)).toEqual(["handoff_brief"])
        h.step(d => wf.completeOutbox(d, claims[0]!.id, { ok: false, error: "push rejected", retryable: false }))
        expect(h.items({ leaseId: "ls-3", kind: "spawn" })[0]!.state).toBe("failed")
        expect(h.lease("ls-3").state).toBe("failed")
        expect(h.task(taskId).workstreams[0]).toMatchObject({ status: "handoff", leaseId: "ls-3" })
        const next = h.step(d => wf.requestHandoff(d, taskId, "ws-api", 3, "p2"))
        expect(next.ok && next.lease.epoch).toBe(4)
    })

    test("fence rejects reports for leases that never ran or were released", () => {
        const { h, taskId } = started()
        h.step(d => wf.completeWorkstream(d, "ls-2", 2, "aaaaaaa", "done"))
        expect(h.step(d => wf.reportCheckpoint(d, "ls-2", 2, "bbbbbbb", "x"))).toEqual({ ok: false, reason: "workstream_done" })
        h.step(d => wf.recordSpawnStatus(d, "ls-1", 1, "failed", null))
        expect(h.task(taskId).workstreams[0]!.status).toBe("pending")
        expect(h.step(d => wf.reportCheckpoint(d, "ls-1", 1, "ccccccc", "x"))).toEqual({ ok: false, reason: "lease_not_active" })
        expect(h.step(d => wf.ackHandoff(d, "ls-1", 1))).toEqual({ ok: false, reason: "lease_not_active" })
    })

    test("an older epoch's checkpoint never replaces a newer one", () => {
        const { h, taskId } = started()
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "quota", "detected"))
        h.step(d => wf.requestHandoff(d, taskId, "ws-api", 1, "p2"))
        h.step(d => wf.ackHandoff(d, "ls-3", 3))
        h.step(d => wf.reportCheckpoint(d, "ls-3", 3, "1111111", "new"))
        // The old worker's checkpoint item lands late.
        const kinds: string[] = []
        for (let round = 0; round < 4; round++)
            for (const claim of h.step(d => wf.claimOutbox(d, 10))) {
                kinds.push(claim.kind)
                h.step(d => wf.completeOutbox(d, claim.id, { ok: true, invocationId: null, sha: claim.kind === "checkpoint" ? "0000000" : null, detail: null }))
            }
        expect(kinds).toContain("checkpoint")
        expect(h.task(taskId).workstreams[0]!.lastCheckpoint).toMatchObject({ sha: "1111111", epoch: 3 })
    })
})

describe("cancel, verification and sweeps", () => {
    test("cancel releases live leases, fails open workstreams and is terminal", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p2"]
        ])
        h.run("ls-1")
        expect(h.step(d => wf.cancelTask(d, taskId, "u-1001"))).toEqual({ ok: true, releasedLeaseIds: ["ls-1", "ls-2"] })
        expect(h.task(taskId).status).toBe("cancelled")
        expect(h.task(taskId).workstreams.map(ws => ws.status)).toEqual(["failed", "failed"])
        expect([h.lease("ls-1").state, h.lease("ls-2").state]).toEqual(["released", "released"])
        // Only the agent that may exist gets a release.
        expect(h.items({ kind: "release" }).map(item => item.leaseId)).toEqual(["ls-1"])
        expect(h.task(taskId).trace.at(-1)).toMatchObject({ kind: "task.cancelled", message: "Cancelled by u-1001" })
        expect(h.step(d => wf.cancelTask(d, taskId, "u-1001"))).toEqual({ ok: false, reason: "task_terminal" })
        expect(h.view().profiles.p1!.availability).toBe("ready")
    })

    describe("deleteTask", () => {
        test("an ended task goes with its ended leases and finished outbox items; the view drops it", () => {
            const h = harness()
            const taskId = h.setup()
            h.reserve(taskId, [
                ["ws-api", "p1"],
                ["ws-web", "p2"]
            ])
            h.step(d => wf.cancelTask(d, taskId, "u-1001"))
            expect(h.items().map(item => item.state)).toEqual(["cancelled", "cancelled"])
            expect(h.step(d => wf.deleteTask(d, taskId, "u-1001"))).toEqual({ ok: true, releasedLeaseIds: [] })
            expect(h.state.tasks[taskId]).toBeUndefined()
            expect(h.state.leases).toEqual({})
            expect(h.state.outbox).toEqual({})
            expect(h.view().tasks).toEqual({})
            expect(h.view().leases).toEqual({})
        })

        test("a running task is cancelled first: leases released, agents told to stop, then the task goes", () => {
            const h = harness()
            const taskId = h.setup()
            h.reserve(taskId, [
                ["ws-api", "p1"],
                ["ws-web", "p2"]
            ])
            h.run("ls-1")
            expect(h.step(d => wf.deleteTask(d, taskId, "u-1001"))).toEqual({ ok: true, releasedLeaseIds: ["ls-1", "ls-2"] })
            expect(h.state.tasks[taskId]).toBeUndefined()
            // ls-1's agent may exist: its lease stays (released) until the release item finishes. ls-2 never started.
            expect(Object.keys(h.state.leases)).toEqual(["ls-1"])
            expect(h.lease("ls-1").state).toBe("released")
            expect(h.items({ state: "pending" }).map(item => [item.kind, item.leaseId])).toEqual([["release", "ls-1"]])
            expect(h.view().tasks).toEqual({})
            expect(h.view().leases).toEqual({})
            expect([h.view().profiles.p1!.availability, h.view().profiles.p2!.availability]).toEqual(["ready", "ready"])
            // The release still reaches its agent after the task is gone.
            const [claim] = h.step(d => wf.claimOutbox(d, 10))
            expect(claim).toMatchObject({ kind: "release", leaseId: "ls-1", taskId })
            expect(h.step(d => wf.completeOutbox(d, claim!.id, { ok: true, invocationId: null, sha: null, detail: "stopped" }))).toEqual({ ok: true, state: "done" })
        })

        test("a planning task gives back its planner's slot", () => {
            const h = harness()
            h.step(d => wf.registerProfile(d, profileInput("p1")))
            h.step(d => wf.createTask(d, taskInput("tk-1")))
            h.step(d => wf.beginPlanning(d, "tk-1", "p1"))
            expect(h.profile("p1").planningHold?.taskId).toBe("tk-1")
            expect(h.step(d => wf.deleteTask(d, "tk-1", "u-1001"))).toEqual({ ok: true, releasedLeaseIds: [] })
            expect(h.profile("p1").planningHold).toBeNull()
            expect(h.state.tasks["tk-1"]).toBeUndefined()
        })

        test("an unknown or already deleted task is refused and nothing changes", () => {
            const h = harness()
            const taskId = h.setup({ roles: ["api"] })
            expect(h.step(d => wf.deleteTask(d, "tk-nope", "u-1001"))).toEqual({ ok: false, reason: "unknown_task" })
            expect(h.state.tasks[taskId]).toBeDefined()
            expect(h.step(d => wf.deleteTask(d, taskId, "u-1001")).ok).toBe(true)
            const after = h.state
            expect(h.step(d => wf.deleteTask(d, taskId, "u-1001"))).toEqual({ ok: false, reason: "unknown_task" })
            expect(h.state).toEqual(after)
        })
    })

    test("verification: pending keeps verifying, passed completes, failed fails", () => {
        for (const [status, expected] of [
            ["pending", "verifying"],
            ["passed", "completed"],
            ["failed", "failed"]
        ] as const) {
            const h = harness()
            const taskId = h.setup({ roles: ["api"] })
            expect(h.step(d => wf.submitVerification(d, taskId, { status: "passed", checks: [] }))).toEqual({ ok: false, reason: "task_not_verifying" })
            h.reserve(taskId, [["ws-api", "p1"]])
            h.step(d => wf.completeWorkstream(d, "ls-1", 1, "abcdef0", "done"))
            const evidence = { status, checks: [{ name: "tests", status, detail: "bun test", url: null }] }
            expect(h.step(d => wf.submitVerification(d, taskId, evidence))).toEqual({ ok: true, status: expected })
            expect(h.task(taskId).verification).toEqual(evidence)
            expect(h.task(taskId).status).toBe(expected)
        }
    })

    describe("retryTask", () => {
        const failing: VerificationView = { status: "failed", checks: [{ name: "Tests pass", status: "failed", detail: "exited 1", url: null }] }

        /** Both workstreams done and verification failed. */
        function failedTask() {
            const h = harness()
            const taskId = h.setup()
            h.reserve(taskId, [
                ["ws-api", "p1"],
                ["ws-web", "p2"]
            ])
            h.step(d => wf.completeWorkstream(d, "ls-1", 1, "aaaaaaa", "api"))
            h.step(d => wf.completeWorkstream(d, "ls-2", 2, "bbbbbbb", "web"))
            expect(h.step(d => wf.submitVerification(d, taskId, failing))).toEqual({ ok: true, status: "failed" })
            return { h, taskId }
        }

        /** Test-only: rewrites the stored task (a failed task with unfinished workstreams is not reachable today). */
        function patchTask(h: ReturnType<typeof harness>, taskId: string, patch: (task: Task) => Partial<Task>) {
            h.step(d => d.putTask({ ...d.tasks[taskId]!, ...patch(d.tasks[taskId]!) }))
        }

        test("every workstream done: back to verifying with the old evidence cleared, then verification decides again", () => {
            const { h, taskId } = failedTask()
            h.advance(1_000)
            expect(h.step(d => wf.retryTask(d, taskId, "u-1001"))).toEqual({ ok: true, mode: "verify", reopenedWorkstreamIds: [] })
            const task = h.task(taskId)
            expect(task.status).toBe("verifying")
            expect(task.verification).toBeNull()
            expect(task.workstreams.map(ws => [ws.status, ws.lastCheckpoint?.sha])).toEqual([
                ["done", "aaaaaaa"],
                ["done", "bbbbbbb"]
            ])
            expect(task.trace.at(-1)).toMatchObject({ kind: "task.retried", at: T0 + 1_000, message: "Retry by u-1001: verifying the finished workstreams again" })
            // No lease, no outbox work: verification is the backend's job.
            expect(Object.values(h.state.leases).filter(wf.isLiveLease)).toEqual([])
            expect(h.items({ state: "pending" })).toEqual([])
            // Only from failed.
            expect(h.step(d => wf.retryTask(d, taskId, "u-1001"))).toEqual({ ok: false, reason: "task_not_failed" })
            expect(h.step(d => wf.submitVerification(d, taskId, { status: "passed", checks: [] }))).toEqual({ ok: true, status: "completed" })
            expect(h.step(d => wf.retryTask(d, taskId, "u-1001"))).toEqual({ ok: false, reason: "task_not_failed" })
            // And it can fail and be retried again.
            const again = failedTask()
            expect(again.h.step(d => wf.retryTask(d, again.taskId, "u-1")).ok).toBe(true)
            expect(again.h.step(d => wf.submitVerification(d, again.taskId, failing))).toEqual({ ok: true, status: "failed" })
            expect(again.h.step(d => wf.retryTask(d, again.taskId, "u-2")).ok).toBe(true)
            expect(again.h.task(again.taskId).trace.filter(e => e.kind === "task.retried")).toHaveLength(2)
        })

        test("unfinished workstreams go back to pending with branch and checkpoint; finished ones stay; new workers get new epochs", () => {
            const { h, taskId } = failedTask()
            patchTask(h, taskId, task => ({ workstreams: task.workstreams.map(ws => (ws.id === "ws-web" ? { ...ws, status: "failed" } : ws)) }))
            expect(h.step(d => wf.retryTask(d, taskId, "u-1001"))).toEqual({ ok: true, mode: "replan", reopenedWorkstreamIds: ["ws-web"] })
            let task = h.task(taskId)
            // One workstream is done and nothing is live: the derived started status.
            expect(task.status).toBe("running")
            expect(task.verification).toBeNull()
            const web = task.workstreams.find(ws => ws.id === "ws-web")!
            expect(web).toMatchObject({ status: "pending", leaseId: "ls-2", branch: "morrow/ws-web/web" })
            expect(web.lastCheckpoint?.sha).toBe("bbbbbbb")
            expect(task.workstreams.find(ws => ws.id === "ws-api")!.status).toBe("done")
            expect(task.trace.at(-1)).toMatchObject({ kind: "task.retried", message: "Retry by u-1001: 1 unfinished workstream will get new workers; 1 finished kept" })

            // The done workstream cannot be leased again; the reopened one can, under a fresh epoch.
            expect(h.reserve(taskId, [["ws-api", "p1"]])).toMatchObject({ ok: false, picks: [{ reason: "workstream_not_pending" }] })
            const reserved = h.reserve(taskId, [["ws-web", "p1"]])
            expect(reserved).toMatchObject({ ok: true, leases: [{ id: "ls-3", epoch: 3 }] })
            // The old lease's reports stay fenced out.
            expect(h.step(d => wf.completeWorkstream(d, "ls-2", 2, "ccccccc", "stale"))).toEqual({ ok: false, reason: "stale_epoch" })
            h.run("ls-3")
            expect(h.task(taskId).status).toBe("running")
            h.step(d => wf.completeWorkstream(d, "ls-3", 3, "ddddddd", "web again"))
            task = h.task(taskId)
            expect(task.status).toBe("verifying")
        })

        test("nothing finished: the task is planned again and Start works", () => {
            const { h, taskId } = failedTask()
            patchTask(h, taskId, task => ({ workstreams: task.workstreams.map(ws => ({ ...ws, status: "failed" })) }))
            expect(h.step(d => wf.retryTask(d, taskId, "u-1001"))).toEqual({ ok: true, mode: "replan", reopenedWorkstreamIds: ["ws-api", "ws-web"] })
            expect(h.task(taskId).status).toBe("planned")
            expect(h.task(taskId).trace.at(-1)!.message).toBe("Retry by u-1001: 2 unfinished workstreams will get new workers")
            expect(h.reserve(taskId, [["ws-api", "p1"], ["ws-web", "p2"]]).ok).toBe(true)
            expect(h.task(taskId).status).toBe("starting")
        })

        test("refuses unknown, unfinished, cancelled and plan-less tasks", () => {
            const h = harness()
            const taskId = h.setup()
            expect(h.step(d => wf.retryTask(d, "tk-nope", "u-1"))).toEqual({ ok: false, reason: "unknown_task" })
            expect(h.step(d => wf.retryTask(d, taskId, "u-1"))).toEqual({ ok: false, reason: "task_not_failed" })
            h.reserve(taskId, [["ws-api", "p1"]])
            expect(h.step(d => wf.retryTask(d, taskId, "u-1"))).toEqual({ ok: false, reason: "task_not_failed" })
            h.step(d => wf.cancelTask(d, taskId, "u-1"))
            expect(h.step(d => wf.retryTask(d, taskId, "u-1"))).toEqual({ ok: false, reason: "task_not_failed" })

            const empty = failedTask()
            patchTask(empty.h, empty.taskId, () => ({ workstreams: [] }))
            expect(empty.h.step(d => wf.retryTask(d, empty.taskId, "u-1"))).toEqual({ ok: false, reason: "no_workstreams" })
            expect(empty.h.task(empty.taskId).status).toBe("failed")
        })
    })

    test("a lease that never starts is failed by the sweep and its agent released", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        h.step(d => wf.claimOutbox(d, 1))
        h.step(d => wf.completeOutbox(d, "ob-ls-1-spawn", { ok: true, invocationId: null, sha: null, detail: null }))
        expect(wf.nextDeadline(h.state)).toBe(T0 + wf.WORKFORCE_TIMING.leaseStartTimeoutMs)
        h.advance(wf.WORKFORCE_TIMING.leaseStartTimeoutMs)
        const swept = h.step(d => wf.sweep(d))
        expect(swept.expired).toEqual([])
        expect(h.lease("ls-1").state).toBe("failed")
        expect(h.items({ kind: "release" })).toHaveLength(1)
        expect(h.task(taskId).workstreams[0]!.status).toBe("pending")
        expect(wf.nextDeadline(h.state)).toBeNull()
    })

    test("sweep is a no-op when nothing is due", () => {
        const h = harness()
        h.setup()
        const before = h.state
        const d = new wf.WorkforceDraft(before, h.now)
        expect(wf.sweep(d)).toEqual({ restored: [], expired: [] })
        wf.finalize(d)
        expect(d.changed.size).toBe(0)
    })
})

describe("bounds, invariants and the view", () => {
    test("finished tasks beyond the store cap are pruned with their leases; the view shows only recent ones", () => {
        const h = harness()
        h.step(d => wf.registerProfile(d, profileInput("p1")))
        const total = wf.WORKFORCE_LIMITS.storedTasks + 5
        for (let i = 0; i < total; i++) {
            const id = `tk-${i}`
            h.advance(1)
            h.step(d => {
                wf.createTask(d, taskInput(id))
                wf.cancelTask(d, id, "u-1")
            })
        }
        expect(Object.keys(h.state.tasks)).toHaveLength(wf.WORKFORCE_LIMITS.storedTasks)
        expect(h.state.tasks["tk-0"]).toBeUndefined()
        expect(h.state.tasks[`tk-${total - 1}`]).toBeDefined()
        const view = h.view()
        expect(Object.keys(view.tasks)).toHaveLength(wf.WORKFORCE_LIMITS.viewTerminalTasks)
        expect(Object.keys(view.tasks).at(-1)).toBe(`tk-${total - 1}`)
    })

    test("ended leases and finished outbox items are bounded; pinned ones stay", () => {
        const h = harness()
        h.step(d => wf.registerProfile(d, profileInput("p1")))
        const rounds = wf.WORKFORCE_LIMITS.terminalLeasesKept + 20
        for (let i = 0; i < rounds; i++) {
            const id = `tk-${i}`
            h.advance(1)
            h.step(d => {
                wf.createTask(d, taskInput(id, { maxAgents: 1 }))
                wf.recordPlan(d, id, plan([workstream("ws", "api")]))
                wf.reserveWorkers(d, id, [{ workstreamId: "ws", profileId: "p1" }])
                wf.recordSpawnStatus(d, `ls-${i + 1}`, i + 1, "running", null)
                wf.cancelTask(d, id, "u-1")
            })
        }
        // Every lease is still pinned by its (stored) task's workstream pointer.
        expect(Object.keys(h.state.leases)).toHaveLength(rounds)
        expect(Object.keys(h.state.outbox).length).toBeLessThanOrEqual(wf.WORKFORCE_LIMITS.finishedOutboxKept + rounds)
        const finished = Object.values(h.state.outbox).filter(item => item.state !== "pending" && item.state !== "inflight")
        expect(finished.length).toBeLessThanOrEqual(wf.WORKFORCE_LIMITS.finishedOutboxKept)
    })

    test("trace is capped per task", () => {
        const h = harness()
        h.step(d => wf.createTask(d, taskInput("tk-1")))
        h.step(d => {
            for (let i = 0; i < wf.WORKFORCE_LIMITS.traceEntries + 50; i++) wf.addTrace(d, "tk-1", "worker.blocked", `entry ${i}`)
        })
        expect(h.task("tk-1").trace).toHaveLength(wf.WORKFORCE_LIMITS.traceEntries)
        expect(h.task("tk-1").trace.at(-1)!.message).toBe(`entry ${wf.WORKFORCE_LIMITS.traceEntries + 49}`)
        h.step(d => wf.addTrace(d, "tk-1", "worker.blocked", "x".repeat(2000)))
        expect(h.task("tk-1").trace.at(-1)!.message.length).toBe(wf.WORKFORCE_LIMITS.traceMessageChars)
    })

    test("the view carries only the trace's tail; count, run start and retry come from the whole stored trace", () => {
        const h = harness()
        const taskId = h.setup()
        h.advance(1_000)
        h.reserve(taskId, [["ws-api", "p1"]])
        for (let i = 0; i < 40; i++) {
            h.advance(10)
            h.step(d => wf.addTrace(d, taskId, "task.checkpointed", `checkpoint ${i}`))
        }
        h.advance(10)
        h.step(d => wf.addTrace(d, taskId, "task.retried", "Retry by u-1"))
        for (let i = 0; i < 300; i++) h.step(d => wf.addTrace(d, taskId, "task.checkpointed", `late ${i}`))

        const stored = h.task(taskId)
        // created, planner fallback, planned, reserved, 40 checkpoints, the retry, 300 more.
        expect(stored.traceCount).toBe(4 + 40 + 1 + 300)
        expect(stored.trace).toHaveLength(wf.WORKFORCE_LIMITS.traceEntries)

        const view = h.view()
        const shown = view.tasks[taskId]!
        expect(shown.trace).toHaveLength(wf.WORKFORCE_LIMITS.viewTraceEntries)
        expect(shown.trace.at(-1)!.message).toBe("late 299")
        expect(shown.trace[0]!.message).toBe(`late ${300 - wf.WORKFORCE_LIMITS.viewTraceEntries}`)
        expect(shown.traceTotal).toBe(stored.traceCount)
        // Both markers dropped out of the stored trace too; the view keeps what the stored trace still says.
        expect(stored.trace.some(e => e.kind === "worker.reserved" || e.kind === "task.retried")).toBe(false)
        expect(shown.runStartedAt).toBeNull()
        expect(shown.retriedAt).toBeNull()
        expect(ContractWorkforceView.safeParse(view).success).toBe(true)

        // The read getter returns everything stored, numbered the same way.
        const full = wf.taskRecord(stored)
        expect(full.trace).toHaveLength(wf.WORKFORCE_LIMITS.traceEntries)
        expect(full.traceTotal).toBe(stored.traceCount)

        // The view holds no long text: exactly the contract's summary fields. The read getter keeps everything.
        const taskShape = ContractWorkforceView.shape.tasks.valueType.shape
        // A split task has no pick, so its view leaves that key out; only a compare task carries one.
        expect(Object.keys(shown).sort()).toEqual(Object.keys(taskShape).filter(k => k !== "pickedWorkstreamId").sort())
        // Likewise a split workstream is bound to no harness.
        expect(Object.keys(shown.workstreams[0]!).sort()).toEqual(Object.keys(taskShape.workstreams.element.shape).filter(k => k !== "harness").sort())
        const sent = JSON.stringify(view)
        for (const text of [stored.prompt, stored.plan!.rationale, stored.workstreams[0]!.brief, stored.workstreams[0]!.why, stored.workstreams[0]!.title])
            expect(sent).not.toContain(text)
        expect(full.workstreams).toEqual(stored.workstreams)
        expect(full.prompt).toBe(stored.prompt)

        // While the markers are still stored, they are reported even when the tail no longer holds them.
        const h2 = harness()
        const t2 = h2.setup()
        h2.advance(1_000)
        h2.reserve(t2, [["ws-api", "p1"]])
        const reserved2 = h2.now
        h2.advance(10)
        h2.step(d => wf.addTrace(d, t2, "task.retried", "Retry by u-1"))
        const retried2 = h2.now
        for (let i = 0; i < 50; i++) h2.step(d => wf.addTrace(d, t2, "task.checkpointed", `c ${i}`))
        const v2 = h2.view().tasks[t2]!
        expect(v2.trace.some(e => e.kind === "worker.reserved" || e.kind === "task.retried")).toBe(false)
        expect(v2.runStartedAt).toBe(reserved2)
        expect(v2.retriedAt).toBe(retried2)
        expect(v2.plannedAt).toBe(h2.task(t2).trace.findLast(e => e.kind === "task.planned")!.at)
    })

    test("a long history does not grow the emitted view", () => {
        const sized = (entries: number) => {
            const h = harness()
            h.step(d => wf.createTask(d, taskInput("tk-1")))
            for (let i = 0; i < entries; i++) h.step(d => wf.addTrace(d, "tk-1", "task.checkpointed", "x".repeat(wf.WORKFORCE_LIMITS.traceMessageChars)))
            const trace = h.view().tasks["tk-1"]!.trace
            expect(trace).toHaveLength(wf.WORKFORCE_LIMITS.viewTraceEntries)
            for (const entry of trace) expect(entry.message.length).toBeLessThanOrEqual(wf.WORKFORCE_LIMITS.viewTraceMessageChars)
            return JSON.stringify(trace).length
        }
        expect(sized(wf.WORKFORCE_LIMITS.viewTraceEntries)).toBe(sized(wf.WORKFORCE_LIMITS.traceEntries + 100))
    })

    test("a task stored before the trace count numbers its entries from what it holds", () => {
        const h = harness()
        h.step(d => wf.createTask(d, taskInput("tk-1")))
        h.step(d => wf.addTrace(d, "tk-1", "task.checkpointed", "one"))
        const { traceCount: _dropped, ...legacy } = h.task("tk-1")
        expect(wf.taskRecord(legacy).traceTotal).toBe(2)
        expect(wf.taskView(legacy).traceTotal).toBe(2)
        expect(wf.taskRecord(legacy).runStartedAt).toBeNull()
        const d = new wf.WorkforceDraft({ ...h.state, tasks: { "tk-1": legacy } }, h.now)
        wf.addTrace(d, "tk-1", "task.checkpointed", "two")
        expect(d.tasks["tk-1"]!.traceCount).toBe(3)
    })

    test("invariant checker flags broken states", () => {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [["ws-api", "p1"]])
        const lease = h.lease("ls-1")
        const state = h.state
        expect(wf.workforceInvariantViolations({ ...state, epoch: 0 })).toContain("lease ls-1 epoch 1 exceeds 0")
        expect(wf.workforceInvariantViolations({ ...state, leases: { ...state.leases, "ls-9": { ...lease, id: "ls-9" } } }).join()).toContain("two live leases")
        expect(wf.workforceInvariantViolations({ ...state, profiles: {} }).join()).toContain("has no profile")
        expect(wf.workforceInvariantViolations({ ...state, leases: {} }).join()).toContain("missing lease")
        expect(wf.workforceInvariantViolations({ ...state, leases: { "ls-1": { ...lease, state: "failed" } } }).join()).toContain("active workstream")
        const cancelled = { ...state.tasks[taskId]!, status: "cancelled" as const }
        expect(wf.workforceInvariantViolations({ ...state, tasks: { [taskId]: cancelled } }).join()).toContain("on cancelled task")
    })

    test("the view matches the contracts schema field for field and carries no internals", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2", "p3"] })
        h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p2"]
        ])
        h.run("ls-1")
        h.step(d => wf.reportCheckpoint(d, "ls-1", 1, "abc1234", "wip"))
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "quota", "detected"))
        h.step(d => wf.requestHandoff(d, taskId, "ws-api", 1, "p3"))
        const view = h.view()
        expect(ContractWorkforceView.parse(view)).toEqual(view)
        const json = JSON.stringify(view)
        for (const internal of ["planningHold", "nodeName\":\"n-p1\",\"cli", "outbox", "spawnInvocationId", "expiresAt", "generation", "checkpoints", "processed"])
            expect(json).not.toContain(internal)
        expect(Object.keys(view.profiles.p1!).sort()).toEqual(Object.keys(ContractWorkforceView.shape.profiles.valueType.shape).sort())
        expect(Object.keys(view.tasks[taskId]!).sort()).toEqual(Object.keys(ContractWorkforceView.shape.tasks.valueType.shape).filter(k => k !== "pickedWorkstreamId").sort())
        // `parentLeaseId` is only on subagent leases (docs/subagents.md).
        expect(Object.keys(view.leases["ls-1"]!).sort()).toEqual(
            Object.keys(ContractWorkforceView.shape.leases.valueType.shape)
                .filter(key => key !== "parentLeaseId")
                .sort()
        )
    })

    test("outbox backoff schedule", () => {
        expect([0, 1, 2, 3, 7, 8, 30].map(wf.outboxBackoffMs)).toEqual([1000, 1000, 2000, 4000, 60000, 60000, 60000])
    })
})

describe("merge conflict resolution", () => {
    const INTEGRATION = "morrow/tk1/integration"
    const conflicted: VerificationView = {
        status: "failed",
        checks: [
            { name: "Commits on GitHub", status: "passed", detail: "2 found", url: null },
            { name: "Merges cleanly", status: "failed", detail: "morrow/ws-web/web conflicts", url: null }
        ]
    }
    const conflict = (overrides: Partial<ConflictInput> = {}): ConflictInput => ({
        branch: "morrow/ws-web/web",
        workstreamId: "ws-web",
        integrationBranch: INTEGRATION,
        involvedWorkstreamIds: ["ws-web", "ws-api"],
        files: ["src/shared.ts"],
        brief: "Merge morrow/ws-web/web into the integration branch.",
        ...overrides
    })

    /** Both planned workstreams done (api by p1, web by p2): the task is verifying. */
    function verifyingTask(profiles = ["p1", "p2", "p3"]) {
        const h = harness()
        const taskId = h.setup({ profiles })
        h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p2"]
        ])
        h.step(d => wf.completeWorkstream(d, "ls-1", 1, "aaaaaaa", "api"))
        h.step(d => wf.completeWorkstream(d, "ls-2", 2, "bbbbbbb", "web"))
        expect(h.task(taskId).status).toBe("verifying")
        return { h, taskId }
    }

    const resolver = (h: ReturnType<typeof harness>, taskId: string) => h.task(taskId).workstreams.find(ws => ws.id === wf.RESOLVER_WORKSTREAM_ID)

    test("a conflict opens a resolution step: resolver workstream, pending evidence, trace, attempt 1", () => {
        const { h, taskId } = verifyingTask()
        h.advance(1_000)
        expect(h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict()))).toEqual({ ok: true, status: "resolving", attempt: 1 })
        const task = h.task(taskId)
        expect(task.status).toBe("resolving")
        expect(task.resolutionAttempts).toBe(1)
        expect(resolver(h, taskId)).toEqual({
            id: "ws-resolver",
            role: "resolver",
            title: "Resolve merge conflict",
            brief: "Merge morrow/ws-web/web into the integration branch.",
            why: `morrow/ws-web/web does not merge into ${INTEGRATION}.`,
            branch: INTEGRATION,
            dependsOn: ["ws-web", "ws-api"],
            ownership: ["**"],
            status: "pending",
            leaseId: null,
            lastCheckpoint: null
        })
        expect(task.verification?.status).toBe("pending")
        expect(task.verification?.checks.at(-1)).toEqual({
            name: "Conflict resolution",
            status: "pending",
            detail: `Attempt 1 of 2: a worker merges morrow/ws-web/web into ${INTEGRATION} and resolves the conflicts.`,
            url: null
        })
        expect(task.trace.at(-1)).toMatchObject({
            kind: "task.conflict_detected",
            at: T0 + 1_000,
            message: `morrow/ws-web/web does not merge into ${INTEGRATION} (1 file changed on both sides). Attempt 1 of 2: a worker will merge it and resolve the conflicts.`
        })
        // No lease yet: the scheduler leases the resolver like any other pending workstream.
        expect(Object.values(h.state.leases).filter(wf.isLiveLease)).toEqual([])
        expect(h.view().tasks[taskId]).toMatchObject({ status: "resolving", resolutionAttempts: 1 })
        expect(ContractWorkforceView.parse(h.view())).toEqual(h.view())
    })

    test("resolving -> lease (trace names the side it knows) -> DONE -> verifying with the evidence cleared", () => {
        const { h, taskId } = verifyingTask()
        h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict()))
        expect(h.reserve(taskId, [["ws-resolver", "p2"]])).toMatchObject({ ok: true, leases: [{ id: "ls-3", workstreamId: "ws-resolver", profileId: "p2" }] })
        expect(h.task(taskId).trace.at(-1)).toMatchObject({
            kind: "task.resolver_reserved",
            profileId: "p2",
            message: 'Reserved Profile p2 (claude) to merge the branches and resolve the conflict; it worked on "web work"'
        })
        expect(h.items({ kind: "spawn", leaseId: "ls-3" })[0]!.payload).toMatchObject({ role: "resolver", branch: INTEGRATION, workstreamId: "ws-resolver", handoff: false })
        expect(h.lease("ls-3").agentName).toBe("w-tk1-resolver-e3")
        h.run("ls-3")
        // Running, and through its own handoff, the task still reads as resolving.
        expect(h.task(taskId).status).toBe("resolving")
        h.step(d => wf.markProfileLimited(d, "p2", h.now + 60_000, "limit", "detected"))
        expect(resolver(h, taskId)?.status).toBe("handoff")
        expect(h.task(taskId).status).toBe("resolving")
        expect(h.step(d => wf.requestHandoff(d, taskId, "ws-resolver", 3, "p3"))).toMatchObject({ ok: true, lease: { id: "ls-4", profileId: "p3" } })
        expect(h.step(d => wf.ackHandoff(d, "ls-4", 4))).toEqual({ ok: true })
        expect(h.task(taskId).status).toBe("resolving")
        // Only the current epoch can finish it.
        expect(h.step(d => wf.completeWorkstream(d, "ls-3", 3, "ccccccc", "old"))).toEqual({ ok: false, reason: "stale_epoch" })
        h.advance(5_000)
        expect(h.step(d => wf.completeWorkstream(d, "ls-4", 4, "ddddddd", "merged"))).toEqual({ ok: true })
        const task = h.task(taskId)
        expect(task.status).toBe("verifying")
        expect(task.verification).toBeNull()
        expect(resolver(h, taskId)).toMatchObject({ status: "done", lastCheckpoint: { sha: "ddddddd", epoch: 4 } })
        expect(task.trace.at(-1)).toMatchObject({ kind: "task.conflict_resolved", message: `Merged and resolved on ${INTEGRATION} at ddddddd. Verifying again.` })
        expect(h.step(d => wf.submitVerification(d, taskId, { status: "passed", checks: [] }))).toEqual({ ok: true, status: "completed" })
    })

    test("attempts are bounded: the next conflict reuses the resolver, the one after fails with the reason", () => {
        const { h, taskId } = verifyingTask()
        const finishAttempt = (leaseId: string, sha: string) => {
            h.reserve(taskId, [["ws-resolver", "p1"]])
            const lease = h.lease(leaseId)
            h.run(leaseId)
            expect(h.step(d => wf.completeWorkstream(d, leaseId, lease.epoch, sha, "merged"))).toEqual({ ok: true })
        }
        h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict()))
        finishAttempt("ls-3", "ccccccc")
        expect(h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict()))).toEqual({ ok: true, status: "resolving", attempt: 2 })
        // Same workstream, back to pending; the old lease id stays so epoch 3 remains fenced out.
        expect(h.task(taskId).workstreams.filter(ws => ws.role === "resolver")).toHaveLength(1)
        expect(resolver(h, taskId)).toMatchObject({ status: "pending", leaseId: "ls-3", lastCheckpoint: { sha: "ccccccc" } })
        expect(h.step(d => wf.completeWorkstream(d, "ls-3", 3, "eeeeeee", "late"))).toEqual({ ok: false, reason: "lease_not_active" })
        finishAttempt("ls-4", "fffffff")

        h.advance(1_000)
        expect(h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict()))).toEqual({ ok: true, status: "failed", attempt: 2 })
        const task = h.task(taskId)
        expect(task.status).toBe("failed")
        const reason = `morrow/ws-web/web does not merge into ${INTEGRATION} after 2 resolution attempts. Resolve it on ${INTEGRATION} by hand, or retry for 2 more attempts.`
        expect(task.verification).toEqual({ status: "failed", checks: [...conflicted.checks, { name: "Conflict resolution", status: "failed", detail: reason, url: null }] })
        expect(task.trace.at(-1)).toMatchObject({ kind: "task.conflict_gave_up", message: `Gave up: ${reason}` })
        expect(Object.values(h.state.leases).filter(wf.isLiveLease)).toEqual([])

        // A retry verifies again with a fresh budget.
        expect(h.step(d => wf.retryTask(d, taskId, "u-1001"))).toEqual({ ok: true, mode: "verify", reopenedWorkstreamIds: [] })
        expect(h.task(taskId).resolutionAttempts).toBe(0)
        expect(h.view().tasks[taskId]!.resolutionAttempts).toBe(0)
        expect(h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict()))).toEqual({ ok: true, status: "resolving", attempt: 1 })
    })

    test("no duplicate resolvers: a second conflict report or a second reservation is refused", () => {
        const { h, taskId } = verifyingTask()
        h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict()))
        expect(h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict()))).toEqual({ ok: false, reason: "task_not_verifying" })
        h.reserve(taskId, [["ws-resolver", "p1"]])
        expect(h.reserve(taskId, [["ws-resolver", "p2"]])).toMatchObject({ ok: false, picks: [{ ok: false, reason: "already_leased" }] })
        expect(Object.values(h.state.leases).filter(l => wf.isLiveLease(l) && l.workstreamId === "ws-resolver")).toHaveLength(1)
        expect(h.task(taskId).workstreams.filter(ws => ws.role === "resolver")).toHaveLength(1)
    })

    test("refusals: unknown task, not verifying, unknown workstream; a planned workstream on the integration branch fails at once", () => {
        const { h, taskId } = verifyingTask()
        expect(h.step(d => wf.resolveConflict(d, "tk-missing", conflicted, conflict()))).toEqual({ ok: false, reason: "unknown_task" })
        expect(h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict({ workstreamId: "ws-nope" })))).toEqual({ ok: false, reason: "unknown_workstream" })
        expect(h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict({ involvedWorkstreamIds: ["ws-resolver"] })))).toEqual({ ok: false, reason: "unknown_workstream" })
        expect(h.task(taskId).status).toBe("verifying")

        const planned = harness()
        const other = planned.setup({ roles: ["api"] })
        expect(planned.step(d => wf.resolveConflict(d, other, conflicted, conflict({ workstreamId: null, involvedWorkstreamIds: [] })))).toEqual({
            ok: false,
            reason: "task_not_verifying"
        })

        // An old plan whose workstream works on the integration branch itself: no resolver can share it.
        const clash = harness()
        const clashId = clash.setup({ roles: ["api"] })
        clash.step(d => d.putTask({ ...d.tasks[clashId]!, workstreams: d.tasks[clashId]!.workstreams.map(ws => ({ ...ws, branch: INTEGRATION })) }))
        clash.reserve(clashId, [["ws-api", "p1"]])
        clash.step(d => wf.completeWorkstream(d, "ls-1", 1, "aaaaaaa", "api"))
        const base = conflict({ branch: "main", workstreamId: null, involvedWorkstreamIds: ["ws-api"] })
        expect(clash.step(d => wf.resolveConflict(d, clashId, conflicted, base))).toEqual({ ok: true, status: "failed", attempt: 0 })
        expect(clash.task(clashId).trace.at(-1)?.message).toContain("a planned workstream already works on that branch")
    })

    test("the default branch moving on: a resolver with no incoming workstream, depending on every planned one", () => {
        const { h, taskId } = verifyingTask()
        const base = conflict({ branch: "main", workstreamId: null, involvedWorkstreamIds: ["ws-api", "ws-web"], files: [] })
        expect(h.step(d => wf.resolveConflict(d, taskId, conflicted, base))).toEqual({ ok: true, status: "resolving", attempt: 1 })
        expect(resolver(h, taskId)).toMatchObject({ dependsOn: ["ws-api", "ws-web"], branch: INTEGRATION })
        expect(h.task(taskId).trace.at(-1)?.message).toBe(`main does not merge into ${INTEGRATION}. Attempt 1 of 2: a worker will merge it and resolve the conflicts.`)
    })

    test("cancel while resolving releases the resolver and is terminal", () => {
        const { h, taskId } = verifyingTask()
        h.step(d => wf.resolveConflict(d, taskId, conflicted, conflict()))
        h.reserve(taskId, [["ws-resolver", "p1"]])
        expect(h.step(d => wf.cancelTask(d, taskId, "u-1001"))).toEqual({ ok: true, releasedLeaseIds: ["ls-3"] })
        expect(h.task(taskId).status).toBe("cancelled")
        expect(resolver(h, taskId)?.status).toBe("failed")
    })
})

describe("worker update watermark", () => {
    test("moves forward only, clamps to what the task recorded, and forgets pruned tasks", () => {
        const h = harness()
        const taskId = h.setup()
        const recorded = h.task(taskId).traceCount ?? h.task(taskId).trace.length
        let marks: Record<string, number> = {}
        const mark = (id: string, through: number) => {
            const out = wf.markNotified(marks, h.state.tasks, id, through)
            marks = out.notified
            return out.result
        }
        expect(mark(taskId, 1)).toEqual({ ok: true, through: 1 })
        expect(mark(taskId, 0)).toEqual({ ok: true, through: 1 })
        expect(mark(taskId, recorded + 50)).toEqual({ ok: true, through: recorded })
        expect(mark("tk-missing", 1)).toEqual({ ok: false, reason: "unknown_task" })
        marks = { ...marks, "tk-gone": 3 }
        expect(mark(taskId, recorded)).toEqual({ ok: true, through: recorded })
        expect(marks).toEqual({ [taskId]: recorded })
    })
})

describe("task thread and interface contracts", () => {
    function started() {
        const h = harness()
        const taskId = h.setup()
        h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p2"]
        ])
        h.run("ls-1")
        h.run("ls-2")
        return { h, taskId }
    }

    test("the first thread root wins and the view does not change", () => {
        const { h, taskId } = started()
        const view = JSON.stringify(h.view())
        const updatedAt = h.task(taskId).updatedAt
        expect(h.step(d => wf.setTaskThread(d, taskId, "msg-1"))).toEqual({ ok: true, threadId: "msg-1" })
        expect(h.step(d => wf.setTaskThread(d, taskId, "msg-2"))).toEqual({ ok: true, threadId: "msg-1" })
        expect(h.step(d => wf.setTaskThread(d, "tk-missing", "msg-3"))).toEqual({ ok: false, reason: "unknown_task" })
        expect(h.task(taskId).threadId).toBe("msg-1")
        expect(h.task(taskId).updatedAt).toBe(updatedAt)
        expect(wf.taskRecord(h.task(taskId)).threadId).toBe("msg-1")
        expect(JSON.stringify(h.view())).toBe(view)
    })

    test("a task stored before threads reads as having none", () => {
        const { h, taskId } = started()
        expect(wf.taskRecord(h.task(taskId)).threadId).toBeNull()
    })

    test("a contract is fenced to the workstream's live lease, kept newest first, traced once per message", () => {
        const { h, taskId } = started()
        expect(h.step(d => wf.recordContract(d, "ls-1", 1, "GET /api/members returns Member[]", "m-10"))).toEqual({ ok: true })
        const ws = () => h.task(taskId).workstreams.find(w => w.id === "ws-api")!
        expect(ws().contract).toEqual({ summary: "GET /api/members returns Member[]", messageId: "m-10", agentName: h.lease("ls-1").agentName, leaseId: "ls-1", at: h.now })
        const traced = h.task(taskId).trace.filter(e => e.kind === "contract.published")
        expect(traced).toHaveLength(1)
        expect(traced[0]).toMatchObject({ leaseId: "ls-1", epoch: 1 })
        expect(traced[0]!.message).toContain("GET /api/members returns Member[]")
        // The same message again (a replay) changes nothing.
        expect(h.step(d => wf.recordContract(d, "ls-1", 1, "GET /api/members returns Member[]", "m-10"))).toEqual({ ok: true })
        expect(h.task(taskId).trace.filter(e => e.kind === "contract.published")).toHaveLength(1)
        // A newer one replaces it.
        h.advance(1000)
        expect(h.step(d => wf.recordContract(d, "ls-1", 1, "GET /api/members?cursor= paginates", "m-11"))).toEqual({ ok: true })
        expect(ws().contract).toMatchObject({ messageId: "m-11", summary: "GET /api/members?cursor= paginates" })
        // Wrong lease, wrong epoch, unknown lease: refused, nothing written.
        expect(h.step(d => wf.recordContract(d, "ls-1", 2, "x", "m-12"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(h.step(d => wf.recordContract(d, "ls-404", 1, "x", "m-13"))).toEqual({ ok: false, reason: "unknown_lease" })
        expect(h.task(taskId).workstreams.find(w => w.id === "ws-web")!.contract).toBeUndefined()
        expect(ws().contract?.messageId).toBe("m-11")
    })

    test("a stopped worker or a finished workstream cannot publish", () => {
        const { h, taskId } = started()
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "limit", "detected"))
        expect(h.step(d => wf.recordContract(d, "ls-1", 1, "late", "m-20"))).toEqual({ ok: false, reason: "lease_not_active" })
        expect(h.step(d => wf.completeWorkstream(d, "ls-2", 2, "a".repeat(40), "done"))).toEqual({ ok: true })
        expect(h.step(d => wf.recordContract(d, "ls-2", 2, "late", "m-21"))).toEqual({ ok: false, reason: "lease_not_active" })
        expect(h.task(taskId).workstreams.every(w => w.contract === undefined)).toBe(true)
    })
})

describe("subagents", () => {
    /** p1 (Claude Code) runs ws-api; cx (Codex) and oc (opencode) share p1's machine; far is Codex on another machine. */
    function started(options: { cxMax?: number } = {}) {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1", "p2"] })
        h.step(d => wf.registerProfile(d, profileInput("cx", { envId: "env-p1", nodeName: "n-p1", cli: "codex", maxConcurrent: options.cxMax ?? 4 })))
        h.step(d => wf.registerProfile(d, profileInput("oc", { envId: "env-p1", nodeName: "n-p1", cli: "opencode", maxConcurrent: 4 })))
        h.step(d => wf.registerProfile(d, profileInput("far", { envId: "env-p2", nodeName: "n-p2", cli: "codex", maxConcurrent: 4 })))
        h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p2"]
        ])
        h.run("ls-1")
        h.run("ls-2")
        return { h, taskId }
    }
    const ask = (over: Partial<Parameters<typeof wf.delegate>[1]> = {}) => ({
        parentLeaseId: "ls-1",
        target: "codex" as const,
        role: "review" as const,
        task: "Review the diff on this branch for auth bugs.",
        clientRequestId: "req-1",
        ...over
    })

    test("delegate starts a child lease on the caller's machine, beside the parent, with a spawn", () => {
        const { h, taskId } = started()
        const result = h.step(d => wf.delegate(d, ask()))
        expect(result).toMatchObject({ ok: true, created: true, subagent: { leaseId: "ls-3", parentLeaseId: "ls-1", cli: "codex", profileId: "cx", role: "review", status: "running", summary: null } })
        const child = h.lease("ls-3")
        expect(child).toMatchObject({ parentLeaseId: "ls-1", role: "review", workstreamId: "ws-api", nodeName: "n-p1", state: "reserved" })
        expect(child.agentName).toMatch(/^w-[a-z0-9]+-api-sub-e3$/)
        const spawn = h.items({ kind: "spawn", leaseId: "ls-3" })[0]!
        expect(spawn.payload).toMatchObject({
            cli: "codex",
            workstreamId: "ws-api",
            branch: h.task(taskId).workstreams[0]!.branch,
            subagent: { parentLeaseId: "ls-1", parentAgentName: h.lease("ls-1").agentName, parentCli: "claude", role: "review" }
        })
        // The parent still owns the workstream, and the task stays running.
        expect(h.task(taskId).workstreams[0]!.leaseId).toBe("ls-1")
        expect(h.task(taskId).status).toBe("running")
        expect(h.task(taskId).trace.at(-1)).toMatchObject({ kind: "subagent.started", leaseId: "ls-3" })
        expect(h.task(taskId).trace.at(-1)!.message).toContain("started Codex as")
        expect(h.view().leases["ls-3"]).toMatchObject({ parentLeaseId: "ls-1", state: "reserved" })
        expect(h.view().leases["ls-1"]).not.toHaveProperty("parentLeaseId")
        expect(wf.taskRecord(h.task(taskId)).subagents).toHaveLength(1)
        expect(wf.taskRecord(h.task(taskId)).subagents![0]).not.toHaveProperty("clientRequestId")
        expect(() => ContractWorkforceView.parse(h.view())).not.toThrow()
    })

    test("a retried request id returns the same subagent and its current status", () => {
        const { h } = started()
        h.step(d => wf.delegate(d, ask()))
        const again = h.step(d => wf.delegate(d, ask()))
        expect(again).toMatchObject({ ok: true, created: false, subagent: { leaseId: "ls-3", task: "Review the diff on this branch for auth bugs." } })
        expect(Object.keys(h.state.leases)).toHaveLength(3)
        // The same id for a different request is refused, not answered with the old subagent.
        for (const other of [ask({ task: "something else" }), ask({ target: "opencode" }), ask({ role: "implementation" })])
            expect(h.step(d => wf.delegate(d, other))).toEqual({ ok: false, reason: "request_mismatch" })
        expect(Object.keys(h.state.leases)).toHaveLength(3)
        // Same id from another parent is a new request.
        expect(h.step(d => wf.delegate(d, ask({ parentLeaseId: "ls-2", target: "codex" })))).toMatchObject({ ok: true, created: true })
    })

    test("refusals: unknown or ended caller, subagent caller, missing CLI, another machine, caps", () => {
        const { h, taskId } = started({ cxMax: 10 })
        expect(h.step(d => wf.delegate(d, ask({ parentLeaseId: "ls-99" })))).toEqual({ ok: false, reason: "parent_not_active" })
        // p2's machine has only Claude Code (p2) and Codex (far); no opencode there, and never p1's.
        expect(h.step(d => wf.delegate(d, ask({ parentLeaseId: "ls-2", target: "opencode" })))).toEqual({ ok: false, reason: "no_target_profile" })
        expect(h.step(d => wf.delegate(d, ask({ parentLeaseId: "ls-2", clientRequestId: "x" })))).toMatchObject({ ok: true, subagent: { profileId: "far" } })
        expect(h.step(d => wf.delegate(d, ask()))).toMatchObject({ ok: true })
        const childId = Object.values(h.state.leases).find(l => l.parentLeaseId === "ls-1")!.id
        expect(h.step(d => wf.delegate(d, ask({ parentLeaseId: childId, clientRequestId: "deep" })))).toEqual({ ok: false, reason: "parent_is_subagent" })
        expect(h.step(d => wf.delegate(d, ask({ clientRequestId: "r2", target: "opencode" })))).toMatchObject({ ok: true })
        expect(h.step(d => wf.delegate(d, ask({ clientRequestId: "r3" })))).toEqual({ ok: false, reason: "parent_limit" })
        expect(h.step(d => wf.delegate(d, ask({ parentLeaseId: "ls-2", clientRequestId: "y" })))).toMatchObject({ ok: true })
        expect(h.step(d => wf.delegate(d, ask({ parentLeaseId: "ls-2", clientRequestId: "z" })))).toEqual({ ok: false, reason: "parent_limit" })
        expect(Object.values(h.state.leases).filter(l => l.parentLeaseId && wf.isLiveLease(l))).toHaveLength(4)
        expect(h.task(taskId).subagents).toHaveLength(4)
    })

    test("task cap and profile rejections", () => {
        const { h } = started({ cxMax: 1 })
        expect(h.step(d => wf.delegate(d, ask()))).toMatchObject({ ok: true })
        // cx is now full: the next Codex request is refused with the profile's reason.
        expect(h.step(d => wf.delegate(d, ask({ clientRequestId: "r2" })))).toEqual({ ok: false, reason: "over_capacity" })
        h.step(d => wf.markProfileLimited(d, "oc", T0 + 60_000, "quota", "detected"))
        expect(h.step(d => wf.delegate(d, ask({ clientRequestId: "r3", target: "opencode" })))).toEqual({ ok: false, reason: "profile_limited" })
    })

    test("task-wide cap counts live subagents across workers", () => {
        const h = harness()
        const taskId = h.setup({ profiles: ["p1"], roles: ["api", "web", "db"], maxConcurrent: 3 })
        h.step(d => wf.registerProfile(d, profileInput("cx", { envId: "env-p1", nodeName: "n-p1", cli: "codex", maxConcurrent: 10 })))
        h.reserve(taskId, [
            ["ws-api", "p1"],
            ["ws-web", "p1"],
            ["ws-db", "p1"]
        ])
        for (const id of ["ls-1", "ls-2"]) for (const r of ["a", "b"]) expect(h.step(d => wf.delegate(d, ask({ parentLeaseId: id, clientRequestId: r })))).toMatchObject({ ok: true })
        expect(h.step(d => wf.delegate(d, ask({ parentLeaseId: "ls-3", clientRequestId: "a" })))).toEqual({ ok: false, reason: "task_limit" })
    })

    test("a result is recorded once, releases the child, and a stale epoch is refused", () => {
        const { h, taskId } = started()
        h.step(d => wf.delegate(d, ask()))
        h.run("ls-3")
        expect(h.task(taskId).trace.some(e => e.kind === "worker.ready" && e.leaseId === "ls-3")).toBe(false)
        expect(h.step(d => wf.recordSubagentResult(d, "ls-3", 2, "completed", "x"))).toEqual({ ok: false, reason: "stale_epoch" })
        expect(h.step(d => wf.recordSubagentResult(d, "ls-1", 1, "completed", "x"))).toEqual({ ok: false, reason: "not_a_subagent" })
        const done = h.step(d => wf.recordSubagentResult(d, "ls-3", 3, "completed", "No auth bugs. One nit in api/session.ts."))
        expect(done).toMatchObject({ ok: true, recorded: true, subagent: { status: "completed", summary: "No auth bugs. One nit in api/session.ts.", finishedAt: T0 } })
        expect(h.lease("ls-3").state).toBe("released")
        expect(h.items({ leaseId: "ls-3", kind: "release" })).toHaveLength(1)
        expect(h.items({ leaseId: "ls-3", kind: "checkpoint" })).toHaveLength(0)
        const last = h.task(taskId).trace.at(-1)!
        expect(last).toMatchObject({ kind: "subagent.finished", leaseId: "ls-3" })
        expect(last.message).toContain("finished the review")
        expect(h.step(d => wf.recordSubagentResult(d, "ls-3", 3, "failed", "late"))).toMatchObject({ ok: true, recorded: false, subagent: { status: "completed" } })
        // Ended subagents leave the view; the record keeps them.
        expect(h.view().leases["ls-3"]).toBeUndefined()
        expect(h.task(taskId).workstreams[0]!.status).toBe("active")
        expect(h.task(taskId).status).toBe("running")
    })

    test("cancel: only the parent's own subagent, once", () => {
        const { h } = started()
        h.step(d => wf.delegate(d, ask()))
        expect(h.step(d => wf.cancelSubagent(d, "ls-2", "ls-3", null))).toEqual({ ok: false, reason: "task_not_found" })
        expect(h.step(d => wf.cancelSubagent(d, "ls-1", "ls-1", null))).toEqual({ ok: false, reason: "task_not_found" })
        expect(h.step(d => wf.cancelSubagent(d, "ls-1", "ls-3", "not needed"))).toMatchObject({ ok: true, cancelled: true, subagent: { status: "cancelled" } })
        expect(h.lease("ls-3").state).toBe("released")
        // Never claimed: nothing to stop on the machine.
        expect(h.items({ leaseId: "ls-3", kind: "spawn" })[0]!.state).toBe("cancelled")
        expect(h.items({ leaseId: "ls-3", kind: "release" })).toHaveLength(0)
        expect(h.step(d => wf.cancelSubagent(d, "ls-1", "ls-3", null))).toMatchObject({ ok: true, cancelled: false })
    })

    test("a parent's checkpoint waits until its subagents are stopped, not only the parent", () => {
        const { h } = started()
        h.step(d => wf.delegate(d, ask()))
        h.run("ls-3")
        expect(wf.stoppingChildren(h.state.leases, h.state.outbox, "ls-1")).toEqual([h.lease("ls-3").agentName])
        // The parent hits its usage limit: it expires, its tree is checkpointed, and its subagent is stopped with it.
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "quota", "detected"))
        expect(h.lease("ls-1").state).toBe("expired")
        expect(h.lease("ls-3").state).toBe("released")
        expect(h.items({ kind: "checkpoint", leaseId: "ls-1" })).toHaveLength(1)
        const first = h.step(d => wf.claimOutbox(d, 10))
        // (The other worker's spawn is still queued from setup; only this parent's work matters here.)
        const mine = (claims: { kind: string; leaseId: string }[]) => claims.filter(c => c.leaseId !== "ls-2").map(c => [c.kind, c.leaseId])
        expect(mine(first).sort()).toEqual([["release", "ls-1"], ["release", "ls-3"]])
        const done = { ok: true as const, invocationId: null, sha: null, detail: null }
        h.step(d => wf.completeOutbox(d, `ob-ls-1-release`, done))
        // The parent is gone but the subagent may still be writing: no checkpoint yet.
        expect(wf.stoppingChildren(h.state.leases, h.state.outbox, "ls-1")).toEqual([h.lease("ls-3").agentName])
        expect(mine(h.step(d => wf.claimOutbox(d, 10)))).toEqual([])
        h.step(d => wf.completeOutbox(d, `ob-ls-3-release`, done))
        expect(wf.stoppingChildren(h.state.leases, h.state.outbox, "ls-1")).toEqual([])
        expect(mine(h.step(d => wf.claimOutbox(d, 10)))).toEqual([["checkpoint", "ls-1"]])
    })

    test("a failed child release does not hold the checkpoint forever", () => {
        const { h } = started()
        h.step(d => wf.delegate(d, ask()))
        h.run("ls-3")
        h.step(d => wf.markProfileLimited(d, "p1", T0 + 60_000, "quota", "detected"))
        h.step(d => wf.claimOutbox(d, 10))
        h.step(d => wf.completeOutbox(d, "ob-ls-1-release", { ok: true, invocationId: null, sha: null, detail: null }))
        h.step(d => wf.completeOutbox(d, "ob-ls-3-release", { ok: false, error: "node gone", retryable: false }))
        expect(h.step(d => wf.claimOutbox(d, 10)).filter(c => c.leaseId === "ls-1").map(c => c.kind)).toEqual(["checkpoint"])
    })

    test("a subagent that fails to start tells its parent why", () => {
        const { h, taskId } = started()
        h.step(d => wf.delegate(d, ask()))
        h.step(d => wf.claimOutbox(d, 10))
        h.step(d => wf.completeOutbox(d, "ob-ls-3-spawn", { ok: false, error: "Relay refused the spawn (spawn_failed) (Codex could not start read-only on this machine)", retryable: false }))
        expect(h.task(taskId).subagents![0]).toMatchObject({ status: "failed", summary: "Could not start: spawn failed: Relay refused the spawn (spawn_failed) (Codex could not start read-only on this machine)." })
    })

    test("the parent ending stops its subagents in the same transition, without touching the workstream", () => {
        const { h, taskId } = started()
        h.step(d => wf.delegate(d, ask()))
        h.run("ls-3")
        h.step(d => wf.completeWorkstream(d, "ls-1", 1, "a".repeat(40), "done"))
        expect(h.lease("ls-3").state).toBe("released")
        expect(h.task(taskId).subagents![0]).toMatchObject({ status: "cancelled" })
        expect(h.items({ leaseId: "ls-3", kind: "release" })).toHaveLength(1)
        expect(h.task(taskId).workstreams.map(ws => ws.status)).toEqual(["done", "active"])
    })

    test("a child exiting or failing to start fails its record and leaves the parent alone", () => {
        const { h, taskId } = started()
        h.step(d => wf.delegate(d, ask()))
        h.step(d => wf.delegate(d, ask({ clientRequestId: "r2", target: "opencode" })))
        h.run("ls-3")
        expect(h.step(d => wf.recordSpawnStatus(d, "ls-3", 3, "exited", null))).toEqual({ ok: true })
        expect(h.step(d => wf.recordSpawnStatus(d, "ls-4", 4, "failed", null))).toEqual({ ok: true })
        const records = h.task(taskId).subagents!
        expect(records.map(r => r.status)).toEqual(["failed", "failed"])
        expect(records[0]!.summary).toContain("exited")
        expect(h.lease("ls-1").state).toBe("running")
        expect(h.task(taskId).workstreams[0]!.status).toBe("active")
        expect(h.items({ leaseId: "ls-3", kind: "checkpoint" })).toHaveLength(0)
        expect(h.task(taskId).trace.filter(e => e.kind === "worker.offline" || e.kind === "worker.blocked")).toHaveLength(0)
    })

    test("a child that never starts times out; a limit on the parent's profile stops both", () => {
        const { h, taskId } = started()
        h.step(d => wf.delegate(d, ask()))
        h.advance(wf.WORKFORCE_TIMING.leaseStartTimeoutMs + 1)
        h.step(() => null)
        expect(h.lease("ls-3").state).toBe("failed")
        expect(h.task(taskId).subagents![0]!.status).toBe("failed")
        h.step(d => wf.delegate(d, ask({ clientRequestId: "r2" })))
        const result = h.step(d => wf.markProfileLimited(d, "p1", h.now + 60_000, "quota", "detected"))
        expect(result).toMatchObject({ ok: true, expiredLeaseIds: ["ls-1"] })
        expect(h.lease("ls-4").state).toBe("released")
        expect(h.task(taskId).subagents![1]!.status).toBe("cancelled")
    })

    test("cancelling the task stops subagents too", () => {
        const { h, taskId } = started()
        h.step(d => wf.delegate(d, ask()))
        h.step(d => wf.cancelTask(d, taskId, "u-1001"))
        expect(h.lease("ls-3").state).toBe("released")
        expect(h.task(taskId).subagents![0]!.status).toBe("cancelled")
    })

    test("finished records are capped, running ones are always kept", () => {
        const { h, taskId } = started({ cxMax: 10 })
        for (let i = 0; i < wf.WORKFORCE_LIMITS.subagentsKept + 5; i++) {
            const r = h.step(d => wf.delegate(d, ask({ clientRequestId: `r${i}` })))
            expect(r.ok).toBe(true)
            if (r.ok) h.step(d => wf.cancelSubagent(d, "ls-1", r.subagent.leaseId, null))
        }
        h.step(d => wf.delegate(d, ask({ clientRequestId: "live" })))
        const records = h.task(taskId).subagents!
        expect(records).toHaveLength(wf.WORKFORCE_LIMITS.subagentsKept)
        expect(records.at(-1)!.status).toBe("running")
        expect(records[0]!.clientRequestId).toBe("r6")
    })
})
