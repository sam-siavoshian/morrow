// TeamWorkforce state machine as pure functions over a copy-on-write draft. The actor validates input, runs one of
// these against a draft, then writes back only the fields that changed. Nothing here does I/O or reads the clock:
// `draft.now` is the transition's time.
import { agentName, subagentName, workstreamBranch } from "./names.ts"
import type {
    AddWorkstreamInput,
    AddWorkstreamResult,
    BeginPlanningResult,
    CancelSubagentResult,
    CancelTaskResult,
    DeleteTaskResult,
    CliKind,
    DelegateInput,
    DelegateResult,
    SubagentRecord,
    SubagentResultResult,
    SubagentResultStatus,
    SubagentRole,
    SubagentStatus,
    SubagentView,
    CliProfile,
    CompleteOutboxResult,
    ConflictInput,
    CreateTaskInput,
    CreateTaskResult,
    FencedResult,
    FenceRejection,
    LeaseView,
    LimitSource,
    Lease,
    MarkLimitedResult,
    MarkNotifiedResult,
    NoteWaitingResult,
    ProfileUsage,
    RecordUsageResult,
    OutboxClaim,
    OutboxItem,
    OutboxKind,
    OutboxResult,
    PickAttemptResult,
    PickResult,
    PlanInput,
    ProfileHealth,
    ProfileRejection,
    ProfileView,
    RecordPlanResult,
    RegisterProfileInput,
    RegisterProfileResult,
    RemoveProfileResult,
    RequestHandoffResult,
    ResolveConflictResult,
    RetryTaskResult,
    ReservePick,
    ReserveResult,
    SetTaskThreadResult,
    SetTaskWorkforceResult,
    SpawnStatus,
    SubmitVerificationResult,
    Task,
    TaskStatus,
    TaskRecord,
    TaskView,
    TraceEntry,
    TraceKind,
    UpdateHealthResult,
    VerificationView,
    WaitingReason,
    WorkforceMode,
    WorkforceRejection,
    WorkforceView,
    Workstream,
    WorkstreamView
} from "./types.ts"

export const WORKFORCE_LIMITS = {
    profiles: 100,
    activeTasks: 100,
    storedTasks: 500,
    traceEntries: 200,
    /** Trace entries per task in the emitted view, so a change never resends a long task's whole history. */
    viewTraceEntries: 1,
    /** Characters of that message in the emitted view (a one-line preview); the task detail carries it whole. */
    viewTraceMessageChars: 120,
    traceMessageChars: 500,
    /**
     * Characters of a lease's `endReason` (stored on the lease, returned by `getLease`). Not in the emitted view: the view's
     * size ceiling has no room for 300 ended leases' reasons. The trace entry that ended the lease carries the same words.
     */
    leaseEndReasonChars: 160,
    taskCheckpoints: 100,
    terminalLeasesKept: 300,
    finishedOutboxKept: 200,
    viewTerminalTasks: 20,
    /** Merge-conflict resolution attempts per task before it fails (a retry starts over). contracts `MAX_CONFLICT_RESOLUTIONS`. */
    conflictResolutions: 2,
    /** Live subagents per worker and per task (docs/subagents.md). A VM has little memory. */
    subagentsPerParent: 2,
    subagentsPerTask: 4,
    /** Subagent records a task keeps (oldest finished ones go first; live ones are never dropped). */
    subagentsKept: 20,
    /**
     * Workstreams per task, not counting the conflict resolver: a plan's most (validation `PlanInput`), and the most a
     * person can reach by adding workers to a running task. contracts `MAX_TASK_WORKSTREAMS`. The view's size ceiling
     * counts on it.
     */
    workstreamsPerTask: 5
} as const

/**
 * Ceiling on one task's JSON in the emitted view: every written field at its limit in three-byte characters, six
 * workstreams, ids at their minted lengths (test/view-budget.test.ts builds that case and the whole worst-case frame).
 */
export const VIEW_TASK_MAX_BYTES = 2048

/** The workstream that resolves a merge conflict. Planned ids are `ws-<role>` and the planner never emits this role. */
export const RESOLVER_ROLE = "resolver"
export const RESOLVER_WORKSTREAM_ID = "ws-resolver"

export const WORKFORCE_TIMING = {
    /**
     * A claimed outbox item becomes claimable again after this, so a crashed dispatcher's work is retried.
     * Per kind, longer than the slowest honest run of that side effect (a spawn prepares a worktree and waits
     * up to ~5 min for Relay to confirm), so a slow success never burns an attempt.
     */
    visibilityTimeoutMs: { spawn: 6 * 60_000, handoff_brief: 6 * 60_000, checkpoint: 3 * 60_000, release: 60_000 },
    /** A lease that never reaches `running` within this is failed by the sweep. */
    leaseStartTimeoutMs: 10 * 60_000,
    /** How long a planner call may hold a profile. */
    planningHoldMs: 150_000,
    maxCooldownMs: 7 * 24 * 60 * 60_000,
    /** An unchanged usage reading is rewritten at most this often (a changed one is written at once). */
    usageRewriteMs: 5 * 60_000,
    /** No subscription window resets further out than this; a later `resetsAt` is a bad reading. */
    maxUsageResetMs: 35 * 24 * 60 * 60_000,
    outboxMaxAttempts: 8,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000
} as const

export type WorkforceState = {
    profiles: Record<string, CliProfile>
    tasks: Record<string, Task>
    leases: Record<string, Lease>
    outbox: Record<string, OutboxItem>
    epoch: number
}

type RecordField = "profiles" | "tasks" | "leases" | "outbox"

/**
 * Copy-on-write view of the state. The first write to a field shallow-copies its record, so persisted objects are
 * never mutated in place; entries are always replaced with new objects.
 */
export class WorkforceDraft implements WorkforceState {
    profiles: Record<string, CliProfile>
    tasks: Record<string, Task>
    leases: Record<string, Lease>
    outbox: Record<string, OutboxItem>
    epoch: number
    readonly changed = new Set<keyof WorkforceState>()

    constructor(
        base: WorkforceState,
        readonly now: number
    ) {
        this.profiles = base.profiles
        this.tasks = base.tasks
        this.leases = base.leases
        this.outbox = base.outbox
        this.epoch = base.epoch
    }

    putProfile(profile: CliProfile): void {
        this.#own("profiles")
        this.profiles[profile.id] = profile
    }
    deleteProfile(id: string): void {
        this.#own("profiles")
        delete this.profiles[id]
    }
    putTask(task: Task): void {
        this.#own("tasks")
        this.tasks[task.id] = task
    }
    deleteTask(id: string): void {
        this.#own("tasks")
        delete this.tasks[id]
    }
    putLease(lease: Lease): void {
        this.#own("leases")
        this.leases[lease.id] = lease
    }
    deleteLease(id: string): void {
        this.#own("leases")
        delete this.leases[id]
    }
    putItem(item: OutboxItem): void {
        this.#own("outbox")
        this.outbox[item.id] = item
    }
    deleteItem(id: string): void {
        this.#own("outbox")
        delete this.outbox[id]
    }
    nextEpoch(): number {
        this.epoch += 1
        this.changed.add("epoch")
        return this.epoch
    }

    #own(field: RecordField): void {
        if (this.changed.has(field)) return
        this.changed.add(field)
        if (field === "profiles") this.profiles = { ...this.profiles }
        else if (field === "tasks") this.tasks = { ...this.tasks }
        else if (field === "leases") this.leases = { ...this.leases }
        else this.outbox = { ...this.outbox }
    }
}

// ---------- predicates ----------

const TERMINAL_TASK: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"])
const STARTABLE_TASK: ReadonlySet<TaskStatus> = new Set(["planned", "starting", "running", "handoff", "resolving"])
const PLANNABLE_TASK: ReadonlySet<TaskStatus> = new Set(["draft", "planning", "planned"])

export const isTerminalTask = (status: TaskStatus): boolean => TERMINAL_TASK.has(status)
export const isLiveLease = (lease: Lease): boolean => lease.state === "reserved" || lease.state === "spawning" || lease.state === "running"
const isOpenItem = (item: OutboxItem): boolean => item.state === "pending" || item.state === "inflight"
const leaseIsLive = (state: WorkforceState, leaseId: string | null): boolean => {
    const lease = leaseId ? state.leases[leaseId] : undefined
    return lease !== undefined && isLiveLease(lease)
}

export function clip(value: string, max: number): string {
    if (value.length <= max) return value
    // Never cut a surrogate pair in half: the view's size ceiling counts on well-formed text.
    const end = /[\uD800-\uDBFF]/.test(value[max - 2] ?? "") ? max - 2 : max - 1
    return `${value.slice(0, end)}…`
}

export function outboxBackoffMs(attempts: number): number {
    const exponent = Math.max(0, attempts - 1)
    return Math.min(WORKFORCE_TIMING.backoffMaxMs, WORKFORCE_TIMING.backoffBaseMs * 2 ** exponent)
}

export function liveLeaseCounts(state: WorkforceState): Map<string, number> {
    const counts = new Map<string, number>()
    for (const lease of Object.values(state.leases))
        if (isLiveLease(lease)) counts.set(lease.profileId, (counts.get(lease.profileId) ?? 0) + 1)
    return counts
}

/** Slots in use: live leases plus an active planning hold. */
export function profileLoad(state: WorkforceState, profile: CliProfile, now: number): number {
    const leases = Object.values(state.leases).filter(lease => lease.profileId === profile.id && isLiveLease(lease)).length
    return leases + (profile.planningHold && profile.planningHold.until > now ? 1 : 0)
}

export function profileRejection(
    d: WorkforceDraft,
    profile: CliProfile | undefined,
    projectId: string,
    extraLoad: number,
    /** The workstream's harness, for a compare attempt: only a profile of that CLI may take it. */
    harness?: CliKind
): ProfileRejection | null {
    if (!profile) return "unknown_profile"
    if (harness !== undefined && profile.cli !== harness) return "wrong_harness"
    if (profile.availability === "limited") return "profile_limited"
    if (profile.availability === "offline") return "profile_offline"
    if (profile.auth === "auth_required") return "profile_auth_required"
    if (profile.scopes !== "all" && !profile.scopes.includes(projectId)) return "out_of_scope"
    if (profileLoad(d, profile, d.now) + extraLoad >= profile.maxConcurrent) return "over_capacity"
    return null
}

// ---------- small writers ----------

type TraceRefs = { leaseId?: string | null; profileId?: string | null; epoch?: number | null }

export function addTrace(d: WorkforceDraft, taskId: string, kind: TraceKind, message: string, refs: TraceRefs = {}): void {
    const task = d.tasks[taskId]
    if (!task) return
    const trace = [
        ...task.trace,
        {
            at: d.now,
            kind,
            message: clip(message, WORKFORCE_LIMITS.traceMessageChars),
            leaseId: refs.leaseId ?? null,
            profileId: refs.profileId ?? null,
            epoch: refs.epoch ?? null
        }
    ]
    d.putTask({
        ...task,
        trace: trace.slice(-WORKFORCE_LIMITS.traceEntries),
        traceCount: (task.traceCount ?? task.trace.length) + 1,
        updatedAt: d.now
    })
}

function setWorkstream(d: WorkforceDraft, taskId: string, workstreamId: string, patch: Partial<Workstream>): void {
    const task = d.tasks[taskId]
    if (!task) return
    d.putTask({
        ...task,
        workstreams: task.workstreams.map(ws => (ws.id === workstreamId ? { ...ws, ...patch } : ws)),
        updatedAt: d.now
    })
}

function setTaskStatus(d: WorkforceDraft, taskId: string, status: TaskStatus, extra: Partial<Task> = {}): void {
    const task = d.tasks[taskId]
    if (!task) return
    d.putTask({ ...task, ...extra, status, updatedAt: d.now })
}

function findWorkstream(task: Task | undefined, workstreamId: string): Workstream | undefined {
    return task?.workstreams.find(ws => ws.id === workstreamId)
}

