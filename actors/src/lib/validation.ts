// Runtime validation for every actor argument. The durable-actors runtime does not check RPC arguments against
// their TS types, so each public method parses its arguments with these schemas before touching state.
import { z } from "zod"
import { isValidBranch } from "./names.ts"

export const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const SINGLE_LINE = /^[^\u0000-\u001f\u007f]*$/
const MULTI_LINE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/
// Backend-encrypted blobs: printable ASCII, no whitespace. The actor never looks inside.
const SEALED = /^[\x21-\x7e]+$/

// Ids become record keys; names like "__proto__" or "constructor" would hit Object.prototype on lookup.
export const Id = z
    .string()
    .regex(ID_PATTERN, "invalid id")
    .refine(value => !(value in Object.prototype), "reserved id")
/** Idempotency keys and event ids share the id charset (UUIDs fit). */
export const Key = Id
export const EpochMs = z.number().int().nonnegative().max(8.64e15)
export const Epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const Sha = z.string().regex(/^[0-9a-f]{7,64}$/, "invalid sha")
/** A Relay message id (the engine's snowflake-like ids). */
export const MessageId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "invalid message id")
export const Sealed = z.string().min(16).max(16_384).regex(SEALED, "invalid sealed blob")

// Half of a surrogate pair is not text, and JSON escapes it to six bytes. Without it every character is at most
// three bytes on the wire, which is what the emitted view's size ceiling counts on.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const wellFormed = (value: string) => !LONE_SURROGATE.test(value)

/** Single-line text, trimmed, no control characters. */
export const line = (min: number, max: number) =>
    z.string().trim().min(min).max(max).regex(SINGLE_LINE, "control characters").refine(wellFormed, "broken characters")
/** Multi-line text: newlines and tabs allowed, other control characters rejected. */
export const text = (min: number, max: number) =>
    z.string().min(min).max(max).regex(MULTI_LINE, "control characters").refine(wellFormed, "broken characters")

export const HttpUrl = z
    .string()
    .max(500)
    .url()
    .refine(value => /^https?:\/\//i.test(value), "must be http(s)")

export const Role = z.enum(["owner", "admin", "member"])
/** Roles a member can be given. `owner` is set once at team creation; there is no ownership transfer. */
export const AssignableRole = z.enum(["admin", "member"])
export const CliKind = z.enum(["claude", "codex", "opencode", "cursor", "gemini", "grok"])
export const ProfileAuth = z.enum(["unknown", "ok", "auth_required"])
export const LimitSource = z.enum(["detected", "manual"])
export const ProfileScopes = z.union([z.literal("all"), z.array(Id).max(100)])
export const EnvironmentPhase = z.enum(["provisioning", "bootstrapping", "awaiting_login", "ready", "paused", "error", "disconnected"])
export const VmState = z.enum(["starting", "running", "pausing", "paused", "stopped", "unknown"])
export const PlanSource = z.enum(["cli", "fallback", "compare"])
export const TaskStrategy = z.enum(["split", "compare"])
export const WorkforceMode = z.enum(["auto", "manual"])
/** Pinned profiles per task (contracts `TASK_PINS_MAX`). */
export const TASK_PINS_MAX = 5
/** A task's pinned profile ids, duplicates dropped (first one kept). Whether they are this team's is the state machine's check. */
export const Pins = z
    .array(Id)
    .max(TASK_PINS_MAX)
    .transform(ids => [...new Set(ids)])
export const WaitingReason = z.enum(["no_pinned_profile"])
/** Harnesses one compare task runs at once (contracts `COMPARE_HARNESSES`). */
export const COMPARE_HARNESSES = { min: 2, max: 3 } as const
export const CheckStatus = z.enum(["pending", "passed", "failed", "skipped"])
export const SpawnStatus = z.enum(["spawning", "running", "failed", "exited"])
/** Relay node names and Linux user names. */
export const NodeName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "invalid node name")
export const LinuxUser = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, "invalid linux user")
/** Workstream roles end up in agent names and branches, so they are slugs. */
export const WorkstreamRole = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/, "role must be a lowercase slug")
export const Branch = z.string().refine(isValidBranch, "invalid branch name")
export const RepoFullName = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "expected owner/name")
export const GithubLogin = z.string().regex(/^[A-Za-z0-9-]{1,39}$/, "invalid github login")
export const InviteHash = z.string().regex(/^[0-9a-f]{64}$/, "expected hex sha-256")

