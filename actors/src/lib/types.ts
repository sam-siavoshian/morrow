// Public shapes of the actor contracts. The *View types mirror packages/contracts/src/domain.ts field for field;
// test/contracts.test.ts asserts that at compile time and at runtime. Plain TS (not z.infer) so the durable-actors
// compiler can turn them into the generated client's types.

// ---------- shared enums ----------

export type Role = "owner" | "admin" | "member"
export type AssignableRole = Exclude<Role, "owner">
export type CliKind = "claude" | "codex" | "opencode" | "cursor" | "gemini" | "grok"
export type ProfileAuth = "unknown" | "ok" | "auth_required"
export type ProfileAvailability = "ready" | "busy" | "limited" | "offline"
/** What is stored. "busy" is derived from live leases when the view is built. */
export type StoredAvailability = "ready" | "limited" | "offline"
export type LimitSource = "detected" | "manual"
export type ProfileScopes = "all" | string[]
export type UsageSource = "probe" | "worker"
export type EnvironmentPhase = "provisioning" | "bootstrapping" | "awaiting_login" | "ready" | "paused" | "error" | "disconnected"
export type VmState = "starting" | "running" | "pausing" | "paused" | "stopped" | "unknown"
export type TaskStatus =
    | "draft"
    | "planning"
    | "planned"
    | "starting"
    | "running"
    | "handoff"
    | "verifying"
    | "resolving"
    | "choosing"
    | "completed"
    | "failed"
    | "cancelled"
export type WorkstreamStatus = "pending" | "active" | "handoff" | "done" | "failed"
export type LeaseState = "reserved" | "spawning" | "running" | "released" | "expired" | "failed"
export type PlanSource = "cli" | "fallback" | "compare"
/** How a task shares the work between harnesses (docs/multi-harness.md). */
export type TaskStrategy = "split" | "compare"
/** Who may take a task's work: any eligible profile (`auto`, pins preferred), or only its pinned profiles (`manual`). */
export type WorkforceMode = "auto" | "manual"
/** Why a workstream waits without a worker. `no_pinned_profile`: a manual task's pinned profiles are all busy or gone. */
export type WaitingReason = "no_pinned_profile"
export type CheckStatus = "pending" | "passed" | "failed" | "skipped"
export type TraceKind =
    | "task.created"
    | "task.planning"
    | "task.planner_fallback"
    | "task.planned"
    | "worker.reserved"
    | "worker.ready"
    | "worker.blocked"
    | "worker.quota_limited"
    | "worker.offline"
    | "task.checkpointed"
    | "task.handoff_requested"
    | "task.handoff_acked"
    | "task.verified"
    | "task.failed"
    | "task.cancelled"
    | "worker.capacity_restored"
    | "task.retried"
    | "task.conflict_detected"
    | "task.resolver_reserved"
    | "task.conflict_resolved"
    | "task.conflict_gave_up"
    | "subagent.started"
    | "subagent.finished"
    | "task.attempt_picked"
    | "worker.waiting"
    | "contract.published"

// ---------- views (mirror contracts) ----------

export type ProfileView = {
    id: string
    envId: string
    ownerUserId: string
    cli: CliKind
    label: string
    auth: ProfileAuth
    availability: ProfileAvailability
    cooldownUntil: number | null
    limitedReason: string | null
    limitedSource: LimitSource | null
    maxConcurrent: number
    activeLeases: number
    scopes: ProfileScopes
    lastSeenAt: number | null
    /** Absent from views written before usage existed; null until the first reading. */
    usage?: ProfileUsage | null
}

/** A subscription usage window (percent of the 5-hour or weekly allowance spent). Never a token count. */
export type UsageWindow = {
    kind: "five_hour" | "weekly" | "other"
    label: string
    usedPercent: number
    resetsAt: number | null
}

export type ProfileUsage = {
    windows: UsageWindow[]
    observedAt: number
    source: UsageSource
}

export type Checkpoint = {
    sha: string
    summary: string
    epoch: number
    at: number
}

/** A workstream in the emitted view: only what lists and lanes need. Its text comes with the task detail. */
export type WorkstreamView = {
    id: string
    branch: string
    status: WorkstreamStatus
    leaseId: string | null
    /** The harness a compare attempt is bound to. Absent on split workstreams. */
    harness?: CliKind
}