function clearPlanningHolds(d: WorkforceDraft, taskId: string): void {
    for (const profile of Object.values(d.profiles))
        if (profile.planningHold?.taskId === taskId) d.putProfile({ ...profile, planningHold: null })
}

// ---------- outbox ----------

type PayloadOf<K extends OutboxKind> = Extract<OutboxItem, { kind: K }>["payload"]

function enqueue<K extends OutboxKind>(
    d: WorkforceDraft,
    kind: K,
    lease: Lease,
    payload: PayloadOf<K>,
    blockedBy: string | null = null,
    hardBlock = false
): OutboxItem {
    const open = Object.values(d.outbox).find(item => item.leaseId === lease.id && item.kind === kind && isOpenItem(item))
    if (open) return open
    const base = `ob-${lease.id}-${kind}`
    let id = base
    for (let n = 2; d.outbox[id]; n++) id = `${base}-${n}`
    const seq = Object.values(d.outbox).reduce((max, item) => Math.max(max, item.seq), 0) + 1
    const item = {
        id,
        seq,
        kind,
        leaseId: lease.id,
        taskId: lease.taskId,
        state: "pending",
        attempts: 0,
        nextAt: d.now,
        claimedUntil: null,
        blockedBy,
        hardBlock,
        lastError: null,
        createdAt: d.now,
        updatedAt: d.now,
        payload
    } as OutboxItem
    d.putItem(item)
    return item
}

/**
 * Agent names of the subagents of `parentLeaseId` that may still be running: a live lease, or an ended one whose
 * release has not gone through yet. Its tree is only settled once this is empty.
 */
export function stoppingChildren(leases: Readonly<Record<string, Lease>>, outbox: Readonly<Record<string, OutboxItem>>, parentLeaseId: string): string[] {
    const names = new Set<string>()
    for (const lease of Object.values(leases)) if (lease.parentLeaseId === parentLeaseId && isLiveLease(lease)) names.add(lease.agentName)
    for (const item of Object.values(outbox)) {
        if (item.kind !== "release" || !isOpenItem(item)) continue
        const lease = leases[item.leaseId]
        if (lease?.parentLeaseId === parentLeaseId) names.add(lease.agentName)
    }
    return [...names].sort()
}

function dependents(d: WorkforceDraft, id: string): OutboxItem[] {
    return Object.values(d.outbox).filter(item => item.blockedBy === id && isOpenItem(item))
}

function isUnblocked(d: WorkforceDraft, item: OutboxItem): boolean {
    // A checkpoint commits the tree its lease worked in, which its subagents write to as well: it waits until every
    // one of them is stopped, not only the lease itself.
    if (item.kind === "checkpoint" && stoppingChildren(d.leases, d.outbox, item.leaseId).length > 0) return false
    if (!item.blockedBy) return true
    const blocker = d.outbox[item.blockedBy]
    if (!blocker || blocker.state === "done") return true
    if (blocker.state === "failed" || blocker.state === "cancelled") return !item.hardBlock
    return false
}

function cancelItem(d: WorkforceDraft, id: string, reason: string): void {
    const item = d.outbox[id]
    if (!item || !isOpenItem(item)) return
    d.putItem({ ...item, state: "cancelled", claimedUntil: null, lastError: clip(reason, 500), updatedAt: d.now })
    for (const dep of dependents(d, id)) if (dep.hardBlock) cancelItem(d, dep.id, `blocked by cancelled ${id}`)
}

function failItem(d: WorkforceDraft, id: string, error: string): void {
    const item = d.outbox[id]
    if (!item || !isOpenItem(item)) return
    d.putItem({ ...item, state: "failed", claimedUntil: null, lastError: clip(error, 500), updatedAt: d.now })
    if (item.kind === "spawn") {
        const lease = d.leases[item.leaseId]
        if (lease && isLiveLease(lease)) {
            // A subagent's parent reads this reason: say what went wrong, not only that it did.
            endLease(d, lease.id, "failed", `spawn failed: ${clip(oneLine(error), 200)}`)
            addTrace(d, lease.taskId, "worker.blocked", `Could not start ${lease.agentName}: ${error}`, refsOf(lease))
        }
    }
    for (const dep of dependents(d, id)) if (dep.hardBlock) failItem(d, dep.id, `blocked by failed ${id}`)
}

function ensureReleased(d: WorkforceDraft, lease: Lease, reason: string): OutboxItem {
    const inflightSpawn = Object.values(d.outbox).find(item => item.leaseId === lease.id && item.kind === "spawn" && item.state === "inflight")
    return enqueue(d, "release", lease, { agentName: lease.agentName, nodeName: lease.nodeName, reason }, inflightSpawn?.id ?? null, false)
}

function toClaim(item: OutboxItem): OutboxClaim {
    const common = { id: item.id, leaseId: item.leaseId, taskId: item.taskId, attempts: item.attempts }
    switch (item.kind) {
        case "spawn":
            return { ...common, kind: "spawn", payload: item.payload }
        case "release":
            return { ...common, kind: "release", payload: item.payload }
        case "checkpoint":
            return { ...common, kind: "checkpoint", payload: item.payload }
        case "handoff_brief":
            return { ...common, kind: "handoff_brief", payload: item.payload }
    }
}

export function claimOutbox(d: WorkforceDraft, limit: number): OutboxClaim[] {
    // Creation order: a blocker is always older than its dependents, so one pass sees blockers settle first.
    const candidates = Object.values(d.outbox)
        .filter(isOpenItem)
        .sort((a, b) => a.seq - b.seq)
    const claims: OutboxClaim[] = []
    for (const candidate of candidates) {
        if (claims.length >= limit) break
        // Re-read: cascades earlier in this loop may have changed it.
        const item = d.outbox[candidate.id]
        if (!item || !isOpenItem(item)) continue
        const due = item.state === "pending" ? item.nextAt <= d.now && isUnblocked(d, item) : (item.claimedUntil ?? 0) <= d.now
        if (!due) continue
        if ((item.kind === "spawn" || item.kind === "handoff_brief") && !leaseIsLive(d, item.leaseId)) {
            cancelItem(d, item.id, "lease ended")
            continue
        }
        if (item.attempts >= WORKFORCE_TIMING.outboxMaxAttempts) {
            failItem(d, item.id, `gave up after ${item.attempts} attempts${item.lastError ? `: ${item.lastError}` : ""}`)
            continue
        }
        const claimed: OutboxItem = {
            ...item,
            state: "inflight",
            attempts: item.attempts + 1,
            claimedUntil: d.now + WORKFORCE_TIMING.visibilityTimeoutMs[item.kind],
            updatedAt: d.now
        }
        d.putItem(claimed)
        claims.push(toClaim(claimed))
    }
    return claims
}

export function completeOutbox(d: WorkforceDraft, id: string, result: OutboxResult): CompleteOutboxResult {
    const item = d.outbox[id]
    if (!item) return { ok: false, reason: "unknown_item" }
    if (item.state === "pending") return { ok: false, reason: "not_claimed" }
    if (item.state !== "inflight") {
        // A spawn that was cancelled while the dispatcher held it may still have started an agent.
        if (item.kind === "spawn" && item.state === "cancelled" && result.ok) {
            const lease = d.leases[item.leaseId]
            if (lease) ensureReleased(d, lease, "spawned after its lease ended")
        }
        return { ok: true, state: item.state }
    }
    if (result.ok) {
        d.putItem({ ...item, state: "done", claimedUntil: null, lastError: null, updatedAt: d.now })
        onItemDone(d, item, result.invocationId, result.sha, result.detail)
    } else if (result.retryable && item.attempts < WORKFORCE_TIMING.outboxMaxAttempts) {
        d.putItem({
            ...item,
            state: "pending",
            claimedUntil: null,
            nextAt: d.now + outboxBackoffMs(item.attempts),
            lastError: clip(result.error, 500),
            updatedAt: d.now
        })
    } else {
        failItem(d, item.id, result.error)
    }
    return { ok: true, state: d.outbox[id]!.state }
}

function onItemDone(d: WorkforceDraft, item: OutboxItem, invocationId: string | null, sha: string | null, detail: string | null): void {
    const lease = d.leases[item.leaseId]
    if (!lease) return
    if (item.kind === "spawn") {
        if (!isLiveLease(lease)) {
            ensureReleased(d, lease, "spawned after its lease ended")
            return
        }
        if (lease.state === "reserved" || (invocationId && lease.spawnInvocationId !== invocationId))
            d.putLease({
                ...lease,
                state: lease.state === "reserved" ? "spawning" : lease.state,
                spawnInvocationId: invocationId ?? lease.spawnInvocationId,
                updatedAt: d.now
            })
    } else if (item.kind === "checkpoint" && sha) {
        recordCheckpoint(d, lease, sha, detail ?? `Checkpoint of ${lease.agentName}'s worktree after its lease ended`)
    }
}

// ---------- leases ----------

function refsOf(lease: Lease): TraceRefs {
    return { leaseId: lease.id, profileId: lease.profileId, epoch: lease.epoch }
}

export function leaseView(lease: Lease): LeaseView {
    return {
        id: lease.id,
        taskId: lease.taskId,
        workstreamId: lease.workstreamId,
        profileId: lease.profileId,
        epoch: lease.epoch,
        agentName: lease.agentName,
        nodeName: lease.nodeName,
        state: lease.state,
        createdAt: lease.createdAt,
        ...(lease.parentLeaseId ? { parentLeaseId: lease.parentLeaseId } : {})
    }
}

function issueLease(d: WorkforceDraft, task: Task, ws: Workstream, profile: CliProfile): Lease {
    const epoch = d.nextEpoch()
    const lease: Lease = {
        id: `ls-${epoch}`,
        taskId: task.id,
        workstreamId: ws.id,
        profileId: profile.id,
        epoch,
        agentName: agentName(task.id, ws.role, epoch),
        nodeName: profile.nodeName,
        state: "reserved",
        spawnInvocationId: null,
        expiresAt: d.now + WORKFORCE_TIMING.leaseStartTimeoutMs,
        createdAt: d.now,
        updatedAt: d.now
    }
    d.putLease(lease)
    return lease
}

function spawnPayload(task: Task, ws: Workstream, profile: CliProfile, lease: Lease, handoff: boolean): PayloadOf<"spawn"> {
    return {
        agentName: lease.agentName,
        nodeName: lease.nodeName,
        cli: profile.cli,
        profileId: profile.id,
        envId: profile.envId,
        taskId: task.id,
        projectId: task.projectId,
        workstreamId: ws.id,
        role: ws.role,
        title: ws.title,
        brief: ws.brief,
        branch: ws.branch,
        epoch: lease.epoch,
        handoff
    }
}

/**
 * Moves a live lease to a terminal state and queues the cleanup its agent needs. `expired` means the worker was cut
 * off mid-work (its workstream needs a handoff); `failed` means it never got going; `released` is a normal end whose
 * caller sets the workstream status.
 */