/** Unix ms supplied by the backend for time-driven sweeps; bounded so a bad clock cannot fast-forward cooldowns. */
export const MAX_CLOCK_SKEW_MS = 10 * 60_000
export function assertClock(now: number, actual = Date.now()): void {
    if (now > actual + MAX_CLOCK_SKEW_MS) throw new Error("invalid_argument: now is too far in the future")
}

/** Parses or throws `invalid_argument: <path>: <message>`. The value itself is never echoed (it may be a secret). */
export function parse<T extends z.ZodType>(schema: T, value: unknown, name: string): z.output<T> {
    const result = schema.safeParse(value)
    if (result.success) return result.data
    const issue = result.error.issues[0]
    const path = [name, ...(issue?.path ?? []).map(String)].join(".")
    throw new Error(`invalid_argument: ${path}: ${issue?.message ?? "invalid"}`)
}

// ---------- TeamWorkforce ----------

export const RegisterProfileInput = z.strictObject({
    id: Id,
    envId: Id,
    ownerUserId: Id,
    nodeName: NodeName,
    cli: CliKind,
    label: line(1, 48),
    scopes: ProfileScopes,
    /** Workers at once for this login, subagents included. contracts `PROFILE_MAX_CONCURRENT`. */
    maxConcurrent: z.number().int().min(1).max(8)
})

export const ProfileHealth = z.strictObject({
    auth: ProfileAuth,
    online: z.boolean(),
    observedAt: EpochMs
})

export const UsageWindow = z.strictObject({
    kind: z.enum(["five_hour", "weekly", "other"]),
    label: line(1, 40),
    usedPercent: z.number().finite().min(0).max(100),
    resetsAt: EpochMs.nullable()
})

export const ProfileUsage = z.strictObject({
    windows: z.array(UsageWindow).max(6),
    observedAt: EpochMs,
    source: z.enum(["probe", "worker"])
})

export const CreateTaskInput = z.strictObject({
    id: Id,
    projectId: Id,
    title: line(1, 120),
    prompt: text(1, 8000),
    acceptance: z.array(line(1, 300)).max(20),
    createdBy: Id,
    maxAgents: z.number().int().min(1).max(5),
    strategy: TaskStrategy.optional(),
    mode: WorkforceMode.optional(),
    pins: Pins.optional()
})

const PlanWorkstreamInput = z.strictObject({
    id: Id,
    role: WorkstreamRole,
    title: line(1, 120),
    // Relay task text must stay under 14 KB; longer context goes into a committed brief file.
    brief: text(1, 12_000),
    why: text(1, 2000),
    branch: Branch,
    dependsOn: z.array(Id).max(5),
    ownership: z.array(line(1, 200)).max(50),
    harness: CliKind.optional()
})

export const PlanInput = z
    .strictObject({
        source: PlanSource,
        profileId: Id.nullable(),
        rationale: text(1, 4000),
        warnings: z.array(line(1, 300)).max(20),
        workstreams: z.array(PlanWorkstreamInput).min(1).max(5),
        feedback: text(1, 4000).optional()
    })
    .superRefine((plan, ctx) => {
        if (plan.source === "cli" && plan.profileId === null)
            ctx.addIssue({ code: "custom", path: ["profileId"], message: "required when source is cli" })
        if (plan.source !== "cli" && plan.profileId !== null)
            ctx.addIssue({ code: "custom", path: ["profileId"], message: `must be null when source is ${plan.source}` })
        const compare = comparePlanProblem(plan)
        if (compare) ctx.addIssue({ code: "custom", path: ["workstreams"], message: compare })
        const problem = planGraphProblem(plan.workstreams)
        if (problem) ctx.addIssue({ code: "custom", path: ["workstreams"], message: problem })
    })

