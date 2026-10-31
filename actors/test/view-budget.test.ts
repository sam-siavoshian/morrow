// The emitted view's size ceiling. Every member's socket gets the whole view on every change, and the backend's hub
// drops a socket with more than 1 MB queued, so the view must stay well under that whatever anyone types.
// The worst case (every written field at its limit, the most records the actor keeps) is built in ./worst-case.ts.
import { describe, expect, test } from "bun:test"
import { CreateTaskInput, PlanInput, Reason, VerificationInput, line, text } from "../src/lib/validation.ts"
import * as wf from "../src/lib/workforce.ts"
import type { Task } from "../src/lib/types.ts"
import { bytes, fill, MAX, slug, worstState, worstTask } from "./worst-case.ts"

describe("the limits this test assumes are the ones the actor validates", () => {
    test("task, plan, verification and reason inputs accept every field at its limit and nothing longer", () => {
        const task = {
            id: "tk-1",
            projectId: "p-1",
            title: fill(MAX.title),
            prompt: fill(MAX.prompt),
            acceptance: Array.from({ length: MAX.criteria }, () => fill(MAX.criterion)),
            createdBy: "u-1",
            maxAgents: 5
        }
        expect(CreateTaskInput.safeParse(task).success).toBe(true)
        expect(CreateTaskInput.safeParse({ ...task, title: fill(MAX.title + 1) }).success).toBe(false)
        const ws = (i: number) => ({
            id: `ws-${i}`,
            role: "r".repeat(MAX.role),
            title: fill(MAX.title),
            brief: fill(MAX.brief),
            why: fill(MAX.why),
            branch: `b${i}`.padEnd(MAX.branch, "x"),
            dependsOn: [],
            ownership: Array.from({ length: MAX.ownerships }, () => fill(MAX.ownership))
        })
        const plan = {
            source: "fallback",
            profileId: null,
            rationale: fill(MAX.rationale),
            warnings: Array.from({ length: MAX.warnings }, () => fill(MAX.warning)),
            workstreams: Array.from({ length: MAX.workstreams }, (_, i) => ws(i))
        }
        expect(PlanInput.safeParse(plan).success).toBe(true)
        expect(PlanInput.safeParse({ ...plan, workstreams: [...plan.workstreams, ws(9)] }).success).toBe(false)
        expect(PlanInput.safeParse({ ...plan, workstreams: [{ ...ws(0), branch: "b".repeat(MAX.branch + 1) }] }).success).toBe(false)
        const check = { name: fill(MAX.checkName), status: "failed", detail: fill(MAX.checkDetail), url: null }
        expect(VerificationInput.safeParse({ status: "failed", checks: Array.from({ length: MAX.checks }, () => check) }).success).toBe(true)
        expect(Reason.safeParse(fill(MAX.reason)).success).toBe(true)
        expect(Reason.safeParse(fill(MAX.reason + 1)).success).toBe(false)
    })

    test("text with half a surrogate pair is rejected, whole pairs are fine", () => {
        for (const schema of [line(1, 10), text(1, 10)]) {
            expect(schema.safeParse("a\uD800").success).toBe(false)
            expect(schema.safeParse("\uDC00a").success).toBe(false)
            expect(schema.safeParse("\uDC00\uD800").success).toBe(false)
            expect(schema.safeParse("ok 🙂").success).toBe(true)
        }
        expect(JSON.stringify("\uD800")).toHaveLength(8) // the six-byte escape the rule keeps out
    })

    test("clipping never leaves half a surrogate pair", () => {
        const clipped = wf.clip("ab🙂🙂", 4)
        expect(clipped).toBe("ab…")
        expect(wf.clip("abc🙂", 4)).toBe("abc…")
        expect(wf.clip("abcd", 4)).toBe("abcd")
    })
})


describe("emitted view size ceiling", () => {
    const state = worstState()
    const view = wf.buildWorkforceView(state)
    // The hub's frame around it (backend/src/realtime/hub.ts).
    const frame = { kind: "workforce.view", teamId: slug("t-", 0), data: view }

    test("the view holds what the limits allow and no more", () => {
        expect(Object.keys(view.tasks)).toHaveLength(wf.WORKFORCE_LIMITS.activeTasks + wf.WORKFORCE_LIMITS.viewTerminalTasks)
        expect(Object.keys(view.profiles)).toHaveLength(wf.WORKFORCE_LIMITS.profiles)
        expect(Object.keys(view.leases)).toHaveLength(wf.WORKFORCE_LIMITS.profiles * 4 + wf.WORKFORCE_LIMITS.terminalLeasesKept)
    })

    test(`each task stays under ${wf.VIEW_TASK_MAX_BYTES} bytes whatever its text`, () => {
        const largest = Math.max(...Object.values(view.tasks).map(bytes))
        const sample = view.tasks[slug("tk-", 0)]!
        expect([sample.runStartedAt, sample.retriedAt, sample.plannedAt].every(at => typeof at === "number")).toBe(true)
        expect(largest).toBeLessThanOrEqual(wf.VIEW_TASK_MAX_BYTES)
        // The stored task it came from is two orders of magnitude bigger.
        expect(bytes(state.tasks[slug("tk-", 0)])).toBeGreaterThan(100 * largest)
    })

    test(`a compare task at its limits stays under ${wf.VIEW_TASK_MAX_BYTES} bytes too`, () => {
        const split = worstTask(0, "verifying")
        // Three attempts plus the resolver, each bound to the longest harness name, with the longest pick.
        const workstreams: Task["workstreams"] = [...split.workstreams.slice(0, 3).map(ws => ({ ...ws, harness: "opencode" as const })), ...split.workstreams.slice(-1)]
        const compare: Task = { ...split, strategy: "compare", maxAgents: 3, pickedWorkstreamId: workstreams[0]!.id, workstreams }
        const size = bytes(wf.taskView(compare))
        expect(wf.taskView(compare)).toMatchObject({ strategy: "compare", pickedWorkstreamId: workstreams[0]!.id })
        expect(size).toBeLessThanOrEqual(wf.VIEW_TASK_MAX_BYTES)
        expect(size).toBeLessThan(bytes(wf.taskView(split)))
    })

    test("the whole frame stays under 700 KB, well inside the hub's 1 MB send buffer", () => {
        const size = bytes(frame)
        const parts = {
            tasks: bytes(view.tasks),
            profiles: bytes(view.profiles),
            leases: bytes(view.leases)
        }
        console.log(`worst-case workforce.view frame: ${size} bytes`, parts)
        expect(size).toBeLessThan(700_000)
    })
})