/** The newest interface contract a workstream's worker posted in the task thread (contracts `WorkstreamContract`). */
export type WorkstreamContract = {
    /** Agent-written, one line. The whole contract is the Relay message `messageId`. */
    summary: string
    messageId: string
    agentName: string
    leaseId: string
    at: number
}

/** A workstream in the task detail the browser reads. The brief and file ownership stay out: only workers and the planner read them. */
export type WorkstreamDetail = {
    id: string
    role: string
    title: string
    why: string
    branch: string
    dependsOn: string[]
    status: WorkstreamStatus
    leaseId: string | null
    lastCheckpoint: Checkpoint | null
    harness?: CliKind
    contract?: WorkstreamContract | null
}

/** A workstream as stored and as `getTask` returns it. */
export type Workstream = {
    id: string
    role: string
    title: string
    brief: string
    why: string
    branch: string
    dependsOn: string[]
    ownership: string[]
    status: WorkstreamStatus
    leaseId: string | null
    lastCheckpoint: Checkpoint | null
    /** A compare attempt's harness: only a profile of this CLI may take it. Absent on split workstreams. */
    harness?: CliKind
    /** The newest interface contract its worker published. Absent before one. */
    contract?: WorkstreamContract | null
}

export type LeaseView = {
    id: string
    taskId: string
    workstreamId: string
    profileId: string
    epoch: number
    agentName: string
    nodeName: string
    state: LeaseState
    createdAt: number
    /** A subagent's parent lease. Absent on workers; only live subagents are in the view. */
    parentLeaseId?: string
}

export type SubagentRole = "review" | "research" | "implementation" | "test" | "general"
export type SubagentStatus = "running" | "completed" | "failed" | "cancelled"

/** One subagent of a task (contracts `SubagentView`). `task` and `summary` are agent-written text. */
export type SubagentView = {
    leaseId: string
    parentLeaseId: string
    agentName: string
    parentAgentName: string
    cli: CliKind
    profileId: string
    role: SubagentRole
    task: string
    status: SubagentStatus
    summary: string | null
    createdAt: number
    finishedAt: number | null
}

export type PlanView = {
    source: PlanSource
    profileId: string | null
    rationale: string
    warnings: string[]
}

export type VerificationCheck = {
    name: string
    status: CheckStatus
    detail: string
    url: string | null
}

export type VerificationView = {
    status: CheckStatus
    checks: VerificationCheck[]
}

export type TraceEntry = {
    at: number
    kind: TraceKind
    message: string
    leaseId: string | null
    profileId: string | null
    epoch: number | null
}

/** A task in the emitted view: no long text, so its size has a fixed ceiling (see `WORKFORCE_LIMITS`). */
export type TaskView = {
    id: string
    projectId: string
    title: string
    createdBy: string
    status: TaskStatus
    maxAgents: number
    /** Absent from tasks stored before strategies existed: those are split. */
    strategy?: TaskStrategy
    /** A compare task's picked attempt, null before a pick. Absent on split tasks. */
    pickedWorkstreamId?: string | null
    workstreams: WorkstreamView[]
    /** The last `WORKFORCE_LIMITS.viewTraceEntries`, messages clipped to `viewTraceMessageChars`. */
    trace: TraceEntry[]
    /** Entries recorded in all. Absent from views written before the view capped the trace. */
    traceTotal?: number
    /** The first reservation after the latest plan, from the whole stored trace. */
    runStartedAt?: number | null
    /** The latest `task.retried`, from the whole stored trace. */
    retriedAt?: number | null
    /** The latest `task.planned`, from the whole stored trace. */
    plannedAt?: number | null
    /** Merge-conflict resolution attempts since the last retry. Absent from views written before conflicts were resolved. */
    resolutionAttempts?: number
    createdAt: number
    updatedAt: number
}

