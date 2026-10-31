// Worst-case TeamWorkforce state for the size budgets (view-budget.test.ts for the emitted view, store-budget.test.ts
// for what is stored). Every user-, planner- and agent-written field at its validation limit, written in a three-byte
// character (lone surrogates, the only longer escape, are rejected), the most tasks, profiles and leases the actor
// keeps. Ids are server-minted, so they take their minted lengths.
import { expect } from "bun:test"
import { agentName, subagentName } from "../src/lib/names.ts"
import * as wf from "../src/lib/workforce.ts"
import type { CliProfile, Lease, Task, TraceEntry, Workstream } from "../src/lib/types.ts"

export const WIDE = "語" // three bytes in UTF-8, one UTF-16 unit, so `max(n)` admits n of them
export const fill = (n: number) => WIDE.repeat(n)
export const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

// Minted lengths: tasks `tk-` + 12, projects `p-` + 12, environments `e-` + 12, CLI profiles `cp-` + 12, users
// `u-<github id>`, leases `ls-<epoch>`, Relay nodes `n-` + 12, branches `morrow/<8>/<role>`, agents `agentName()`.
export const slug = (prefix: string, n: number) => `${prefix}${String(n).padStart(12, "0")}`
export const NOW = 1_800_000_000_000
export const BIG_EPOCH = 999_999_999_999
export const MAX = {
    title: 120,
    prompt: 8000,
    criterion: 300,
    criteria: 20,
    rationale: 4000,
    warning: 300,
    warnings: 20,
    brief: 12_000,
    why: 2000,
    ownership: 200,
    ownerships: 50,
    checkName: 120,
    checkDetail: 2000,
    checks: 50,
    summary: 2000,
    label: 48,
    reason: 300,
    usageWindows: 6,
    workstreams: 5,
    branch: 200,
    role: 24,
    projects: 50
} as const

export function worstWorkstream(taskId: string, i: number, leaseId: string | null): Workstream {
    const role = `${"r".repeat(MAX.role - 1)}${i}`
    return {
        id: `ws-${role}`,
        role,
        title: fill(MAX.title),
        brief: fill(MAX.brief),
        why: fill(MAX.why),
        // Planned branches are minted as `morrow/<taskShort>/<role>` (backend planner/shape.ts).
        branch: `morrow/${"s".repeat(8)}/${role}`,
        dependsOn: Array.from({ length: MAX.workstreams }, (_, d) => `ws-${"r".repeat(MAX.role - 1)}${d}`).filter((_, d) => d !== i),
        ownership: Array.from({ length: MAX.ownerships }, () => fill(MAX.ownership)),
        status: "handoff",
        leaseId,
        lastCheckpoint: { sha: "f".repeat(64), summary: fill(MAX.summary), epoch: BIG_EPOCH, at: NOW }
    }
}

export function worstTask(n: number, status: Task["status"]): Task {
    const id = slug("tk-", n)
    // Five planned workstreams plus the conflict resolver.
    const workstreams = Array.from({ length: MAX.workstreams + 1 }, (_, i) => worstWorkstream(id, i, `ls-${BIG_EPOCH - n * 10 - i}`))
    // The longest kind, with a plan, a reservation and a retry still stored so every derived time is set.
    const marks = ["task.planned", "worker.reserved", "task.retried"] as const
    const trace: TraceEntry[] = Array.from({ length: wf.WORKFORCE_LIMITS.traceEntries }, (_, i) => ({
        at: NOW + i,
        kind: marks[i] ?? "worker.capacity_restored",
        message: fill(wf.WORKFORCE_LIMITS.traceMessageChars),
        leaseId: `ls-${BIG_EPOCH}`,
        profileId: slug("cp-", 0),
        epoch: BIG_EPOCH
    }))
    return {
        id,
        projectId: slug("p-", n % MAX.projects),
        title: fill(MAX.title),
        prompt: fill(MAX.prompt),
        acceptance: Array.from({ length: MAX.criteria }, () => fill(MAX.criterion)),
        createdBy: `u-${"9".repeat(12)}`,
        status,
        maxAgents: 5,
        // Every task stored since strategies exist names its strategy; split tasks have the most workstreams.
        strategy: "split",
        plan: {
            source: "cli",
            profileId: slug("cp-", 0),
            rationale: fill(MAX.rationale),
            warnings: Array.from({ length: MAX.warnings }, () => fill(MAX.warning))
        },
        workstreams,
        checkpoints: [],
        verification: {
            status: "failed",
            checks: Array.from({ length: MAX.checks }, () => ({
                name: fill(MAX.checkName),
                status: "failed" as const,
                detail: fill(MAX.checkDetail),
                url: `https://example.com/${"x".repeat(470)}`
            }))
        },
        trace,
        traceCount: Number.MAX_SAFE_INTEGER,
        generation: BIG_EPOCH,
        planningUntil: null,
        resolutionAttempts: wf.WORKFORCE_LIMITS.conflictResolutions,
        createdAt: NOW + n,
        updatedAt: NOW + n
    }
}