function endLease(d: WorkforceDraft, leaseId: string, to: "released" | "expired" | "failed", reason: string): void {
    const lease = d.leases[leaseId]
    if (!lease || !isLiveLease(lease)) return
    const spawnClaimed = Object.values(d.outbox).some(
        item => item.leaseId === lease.id && item.kind === "spawn" && (item.state === "inflight" || item.state === "done")
    )
    const agentMayExist = lease.state === "spawning" || lease.state === "running" || spawnClaimed
    const workedOnTree = lease.state === "spawning" || lease.state === "running"
    // Kept on the lease (and in the view) so every surface can say why this worker stopped, not only that it did.
    const endReason = clip(oneLine(reason), WORKFORCE_LIMITS.leaseEndReasonChars) || null
    d.putLease({ ...lease, state: to, expiresAt: null, updatedAt: d.now, endReason })

    // Pending start-up work is pointless now. In-flight work is left to finish and is cleaned up on completion.
    for (const item of Object.values(d.outbox))
        if (item.leaseId === lease.id && (item.kind === "spawn" || item.kind === "handoff_brief") && item.state === "pending")
            cancelItem(d, item.id, reason)

    // A subagent works in its parent's tree and owns no workstream: stop it, record why, nothing else. Its parent's
    // checkpoint or handoff covers the tree.
    if (lease.parentLeaseId) {
        if (agentMayExist) ensureReleased(d, lease, reason)
        const status: SubagentStatus = to === "released" ? "cancelled" : "failed"
        const why = to === "released" ? `Stopped: ${reason}.` : to === "expired" ? `Stopped before reporting a result: ${reason}.` : `Could not start: ${reason}.`
        finishSubagent(d, lease, status, why, false)
        return
    }
    // Every subagent stops with its parent, in the same transition (t3code kept finished children for an hour).
    for (const child of liveChildren(d, lease.id)) endLease(d, child.id, "released", `its parent ${lease.agentName} stopped`)

    const task = d.tasks[lease.taskId]
    const ws = findWorkstream(task, lease.workstreamId)
    if (task && ws && ws.leaseId === lease.id && (ws.status === "active" || ws.status === "handoff")) {
        const status = to === "expired" ? "handoff" : to === "failed" ? (ws.status === "handoff" ? "handoff" : "pending") : ws.status
        if (status !== ws.status) setWorkstream(d, task.id, ws.id, { status })
    }

    const release = agentMayExist ? ensureReleased(d, lease, reason) : null
    if (to === "expired" && workedOnTree && task && ws) {
        const profile = d.profiles[lease.profileId]
        // Stop the agent first, then commit whatever it left in its worktree.
        enqueue(
            d,
            "checkpoint",
            lease,
            {
                agentName: lease.agentName,
                nodeName: lease.nodeName,
                profileId: lease.profileId,
                envId: profile?.envId ?? "",
                taskId: task.id,
                workstreamId: ws.id,
                branch: ws.branch,
                epoch: lease.epoch
            },
            release?.id ?? null,
            false
        )
    }
}

function recordCheckpoint(d: WorkforceDraft, lease: Lease, sha: string, summary: string): boolean {
    const task = d.tasks[lease.taskId]
    const ws = findWorkstream(task, lease.workstreamId)
    if (!task || !ws || ws.status === "done") return false
    // Never let an older epoch's checkpoint replace a newer worker's.
    if (ws.lastCheckpoint && ws.lastCheckpoint.epoch > lease.epoch) return false
    if (ws.lastCheckpoint?.sha === sha && ws.lastCheckpoint.epoch === lease.epoch) return false
    const checkpoint = { sha, summary: clip(summary, 2000), epoch: lease.epoch, at: d.now }
    setWorkstream(d, task.id, ws.id, { lastCheckpoint: checkpoint })
    const updated = d.tasks[task.id]!
    d.putTask({
        ...updated,
        checkpoints: [...updated.checkpoints, { workstreamId: ws.id, ...checkpoint }].slice(-WORKFORCE_LIMITS.taskCheckpoints)
    })
    addTrace(d, task.id, "task.checkpointed", `Checkpoint ${sha.slice(0, 12)} on ${ws.branch} by ${lease.agentName}`, refsOf(lease))
    return true
}

// ---------- subagents (docs/subagents.md) ----------

const CLI_LABEL: Record<CliKind, string> = {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "opencode",
    cursor: "Cursor Agent",
    gemini: "Gemini CLI",
    grok: "Grok"
}
const ROLE_NOUN: Record<SubagentRole, string> = { review: "review", research: "research", implementation: "implementation", test: "test pass", general: "task" }

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

export function liveChildren(state: Pick<WorkforceState, "leases">, parentLeaseId: string): Lease[] {
    return Object.values(state.leases)
        .filter(lease => lease.parentLeaseId === parentLeaseId && isLiveLease(lease))
        .sort((a, b) => a.epoch - b.epoch)
}

export function subagentView(record: SubagentRecord): SubagentView {
    return {
        leaseId: record.leaseId,
        parentLeaseId: record.parentLeaseId,
        agentName: record.agentName,
        parentAgentName: record.parentAgentName,
        cli: record.cli,
        profileId: record.profileId,
        role: record.role,
        task: record.task,
        status: record.status,
        summary: record.summary,
        createdAt: record.createdAt,
        finishedAt: record.finishedAt
    }
}

/** Keeps every live record and the newest finished ones, oldest first. */
function keepSubagents(records: readonly SubagentRecord[]): SubagentRecord[] {
    const excess = records.length - WORKFORCE_LIMITS.subagentsKept
    if (excess <= 0) return [...records]
    const drop = new Set(records.filter(r => r.status !== "running").slice(0, excess))
    return records.filter(r => !drop.has(r))
}

function putSubagent(d: WorkforceDraft, taskId: string, record: SubagentRecord): void {
    const task = d.tasks[taskId]
    if (!task) return
    const others = (task.subagents ?? []).filter(r => r.leaseId !== record.leaseId)
    const known = (task.subagents ?? []).some(r => r.leaseId === record.leaseId)
    const subagents = known ? (task.subagents ?? []).map(r => (r.leaseId === record.leaseId ? record : r)) : keepSubagents([...others, record])
    d.putTask({ ...task, subagents, updatedAt: d.now })
}

function findSubagent(d: WorkforceDraft, lease: Lease): SubagentRecord | undefined {
    return d.tasks[lease.taskId]?.subagents?.find(r => r.leaseId === lease.id)
}

/**
 * Ends a running subagent's record: its own result (`fromResult`), or why it stopped. A record that already ended
 * keeps its first outcome, so a result followed by the release that stops the process stays a result.
 */
function finishSubagent(d: WorkforceDraft, lease: Lease, status: Exclude<SubagentStatus, "running">, summary: string, fromResult: boolean): boolean {
    const record = findSubagent(d, lease)
    if (!record || record.status !== "running") return false
    putSubagent(d, lease.taskId, { ...record, status, summary, finishedAt: d.now })
    const who = `${CLI_LABEL[record.cli]} (${record.agentName})`
    const noun = ROLE_NOUN[record.role]
    const said = `"${clip(oneLine(summary), 200)}"`
    const message =
        status === "completed"
            ? `${who} finished the ${noun}: ${said}`
            : status === "cancelled"
              ? `${who} was stopped: ${clip(oneLine(summary).replace(/^Stopped: /, ""), 200)}`
              : fromResult
                ? `${who} could not finish the ${noun}: ${said}`
                : `${who} ended without finishing the ${noun}. ${clip(oneLine(summary), 200)}`
    addTrace(d, lease.taskId, "subagent.finished", message, refsOf(lease))
    return true
}

/**
 * A worker starts a subagent on another CLI of its own machine: same task, workstream and worktree, a fresh lease
 * and epoch, and a spawn in the outbox like any worker. Refused for a caller that is not a live worker, a subagent
 * caller, a CLI with no usable profile on that machine, and past the live caps. Idempotent on (caller, request id).
 */
export function delegate(d: WorkforceDraft, input: DelegateInput): DelegateResult {
    const parent = d.leases[input.parentLeaseId]
    if (!parent || !isLiveLease(parent)) return { ok: false, reason: "parent_not_active" }
    if (parent.parentLeaseId) return { ok: false, reason: "parent_is_subagent" }
    const task = d.tasks[parent.taskId]
    const ws = findWorkstream(task, parent.workstreamId)
    if (!task || !ws || ws.leaseId !== parent.id || !STARTABLE_TASK.has(task.status)) return { ok: false, reason: "parent_not_active" }
    const prior = task.subagents?.find(r => r.parentLeaseId === parent.id && r.clientRequestId === input.clientRequestId)
    if (prior) {
        // A retry must be the same request. Another one under a used id would silently get the old subagent back.
        if (prior.cli !== input.target || prior.role !== input.role || prior.task !== input.task) return { ok: false, reason: "request_mismatch" }
        return { ok: true, created: false, subagent: subagentView(prior) }
    }

    if (liveChildren(d, parent.id).length >= WORKFORCE_LIMITS.subagentsPerParent) return { ok: false, reason: "parent_limit" }
    const liveInTask = Object.values(d.leases).filter(l => l.taskId === task.id && l.parentLeaseId && isLiveLease(l)).length
    if (liveInTask >= WORKFORCE_LIMITS.subagentsPerTask) return { ok: false, reason: "task_limit" }

    // Only the caller's own machine: a subagent never spends another member's plan or runs on their VM.
    const home = d.profiles[parent.profileId]
    if (!home) return { ok: false, reason: "parent_not_active" }
    const onMachine = Object.values(d.profiles)
        .filter(p => p.envId === home.envId && p.ownerUserId === home.ownerUserId && p.cli === input.target)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (onMachine.length === 0) return { ok: false, reason: "no_target_profile" }
    // A manual task's subagents are leases like its workers: only a pinned profile may run one.
    const candidates = onMachine.filter(p => !pinRejection(task, p.id))
    if (candidates.length === 0) return { ok: false, reason: "not_pinned" }
    let profile: CliProfile | undefined
    let rejection: DelegateResult extends infer R ? (R extends { ok: false; reason: infer X } ? X : never) : never = "no_target_profile"
    for (const candidate of candidates) {
        const why = profileRejection(d, candidate, task.projectId, 0)
        if (!why) {
            profile = candidate
            break
        }
        if (rejection === "no_target_profile") rejection = why
    }
    if (!profile) return { ok: false, reason: rejection }

    const epoch = d.nextEpoch()
    const lease: Lease = {
        id: `ls-${epoch}`,
        taskId: task.id,
        workstreamId: ws.id,
        profileId: profile.id,
        epoch,
        agentName: subagentName(task.id, ws.role, epoch),
        nodeName: profile.nodeName,
        state: "reserved",
        spawnInvocationId: null,
        expiresAt: d.now + WORKFORCE_TIMING.leaseStartTimeoutMs,
        createdAt: d.now,
        updatedAt: d.now,
        parentLeaseId: parent.id,
        role: input.role
    }
    d.putLease(lease)
    const parentCli = home.cli
    enqueue(d, "spawn", lease, {
        ...spawnPayload(task, ws, profile, lease, false),
        subagent: { parentLeaseId: parent.id, parentAgentName: parent.agentName, parentCli, role: input.role }
    })
    const record: SubagentRecord = {
        leaseId: lease.id,
        parentLeaseId: parent.id,
        agentName: lease.agentName,
        parentAgentName: parent.agentName,
        cli: profile.cli,
        profileId: profile.id,
        role: input.role,
        task: input.task,
        status: "running",
        summary: null,
        createdAt: d.now,
        finishedAt: null,
        clientRequestId: input.clientRequestId
    }
    putSubagent(d, task.id, record)
    addTrace(
        d,
        task.id,
        "subagent.started",
        `${CLI_LABEL[parentCli]} (${parent.agentName}) started ${CLI_LABEL[profile.cli]} as ${lease.agentName} for a ${ROLE_NOUN[input.role]}: "${clip(oneLine(input.task), 200)}"`,
        refsOf(lease)
    )
    return { ok: true, created: true, subagent: subagentView(record) }
}

/** A subagent's own result. Recorded once; the lease is released in the same transition, which stops the process. */
export function recordSubagentResult(d: WorkforceDraft, leaseId: string, epoch: number, status: SubagentResultStatus, summary: string): SubagentResultResult {
    const lease = d.leases[leaseId]
    if (!lease) return { ok: false, reason: "unknown_lease" }
    if (!lease.parentLeaseId) return { ok: false, reason: "not_a_subagent" }
    if (lease.epoch !== epoch) return { ok: false, reason: "stale_epoch" }
    const record = findSubagent(d, lease)
    if (!record) return { ok: false, reason: "not_a_subagent" }
    if (!isLiveLease(lease) || record.status !== "running") return { ok: true, recorded: false, subagent: subagentView(record) }
    finishSubagent(d, lease, status, summary, true)
    endLease(d, lease.id, "released", "its result was recorded")
    return { ok: true, recorded: true, subagent: subagentView(findSubagent(d, lease)!) }
}