/** The task detail the browser reads (contracts `TaskDetail`): the full text and every stored trace entry. */
export type TaskDetail = {
    id: string
    projectId: string
    title: string
    prompt: string
    acceptance: string[]
    createdBy: string
    status: TaskStatus
    maxAgents: number
    strategy?: TaskStrategy
    pickedWorkstreamId?: string | null
    plan: PlanView | null
    workstreams: WorkstreamDetail[]
    verification: VerificationView | null
    trace: TraceEntry[]
    traceTotal?: number
    runStartedAt?: number | null
    retriedAt?: number | null
    plannedAt?: number | null
    resolutionAttempts?: number
    createdAt: number
    updatedAt: number
    subagents?: SubagentView[]
    threadId?: string | null
}

/**
 * A task as `getTask` returns it: the detail plus each workstream's brief and file ownership, and who may take its
 * work, for the backend only (the browser's `TaskDetail` drops them).
 */
export type TaskRecord = Omit<TaskDetail, "workstreams"> & {
    workstreams: Workstream[]
    /** `auto` for tasks stored before modes existed. */
    mode: WorkforceMode
    /** Profile ids, deduplicated; empty for tasks stored before pins were kept. */
    pins: string[]
}

export type WorkforceView = {
    profiles: Record<string, ProfileView>
    tasks: Record<string, TaskView>
    leases: Record<string, LeaseView>
}

export type MemberView = {
    userId: string
    login: string
    name: string | null
    avatarUrl: string | null
    role: Role
}

export type ProjectView = {
    id: string
    repoFullName: string
    defaultBranch: string
    testCommand: string | null
}

export type TeamPolicy = {
    allowInspect: boolean
    maxParallelPerTask: number
}

export type EnvironmentView = {
    id: string
    ownerUserId: string
    name: string
    linuxUser: string | null
    nodeName: string | null
    phase: EnvironmentPhase
    vmState: VmState
    nodeOnline: boolean
    lastError: string | null
    createdAt: number
}

/** contracts `TeamView` without `viewerRole`, which the backend adds per viewer. */
export type TeamProjection = {
    id: string
    name: string
    slug: string
    members: MemberView[]
    projects: ProjectView[]
    environments: EnvironmentView[]
    policy: TeamPolicy
    relayReady: boolean
}

// ---------- stored TeamWorkforce records ----------

export type PlanningHold = { taskId: string; until: number }

export type CliProfile = {
    id: string
    envId: string
    ownerUserId: string
    nodeName: string
    cli: CliKind
    label: string
    auth: ProfileAuth
    availability: StoredAvailability
    cooldownUntil: number | null
    limitedReason: string | null
    limitedSource: LimitSource | null
    maxConcurrent: number
    scopes: ProfileScopes
    lastSeenAt: number | null
    /** The latest usage reading. Absent on profiles stored before usage existed. */
    usage?: ProfileUsage | null
    planningHold: PlanningHold | null
    createdAt: number
}

export type TaskCheckpoint = {
    workstreamId: string
    sha: string
    summary: string
    epoch: number
    at: number
}

export type Task = {
    id: string
    projectId: string
    title: string
    prompt: string
    acceptance: string[]
    createdBy: string
    status: TaskStatus
    maxAgents: number
    /** Absent on tasks stored before strategies existed: those are split. */
    strategy?: TaskStrategy
    /** A compare task's picked attempt; null before a pick or after a finish without shipping. */
    pickedWorkstreamId?: string | null
    /** Absent on tasks stored before modes existed: those are auto. Manual: every lease must be on a pinned profile. */
    mode?: WorkforceMode
    /** Profiles the creator picked (at most 5, deduplicated). A preference in auto, the only allowed ones in manual. */
    pins?: string[]
    plan: PlanView | null
    workstreams: Workstream[]
    checkpoints: TaskCheckpoint[]
    verification: VerificationView | null
    trace: TraceEntry[]
    /** Trace entries recorded in all, including ones dropped from `trace`. Absent on tasks stored before it existed. */
    traceCount?: number
    generation: number
    planningUntil: number | null
    /** Merge-conflict resolution attempts since the last retry. Absent on tasks stored before conflicts were resolved. */
    resolutionAttempts?: number
    /** The newest `WORKFORCE_LIMITS.subagentsKept` subagents, oldest first. Absent on tasks stored before subagents existed. */
    subagents?: SubagentRecord[]
    /** The Relay id of the task's kickoff post: its replies are the task thread. Set once, by the first worker spawn. */
    threadId?: string | null
    createdAt: number
    updatedAt: number
}