export function worstProfile(n: number): CliProfile {
    return {
        id: slug("cp-", n),
        envId: slug("e-", n),
        ownerUserId: `u-${"9".repeat(12)}`,
        nodeName: slug("n-", n),
        cli: "opencode",
        label: fill(MAX.label),
        auth: "auth_required",
        availability: "limited",
        cooldownUntil: NOW,
        limitedReason: fill(MAX.reason),
        limitedSource: "detected",
        maxConcurrent: 4,
        scopes: Array.from({ length: MAX.projects }, (_, p) => slug("p-", p)),
        lastSeenAt: NOW,
        usage: {
            // Window labels are named by the backend ("Weekly Sonnet", "10080-minute"), never copied from CLI output.
            windows: Array.from({ length: MAX.usageWindows }, () => ({ kind: "other" as const, label: "x".repeat(16), usedPercent: 99.99999, resetsAt: NOW })),
            observedAt: NOW,
            source: "worker"
        },
        planningHold: null,
        createdAt: NOW
    }
}

export function worstLease(n: number, task: Task, state: Lease["state"], parent: Lease | null = null): Lease {
    const epoch = BIG_EPOCH - n
    const role = task.workstreams[n % task.workstreams.length]!.role
    return {
        id: `ls-${epoch}`,
        taskId: task.id,
        workstreamId: task.workstreams[n % task.workstreams.length]!.id,
        profileId: slug("cp-", n % wf.WORKFORCE_LIMITS.profiles),
        epoch,
        agentName: parent ? subagentName(task.id, role, epoch) : agentName(task.id, role, epoch),
        nodeName: slug("n-", n % wf.WORKFORCE_LIMITS.profiles),
        state,
        spawnInvocationId: null,
        expiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        // An ended lease keeps why it ended, at its limit (stored only; the view leaves it out).
        ...(state === "running" ? {} : { endReason: fill(wf.WORKFORCE_LIMITS.leaseEndReasonChars) }),
        ...(parent ? { workstreamId: parent.workstreamId, parentLeaseId: parent.id, role: "implementation" as const } : {})
    }
}

/** The most the actor keeps: 100 profiles, 100 active tasks, 20 shown finished ones, 400 live leases, 300 ended. */
export function worstState(): wf.WorkforceState {
    const state: wf.WorkforceState = { profiles: {}, tasks: {}, leases: {}, outbox: {}, epoch: BIG_EPOCH }
    for (let p = 0; p < wf.WORKFORCE_LIMITS.profiles; p++) state.profiles[slug("cp-", p)] = worstProfile(p)
    const active = Array.from({ length: wf.WORKFORCE_LIMITS.activeTasks }, (_, n) => worstTask(n, "verifying"))
    const finished = Array.from({ length: wf.WORKFORCE_LIMITS.viewTerminalTasks + 5 }, (_, n) => worstTask(1000 + n, "cancelled"))
    for (const task of [...active, ...finished]) state.tasks[task.id] = task
    // Live leases are capped by profile slots (4 each), ended ones by `terminalLeasesKept`.
    const liveLeases = wf.WORKFORCE_LIMITS.profiles * 4
    // Every worker with its two live subagents (docs/subagents.md): a subagent lease carries `parentLeaseId` too.
    let parent: Lease | null = null
    for (let n = 0; n < liveLeases; n++) {
        const lease: Lease = n % 3 === 0 || !parent ? worstLease(n, active[n % active.length]!, "running") : worstLease(n, state.tasks[parent.taskId]!, "running", parent)
        if (n % 3 === 0) parent = lease
        state.leases[lease.id] = lease
    }
    expect(Object.values(state.leases).filter(l => l.parentLeaseId).length).toBeGreaterThan(260)
    for (let n = 0; n < wf.WORKFORCE_LIMITS.terminalLeasesKept; n++) {
        // Ended leases of the finished tasks the view shows (the newest ones).
        const lease = worstLease(liveLeases + n, finished.at(-1 - (n % wf.WORKFORCE_LIMITS.viewTerminalTasks))!, "released")
        state.leases[lease.id] = lease
    }
    return state
}