/** The parent stops one of its subagents. Someone else's, or an unknown id, is `task_not_found`. */
export function cancelSubagent(d: WorkforceDraft, parentLeaseId: string, childLeaseId: string, reason: string | null): CancelSubagentResult {
    const child = d.leases[childLeaseId]
    const record = child && child.parentLeaseId === parentLeaseId ? findSubagent(d, child) : undefined
    if (!child || !record) return { ok: false, reason: "task_not_found" }
    if (!isLiveLease(child) || record.status !== "running") return { ok: true, cancelled: false, subagent: subagentView(record) }
    endLease(d, child.id, "released", `cancelled by ${record.parentAgentName}${reason ? ` (${clip(oneLine(reason), 200)})` : ""}`)
    return { ok: true, cancelled: true, subagent: subagentView(findSubagent(d, child)!) }
}

// ---------- profiles ----------

export function registerProfile(d: WorkforceDraft, input: RegisterProfileInput): RegisterProfileResult {
    const existing = d.profiles[input.id]
    if (existing && (existing.ownerUserId !== input.ownerUserId || existing.envId !== input.envId))
        return { ok: false, reason: "profile_owner_mismatch" }
    if (!existing && Object.keys(d.profiles).length >= WORKFORCE_LIMITS.profiles) return { ok: false, reason: "too_many_profiles" }
    const profile: CliProfile = existing
        ? { ...existing, nodeName: input.nodeName, cli: input.cli, label: input.label, scopes: input.scopes, maxConcurrent: input.maxConcurrent }
        : {
              ...input,
              auth: "unknown",
              availability: "ready",
              cooldownUntil: null,
              limitedReason: null,
              limitedSource: null,
              lastSeenAt: null,
              usage: null,
              planningHold: null,
              createdAt: d.now
          }
    d.putProfile(profile)
    return { ok: true, profile: profileView(profile, liveLeaseCounts(d).get(profile.id) ?? 0) }
}

export function updateProfileHealth(d: WorkforceDraft, profileId: string, health: ProfileHealth): UpdateHealthResult {
    const profile = d.profiles[profileId]
    if (!profile) return { ok: false, reason: "unknown_profile" }
    if (profile.lastSeenAt !== null && health.observedAt < profile.lastSeenAt) return { ok: true, applied: false }
    const availability = profile.availability === "limited" ? "limited" : health.online ? "ready" : "offline"
    d.putProfile({ ...profile, auth: health.auth, availability, lastSeenAt: health.observedAt })
    if (profile.availability === "ready" && availability === "offline")
        for (const lease of Object.values(d.leases))
            if (lease.profileId === profileId && isLiveLease(lease))
                addTrace(d, lease.taskId, "worker.offline", `${profile.label} went offline while ${lease.agentName} held a lease`, refsOf(lease))
    return { ok: true, applied: true }
}

export function removeProfile(d: WorkforceDraft, profileId: string): RemoveProfileResult {
    const profile = d.profiles[profileId]
    if (!profile) return { ok: true, removed: false, expiredLeaseIds: [] }
    const expired: string[] = []
    for (const lease of liveLeasesOf(d, profileId)) {
        if (!isLiveLease(d.leases[lease.id]!)) continue
        endLease(d, lease.id, "expired", "profile removed")
        expired.push(lease.id)
        if (lease.parentLeaseId) continue
        addTrace(d, lease.taskId, "worker.offline", `${profile.label} was removed; ${lease.agentName} needs a handoff`, refsOf(lease))
    }
    d.deleteProfile(profileId)
    return { ok: true, removed: true, expiredLeaseIds: expired }
}

function liveLeasesOf(d: WorkforceDraft, profileId: string): Lease[] {
    return Object.values(d.leases)
        .filter(lease => lease.profileId === profileId && isLiveLease(lease))
        .sort((a, b) => a.epoch - b.epoch)
}

/** Cooldown for this one profile only; its live leases expire and their workstreams go to handoff. */
export function markProfileLimited(d: WorkforceDraft, profileId: string, until: number, reason: string, source: LimitSource): MarkLimitedResult {
    const profile = d.profiles[profileId]
    if (!profile) return { ok: false, reason: "unknown_profile" }
    const cooldownUntil = profile.availability === "limited" && profile.cooldownUntil !== null ? Math.max(profile.cooldownUntil, until) : until
    d.putProfile({ ...profile, availability: "limited", cooldownUntil, limitedReason: reason, limitedSource: source })
    const expired: string[] = []
    for (const lease of liveLeasesOf(d, profileId)) {
        // A parent listed first may already have stopped its subagents.
        if (!isLiveLease(d.leases[lease.id]!)) continue
        endLease(d, lease.id, "expired", `usage limit (${source})`)
        expired.push(lease.id)
        if (lease.parentLeaseId) continue
        addTrace(
            d,
            lease.taskId,
            "worker.quota_limited",
            `[${source}] ${profile.label} (${profile.cli}) hit a usage limit: ${reason}. ${lease.agentName} stopped; its workstream needs a handoff.`,
            refsOf(lease)
        )
    }
    return { ok: true, cooldownUntil, expiredLeaseIds: expired }
}

const windowKey = (w: ProfileUsage["windows"][number]) => `${w.kind}|${w.label}`

function sameWindows(a: ProfileUsage["windows"], b: ProfileUsage["windows"]): boolean {
    return a.length === b.length && a.every((w, i) => windowKey(w) === windowKey(b[i]!) && w.usedPercent === b[i]!.usedPercent && w.resetsAt === b[i]!.resetsAt)
}

/**
 * The latest usage reading wins; an older or equal `observedAt` is ignored, so readings from the probe and from
 * worker output can arrive in any order. A probe reading is the whole picture and replaces the stored windows. A
 * worker reading usually names one window (the CLI printed one warning), so it replaces only that window. An
 * unchanged reading is rewritten at most every `usageRewriteMs`, so a chatty source cannot flood the view.
 */
export function recordProfileUsage(d: WorkforceDraft, profileId: string, usage: ProfileUsage): RecordUsageResult {
    const profile = d.profiles[profileId]
    if (!profile) return { ok: false, reason: "unknown_profile" }
    const prev = profile.usage ?? null
    if (prev && usage.observedAt <= prev.observedAt) return { ok: true, applied: false }
    const byKey = new Map<string, ProfileUsage["windows"][number]>()
    if (prev && usage.source === "worker") for (const w of prev.windows) byKey.set(windowKey(w), w)
    for (const w of usage.windows) byKey.set(windowKey(w), w)
    const windows = [...byKey.values()].slice(0, 6)
    if (prev && sameWindows(prev.windows, windows) && usage.observedAt - prev.observedAt < WORKFORCE_TIMING.usageRewriteMs) return { ok: true, applied: false }
    d.putProfile({ ...profile, usage: { windows, observedAt: usage.observedAt, source: usage.source } })
    return { ok: true, applied: true }
}

// ---------- tasks and planning ----------

export function createTask(d: WorkforceDraft, input: CreateTaskInput): CreateTaskResult {
    if (d.tasks[input.id]) return { ok: false, reason: "task_exists" }
    const active = Object.values(d.tasks).filter(task => !isTerminalTask(task.status)).length
    if (active >= WORKFORCE_LIMITS.activeTasks) return { ok: false, reason: "too_many_active_tasks" }
    const mode = input.mode ?? "auto"
    const pins = input.pins ?? []
    // No plan yet, so no harness to check: a compare plan is checked against the pins when it is recorded.
    const rejection = workforceRejection(d, mode, pins, [])
    if (rejection) return { ok: false, reason: rejection }
    d.putTask({
        ...input,
        strategy: input.strategy ?? "split",
        mode,
        pins,
        pickedWorkstreamId: null,
        status: "draft",
        plan: null,
        workstreams: [],
        checkpoints: [],
        verification: null,
        trace: [],
        traceCount: 0,
        generation: 0,
        planningUntil: null,
        createdAt: d.now,
        updatedAt: d.now
    })
    addTrace(d, input.id, "task.created", "Task created")
    return { ok: true, taskId: input.id }
}

export function beginPlanning(d: WorkforceDraft, taskId: string, profileId: string | null): BeginPlanningResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (task.status !== "draft" && task.status !== "planned") return { ok: false, reason: "task_not_plannable" }
    const until = d.now + WORKFORCE_TIMING.planningHoldMs
    if (profileId !== null) {
        const profile = d.profiles[profileId]
        // A planner call spends that profile's plan too, so a manual task plans only on a pinned one.
        const rejection = pinRejection(task, profileId) ?? profileRejection(d, profile, task.projectId, 0)
        if (rejection || !profile) return { ok: false, reason: rejection ?? "unknown_profile" }
        d.putProfile({ ...profile, planningHold: { taskId, until } })
    }
    setTaskStatus(d, taskId, "planning", { planningUntil: until })
    if (profileId !== null) {
        const profile = d.profiles[profileId]!
        addTrace(d, taskId, "task.planning", `Planning with ${profile.label} (${profile.cli}) on ${profile.nodeName}`, { profileId })
    }
    return { ok: true, until }
}

export function recordPlan(d: WorkforceDraft, taskId: string, plan: PlanInput): RecordPlanResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (!PLANNABLE_TASK.has(task.status)) return { ok: false, reason: "task_not_plannable" }
    if (plan.workstreams.length > task.maxAgents) return { ok: false, reason: "too_many_workstreams" }
    // A compare task only takes its one-attempt-per-harness plan, and a split task never takes one.
    if ((plan.source === "compare") !== (strategyOf(task) === "compare")) return { ok: false, reason: "wrong_strategy" }
    // A manual compare attempt could never get a worker if none of the pins runs its harness.
    if (workforceRejection(d, modeOf(task), pinsOf(task), plan.workstreams) === "harness_not_pinned") return { ok: false, reason: "harness_not_pinned" }
    clearPlanningHolds(d, taskId)
    const generation = task.generation + 1
    setTaskStatus(d, taskId, "planned", {
        plan: { source: plan.source, profileId: plan.profileId, rationale: plan.rationale, warnings: plan.warnings },
        workstreams: plan.workstreams.map(ws => ({ ...ws, status: "pending", leaseId: null, lastCheckpoint: null })),
        generation,
        planningUntil: null
    })
    if (plan.source === "fallback")
        addTrace(d, taskId, "task.planner_fallback", plan.warnings[0] ?? "Planner fallback: the CLI planner was not used")
    const count = plan.workstreams.length
    if (plan.source === "compare") {
        const who = plan.workstreams.map(ws => (ws.harness ? CLI_LABEL[ws.harness] : ws.role)).join(", ")
        addTrace(d, taskId, "task.planned", `Compare plan: ${count} attempts at the whole task (${who}).`)
        return { ok: true, generation }
    }
    const label = plan.source === "cli" ? "the CLI planner" : "the fallback planner"
    const revision = plan.feedback ? `Re-planned with feedback: "${clip(plan.feedback.replace(/\s+/g, " "), 160)}". ` : ""
    addTrace(d, taskId, "task.planned", `${revision}Plan v${generation} from ${label}: ${count} workstream${count === 1 ? "" : "s"}. ${plan.rationale}`, {
        profileId: plan.profileId
    })
    return { ok: true, generation }
}