/** A subagent as stored: the view plus the caller's request id, which makes a retried `delegate` return the same child. */
export type SubagentRecord = SubagentView & { clientRequestId: string }

export type Lease = {
    id: string
    taskId: string
    workstreamId: string
    profileId: string
    epoch: number
    agentName: string
    nodeName: string
    state: LeaseState
    spawnInvocationId: string | null
    /** Deadline for the lease to reach `running`; null once it does. */
    expiresAt: number | null
    createdAt: number
    updatedAt: number
    /** A subagent's parent lease (same task, workstream and machine). Null or absent on workers. */
    parentLeaseId?: string | null
    /** What the parent asked the subagent to do. Null or absent on workers. */
    role?: SubagentRole | null
    /** Why it ended, set once by `endLease` (backend text, one line, clipped). Null or absent while live and on older leases. */
    endReason?: string | null
}

// ---------- outbox ----------

export type OutboxKind = "spawn" | "release" | "handoff_brief" | "checkpoint"
export type OutboxState = "pending" | "inflight" | "done" | "failed" | "cancelled"

export type SpawnPayload = {
    agentName: string
    nodeName: string
    cli: CliKind
    profileId: string
    envId: string
    taskId: string
    projectId: string
    workstreamId: string
    role: string
    title: string
    brief: string
    branch: string
    epoch: number
    handoff: boolean
    /** Set when the lease is a subagent: it runs in its parent's worktree with a subagent brief. */
    subagent?: SubagentSpawn | null
}

export type SubagentSpawn = {
    parentLeaseId: string
    parentAgentName: string
    /** The parent's CLI, for the brief ("Claude Code asked you"). */
    parentCli: CliKind
    role: SubagentRole
}

export type ReleasePayload = {
    agentName: string
    nodeName: string
    reason: string
}

export type CheckpointPayload = {
    agentName: string
    nodeName: string
    profileId: string
    envId: string
    taskId: string
    workstreamId: string
    branch: string
    epoch: number
}

export type HandoffBriefPayload = {
    taskId: string
    workstreamId: string
    branch: string
    fromLeaseId: string
    fromEpoch: number
    toLeaseId: string
    toEpoch: number
    toAgentName: string
    reason: string
    lastCheckpointSha: string | null
}

type OutboxCommon = {
    id: string
    /** Creation order within this actor. */
    seq: number
    leaseId: string
    taskId: string
    state: OutboxState
    attempts: number
    nextAt: number
    claimedUntil: number | null
    /** Item that must finish first. A failed hard blocker fails this item too; a soft one only delays it. */
    blockedBy: string | null
    hardBlock: boolean
    lastError: string | null
    createdAt: number
    updatedAt: number
}

export type SpawnItem = OutboxCommon & { kind: "spawn"; payload: SpawnPayload }
export type ReleaseItem = OutboxCommon & { kind: "release"; payload: ReleasePayload }
export type CheckpointItem = OutboxCommon & { kind: "checkpoint"; payload: CheckpointPayload }
export type HandoffBriefItem = OutboxCommon & { kind: "handoff_brief"; payload: HandoffBriefPayload }
export type OutboxItem = SpawnItem | ReleaseItem | CheckpointItem | HandoffBriefItem

/** What the dispatcher receives from claimOutbox. `id` doubles as the Relay idempotency key. */
export type OutboxClaim =
    | { id: string; kind: "spawn"; leaseId: string; taskId: string; attempts: number; payload: SpawnPayload }
    | { id: string; kind: "release"; leaseId: string; taskId: string; attempts: number; payload: ReleasePayload }
    | { id: string; kind: "checkpoint"; leaseId: string; taskId: string; attempts: number; payload: CheckpointPayload }
    | { id: string; kind: "handoff_brief"; leaseId: string; taskId: string; attempts: number; payload: HandoffBriefPayload }

export type OutboxResult =
    | { ok: true; invocationId: string | null; sha: string | null; detail: string | null }
    | { ok: false; error: string; retryable: boolean }

export type CompleteOutboxResult =
    | { ok: true; state: OutboxState }
    | { ok: false; reason: "unknown_item" | "not_claimed" }

// ---------- TeamWorkforce inputs ----------