/**
 * A compare plan is one attempt per harness: 2 or 3 workstreams, each bound to a different harness, none waiting on
 * another. Any other plan binds no workstream to a harness.
 */
export function comparePlanProblem(plan: { source: string; workstreams: readonly { harness?: string; dependsOn: readonly string[] }[] }): string | null {
    const bound = plan.workstreams.filter(ws => ws.harness !== undefined)
    if (plan.source !== "compare") return bound.length > 0 ? "only a compare plan binds workstreams to a harness" : null
    const count = plan.workstreams.length
    if (count < COMPARE_HARNESSES.min || count > COMPARE_HARNESSES.max)
        return `a compare plan has ${COMPARE_HARNESSES.min} to ${COMPARE_HARNESSES.max} attempts`
    if (bound.length !== count) return "every compare attempt needs a harness"
    if (new Set(bound.map(ws => ws.harness)).size !== count) return "each compare attempt needs a different harness"
    if (plan.workstreams.some(ws => ws.dependsOn.length > 0)) return "compare attempts do not wait on each other"
    return null
}

/** Unique ids and branches, known dependencies, no self or cyclic dependencies. */
export function planGraphProblem(workstreams: readonly { id: string; branch: string; dependsOn: readonly string[] }[]): string | null {
    const ids = new Set<string>()
    const branches = new Set<string>()
    for (const ws of workstreams) {
        if (ids.has(ws.id)) return `duplicate workstream id ${ws.id}`
        if (branches.has(ws.branch)) return `duplicate branch ${ws.branch}`
        ids.add(ws.id)
        branches.add(ws.branch)
    }
    const deps = new Map(workstreams.map(ws => [ws.id, ws.dependsOn]))
    for (const ws of workstreams)
        for (const dep of ws.dependsOn) {
            if (dep === ws.id) return `workstream ${ws.id} depends on itself`
            if (!ids.has(dep)) return `workstream ${ws.id} depends on unknown ${dep}`
        }
    const state = new Map<string, "visiting" | "done">()
    const visit = (id: string): boolean => {
        const seen = state.get(id)
        if (seen === "done") return false
        if (seen === "visiting") return true
        state.set(id, "visiting")
        for (const dep of deps.get(id) ?? []) if (visit(dep)) return true
        state.set(id, "done")
        return false
    }
    for (const ws of workstreams) if (visit(ws.id)) return "dependency cycle"
    return null
}

export const AddWorkstreamInput = z.strictObject({
    profileIds: z
        .array(Id)
        .min(1)
        .max(100)
        .transform(ids => [...new Set(ids)].sort()),
    title: line(1, 120),
    // Same budget as a planned workstream's brief.
    brief: text(1, 12_000),
    byUserId: Id,
    // The team policy's cap; the workstream ceiling bounds what it can reach.
    maxLive: z.number().int().min(1).max(100)
})

export const ReservePicks = z
    .array(z.strictObject({ workstreamId: Id, profileId: Id }))
    .min(1)
    .max(5)

export const OutboxResult = z.discriminatedUnion("ok", [
    z.strictObject({
        ok: z.literal(true),
        invocationId: line(1, 200).nullable(),
        sha: Sha.nullable(),
        detail: line(0, 500).nullable()
    }),
    z.strictObject({ ok: z.literal(false), error: line(1, 500), retryable: z.boolean() })
])

export const VerificationInput = z
    .strictObject({
        status: CheckStatus,
        checks: z
            .array(
                z.strictObject({
                    name: line(1, 120),
                    status: CheckStatus,
                    detail: text(0, 2000),
                    url: HttpUrl.nullable()
                })
            )
            .max(50)
    })
    .refine(value => value.status !== "skipped", { message: "overall status cannot be skipped", path: ["status"] })

export const ConflictInput = z.strictObject({
    branch: Branch,
    workstreamId: Id.nullable(),
    integrationBranch: Branch,
    involvedWorkstreamIds: z.array(Id).max(5),
    files: z.array(line(1, 300)).max(50),
    // Same budget as a planned workstream's brief (it becomes the resolver workstream's brief).
    brief: text(1, 12_000)
})