/** All-or-nothing: either every pick gets a lease or nothing changes and each pick says why. */
export function reserveWorkers(d: WorkforceDraft, taskId: string, picks: readonly ReservePick[]): ReserveResult {
    const task = d.tasks[taskId]
    const results: PickResult[] = []
    const seen = new Set<string>()
    const batchLoad = new Map<string, number>()
    for (const pick of picks) {
        let reason: PickResult["reason"] = null
        if (!task) reason = "unknown_task"
        else if (!STARTABLE_TASK.has(task.status)) reason = "task_not_startable"
        else {
            const ws = findWorkstream(task, pick.workstreamId)
            if (!ws) reason = "unknown_workstream"
            else if (seen.has(ws.id)) reason = "duplicate_workstream"
            else if (leaseIsLive(d, ws.leaseId)) reason = "already_leased"
            else if (ws.status !== "pending") reason = "workstream_not_pending"
            else
                reason =
                    pinRejection(task, pick.profileId) ??
                    profileRejection(d, d.profiles[pick.profileId], task.projectId, batchLoad.get(pick.profileId) ?? 0, ws.harness)
            seen.add(pick.workstreamId)
        }
        if (!reason) batchLoad.set(pick.profileId, (batchLoad.get(pick.profileId) ?? 0) + 1)
        results.push({ workstreamId: pick.workstreamId, profileId: pick.profileId, ok: reason === null, reason })
    }
    if (!task || results.some(result => !result.ok)) return { ok: false, reason: "invalid_picks", picks: results }

    const leases: LeaseView[] = []
    for (const pick of picks) {
        const current = d.tasks[taskId]!
        const ws = findWorkstream(current, pick.workstreamId)!
        const profile = d.profiles[pick.profileId]!
        const lease = issueLease(d, current, ws, profile)
        setWorkstream(d, taskId, ws.id, { status: "active", leaseId: lease.id })
        enqueue(d, "spawn", lease, spawnPayload(current, ws, profile, lease, false))
        if (ws.id === RESOLVER_WORKSTREAM_ID) {
            // Which side of the conflict this profile already knows, if any.
            const knows = current.workstreams.filter(w => ws.dependsOn.includes(w.id) && w.leaseId && d.leases[w.leaseId]?.profileId === profile.id)
            const context = knows.length > 0 ? `; it worked on ${knows.map(w => `"${w.title}"`).join(" and ")}` : ""
            addTrace(d, taskId, "task.resolver_reserved", `Reserved ${profile.label} (${profile.cli}) to merge the branches and resolve the conflict${context}`, refsOf(lease))
        } else
            addTrace(
                d,
                taskId,
                "worker.reserved",
                `Reserved ${profile.label} (${profile.cli}) on ${profile.nodeName} for "${ws.title}" as ${lease.agentName}`,
                refsOf(lease)
            )
        leases.push(leaseView(lease))
    }
    return { ok: true, leases }
}

/** Statuses a person can add a worker in: started, still working, not verifying or resolving a conflict. */
const ADDABLE_TASK: ReadonlySet<TaskStatus> = new Set(["starting", "running", "handoff"])
/** Role of a workstream a person added: `helper`, then `helper2`, `helper3`. The planner's roles never repeat. */
const ADDED_ROLE = "helper"

/**
 * A person adds a worker to a running split task, with their message as its brief: a new workstream that owns the
 * whole tree and waits on nothing, its lease and its spawn, all in one transition (so the scheduler never sees it
 * pending). It goes on the best candidate profile that passes the rules of any placement (pins, scope, health, a free
 * slot), within two caps: the task's workstream ceiling, and its live workers against the team's per-task cap. The
 * task's `maxAgents` is not one of them: it only bounds how many workstreams the planner may propose.
 */
export function addWorkstream(d: WorkforceDraft, taskId: string, input: AddWorkstreamInput): AddWorkstreamResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (strategyOf(task) !== "split") return { ok: false, reason: "not_split" }
    if (!ADDABLE_TASK.has(task.status)) return { ok: false, reason: "task_not_running" }
    if (task.workstreams.filter(ws => ws.id !== RESOLVER_WORKSTREAM_ID).length >= WORKFORCE_LIMITS.workstreamsPerTask)
        return { ok: false, reason: "too_many_workstreams" }
    const busy = task.workstreams.filter(ws => ws.status === "active" || ws.status === "handoff").length
    if (busy >= input.maxLive) return { ok: false, reason: "task_at_capacity" }
    const rejections = input.profileIds.map(id => pinRejection(task, id) ?? profileRejection(d, d.profiles[id], task.projectId, 0))
    // Best first: a pinned profile, a CLI known to be signed in, the most free slots, then the id.
    const profile = input.profileIds
        .filter((_, i) => rejections[i] === null)
        .map(id => d.profiles[id]!)
        .sort(
            (a, b) =>
                Number(pinsOf(task).includes(b.id)) - Number(pinsOf(task).includes(a.id)) ||
                Number(b.auth === "ok") - Number(a.auth === "ok") ||
                b.maxConcurrent - profileLoad(d, b, d.now) - (a.maxConcurrent - profileLoad(d, a, d.now)) ||
                (a.id < b.id ? -1 : 1)
        )[0]
    if (!profile) return { ok: false, reason: input.profileIds.length === 1 ? rejections[0]! : "no_eligible_profile" }

    const ids = new Set(task.workstreams.map(ws => ws.id))
    const roles = new Set(task.workstreams.map(ws => ws.role))
    const branches = new Set(task.workstreams.map(ws => ws.branch))
    let role = ADDED_ROLE
    // At most six workstreams, so this ends within seven tries.
    for (let n = 2; roles.has(role) || ids.has(`ws-${role}`) || branches.has(workstreamBranch(task.id, role)); n++) role = `${ADDED_ROLE}${n}`
    const ws: Workstream = {
        id: `ws-${role}`,
        role,
        title: input.title,
        brief: input.brief,
        why: "Added by a person while the task was running.",
        branch: workstreamBranch(task.id, role),
        dependsOn: [],
        ownership: ["**"],
        status: "pending",
        leaseId: null,
        lastCheckpoint: null
    }
    d.putTask({ ...task, workstreams: [...task.workstreams, ws], updatedAt: d.now })
    const current = d.tasks[taskId]!
    const lease = issueLease(d, current, ws, profile)
    setWorkstream(d, taskId, ws.id, { status: "active", leaseId: lease.id })
    enqueue(d, "spawn", lease, spawnPayload(current, ws, profile, lease, false))
    addTrace(
        d,
        taskId,
        "worker.reserved",
        `${input.byUserId} added ${profile.label} (${profile.cli}) on ${profile.nodeName} for "${ws.title}" as ${lease.agentName}`,
        refsOf(lease)
    )
    return { ok: true, workstreamId: ws.id, lease: leaseView(lease) }
}

export function requestHandoff(
    d: WorkforceDraft,
    taskId: string,
    workstreamId: string,
    fromEpoch: number,
    toProfileId: string
): RequestHandoffResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (!STARTABLE_TASK.has(task.status)) return { ok: false, reason: "task_not_startable" }
    const ws = findWorkstream(task, workstreamId)
    if (!ws) return { ok: false, reason: "unknown_workstream" }
    if (ws.status !== "handoff") return { ok: false, reason: "not_in_handoff" }
    const from = ws.leaseId ? d.leases[ws.leaseId] : undefined
    // A live current lease means a replacement was already issued: this request is stale, not a second handoff.
    if (!from || from.epoch !== fromEpoch || isLiveLease(from)) return { ok: false, reason: "stale_epoch" }
    const profile = d.profiles[toProfileId]
    const rejection = pinRejection(task, toProfileId) ?? profileRejection(d, profile, task.projectId, 0, ws.harness)
    if (rejection || !profile) return { ok: false, reason: rejection ?? "unknown_profile" }

    const lease = issueLease(d, task, ws, profile)
    setWorkstream(d, taskId, ws.id, { leaseId: lease.id })
    const pendingCheckpoint = Object.values(d.outbox).find(
        item => item.kind === "checkpoint" && item.taskId === taskId && item.payload.workstreamId === ws.id && isOpenItem(item)
    )
    const brief = enqueue(
        d,
        "handoff_brief",
        lease,
        {
            taskId,
            workstreamId: ws.id,
            branch: ws.branch,
            fromLeaseId: from.id,
            fromEpoch: from.epoch,
            toLeaseId: lease.id,
            toEpoch: lease.epoch,
            toAgentName: lease.agentName,
            reason: from.state === "expired" ? "previous worker stopped" : "previous replacement failed to start",
            lastCheckpointSha: ws.lastCheckpoint?.sha ?? null
        },
        pendingCheckpoint?.id ?? null,
        false
    )
    enqueue(d, "spawn", lease, spawnPayload(task, ws, profile, lease, true), brief.id, true)
    addTrace(
        d,
        taskId,
        "task.handoff_requested",
        `Handing "${ws.title}" from e${from.epoch} to ${profile.label} (${profile.cli}) as ${lease.agentName}, from checkpoint ${
            ws.lastCheckpoint ? ws.lastCheckpoint.sha.slice(0, 12) : "none"
        }`,
        refsOf(lease)
    )
    return { ok: true, lease: leaseView(lease) }
}

// ---------- fenced reports ----------

type Fence = { ok: true; lease: Lease; task: Task; ws: Workstream } | { ok: false; reason: FenceRejection }

/** A report is accepted only from the workstream's current lease at its exact epoch. */
export function fence(d: WorkforceDraft, leaseId: string, epoch: number): Fence {
    const lease = d.leases[leaseId]
    if (!lease) return { ok: false, reason: "unknown_lease" }
    if (lease.epoch !== epoch) return { ok: false, reason: "stale_epoch" }
    const task = d.tasks[lease.taskId]
    const ws = findWorkstream(task, lease.workstreamId)
    if (!task || !ws || ws.leaseId !== lease.id) return { ok: false, reason: "stale_epoch" }
    return { ok: true, lease, task, ws }
}

/**
 * `detail`: what the backend saw when it ended the lease ("login expired", "missing from Relay"), one line. It goes into
 * the lease's `endReason` and the trace, so a failed worker says why.
 */
export function recordSpawnStatus(
    d: WorkforceDraft,
    leaseId: string,
    epoch: number,
    status: SpawnStatus,
    invocationId: string | null,
    detail: string | null = null
): FencedResult {
    const child = d.leases[leaseId]
    if (child?.parentLeaseId) return recordSubagentSpawnStatus(d, child, epoch, status, invocationId, detail)
    const f = fence(d, leaseId, epoch)
    if (!f.ok) return f
    const { lease } = f
    if (!isLiveLease(lease)) return { ok: false, reason: "lease_not_active" }
    const spawnInvocationId = invocationId ?? lease.spawnInvocationId
    if (status === "spawning") {
        if (lease.state === "reserved" || spawnInvocationId !== lease.spawnInvocationId)
            d.putLease({ ...lease, state: lease.state === "reserved" ? "spawning" : lease.state, spawnInvocationId, updatedAt: d.now })
    } else if (status === "running") {
        if (lease.state !== "running") {
            d.putLease({ ...lease, state: "running", spawnInvocationId, expiresAt: null, updatedAt: d.now })
            addTrace(d, lease.taskId, "worker.ready", `${lease.agentName} is running on ${lease.nodeName}`, refsOf(lease))
        }
    } else if (status === "failed" || lease.state === "reserved") {
        endLease(d, lease.id, "failed", detail ? `spawn failed: ${detail}` : "spawn failed")
        addTrace(d, lease.taskId, "worker.blocked", `${lease.agentName} failed to start${detail ? `: ${detail}` : ""}`, refsOf(lease))
    } else {
        endLease(d, lease.id, "expired", detail ? `agent exited: ${detail}` : "agent exited")
        addTrace(
            d,
            lease.taskId,
            "worker.offline",
            `${lease.agentName} exited before finishing${detail ? ` (${detail})` : ""}; its workstream needs a handoff`,
            refsOf(lease)
        )
    }
    return { ok: true }
}

/** A subagent owns no workstream, so only its own lease and epoch fence it. Its record says how it ended. */
function recordSubagentSpawnStatus(
    d: WorkforceDraft,
    lease: Lease,
    epoch: number,
    status: SpawnStatus,
    invocationId: string | null,
    detail: string | null
): FencedResult {
    if (lease.epoch !== epoch) return { ok: false, reason: "stale_epoch" }
    if (!isLiveLease(lease)) return { ok: false, reason: "lease_not_active" }
    const spawnInvocationId = invocationId ?? lease.spawnInvocationId
    if (status === "spawning") {
        if (lease.state === "reserved" || spawnInvocationId !== lease.spawnInvocationId)
            d.putLease({ ...lease, state: lease.state === "reserved" ? "spawning" : lease.state, spawnInvocationId, updatedAt: d.now })
    } else if (status === "running") {
        if (lease.state !== "running") d.putLease({ ...lease, state: "running", spawnInvocationId, expiresAt: null, updatedAt: d.now })
    } else if (status === "failed" || lease.state === "reserved") endLease(d, lease.id, "failed", `the agent failed to start${detail ? `: ${detail}` : ""}`)
    else endLease(d, lease.id, "expired", `the agent exited${detail ? `: ${detail}` : ""}`)
    return { ok: true }
}