export type RegisterProfileInput = {
    id: string
    envId: string
    ownerUserId: string
    /** Relay node of the profile's environment; spawns target it. */
    nodeName: string
    cli: CliKind
    label: string
    scopes: ProfileScopes
    maxConcurrent: number
}

export type ProfileHealth = {
    auth: ProfileAuth
    online: boolean
    observedAt: number
}

export type CreateTaskInput = {
    id: string
    projectId: string
    title: string
    prompt: string
    acceptance: string[]
    createdBy: string
    maxAgents: number
    /** Default split. A compare task's `maxAgents` is its harness count. */
    strategy?: TaskStrategy
    /** Default auto. Manual needs at least one pin. */
    mode?: WorkforceMode
    /** Profiles of this team, at most 5; duplicates are dropped. Default none. */
    pins?: string[]
}

export type PlanWorkstreamInput = {
    id: string
    role: string
    title: string
    brief: string
    why: string
    branch: string
    dependsOn: string[]
    ownership: string[]
    /** Compare attempts only: the harness this attempt runs on. */
    harness?: CliKind
}

export type PlanInput = {
    source: PlanSource
    profileId: string | null
    rationale: string
    warnings: string[]
    workstreams: PlanWorkstreamInput[]
    /** The human feedback this plan answers, when it re-plans an existing plan. Only traced. */
    feedback?: string
}

export type ReservePick = { workstreamId: string; profileId: string }

/** A person adds a worker to a running split task (the task's @ menu): a new workstream, its lease and its spawn. */
export type AddWorkstreamInput = {
    /**
     * The profiles it may run on: the one a person picked, or every profile of the VM they picked. The actor takes the
     * best one that can take the work, so a retry of the same request finds the same list whatever changed since.
     */
    profileIds: string[]
    title: string
    /** The person's message with the backend's framing, already cleaned. It becomes the workstream's brief. */
    brief: string
    /** Who asked, for the trace. */
    byUserId: string
    /** The team's per-task worker cap right now (`policy.maxParallelPerTask`): the most live workers the task may have. */
    maxLive: number
}

/** A worker's `delegate_task`: one subagent on its own machine (docs/subagents.md). */
export type DelegateInput = {
    parentLeaseId: string
    target: CliKind
    role: SubagentRole
    /** Already cleaned by the backend: bounded, no hidden characters, credentials masked. */
    task: string
    clientRequestId: string
}

export type SubagentResultStatus = "completed" | "failed"

export type SpawnStatus = "spawning" | "running" | "failed" | "exited"

// ---------- TeamWorkforce results ----------

export type ProfileRejection =
    | "unknown_profile"
    | "profile_limited"
    | "profile_offline"
    | "profile_auth_required"
    | "out_of_scope"
    | "over_capacity"
    | "wrong_harness"
    /** A manual task's lease must be on one of its pinned profiles. */
    | "not_pinned"

export type PickRejection =
    | ProfileRejection
    | "unknown_task"
    | "task_not_startable"
    | "unknown_workstream"
    | "duplicate_workstream"
    | "workstream_not_pending"
    | "already_leased"

export type PickResult = {
    workstreamId: string
    profileId: string
    ok: boolean
    reason: PickRejection | null
}

export type ReserveResult = { ok: true; leases: LeaseView[] } | { ok: false; reason: "invalid_picks"; picks: PickResult[] }

/**
 * Why a worker could not be added. `not_split`: a compare task runs one attempt per harness. `task_not_running`: only a
 * started task that is still working takes one. `too_many_workstreams`: the task already holds as many workstreams as
 * a plan may. `task_at_capacity`: it already runs as many workers as the team's or the task's cap allows. A
 * `ProfileRejection` when there was one candidate; `no_eligible_profile` when none of several could take it.
 */
export type AddWorkstreamRejection =
    | ProfileRejection
    | "unknown_task"
    | "not_split"
    | "task_not_running"
    | "too_many_workstreams"
    | "task_at_capacity"
    | "no_eligible_profile"

export type AddWorkstreamResult = { ok: true; workstreamId: string; lease: LeaseView } | { ok: false; reason: AddWorkstreamRejection }

export type RegisterProfileResult =
    | { ok: true; profile: ProfileView }
    | { ok: false; reason: "profile_owner_mismatch" | "too_many_profiles" }