export const SubagentRole = z.enum(["review", "research", "implementation", "test", "general"])
export const SubagentResultStatus = z.enum(["completed", "failed"])
/** The `<ref>` of a subagent request, also its idempotency key (docs/subagents.md, wire protocol). */
export const ClientRequestId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "invalid request id")

export const DelegateInput = z.strictObject({
    parentLeaseId: Id,
    target: CliKind,
    role: SubagentRole,
    // At most 12 KB on the wire, so the subagent's brief stays under Relay's 14 KB spawn limit.
    task: text(1, 4000),
    clientRequestId: ClientRequestId
})

/** A subagent's result: the backend clips it to 8 KB of UTF-8 first. */
export const SubagentSummary = text(1, 8192)

export const OutboxLimit = z.number().int().min(1).max(50)
/** A trace entry count (`traceCount`), for update watermarks. */
export const TraceNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const Reason = line(1, 300)
export const Summary = text(0, 2000)
/** A published interface contract's one-line summary (agent text). */
export const ContractSummary = line(1, 300)

// ---------- Team ----------

export const MemberIdentity = z.strictObject({
    userId: Id,
    login: GithubLogin,
    name: line(0, 255).nullable(),
    avatarUrl: HttpUrl.nullable()
})

export const TeamName = line(1, 64)

export const CreateTeamInput = z.strictObject({
    name: TeamName,
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "invalid slug"),
    owner: MemberIdentity
})

export const CreateInviteInput = z.strictObject({
    id: Id,
    hash: InviteHash,
    createdBy: Id,
    expiresAt: EpochMs,
    maxUses: z.number().int().min(1).max(50)
})

/**
 * One visible line: no newline or NUL can reach the shell that runs it on the VM, and no zero-width, bidi or
 * C1 character can make the command members see differ from the one bash runs.
 */
export const TestCommand = line(1, 200).regex(/^[^\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]*$/, "hidden characters")

export const LinkProjectInput = z.strictObject({
    id: Id,
    repoFullName: RepoFullName,
    repoId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    defaultBranch: Branch,
    testCommand: TestCommand.nullable(),
    createdBy: Id
})

export const CreateEnvironmentInput = z.strictObject({
    id: Id,
    ownerUserId: Id,
    name: line(1, 48)
})

export const EnvironmentPatch = z
    .strictObject({
        name: line(1, 48).optional(),
        freestyleVmId: Id.nullable().optional(),
        freestyleIdentityId: Id.nullable().optional(),
        linuxUser: LinuxUser.nullable().optional(),
        nodeName: NodeName.nullable().optional(),
        phase: EnvironmentPhase.optional(),
        vmState: VmState.optional(),
        nodeOnline: z.boolean().optional(),
        lastError: line(1, 500).nullable().optional()
    })
    .refine(patch => Object.values(patch).some(value => value !== undefined), "empty patch")

export const RelayConfig = z.strictObject({
    workspaceId: Id,
    baseUrl: HttpUrl,
    workspaceKeyEnc: Sealed,
    dispatcherTokenEnc: Sealed,
    observerTokenEnc: Sealed,
    observerTokenId: Id
})

export const RelayCursor = z.string().min(1).max(512).regex(SEALED, "invalid cursor")

export const TeamPolicy = z.strictObject({
    allowInspect: z.boolean(),
    maxParallelPerTask: z.number().int().min(1).max(5)
})

/** Any subset of the policy; the actor merges it onto the current one in the same atomic step. */
export const TeamPolicyPatch = TeamPolicy.partial().refine(patch => Object.values(patch).some(value => value !== undefined), "empty patch")

// ---------- User ----------

export const UpsertFromGithubInput = z.strictObject({
    githubId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    login: GithubLogin,
    name: line(0, 255).nullable(),
    avatarUrl: HttpUrl.nullable(),
    email: z.string().max(254).email().nullable(),
    githubTokenEnc: Sealed
})

export const SocketMetadata = z.object({ userId: Id })
