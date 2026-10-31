// summarizeOutbox against the real claimOutbox: after every transition of a flow with spawns, retries, a handoff
// (blocked items) and a cancel, claimOutbox does nothing just before `nextDueAt` and acts exactly at it. That is the
// promise the backend relies on when it claims on push instead of on a timer.
import { describe, expect, test } from "bun:test"
import { EMPTY_OUTBOX_SUMMARY, summarizeOutbox } from "../src/lib/outbox-summary.ts"
import type { OutboxItem } from "../src/lib/types.ts"
import * as wf from "../src/lib/workforce.ts"
import { plan, profileInput, taskInput, workstream } from "./helpers.ts"

const T0 = 1_800_000_000_000
const FAR = 10 * 365 * 24 * 3_600_000

/** Whether claimOutbox at `at` would change anything (claim, cancel or fail an item). Never mutates `state`. */
function claimActs(state: wf.WorkforceState, at: number): boolean {
    const d = new wf.WorkforceDraft(state, at)
    wf.claimOutbox(d, 1_000)
    return d.changed.has("outbox")
}

function expectSummaryMatchesClaim(state: wf.WorkforceState): void {
    const summary = summarizeOutbox(state.outbox)
    expect(summary.open).toBe(Object.values(state.outbox).filter(i => i.state === "pending" || i.state === "inflight").length)
    if (summary.nextDueAt === null) {
        expect(claimActs(state, T0 + FAR)).toBe(false)
        return
    }
    expect(claimActs(state, summary.nextDueAt - 1)).toBe(false)
    expect(claimActs(state, summary.nextDueAt)).toBe(true)
}

function flow() {
    let state: wf.WorkforceState = { profiles: {}, tasks: {}, leases: {}, outbox: {}, epoch: 0 }
    let now = T0
    let checked = 0
    return {
        get state() {
            return state
        },
        get checked() {
            return checked
        },
        advance(ms: number) {
            now += ms
        },
        step<R>(run: (d: wf.WorkforceDraft) => R): R {
            const d = new wf.WorkforceDraft(state, now)
            wf.sweep(d)
            const result = run(d)
            wf.finalize(d)
            state = { profiles: d.profiles, tasks: d.tasks, leases: d.leases, outbox: d.outbox, epoch: d.epoch }
            expectSummaryMatchesClaim(state)
            checked++
            now += 1_000
            return result
        }
    }
}