export type UpdateHealthResult =
    | { ok: true; applied: boolean }
    | { ok: false; reason: "unknown_profile" }

export type RecordUsageResult =
    | { ok: true; applied: boolean }
    | { ok: false; reason: "unknown_profile" }

export type RemoveProfileResult = { ok: true; removed: boolean; expiredLeaseIds: string[] }

/**
 * Why a task's mode and pins were refused. `no_pins`: manual with none. `unknown_pin`: a pin is not a profile of this
 * team. `harness_not_pinned`: a manual compare task with a harness none of its pins runs.
 */
export type WorkforceRejection = "no_pins" | "unknown_pin" | "harness_not_pinned"

export type CreateTaskResult =
    | { ok: true; taskId: string }
    | { ok: false; reason: "task_exists" | "too_many_active_tasks" | WorkforceRejection }

/** `changed` is false when the task already had this mode and these pins. */
export type SetTaskWorkforceResult =
    | { ok: true; mode: WorkforceMode; pins: string[]; changed: boolean }
    | { ok: false; reason: "unknown_task" | "task_started" | WorkforceRejection }

/** `noted` is false when the same wait is already the workstream's latest note (or the task has ended). */
export type NoteWaitingResult =
    | { ok: true; noted: boolean }
    | { ok: false; reason: "unknown_task" | "unknown_workstream" | "not_manual" }

export type BeginPlanningResult =
    | { ok: true; until: number }
    | { ok: false; reason: "unknown_task" | "task_not_plannable" | ProfileRejection }

export type RecordPlanResult =
    | { ok: true; generation: number }
    | { ok: false; reason: "unknown_task" | "task_not_plannable" | "too_many_workstreams" | "wrong_strategy" | "harness_not_pinned" }

export type FenceRejection =
    | "unknown_lease"
    | "stale_epoch"
    | "lease_not_active"
    | "workstream_done"
    | "handoff_not_acked"
    | "not_in_handoff"

export type FencedResult = { ok: true } | { ok: false; reason: FenceRejection }

/** The task's thread root. `threadId` is the one stored first: a later, different id loses. */
export type SetTaskThreadResult = { ok: true; threadId: string } | { ok: false; reason: "unknown_task" }

/** How far workers have been told about a task's trace (architecture 9.8). */
export type MarkNotifiedResult = { ok: true; through: number } | { ok: false; reason: "unknown_task" }

export type MarkLimitedResult =
    | { ok: true; cooldownUntil: number; expiredLeaseIds: string[] }
    | { ok: false; reason: "unknown_profile" }

export type HandoffRejection =
    | ProfileRejection
    | "unknown_task"
    | "task_not_startable"
    | "unknown_workstream"
    | "not_in_handoff"
    | "stale_epoch"

export type RequestHandoffResult = { ok: true; lease: LeaseView } | { ok: false; reason: HandoffRejection }

/**
 * Why a delegation was refused. `parent_*`: the caller. `no_target_profile`: no profile of that CLI on the caller's
 * machine. A `ProfileRejection` names what is wrong with it. `parent_limit` / `task_limit`: too many live subagents.
 * `request_mismatch`: the `clientRequestId` already started a subagent with a different CLI, role or task.
 */
export type DelegateRejection =
    | "parent_not_active"
    | "parent_is_subagent"
    | "no_target_profile"
    | ProfileRejection
    | "parent_limit"
    | "task_limit"
    | "request_mismatch"

/** `created` is false for a retry with the same `clientRequestId`: the same subagent comes back. */
export type DelegateResult =
    | { ok: true; created: boolean; subagent: SubagentView }
    | { ok: false; reason: DelegateRejection }

/** `recorded` is false when the subagent had already ended (a replay, or a result after a cancel). */
export type SubagentResultResult =
    | { ok: true; recorded: boolean; subagent: SubagentView }
    | { ok: false; reason: "unknown_lease" | "stale_epoch" | "not_a_subagent" }

/** `cancelled` is false when it had already ended; its result is kept. */
export type CancelSubagentResult =
    | { ok: true; cancelled: boolean; subagent: SubagentView }
    | { ok: false; reason: "task_not_found" }