export function reportCheckpoint(d: WorkforceDraft, leaseId: string, epoch: number, sha: string, summary: string): FencedResult {
    const f = fence(d, leaseId, epoch)
    if (!f.ok) return f
    const { lease, ws } = f
    if (ws.status === "done") return { ok: false, reason: "workstream_done" }
    // The backend checkpoints a stopped worker's tree under its old epoch until a replacement takes over.
    const deadButCurrent = lease.state === "expired" && ws.status === "handoff"
    if (!isLiveLease(lease) && !deadButCurrent) return { ok: false, reason: "lease_not_active" }
    recordCheckpoint(d, lease, sha, summary)
    return { ok: true }
}

export function completeWorkstream(d: WorkforceDraft, leaseId: string, epoch: number, sha: string, summary: string): FencedResult {
    const f = fence(d, leaseId, epoch)
    if (!f.ok) return f
    const { lease, task, ws } = f
    if (ws.status === "done") return { ok: false, reason: "workstream_done" }
    if (!isLiveLease(lease)) return { ok: false, reason: "lease_not_active" }
    if (ws.status === "handoff") return { ok: false, reason: "handoff_not_acked" }
    recordCheckpoint(d, lease, sha, summary || "Workstream completed")
    setWorkstream(d, task.id, ws.id, { status: "done" })
    endLease(d, lease.id, "released", "workstream completed")
    if (ws.id === RESOLVER_WORKSTREAM_ID) {
        // Every workstream is done again: finalize moves the task to verifying, which re-checks from scratch.
        setTaskStatus(d, task.id, task.status, { verification: null })
        addTrace(d, task.id, "task.conflict_resolved", `Merged and resolved on ${ws.branch} at ${sha.slice(0, 12)}. Verifying again.`, refsOf(lease))
    } else addTrace(d, task.id, "task.checkpointed", `"${ws.title}" completed at ${sha.slice(0, 12)} by ${lease.agentName}`, refsOf(lease))
    return { ok: true }
}

export function ackHandoff(d: WorkforceDraft, leaseId: string, epoch: number): FencedResult {
    const f = fence(d, leaseId, epoch)
    if (!f.ok) return f
    const { lease, task, ws } = f
    if (!isLiveLease(lease)) return { ok: false, reason: "lease_not_active" }
    if (ws.status === "active") return { ok: true }
    if (ws.status !== "handoff") return { ok: false, reason: "not_in_handoff" }
    setWorkstream(d, task.id, ws.id, { status: "active" })
    if (lease.state !== "running") d.putLease({ ...lease, state: "running", expiresAt: null, updatedAt: d.now })
    addTrace(d, task.id, "task.handoff_acked", `${lease.agentName} acknowledged the handoff of "${ws.title}"`, refsOf(lease))
    return { ok: true }
}

// ---------- task thread and contracts (architecture 9.8) ----------

/**
 * The task thread's root message. First write wins: two workers spawning at once may both post a kickoff, and both
 * then use the one stored first. Not a change anyone sees in the view, so `updatedAt` stays.
 */
export function setTaskThread(d: WorkforceDraft, taskId: string, messageId: string): SetTaskThreadResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (task.threadId) return { ok: true, threadId: task.threadId }
    d.putTask({ ...task, threadId: messageId })
    return { ok: true, threadId: messageId }
}

/**
 * A worker published its interface contract (`CONTRACT <leaseId> <summary>`). Fenced like a checkpoint: only the
 * workstream's current, live lease. The newest one is kept on the workstream; a repeat of the same message is a no-op.
 */
export function recordContract(d: WorkforceDraft, leaseId: string, epoch: number, summary: string, messageId: string): FencedResult {
    const f = fence(d, leaseId, epoch)
    if (!f.ok) return f
    const { lease, task, ws } = f
    if (!isLiveLease(lease)) return { ok: false, reason: "lease_not_active" }
    if (ws.status === "done") return { ok: false, reason: "workstream_done" }
    if (ws.contract?.messageId === messageId) return { ok: true }
    setWorkstream(d, task.id, ws.id, { contract: { summary, messageId, agentName: lease.agentName, leaseId: lease.id, at: d.now } })
    addTrace(d, task.id, "contract.published", `${lease.agentName} published the interface of "${ws.title}": ${summary}`, refsOf(lease))
    return { ok: true }
}

// ---------- compare (docs/multi-harness.md) ----------

/** Tasks stored before strategies existed are split. */
export const strategyOf = (task: Pick<Task, "strategy">) => task.strategy ?? "split"

/**
 * The workstreams that decide a task's progress. All of them for a split task; for a compare task with a pick, only
 * the picked attempt and a conflict resolver, so the attempts that were not picked never hold verification back.
 */
export function deciding(task: Pick<Task, "strategy" | "pickedWorkstreamId" | "workstreams">): Workstream[] {
    if (strategyOf(task) !== "compare" || !task.pickedWorkstreamId) return task.workstreams
    return task.workstreams.filter(ws => ws.id === task.pickedWorkstreamId || ws.id === RESOLVER_WORKSTREAM_ID)
}

/**
 * A person picks a finished compare attempt to ship, or (`workstreamId` null) finishes the task without shipping any,
 * for a review or analysis run. Every other live lease of the task is released in the same transition (their
 * subagents with them) and unfinished attempts are marked failed. With a pick the task derives to `verifying`, which
 * checks only the picked attempt; without one it is completed with nothing to verify.
 */
export function pickAttempt(d: WorkforceDraft, taskId: string, workstreamId: string | null, byUserId: string): PickAttemptResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (strategyOf(task) !== "compare") return { ok: false, reason: "not_compare" }
    if (isTerminalTask(task.status)) return { ok: false, reason: "task_terminal" }
    if (task.pickedWorkstreamId) return { ok: false, reason: "already_picked" }
    const picked = workstreamId === null ? null : findWorkstream(task, workstreamId)
    if (workstreamId !== null && !picked) return { ok: false, reason: "unknown_workstream" }
    if (picked && picked.status !== "done") return { ok: false, reason: "attempt_not_done" }
    if (!picked && !task.workstreams.some(ws => ws.status === "done")) return { ok: false, reason: "nothing_finished" }

    const released: string[] = []
    const why = picked ? "another attempt was picked" : "the task was finished without shipping"
    for (const lease of Object.values(d.leases))
        if (lease.taskId === taskId && isLiveLease(lease) && !lease.parentLeaseId) {
            endLease(d, lease.id, "released", why)
            released.push(lease.id)
        }
    const current = d.tasks[taskId]!
    const workstreams = current.workstreams.map(ws => (ws.status === "done" ? ws : { ...ws, status: "failed" as const }))
    const name = (ws: Workstream) => (ws.harness ? CLI_LABEL[ws.harness] : ws.role)
    if (picked) {
        setTaskStatus(d, taskId, current.status, { workstreams, pickedWorkstreamId: picked.id })
        // The picked attempt is done, so this is `verifying` now; the caller sees the status the transition ends in.
        setTaskStatus(d, taskId, deriveTaskStatus(d.tasks[taskId]!, d.leases))
        const others = released.length > 0 ? ` and stopped ${released.length} other attempt${released.length === 1 ? "" : "s"}` : ""
        addTrace(d, taskId, "task.attempt_picked", `${byUserId} picked the ${name(picked)} attempt on ${picked.branch}${others}. Verifying it.`)
    } else {
        const skipped = { name: "Ship", status: "skipped" as const, detail: "Nothing shipped: the team kept the findings.", url: null }
        setTaskStatus(d, taskId, "completed", { workstreams, verification: { status: "skipped", checks: [skipped] } })
        addTrace(d, taskId, "task.attempt_picked", `${byUserId} finished the task without shipping an attempt.`)
    }
    return { ok: true, status: d.tasks[taskId]!.status, releasedLeaseIds: released.sort() }
}

export function cancelTask(d: WorkforceDraft, taskId: string, byUserId: string): CancelTaskResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (isTerminalTask(task.status)) return { ok: false, reason: "task_terminal" }
    const released: string[] = []
    for (const lease of Object.values(d.leases))
        if (lease.taskId === taskId && isLiveLease(lease)) {
            endLease(d, lease.id, "released", "task cancelled")
            released.push(lease.id)
        }
    clearPlanningHolds(d, taskId)
    const current = d.tasks[taskId]!
    setTaskStatus(d, taskId, "cancelled", {
        planningUntil: null,
        workstreams: current.workstreams.map(ws => (ws.status === "done" ? ws : { ...ws, status: "failed" }))
    })
    addTrace(d, taskId, "task.cancelled", `Cancelled by ${byUserId}`)
    return { ok: true, releasedLeaseIds: released.sort() }
}

/**
 * A person deletes a task for the whole team. A task that has not ended is cancelled first, exactly as `cancelTask`
 * does it (live leases end, agents that may exist get a release). Then the task goes with its ended leases and
 * finished outbox items, as `prune` drops them. A lease an open item still names stays until that item finishes, so a
 * release still reaches its agent; `prune` drops it later.
 */
export function deleteTask(d: WorkforceDraft, taskId: string, byUserId: string): DeleteTaskResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    const cancelled = isTerminalTask(task.status) ? null : cancelTask(d, taskId, byUserId)
    clearPlanningHolds(d, taskId)
    d.deleteTask(taskId)
    const pinned = new Set(Object.values(d.outbox).filter(isOpenItem).map(item => item.leaseId))
    for (const lease of Object.values(d.leases))
        if (lease.taskId === taskId && !isLiveLease(lease) && !pinned.has(lease.id)) d.deleteLease(lease.id)
    for (const item of Object.values(d.outbox)) if (item.taskId === taskId && !isOpenItem(item)) d.deleteItem(item.id)
    return { ok: true, releasedLeaseIds: cancelled?.ok ? cancelled.releasedLeaseIds : [] }
}

/**
 * The only way out of `failed`. A failed task holds no live lease (invariant), so nothing needs fencing here:
 * when every workstream is done it goes back to `verifying` with the old evidence cleared; otherwise every
 * unfinished workstream goes back to `pending` (keeping its branch and last checkpoint), finished ones stay done,
 * and the task re-enters the started states where new workers get fresh leases and epochs.
 */
export function retryTask(d: WorkforceDraft, taskId: string, byUserId: string): RetryTaskResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (task.status !== "failed") return { ok: false, reason: "task_not_failed" }
    if (task.workstreams.length === 0) return { ok: false, reason: "no_workstreams" }
    // A compare task fails only in verification, which needs a pick: retry checks the picked attempt again and
    // never reopens the attempts that were not picked.
    const reopened = deciding(task)
        .filter(ws => ws.status !== "done")
        .map(ws => ws.id)
    // A retry also gives merge-conflict resolution its full budget again.
    const fresh = task.resolutionAttempts ? { resolutionAttempts: 0 } : {}
    if (reopened.length === 0) {
        setTaskStatus(d, taskId, "verifying", { verification: null, ...fresh })
        addTrace(d, taskId, "task.retried", `Retry by ${byUserId}: verifying the finished workstreams again`)
        return { ok: true, mode: "verify", reopenedWorkstreamIds: [] }
    }
    // `planned` is a started state: finalize derives running/planned from the workstreams and leases.
    setTaskStatus(d, taskId, "planned", {
        verification: null,
        ...fresh,
        workstreams: task.workstreams.map(ws => (reopened.includes(ws.id) ? { ...ws, status: "pending" } : ws))
    })
    const kept = deciding(task).length - reopened.length
    addTrace(
        d,
        taskId,
        "task.retried",
        `Retry by ${byUserId}: ${reopened.length} unfinished workstream${reopened.length === 1 ? "" : "s"} will get new workers${
            kept > 0 ? `; ${kept} finished kept` : ""
        }`
    )
    return { ok: true, mode: "replan", reopenedWorkstreamIds: reopened }
}

