// Compare tasks (docs/multi-harness.md) as a pure state machine: every step runs the actor's pipeline (sweep, run,
// finalize, invariants) against a deep-frozen state, like lib-workforce.test.ts.
import { describe, expect, test } from "bun:test"
import { TaskDetail as ContractTaskDetail, WorkforceView as ContractWorkforceView } from "../../packages/contracts/src/domain.ts"
import type { CliKind, Lease, PlanWorkstreamInput, Task } from "../src/lib/types.ts"
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

const attempt = (cli: CliKind, overrides: Partial<PlanWorkstreamInput> = {}): PlanWorkstreamInput =>
    workstream(`ws-${cli}`, cli, { branch: `morrow/tk1/${cli}`, ownership: ["**"], harness: cli, ...overrides })

const comparePlan = (clis: CliKind[]) => plan(clis.map(cli => attempt(cli)), { source: "compare", rationale: "Every harness attempts the whole task." })

function harness() {
    let state: wf.WorkforceState = deepFreeze({ profiles: {}, tasks: {}, leases: {}, outbox: {}, epoch: 0 })
    const h = {
        step<R>(run: (d: wf.WorkforceDraft) => R): R {
            const d = new wf.WorkforceDraft(state, T0)
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
        view() {
            return wf.buildWorkforceView(state)
        },
        /** One profile per CLI (`p-<cli>`), plus extras, and a compare task over `clis`. */
        setup(clis: CliKind[] = ["claude", "codex", "opencode"], extra: [string, CliKind][] = []) {
            for (const cli of ["claude", "codex", "opencode"] as const) h.step(d => wf.registerProfile(d, profileInput(`p-${cli}`, { cli })))
            for (const [id, cli] of extra) h.step(d => wf.registerProfile(d, profileInput(id, { cli })))
            expect(h.step(d => wf.createTask(d, taskInput("tk-1", { strategy: "compare", maxAgents: clis.length })))).toEqual({ ok: true, taskId: "tk-1" })
            expect(h.step(d => wf.recordPlan(d, "tk-1", comparePlan(clis)))).toEqual({ ok: true, generation: 1 })
        },
        /** Reserves every attempt on its own CLI's profile and marks the leases running. */
        startAll(clis: CliKind[] = ["claude", "codex", "opencode"]): Record<CliKind, string> {
            const result = h.step(d => wf.reserveWorkers(d, "tk-1", clis.map(cli => ({ workstreamId: `ws-${cli}`, profileId: `p-${cli}` }))))
            if (!result.ok) throw new Error(JSON.stringify(result))
            const leases = {} as Record<CliKind, string>
            for (const lease of result.leases) {
                h.step(d => wf.recordSpawnStatus(d, lease.id, lease.epoch, "running", "inv"))
                leases[lease.workstreamId.slice(3) as CliKind] = lease.id
            }
            return leases
        },
        finish(leaseId: string, sha = "abc1234") {
            const lease = h.lease(leaseId)
            expect(h.step(d => wf.completeWorkstream(d, leaseId, lease.epoch, sha, "attempt done"))).toEqual({ ok: true })
        }
    }
    return h
}

describe("compare plans", () => {
    test("a compare task records one attempt per harness and keeps each attempt's harness", () => {
        const h = harness()
        h.setup()
        const task = h.task()
        expect(task.strategy).toBe("compare")
        expect(task.pickedWorkstreamId).toBeNull()
        expect(task.status).toBe("planned")
        expect(task.workstreams.map(ws => ws.harness)).toEqual(["claude", "codex", "opencode"])
        expect(task.trace.at(-1)!.message).toBe("Compare plan: 3 attempts at the whole task (Claude Code, Codex, opencode).")
    })

    test("strategy and plan must agree", () => {
        const h = harness()
        h.step(d => wf.registerProfile(d, profileInput("p1")))
        h.step(d => wf.createTask(d, taskInput("tk-split")))
        expect(h.step(d => wf.recordPlan(d, "tk-split", comparePlan(["claude", "codex"])))).toEqual({ ok: false, reason: "wrong_strategy" })
        h.step(d => wf.createTask(d, taskInput("tk-cmp", { strategy: "compare", maxAgents: 2 })))
        expect(h.step(d => wf.recordPlan(d, "tk-cmp", plan([workstream("ws-api", "api")])))).toEqual({ ok: false, reason: "wrong_strategy" })
        // A task stored before strategies existed reads as split.
        expect(wf.strategyOf({})).toBe("split")
    })

    test("validation refuses malformed compare plans and harnesses on split plans", () => {
        const problem = (p: unknown) => v.PlanInput.safeParse(p).error?.issues.map(i => i.message).join("; ") ?? null
        expect(problem(comparePlan(["claude", "codex"]))).toBeNull()
        expect(problem(comparePlan(["claude"]))).toMatch(/2 to 3 attempts/)
        expect(problem(plan([attempt("claude"), attempt("codex", { id: "ws-c2", branch: "morrow/tk1/c2", harness: "claude" })], { source: "compare" }))).toMatch(
            /different harness/
        )
        expect(problem(plan([attempt("claude"), attempt("codex", { harness: undefined })], { source: "compare" }))).toMatch(/needs a harness/)
        expect(problem(plan([attempt("claude"), attempt("codex", { dependsOn: ["ws-claude"] })], { source: "compare" }))).toMatch(/do not wait/)
        expect(problem(plan([attempt("claude")], { source: "fallback" }))).toMatch(/only a compare plan/)
        expect(problem(comparePlan(["claude", "codex"]).workstreams && { ...comparePlan(["claude", "codex"]), profileId: "p1" })).toMatch(/must be null/)
    })
})

describe("harness binding", () => {
    test("reserveWorkers and requestHandoff only place an attempt on its own CLI", () => {
        const h = harness()
        h.setup(["claude", "codex"], [["p-codex-2", "codex"], ["p-claude-2", "claude"]])
        const wrong = h.step(d => wf.reserveWorkers(d, "tk-1", [{ workstreamId: "ws-codex", profileId: "p-claude" }]))
        expect(wrong).toMatchObject({ ok: false, picks: [{ ok: false, reason: "wrong_harness" }] })
        const leases = h.startAll(["claude", "codex"])
        // Codex's plan runs out: the attempt goes to handoff and only another Codex may take it over.
        h.step(d => wf.markProfileLimited(d, "p-codex", T0 + 3_600_000, "limit", "detected"))
        expect(h.ws("ws-codex").status).toBe("handoff")
        const epoch = h.lease(leases.codex).epoch
        expect(h.step(d => wf.requestHandoff(d, "tk-1", "ws-codex", epoch, "p-claude-2"))).toEqual({ ok: false, reason: "wrong_harness" })
        const handed = h.step(d => wf.requestHandoff(d, "tk-1", "ws-codex", epoch, "p-codex-2"))
        expect(handed.ok && handed.lease.profileId).toBe("p-codex-2")
        // The Claude attempt kept going.
        expect(h.lease(leases.claude).state).toBe("running")
    })
})

describe("status", () => {
    test("running while attempts run, choosing once every attempt ended with one done, never verifying without a pick", () => {
        const h = harness()
        h.setup()
        const leases = h.startAll()
        expect(h.task().status).toBe("running")
        h.finish(leases.claude)
        expect(h.task().status).toBe("running")
        h.finish(leases.codex)
        h.finish(leases.opencode)
        expect(h.task().status).toBe("choosing")
        expect(ContractWorkforceView.safeParse(h.view()).success).toBe(true)
        const view = h.view().tasks["tk-1"]!
        expect(view).toMatchObject({ status: "choosing", strategy: "compare", pickedWorkstreamId: null })
        expect(view.workstreams.map(ws => ws.harness)).toEqual(["claude", "codex", "opencode"])
    })

    test("an attempt still waiting for a worker keeps the task out of choosing", () => {
        const h = harness()
        h.setup()
        const leases = h.startAll(["claude", "codex"])
        h.finish(leases.claude)
        h.finish(leases.codex)
        expect(h.ws("ws-opencode").status).toBe("pending")
        expect(h.task().status).toBe("running")
    })
})

describe("pickAttempt", () => {
    test("picking a finished attempt stops the others, marks unfinished ones failed and verifies only the pick", () => {
        const h = harness()
        h.setup()
        const leases = h.startAll()
        h.finish(leases.codex)
        const result = h.step(d => wf.pickAttempt(d, "tk-1", "ws-codex", "u-1001"))
        expect(result).toEqual({ ok: true, status: "verifying", releasedLeaseIds: [leases.claude, leases.opencode].sort() })
        expect(h.task().pickedWorkstreamId).toBe("ws-codex")
        expect(h.lease(leases.claude).state).toBe("released")
        expect(h.ws("ws-claude").status).toBe("failed")
        expect(h.ws("ws-codex").status).toBe("done")
        expect(h.task().trace.at(-1)).toMatchObject({ kind: "task.attempt_picked" })
        expect(h.task().trace.at(-1)!.message).toContain("picked the Codex attempt on morrow/tk1/codex and stopped 2 other attempts")
        // The released workers are told to stop.
        const releases = Object.values(h.view().leases).filter(l => l.state === "released").length
        expect(releases).toBe(3)
        // Verification passes on the picked attempt alone.
        expect(h.step(d => wf.submitVerification(d, "tk-1", { status: "passed", checks: [] }))).toEqual({ ok: true, status: "completed" })
    })

    test("refusals: running attempt, unknown attempt, split task, second pick, terminal task, nothing finished", () => {
        const h = harness()
        h.setup()
        expect(h.step(d => wf.pickAttempt(d, "tk-1", null, "u-1001"))).toEqual({ ok: false, reason: "nothing_finished" })
        const leases = h.startAll()
        expect(h.step(d => wf.pickAttempt(d, "tk-1", "ws-claude", "u-1001"))).toEqual({ ok: false, reason: "attempt_not_done" })
        expect(h.step(d => wf.pickAttempt(d, "tk-1", "ws-nope", "u-1001"))).toEqual({ ok: false, reason: "unknown_workstream" })
        expect(h.step(d => wf.pickAttempt(d, "tk-nope", null, "u-1001"))).toEqual({ ok: false, reason: "unknown_task" })
        h.finish(leases.claude)
        expect(h.step(d => wf.pickAttempt(d, "tk-1", "ws-claude", "u-1001")).ok).toBe(true)
        expect(h.step(d => wf.pickAttempt(d, "tk-1", "ws-claude", "u-1002"))).toEqual({ ok: false, reason: "already_picked" })
        h.step(d => wf.createTask(d, taskInput("tk-split")))
        expect(h.step(d => wf.pickAttempt(d, "tk-split", null, "u-1001"))).toEqual({ ok: false, reason: "not_compare" })
        h.step(d => wf.submitVerification(d, "tk-1", { status: "passed", checks: [] }))
        expect(h.step(d => wf.pickAttempt(d, "tk-1", null, "u-1001"))).toEqual({ ok: false, reason: "task_terminal" })
    })

    test("finishing without shipping completes the task, ships nothing and stops what still runs", () => {
        const h = harness()
        h.setup()
        const leases = h.startAll()
        h.finish(leases.claude)
        h.finish(leases.codex)
        const result = h.step(d => wf.pickAttempt(d, "tk-1", null, "u-1001"))
        expect(result).toEqual({ ok: true, status: "completed", releasedLeaseIds: [leases.opencode] })
        expect(h.task().pickedWorkstreamId).toBeNull()
        expect(h.task().verification).toEqual({ status: "skipped", checks: [{ name: "Ship", status: "skipped", detail: "Nothing shipped: the team kept the findings.", url: null }] })
        expect(h.task().trace.at(-1)!.message).toBe("u-1001 finished the task without shipping an attempt.")
    })

    test("a pick from choosing goes to verifying", () => {
        const h = harness()
        h.setup(["claude", "codex"])
        const leases = h.startAll(["claude", "codex"])
        h.finish(leases.claude)
        h.finish(leases.codex)
        expect(h.task().status).toBe("choosing")
        expect(h.step(d => wf.pickAttempt(d, "tk-1", "ws-claude", "u-1001"))).toEqual({ ok: true, status: "verifying", releasedLeaseIds: [] })
        expect(h.ws("ws-codex").status).toBe("done")
    })

    test("a pick releases a losing attempt's subagents with it", () => {
        const h = harness()
        h.setup(["claude", "codex"], [["p-codex-2", "codex"]])
        // A second Codex on the Claude attempt's machine takes the subagent.
        h.step(d => wf.registerProfile(d, profileInput("p-sub", { cli: "codex", envId: "env-p-claude", nodeName: "n-p-claude" })))
        const leases = h.startAll(["claude", "codex"])
        const child = h.step(d => wf.delegate(d, { parentLeaseId: leases.claude, target: "codex", task: "Review the diff", role: "review", clientRequestId: "r1" }))
        expect(child.ok).toBe(true)
        const childId = child.ok ? child.subagent.leaseId : ""
        h.finish(leases.codex)
        h.step(d => wf.pickAttempt(d, "tk-1", "ws-codex", "u-1001"))
        expect(h.lease(childId).state).toBe("released")
    })

    test("a failed compare task retries verification of the pick only and never reopens the others", () => {
        const h = harness()
        h.setup()
        const leases = h.startAll()
        h.finish(leases.claude)
        h.step(d => wf.pickAttempt(d, "tk-1", "ws-claude", "u-1001"))
        h.step(d => wf.submitVerification(d, "tk-1", { status: "failed", checks: [] }))
        expect(h.task().status).toBe("failed")
        expect(h.step(d => wf.retryTask(d, "tk-1", "u-1001"))).toEqual({ ok: true, mode: "verify", reopenedWorkstreamIds: [] })
        expect(h.task().status).toBe("verifying")
        expect(h.ws("ws-codex").status).toBe("failed")
    })

    test("a merge conflict on the picked attempt gets a resolver, and the task verifies again once it is done", () => {
        const h = harness()
        h.setup(["claude", "codex"], [["p-claude-2", "claude"]])
        const leases = h.startAll(["claude", "codex"])
        h.finish(leases.claude)
        h.step(d => wf.pickAttempt(d, "tk-1", "ws-claude", "u-1001"))
        const conflict = {
            branch: "main",
            workstreamId: null,
            integrationBranch: "morrow/tk1/integration",
            involvedWorkstreamIds: ["ws-claude"],
            files: ["src/a.ts"],
            brief: "Merge main into the integration branch."
        }
        expect(h.step(d => wf.resolveConflict(d, "tk-1", { status: "failed", checks: [] }, conflict))).toMatchObject({ ok: true, status: "resolving" })
        const resolver = h.step(d => wf.reserveWorkers(d, "tk-1", [{ workstreamId: wf.RESOLVER_WORKSTREAM_ID, profileId: "p-claude-2" }]))
        expect(resolver.ok).toBe(true)
        const lease = resolver.ok ? resolver.leases[0]! : null!
        h.step(d => wf.recordSpawnStatus(d, lease.id, lease.epoch, "running", "inv"))
        expect(h.task().status).toBe("resolving")
        h.finish(lease.id, "def5678")
        expect(h.task().status).toBe("verifying")
    })
})

describe("views", () => {
    test("split tasks carry no compare fields; the detail parses with the contract", () => {
        const h = harness()
        h.step(d => wf.registerProfile(d, profileInput("p1")))
        h.step(d => wf.createTask(d, taskInput("tk-split")))
        h.step(d => wf.recordPlan(d, "tk-split", plan([workstream("ws-api", "api")])))
        const view = h.view().tasks["tk-split"]!
        expect(view.strategy).toBe("split")
        expect("pickedWorkstreamId" in view).toBe(false)
        expect("harness" in view.workstreams[0]!).toBe(false)
        h.setup()
        expect(ContractTaskDetail.safeParse(wf.taskRecord(h.task())).success).toBe(true)
        expect(ContractTaskDetail.parse(wf.taskRecord(h.task())).workstreams[0]!.harness).toBe("claude")
    })
})