export type PickAttemptResult =
    | { ok: true; status: TaskStatus; releasedLeaseIds: string[] }
    | {
          ok: false
          reason: "unknown_task" | "not_compare" | "task_terminal" | "already_picked" | "unknown_workstream" | "attempt_not_done" | "nothing_finished"
      }

export type CancelTaskResult =
    | { ok: true; releasedLeaseIds: string[] }
    | { ok: false; reason: "unknown_task" | "task_terminal" }

/** `releasedLeaseIds`: the live leases a delete cancelled first (empty for a task that had already ended). */
export type DeleteTaskResult = { ok: true; releasedLeaseIds: string[] } | { ok: false; reason: "unknown_task" }

/** `verify`: every workstream was done, so verification runs again. `replan`: unfinished workstreams wait for new workers. */
export type RetryTaskResult =
    | { ok: true; mode: "verify" | "replan"; reopenedWorkstreamIds: string[] }
    | { ok: false; reason: "unknown_task" | "task_not_failed" | "no_workstreams" }

export type SubmitVerificationResult =
    | { ok: true; status: TaskStatus }
    | { ok: false; reason: "unknown_task" | "task_not_verifying" }

/** What verification saw when a branch did not merge into the task's integration branch. */
export type ConflictInput = {
    /** The branch that did not merge: a workstream's branch, or the project's default branch when it moved on. */
    branch: string
    /** The workstream that owns `branch`; null for the default branch. */
    workstreamId: string | null
    /** The task's integration branch. The resolver works on it. */
    integrationBranch: string
    /** Workstreams on either side of the conflict; the scheduler prefers a profile that worked on one. */
    involvedWorkstreamIds: string[]
    /** Files both sides changed, where the conflicts are. */
    files: string[]
    /** The resolver's instructions, written by the backend. */
    brief: string
}

/** `resolving`: a resolver workstream waits for a worker. `failed`: the attempts are used up (or nobody can resolve it). */
export type ResolveConflictResult =
    | { ok: true; status: "resolving" | "failed"; attempt: number }
    | { ok: false; reason: "unknown_task" | "task_not_verifying" | "unknown_workstream" }

export type ReconcileResult = {
    restoredProfileIds: string[]
    expiredLeaseIds: string[]
    nextAlarmAt: number | null
}

export type WorkforceInternals = {
    epoch: number
    alarmAt: number | null
    ledgerSize: number
    outbox: OutboxItem[]
}

// ---------- Team ----------

export type MemberIdentity = {
    userId: string
    login: string
    name: string | null
    avatarUrl: string | null
}

export type Member = {
    userId: string
    login: string
    name: string | null
    avatarUrl: string | null
    role: Role
    joinedAt: number
}

export type Invite = {
    /** Not secret: how owners list and revoke the invite. The record's key is the hash of the secret code. */
    id: string
    createdBy: string
    expiresAt: number
    uses: number
    maxUses: number
    createdAt: number
}

export type Project = {
    id: string
    repoFullName: string
    repoId: number
    defaultBranch: string
    testCommand: string | null
    createdBy: string
    createdAt: number
}

export type Environment = {
    id: string
    ownerUserId: string
    name: string
    freestyleVmId: string | null
    linuxUser: string | null
    nodeName: string | null
    phase: EnvironmentPhase
    vmState: VmState
    nodeOnline: boolean
    lastError: string | null
    /** Freestyle identity behind this environment's terminal tokens. Backend-only; absent on older records. */
    freestyleIdentityId?: string | null
    createdAt: number
    updatedAt: number
}

export type EnvironmentPatch = {
    name?: string
    freestyleVmId?: string | null
    freestyleIdentityId?: string | null
    linuxUser?: string | null
    nodeName?: string | null
    phase?: EnvironmentPhase
    vmState?: VmState
    nodeOnline?: boolean
    lastError?: string | null
}

/** Every secret is a backend-encrypted blob; actors store and return them, never decrypt them. */
export type RelayConfig = {
    workspaceId: string
    baseUrl: string
    workspaceKeyEnc: string
    dispatcherTokenEnc: string
    observerTokenEnc: string
    observerTokenId: string
}

export type RelayState = RelayConfig & { cursor: string | null }

export type CreateTeamInput = {
    name: string
    slug: string
    owner: MemberIdentity
}