export function submitVerification(d: WorkforceDraft, taskId: string, evidence: VerificationView): SubmitVerificationResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (task.status !== "verifying") return { ok: false, reason: "task_not_verifying" }
    const passed = evidence.checks.filter(check => check.status === "passed").length
    if (evidence.status === "pending") {
        setTaskStatus(d, taskId, "verifying", { verification: evidence })
        return { ok: true, status: "verifying" }
    }
    for (const lease of Object.values(d.leases))
        if (lease.taskId === taskId && isLiveLease(lease)) endLease(d, lease.id, "released", "task finished")
    const status: TaskStatus = evidence.status === "passed" ? "completed" : "failed"
    setTaskStatus(d, taskId, status, { verification: evidence })
    addTrace(
        d,
        taskId,
        status === "completed" ? "task.verified" : "task.failed",
        status === "completed"
            ? `Verified: ${passed}/${evidence.checks.length} checks passed`
            : `Verification failed: ${evidence.checks.filter(check => check.status === "failed").map(check => check.name).join(", ") || "see checks"}`
    )
    return { ok: true, status }
}

/**
 * Verification found a merge conflict. While attempts remain, the task goes to `resolving` and gets a resolver
 * workstream (role `resolver`, on the integration branch, depending on the workstreams on either side) that waits for
 * a worker; the scheduler leases it like any other workstream, so leases, fencing, handoff and DONE all apply. A
 * later attempt reuses the same workstream (its old lease id keeps earlier epochs fenced out). After the last attempt,
 * or when a planned workstream already owns the integration branch, the task fails and says why.
 */
export function resolveConflict(d: WorkforceDraft, taskId: string, evidence: VerificationView, conflict: ConflictInput): ResolveConflictResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (task.status !== "verifying") return { ok: false, reason: "task_not_verifying" }
    const planned = task.workstreams.filter(ws => ws.id !== RESOLVER_WORKSTREAM_ID)
    const known = new Set(planned.map(ws => ws.id))
    if ((conflict.workstreamId !== null && !known.has(conflict.workstreamId)) || conflict.involvedWorkstreamIds.some(id => !known.has(id)))
        return { ok: false, reason: "unknown_workstream" }
    const used = task.resolutionAttempts ?? 0
    const max = WORKFORCE_LIMITS.conflictResolutions
    const where = `${conflict.branch} does not merge into ${conflict.integrationBranch}`
    const check = (status: "pending" | "failed", detail: string) => ({ name: "Conflict resolution", status, detail, url: null })

    const clash = planned.some(ws => ws.branch === conflict.integrationBranch)
    if (used >= max || clash) {
        const why = clash
            ? `${where}, and a planned workstream already works on that branch, so no worker can resolve it there. Merge it by hand, then retry.`
            : `${where} after ${used} resolution attempt${used === 1 ? "" : "s"}. Resolve it on ${conflict.integrationBranch} by hand, or retry for ${max} more attempts.`
        setTaskStatus(d, taskId, "failed", { verification: { status: "failed", checks: [...evidence.checks, check("failed", why)] } })
        addTrace(d, taskId, "task.conflict_gave_up", `Gave up: ${why}`)
        return { ok: true, status: "failed", attempt: used }
    }

    const attempt = used + 1
    const previous = findWorkstream(task, RESOLVER_WORKSTREAM_ID)
    const resolver: Workstream = {
        id: RESOLVER_WORKSTREAM_ID,
        role: RESOLVER_ROLE,
        title: "Resolve merge conflict",
        brief: conflict.brief,
        why: `${where}.`,
        branch: conflict.integrationBranch,
        dependsOn: [...new Set(conflict.involvedWorkstreamIds)],
        ownership: ["**"],
        status: "pending",
        leaseId: previous?.leaseId ?? null,
        lastCheckpoint: previous?.lastCheckpoint ?? null
    }
    setTaskStatus(d, taskId, "resolving", {
        workstreams: previous ? task.workstreams.map(ws => (ws.id === resolver.id ? resolver : ws)) : [...task.workstreams, resolver],
        resolutionAttempts: attempt,
        verification: {
            status: "pending",
            checks: [...evidence.checks, check("pending", `Attempt ${attempt} of ${max}: a worker merges ${conflict.branch} into ${conflict.integrationBranch} and resolves the conflicts.`)]
        }
    })
    const files = conflict.files.length
    addTrace(
        d,
        taskId,
        "task.conflict_detected",
        `${where}${files > 0 ? ` (${files} file${files === 1 ? "" : "s"} changed on both sides)` : ""}. Attempt ${attempt} of ${max}: a worker will merge it and resolve the conflicts.`
    )
    return { ok: true, status: "resolving", attempt }
}

/** Status of a started task, from its workstreams and their current leases. */
export function deriveTaskStatus(task: Task, leases: Record<string, Lease>): TaskStatus {
    if (!STARTABLE_TASK.has(task.status) && task.status !== "choosing") return task.status
    const workstreams = deciding(task)
    if (strategyOf(task) === "compare" && !task.pickedWorkstreamId) {
        // Without a pick nothing is verified: once no attempt is waiting, working or being replaced, a person picks.
        const open = workstreams.some(ws => ws.status === "pending" || ws.status === "active" || ws.status === "handoff")
        if (!open && workstreams.some(ws => ws.status === "done")) return "choosing"
    } else if (workstreams.length > 0 && workstreams.every(ws => ws.status === "done")) return "verifying"
    // Only the resolver is open; its own handoffs and restarts stay inside "resolving".
    if (task.status === "resolving") return "resolving"
    if (workstreams.some(ws => ws.status === "handoff")) return "handoff"
    const live = workstreams.map(ws => (ws.leaseId ? leases[ws.leaseId] : undefined)).filter((l): l is Lease => !!l && isLiveLease(l))
    if (live.some(lease => lease.state === "running")) return "running"
    if (live.length > 0) return "starting"
    if (workstreams.some(ws => ws.status === "done")) return "running"
    return "planned"
}

// ---------- workforce mode: who may take a task's work (docs/multi-harness.md, "Manual mode") ----------

/** Tasks stored before modes existed are auto with no pins. */
export const modeOf = (task: Pick<Task, "mode">): WorkforceMode => task.mode ?? "auto"
export const pinsOf = (task: Pick<Task, "pins">): string[] => task.pins ?? []

/** `not_pinned` when a manual task's lease would be on a profile it did not pin. Auto tasks take any profile. */
export function pinRejection(task: Pick<Task, "mode" | "pins">, profileId: string): "not_pinned" | null {
    return modeOf(task) === "manual" && !pinsOf(task).includes(profileId) ? "not_pinned" : null
}

/**
 * What is wrong with a mode and pins for this team, or null. Every pin must be one of the team's profiles (in either
 * mode, so an id from elsewhere is never stored). Manual needs a pin, and in a compare plan a pin of each harness.
 */
export function workforceRejection(
    d: WorkforceDraft,
    mode: WorkforceMode,
    pins: readonly string[],
    workstreams: readonly { harness?: CliKind }[]
): WorkforceRejection | null {
    if (pins.some(id => !d.profiles[id])) return "unknown_pin"
    if (mode !== "manual") return null
    if (pins.length === 0) return "no_pins"
    const pinnedClis = new Set(pins.map(id => d.profiles[id]!.cli))
    if (workstreams.some(ws => ws.harness !== undefined && !pinnedClis.has(ws.harness))) return "harness_not_pinned"
    return null
}

/** Whether any worker was ever placed: from then on the mode and pins are fixed. */
function hasStarted(task: Task): boolean {
    if (!PLANNABLE_TASK.has(task.status)) return true
    return task.workstreams.some(ws => ws.leaseId !== null || ws.status !== "pending")
}

/**
 * Changes a task's mode and pins while it has not started (a re-plan, or Start with the composer's latest choice).
 * Refused once any worker was placed, so a running manual task can never be widened.
 */
export function setTaskWorkforce(d: WorkforceDraft, taskId: string, mode: WorkforceMode, pins: readonly string[]): SetTaskWorkforceResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    if (hasStarted(task)) return { ok: false, reason: "task_started" }
    const rejection = workforceRejection(d, mode, pins, task.workstreams)
    if (rejection) return { ok: false, reason: rejection }
    const same = modeOf(task) === mode && pinsOf(task).length === pins.length && pins.every((id, i) => pinsOf(task)[i] === id)
    if (same) return { ok: true, mode, pins: pinsOf(task), changed: false }
    d.putTask({ ...task, mode, pins: [...pins], updatedAt: d.now })
    return { ok: true, mode, pins: [...pins], changed: true }
}

/**
 * The backend scheduler found no pinned profile free for a manual task's workstream: say so in the trace, in plain
 * words, once per wait. A repeat is a no-op while the workstream's latest note says the same and no worker was placed
 * on it since. The actor writes the message itself, so no backend or browser text reaches the trace here.
 */
export function noteWaiting(d: WorkforceDraft, taskId: string, workstreamId: string, reason: WaitingReason): NoteWaitingResult {
    const task = d.tasks[taskId]
    if (!task) return { ok: false, reason: "unknown_task" }
    const ws = findWorkstream(task, workstreamId)
    if (!ws) return { ok: false, reason: "unknown_workstream" }
    if (reason === "no_pinned_profile" && modeOf(task) !== "manual") return { ok: false, reason: "not_manual" }
    if (isTerminalTask(task.status) || ws.status === "done" || ws.status === "failed" || leaseIsLive(d, ws.leaseId)) return { ok: true, noted: false }
    const busy = clip(`Waiting for a pinned profile: none of them is free. "${ws.title}" starts when one is.`, WORKFORCE_LIMITS.traceMessageChars)
    const gone = clip(
        `Waiting for a pinned profile: all of them were removed from the team. "${ws.title}" cannot start until the task is cancelled and started again with other profiles.`,
        WORKFORCE_LIMITS.traceMessageChars
    )
    const message = pinsOf(task).some(id => d.profiles[id]) ? busy : gone
    const last = task.trace.findLast(entry => entry.kind === "worker.waiting" && (entry.message === busy || entry.message === gone))
    // Strictly after the note: a worker placed (and lost) since then makes this a new wait worth saying again.
    const placedSince = last !== undefined && ws.leaseId !== null && (d.leases[ws.leaseId]?.createdAt ?? 0) > last.at
    if (last?.message === message && !placedSince) return { ok: true, noted: false }
    addTrace(d, taskId, "worker.waiting", message)
    return { ok: true, noted: true }
}

// ---------- time ----------

/** Restores due cooldowns, drops expired planning holds, fails leases that never started. Idempotent. */
export function sweep(d: WorkforceDraft): { restored: string[]; expired: string[] } {
    const restored: string[] = []
    for (const profile of Object.values(d.profiles)) {
        let next = profile
        if (profile.availability === "limited" && profile.cooldownUntil !== null && profile.cooldownUntil <= d.now) {
            next = { ...next, availability: "ready", cooldownUntil: null, limitedReason: null, limitedSource: null }
            restored.push(profile.id)
        }
        if (profile.planningHold && profile.planningHold.until <= d.now) next = { ...next, planningHold: null }
        if (next !== profile) d.putProfile(next)
    }
    for (const profileId of restored) {
        const profile = d.profiles[profileId]!
        const taskIds = new Set(Object.values(d.leases).filter(lease => lease.profileId === profileId).map(lease => lease.taskId))
        for (const taskId of taskIds) {
            const task = d.tasks[taskId]
            if (task && !isTerminalTask(task.status))
                addTrace(d, taskId, "worker.capacity_restored", `${profile.label} is ready again after its cooldown`, { profileId })
        }
    }
    for (const task of Object.values(d.tasks))
        if (task.status === "planning" && task.planningUntil !== null && task.planningUntil <= d.now) {
            setTaskStatus(d, task.id, task.plan ? "planned" : "draft", { planningUntil: null })
            addTrace(d, task.id, "worker.blocked", "The planner did not report back in time; plan again")
        }
    const expired: string[] = []
    for (const lease of Object.values(d.leases))
        if (isLiveLease(d.leases[lease.id]!) && lease.expiresAt !== null && lease.expiresAt <= d.now) {
            endLease(d, lease.id, "failed", "did not start in time")
            expired.push(lease.id)
            if (lease.parentLeaseId) continue
            addTrace(d, lease.taskId, "worker.blocked", `${lease.agentName} did not start in time`, refsOf(lease))
        }
    return { restored, expired }
}