describe("summarizeOutbox", () => {
    test("an empty outbox has nothing open or due", () => {
        expect(summarizeOutbox({})).toEqual(EMPTY_OUTBOX_SUMMARY)
    })

    test("nextDueAt matches claimOutbox after every transition: spawns, a failed spawn retried, a handoff, a cancel", () => {
        const f = flow()
        for (const id of ["p1", "p2", "p3"]) f.step(d => wf.registerProfile(d, profileInput(id, { maxConcurrent: 2 })))
        f.step(d => wf.createTask(d, taskInput("tk-1")))
        f.step(d => wf.recordPlan(d, "tk-1", plan([workstream("ws-api", "api"), workstream("ws-web", "web")])))
        const reserved = f.step(d => wf.reserveWorkers(d, "tk-1", [{ workstreamId: "ws-api", profileId: "p1" }, { workstreamId: "ws-web", profileId: "p2" }]))
        if (!reserved.ok) throw new Error(JSON.stringify(reserved))
        const [api, web] = reserved.leases as [wf.WorkforceState["leases"][string], wf.WorkforceState["leases"][string]]
        expect(summarizeOutbox(f.state.outbox).open).toBe(2)

        // Claimed: both inflight, due again when their visibility timeout runs out.
        const claims = f.step(d => wf.claimOutbox(d, 10))
        expect(claims).toHaveLength(2)
        const inflight = Object.values(f.state.outbox).map(i => i.claimedUntil)
        expect(summarizeOutbox(f.state.outbox).nextDueAt).toBe(Math.min(...inflight.map(Number)))

        // One spawn fails and is retried later; the other succeeds.
        const webClaim = claims.find(c => c.leaseId === web.id)!
        const apiClaim = claims.find(c => c.leaseId === api.id)!
        f.step(d => wf.completeOutbox(d, webClaim.id, { ok: false, error: "relay down", retryable: true }))
        const retry = f.state.outbox[webClaim.id] as OutboxItem
        expect(retry.state).toBe("pending")
        f.step(d => wf.completeOutbox(d, apiClaim.id, { ok: true, invocationId: "inv-api", sha: null, detail: null }))
        expect(summarizeOutbox(f.state.outbox).nextDueAt).toBe(retry.nextAt)
        f.advance(retry.nextAt - T0)
        for (const claim of f.step(d => wf.claimOutbox(d, 10))) f.step(d => wf.completeOutbox(d, claim.id, { ok: true, invocationId: "inv-web", sha: null, detail: null }))
        f.step(d => wf.recordSpawnStatus(d, api.id, api.epoch, "running", null))
        f.step(d => wf.recordSpawnStatus(d, web.id, web.epoch, "running", null))
        for (let i = 0; i < 3; i++) f.step(d => wf.reportCheckpoint(d, api.id, api.epoch, (0x1000000 + i).toString(16), `progress ${i}`))

        // A cooldown hands api to p3: release, checkpoint and brief items, some blocked behind others.
        f.step(d => wf.markProfileLimited(d, "p1", T0 + 3_600_000, "limit", "detected"))
        expect(f.step(d => wf.requestHandoff(d, "tk-1", "ws-api", api.epoch, "p3")).ok).toBe(true)
        expect(Object.values(f.state.outbox).some(i => i.blockedBy && (i.state === "pending" || i.state === "inflight"))).toBe(true)
        // Drain one claim at a time so every intermediate blocked state is checked.
        for (let round = 0; round < 20 && summarizeOutbox(f.state.outbox).open > 0; round++) {
            const due = summarizeOutbox(f.state.outbox).nextDueAt
            if (due === null) break
            f.advance(Math.max(0, due - T0))
            for (const claim of f.step(d => wf.claimOutbox(d, 1)))
                f.step(d => wf.completeOutbox(d, claim.id, { ok: true, invocationId: `inv-${claim.id}`, sha: "abcdef1", detail: null }))
        }

        f.step(d => wf.cancelTask(d, "tk-1", "u-1001"))
        for (const claim of f.step(d => wf.claimOutbox(d, 50))) f.step(d => wf.completeOutbox(d, claim.id, { ok: true, invocationId: null, sha: null, detail: null }))
        expect(f.checked).toBeGreaterThan(25)
    })

    test("a pending item behind a pending blocker is not due; behind a failed soft blocker it is", () => {
        const base = { taskId: "tk-1", leaseId: "l-1", attempts: 0, lastError: null, createdAt: T0, updatedAt: T0, claimedUntil: null, hardBlock: false }
        const blocker = { ...base, id: "o-1", seq: 1, kind: "release", state: "pending", nextAt: T0 + 50, blockedBy: null } as unknown as OutboxItem
        const dependent = { ...base, id: "o-2", seq: 2, kind: "checkpoint", state: "pending", nextAt: T0, blockedBy: "o-1" } as unknown as OutboxItem
        expect(summarizeOutbox({ "o-1": blocker, "o-2": dependent })).toEqual({ open: 2, nextDueAt: T0 + 50 })
        const failed = { ...blocker, state: "failed" } as OutboxItem
        expect(summarizeOutbox({ "o-1": failed, "o-2": dependent })).toEqual({ open: 1, nextDueAt: T0 })
        const hard = { ...dependent, hardBlock: true } as OutboxItem
        expect(summarizeOutbox({ "o-1": failed, "o-2": hard })).toEqual({ open: 1, nextDueAt: null })
    })
})