export type CreateInviteInput = {
    id: string
    /** Hex SHA-256 of the invite code; the code itself never reaches the actor. */
    hash: string
    createdBy: string
    expiresAt: number
    maxUses: number
}

export type LinkProjectInput = {
    id: string
    repoFullName: string
    repoId: number
    defaultBranch: string
    testCommand: string | null
    createdBy: string
}

export type CreateEnvironmentInput = {
    id: string
    ownerUserId: string
    name: string
}

export type CreateTeamResult = { ok: true } | { ok: false; reason: "already_exists" }
export type MemberLookup = { userId: string; role: Role } | null
export type RemoveMemberResult = { ok: true; removed: boolean } | { ok: false; reason: "last_owner" }
export type CreateInviteResult = { ok: true } | { ok: false; reason: "no_team" | "not_a_member" | "invite_exists" | "too_many_invites" }
export type AcceptInviteResult =
    | { ok: true; role: Role; alreadyMember: boolean }
    | { ok: false; reason: "no_team" | "invalid_invite" | "expired" | "exhausted" | "too_many_members" }
export type LinkProjectResult =
    | { ok: true; projectId: string; created: boolean }
    | { ok: false; reason: "no_team" | "not_a_member" | "project_exists" | "too_many_projects" }
export type CreateEnvironmentResult =
    | { ok: true; created: boolean }
    | { ok: false; reason: "no_team" | "not_a_member" | "environment_exists" | "too_many_environments" }
export type UpdateEnvironmentResult =
    | { ok: true; environment: Environment }
    | { ok: false; reason: "unknown_environment" | "environment_disconnected" }
export type TeamWriteResult = { ok: true } | { ok: false; reason: "no_team" }
export type SetProjectTestCommandResult =
    | { ok: true; project: ProjectView; changed: boolean }
    | { ok: false; reason: "no_team" | "unknown_project" }
/** An active invite as owners see it: never the hash. */
export type InviteView = {
    id: string
    createdBy: string
    expiresAt: number
    uses: number
    maxUses: number
    createdAt: number
}
export type RevokeInviteResult = { ok: true; revoked: boolean } | { ok: false; reason: "no_team" }
export type SetMemberRoleResult =
    | { ok: true; role: AssignableRole; changed: boolean }
    | { ok: false; reason: "no_team" | "not_a_member" | "owner_role_fixed" }
/**
 * A usable invite, for the join page. Null covers no team, unknown hash, expired and used up alike, so a caller
 * cannot tell them apart. `inviter` is null when the creator has since left the team.
 */
export type InvitePreview = {
    teamName: string
    expiresAt: number
    createdBy: string
    inviter: { login: string; avatarUrl: string | null } | null
} | null
export type MemberWriteResult = { ok: true } | { ok: false; reason: "no_team" | "not_a_member" }
export type RelayWriteResult = { ok: true } | { ok: false; reason: "relay_not_configured" }

// ---------- User ----------

export type GithubProfile = {
    githubId: number
    login: string
    name: string | null
    avatarUrl: string | null
    email: string | null
}

export type UpsertFromGithubInput = GithubProfile & { githubTokenEnc: string }

export type UserRecord = {
    id: string
    profile: GithubProfile
    githubTokenEnc: string
    sessionVersion: number
    teamIds: string[]
    relayHumanTokens: Record<string, string>
    freestyleIdentityId: string | null
    createdAt: number
    updatedAt: number
}

export type UpsertUserResult = { ok: true; created: boolean; sessionVersion: number }
export type UserWriteResult = { ok: true } | { ok: false; reason: "unknown_user" }
export type BumpSessionResult = { ok: true; sessionVersion: number } | { ok: false; reason: "unknown_user" }
export type UserTeamsResult = { ok: true; teamIds: string[] } | { ok: false; reason: "unknown_user" | "too_many_teams" }
export type SetRelayTokenResult = { ok: true } | { ok: false; reason: "unknown_user" | "not_in_team" }

// ---------- sockets ----------

export type SocketMetadata = { userId: string }
// The keepalive: the gateway answers the ping itself (setWebSocketAutoResponse), so actors never send.
export type SocketIncoming = { type: "ping" }
export type SocketOutgoing = { type: "pong" }