/** Earliest persisted deadline; the alarm is only an early wake-up for it. */
export function nextDeadline(state: WorkforceState): number | null {
    let next: number | null = null
    const consider = (at: number | null) => {
        if (at !== null && (next === null || at < next)) next = at
    }
    for (const profile of Object.values(state.profiles)) {
        if (profile.availability === "limited") consider(profile.cooldownUntil)
        consider(profile.planningHold?.until ?? null)
    }
    for (const task of Object.values(state.tasks)) if (task.status === "planning") consider(task.planningUntil)
    for (const lease of Object.values(state.leases)) if (isLiveLease(lease)) consider(lease.expiresAt)
    return next
}

// ---------- end of every transition ----------

/** Re-derives task statuses and bounds stored history. Runs before every commit. */
export function finalize(d: WorkforceDraft): void {
    for (const task of Object.values(d.tasks)) {
        const status = deriveTaskStatus(task, d.leases)
        if (status !== task.status) setTaskStatus(d, task.id, status)
    }
    prune(d)
}

export function prune(d: WorkforceDraft): void {
    const tasks = Object.values(d.tasks)
    if (tasks.length > WORKFORCE_LIMITS.storedTasks) {
        const removable = tasks.filter(task => isTerminalTask(task.status)).sort((a, b) => a.updatedAt - b.updatedAt)
        const excess = tasks.length - WORKFORCE_LIMITS.storedTasks
        for (const task of removable.slice(0, excess)) {
            d.deleteTask(task.id)
            for (const lease of Object.values(d.leases)) if (lease.taskId === task.id && !isLiveLease(lease)) d.deleteLease(lease.id)
            for (const item of Object.values(d.outbox)) if (item.taskId === task.id && !isOpenItem(item)) d.deleteItem(item.id)
        }
    }

    const pinned = new Set<string>()
    for (const task of Object.values(d.tasks)) for (const ws of task.workstreams) if (ws.leaseId) pinned.add(ws.leaseId)
    for (const item of Object.values(d.outbox)) if (isOpenItem(item)) pinned.add(item.leaseId)
    const endedLeases = Object.values(d.leases)
        .filter(lease => !isLiveLease(lease) && !pinned.has(lease.id))
        .sort((a, b) => a.updatedAt - b.updatedAt)
    for (const lease of endedLeases.slice(0, Math.max(0, endedLeases.length - WORKFORCE_LIMITS.terminalLeasesKept))) d.deleteLease(lease.id)

    const finished = Object.values(d.outbox)
        .filter(item => !isOpenItem(item))
        .sort((a, b) => a.updatedAt - b.updatedAt)
    for (const item of finished.slice(0, Math.max(0, finished.length - WORKFORCE_LIMITS.finishedOutboxKept))) d.deleteItem(item.id)
}

// ---------- worker update watermarks ----------

/**
 * Records that workers were told about a task's trace up to entry `through` (architecture 9.8). Monotonic and capped
 * at the entries the task has recorded, so a replay or a stale mark changes nothing. Marks of tasks that are gone
 * are dropped on every write, so the map never outgrows the stored tasks.
 */
export function markNotified(
    notified: Record<string, number>,
    tasks: Record<string, Task>,
    taskId: string,
    through: number
): { notified: Record<string, number>; result: MarkNotifiedResult } {
    const kept: Record<string, number> = {}
    for (const [id, at] of Object.entries(notified)) if (tasks[id]) kept[id] = at
    const task = tasks[taskId]
    if (!task) return { notified: kept, result: { ok: false, reason: "unknown_task" } }
    const recorded = task.traceCount ?? task.trace.length
    const at = Math.max(kept[taskId] ?? 0, Math.min(through, recorded))
    kept[taskId] = at
    return { notified: kept, result: { ok: true, through: at } }
}

/** Structural invariants every committed state must hold. Non-empty means a bug; the commit is refused. */
export function workforceInvariantViolations(state: WorkforceState): string[] {
    const violations: string[] = []
    const liveByWorkstream = new Set<string>()
    for (const lease of Object.values(state.leases)) {
        if (lease.epoch > state.epoch) violations.push(`lease ${lease.id} epoch ${lease.epoch} exceeds ${state.epoch}`)
        if (!isLiveLease(lease)) continue
        if (lease.parentLeaseId) {
            const parent = state.leases[lease.parentLeaseId]
            if (!parent || !isLiveLease(parent)) violations.push(`live subagent ${lease.id} has no live parent`)
            else if (parent.parentLeaseId) violations.push(`subagent ${lease.id} has a subagent parent`)
            else if (parent.taskId !== lease.taskId || parent.workstreamId !== lease.workstreamId)
                violations.push(`subagent ${lease.id} is not on its parent workstream`)
        }
        const key = `${lease.taskId}/${lease.workstreamId}`
        if (!lease.parentLeaseId) {
            if (liveByWorkstream.has(key)) violations.push(`two live leases on ${key}`)
            liveByWorkstream.add(key)
        }
        if (!state.profiles[lease.profileId]) violations.push(`live lease ${lease.id} has no profile`)
        const task = state.tasks[lease.taskId]
        if (!task) violations.push(`live lease ${lease.id} has no task`)
        else if (isTerminalTask(task.status)) violations.push(`live lease ${lease.id} on ${task.status} task`)
        else if (pinRejection(task, lease.profileId)) violations.push(`live lease ${lease.id} of manual task ${task.id} is on unpinned ${lease.profileId}`)
    }
    for (const task of Object.values(state.tasks))
        for (const ws of task.workstreams) {
            const lease = ws.leaseId ? state.leases[ws.leaseId] : undefined
            if (ws.leaseId && !lease) violations.push(`workstream ${task.id}/${ws.id} points at missing lease`)
            if (ws.status === "active" && !(lease && isLiveLease(lease))) violations.push(`active workstream ${task.id}/${ws.id} has no live lease`)
            const profile = lease && isLiveLease(lease) ? state.profiles[lease.profileId] : undefined
            if (ws.harness && profile && profile.cli !== ws.harness) violations.push(`${ws.harness} attempt ${task.id}/${ws.id} runs on ${profile.cli}`)
        }
    for (const task of Object.values(state.tasks)) {
        if (!task.pickedWorkstreamId) continue
        if (strategyOf(task) !== "compare") violations.push(`split task ${task.id} has a picked attempt`)
        if (findWorkstream(task, task.pickedWorkstreamId)?.status !== "done") violations.push(`picked attempt ${task.id}/${task.pickedWorkstreamId} is not done`)
    }
    return violations
}

// ---------- view ----------

export function profileView(profile: CliProfile, activeLeases: number): ProfileView {
    const availability = profile.availability === "ready" && activeLeases >= profile.maxConcurrent ? "busy" : profile.availability
    return {
        id: profile.id,
        envId: profile.envId,
        ownerUserId: profile.ownerUserId,
        cli: profile.cli,
        label: profile.label,
        auth: profile.auth,
        availability,
        cooldownUntil: profile.cooldownUntil,
        // The limit line a CLI printed: agent text, so the view keeps a preview like a trace message.
        limitedReason: profile.limitedReason === null ? null : clip(profile.limitedReason, WORKFORCE_LIMITS.viewTraceMessageChars),
        limitedSource: profile.limitedSource,
        maxConcurrent: profile.maxConcurrent,
        activeLeases,
        scopes: profile.scopes,
        lastSeenAt: profile.lastSeenAt,
        usage: profile.usage ?? null
    }
}

/** When the current run started: the first reservation after the latest plan. */
function runStartedAt(trace: readonly TraceEntry[]): number | null {
    let plannedAt = -1
    for (const entry of trace) if (entry.kind === "task.planned") plannedAt = entry.at
    return trace.find(entry => entry.kind === "worker.reserved" && entry.at >= plannedAt)?.at ?? null
}

/** A task as `getTask` returns it: every stored trace entry and the full workstreams (the backend drops briefs and ownership before a browser sees it). */
export function taskRecord(task: Task): TaskRecord {
    return {
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        prompt: task.prompt,
        acceptance: task.acceptance,
        createdBy: task.createdBy,
        status: task.status,
        maxAgents: task.maxAgents,
        ...strategyFields(task),
        mode: modeOf(task),
        pins: pinsOf(task),
        plan: task.plan,
        workstreams: task.workstreams,
        verification: task.verification,
        trace: task.trace,
        traceTotal: task.traceCount ?? task.trace.length,
        runStartedAt: runStartedAt(task.trace),
        retriedAt: task.trace.findLast(entry => entry.kind === "task.retried")?.at ?? null,
        plannedAt: task.trace.findLast(entry => entry.kind === "task.planned")?.at ?? null,
        resolutionAttempts: task.resolutionAttempts ?? 0,
        subagents: (task.subagents ?? []).map(subagentView),
        threadId: task.threadId ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt
    }
}

/** `strategy` on every task stored with one; `pickedWorkstreamId` only on compare tasks, so split tasks pay no bytes. */
function strategyFields(task: Task): Pick<TaskView, "strategy" | "pickedWorkstreamId"> {
    if (task.strategy === undefined) return {}
    return task.strategy === "compare" ? { strategy: "compare", pickedWorkstreamId: task.pickedWorkstreamId ?? null } : { strategy: "split" }
}

export function workstreamView(ws: Workstream): WorkstreamView {
    const view: WorkstreamView = { id: ws.id, branch: ws.branch, status: ws.status, leaseId: ws.leaseId }
    if (ws.harness) view.harness = ws.harness
    return view
}

/**
 * A task in the emitted view, resent to every member on every change. It names its fields one by one and holds no
 * long text (prompt, acceptance, plan, workstream text, verification): those come with `getTask`. With every field
 * at its limit it stays under `VIEW_TASK_MAX_BYTES` (test/view-budget.test.ts).
 */
export function taskView(task: Task): TaskView {
    const record = taskRecord(task)
    return {
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        createdBy: task.createdBy,
        status: task.status,
        maxAgents: task.maxAgents,
        ...strategyFields(task),
        workstreams: task.workstreams.map(workstreamView),
        trace: task.trace
            .slice(-WORKFORCE_LIMITS.viewTraceEntries)
            .map(entry => ({ ...entry, message: clip(entry.message, WORKFORCE_LIMITS.viewTraceMessageChars) })),
        traceTotal: record.traceTotal,
        runStartedAt: record.runStartedAt,
        retriedAt: record.retriedAt,
        plannedAt: record.plannedAt,
        resolutionAttempts: record.resolutionAttempts,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt
    }
}

/** The single emitted projection: every active task plus the most recent finished ones, and their leases. */
export function buildWorkforceView(state: WorkforceState): WorkforceView {
    const counts = liveLeaseCounts(state)
    const profiles: WorkforceView["profiles"] = {}
    for (const profile of Object.values(state.profiles)) profiles[profile.id] = profileView(profile, counts.get(profile.id) ?? 0)

    const all = Object.values(state.tasks)
    const recentFinished = all
        .filter(task => isTerminalTask(task.status))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, WORKFORCE_LIMITS.viewTerminalTasks)
    const shown = [...all.filter(task => !isTerminalTask(task.status)), ...recentFinished].sort(
        (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    const tasks: WorkforceView["tasks"] = {}
    for (const task of shown) tasks[task.id] = taskView(task)

    const leases: WorkforceView["leases"] = {}
    for (const lease of Object.values(state.leases).sort((a, b) => a.epoch - b.epoch))
        // A finished subagent lives on in its task record; only live ones take room in the view.
        if (tasks[lease.taskId] && (!lease.parentLeaseId || isLiveLease(lease))) leases[lease.id] = leaseView(lease)
    return { profiles, tasks, leases }
}
