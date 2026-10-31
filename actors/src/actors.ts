// Morrow durable actors: User, Team, TeamWorkforce.
//
// Rules every method follows (docs/research/terse.md section 8): each state transition is @Atomic and there is no
// @Interleave anywhere; persisted objects are reassigned, never mutated; helpers are #private or module functions
// (TS `private async` methods would be RPC-callable); every argument is validated here because the runtime does not;
// no network I/O; alarm set/delete is the last state operation of a method.
import { Actor, Emittable, Ephemeral, Persisted, type ActorSocket } from "durable-actors"
import { Atomic } from "./lib/atomic.ts"
import { fingerprint, ledgerLookup, ledgerRecord, type Ledger } from "./lib/ledger.ts"
import {
    applyEnvironmentPatch,
    blockedByRemoval,
    buildTeamView,
    DEFAULT_POLICY,
    inviteViews,
    ownerCount,
    pruneExpiredInvites,
    pruneRemoved,
    TEAM_LIMITS,
    type TeamState
} from "./lib/team.ts"
import type {
    AcceptInviteResult,
    AddWorkstreamInput,
    AddWorkstreamResult,
    AssignableRole,
    BeginPlanningResult,
    BumpSessionResult,
    CancelSubagentResult,
    CancelTaskResult,
    DeleteTaskResult,
    PickAttemptResult,
    CliProfile,
    CompleteOutboxResult,
    CreateEnvironmentInput,
    CreateEnvironmentResult,
    CreateInviteInput,
    CreateInviteResult,
    CreateTaskInput,
    CreateTaskResult,
    CreateTeamInput,
    CreateTeamResult,
    DelegateInput,
    DelegateResult,
    Environment,
    EnvironmentPatch,
    FencedResult,
    GithubProfile,
    Invite,
    InvitePreview,
    InviteView,
    LinkProjectInput,
    LinkProjectResult,
    Lease,
    LimitSource,
    MarkLimitedResult,
    MarkNotifiedResult,
    Member,
    MemberIdentity,
    MemberLookup,
    MemberWriteResult,
    NoteWaitingResult,
    OutboxClaim,
    OutboxItem,
    OutboxResult,
    PlanInput,
    ProfileHealth,
    ProfileUsage,
    RecordUsageResult,
    Project,
    RecordPlanResult,
    ReconcileResult,
    RegisterProfileInput,
    RegisterProfileResult,
    RelayConfig,
    RelayState,
    RelayWriteResult,
    RemoveMemberResult,
    RemoveProfileResult,
    RequestHandoffResult,
    ResolveConflictResult,
    ConflictInput,
    RetryTaskResult,
    RevokeInviteResult,
    ReservePick,
    ReserveResult,
    SetMemberRoleResult,
    SetProjectTestCommandResult,
    SetRelayTokenResult,
    SetTaskThreadResult,
    SetTaskWorkforceResult,
    SocketIncoming,
    SocketMetadata,
    SocketOutgoing,
    SpawnStatus,
    SubagentResultResult,
    SubagentResultStatus,
    SubmitVerificationResult,
    Task,
    TaskRecord,
    TeamPolicy,
    TeamProjection,
    TeamWriteResult,
    UpdateEnvironmentResult,
    UpdateHealthResult,
    UpsertFromGithubInput,
    UpsertUserResult,
    UserRecord,
    UserTeamsResult,
    UserWriteResult,
    VerificationView,
    WaitingReason,
    WorkforceInternals,
    WorkforceMode,
    WorkforceView
} from "./lib/types.ts"
import * as v from "./lib/validation.ts"
import * as wf from "./lib/workforce.ts"
import { EMPTY_OUTBOX_SUMMARY, summarizeOutbox, type OutboxSummary } from "./lib/outbox-summary.ts"
import { SCHEMA_VERSION, WorkforceStore, type StoredRecords } from "./lib/store.ts"

// One durable list of teams with unfinished work; the backend reads it to resume them after a restart.
export { TeamDirectory } from "./lib/directory.ts"

type Socket = ActorSocket<SocketMetadata, SocketOutgoing>

const USER_TEAM_LIMIT = 100
const MAX_INVITE_LIFETIME_MS = 8 * 24 * 60 * 60_000

/**
 * Actor sockets are for the backend only (backend/src/actors/gateway.ts). Browsers get actor state from the backend
 * hub, which checks membership first; a socket straight to an actor would skip that check.
 */
const BACKEND_SOCKET_USER = "system.backend"
/** The backend's keepalive (backend/src/realtime/actorSubscription.ts), answered by the gateway without waking the actor. */
const KEEPALIVE = { request: '{"type":"ping"}', response: '{"type":"pong"}' } as const

function admit(socket: Socket): boolean {
    const meta = v.SocketMetadata.safeParse(socket.metadata)
    if (meta.success && meta.data.userId === BACKEND_SOCKET_USER) return true
    socket.reject(4003, "backend only")
    return false
}

function sameJson(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

// ============================================================================
// User (id `u-<githubId>`). Emits nothing.
// ============================================================================

export class User extends Actor<SocketMetadata, SocketIncoming, SocketOutgoing> {
    @Persisted private profile: GithubProfile | null = null
    @Persisted private githubTokenEnc: string | null = null
    @Persisted private sessionVersion = 1
    @Persisted private teamIds: string[] = []
    @Persisted private relayHumanTokens: Record<string, string> = {}
    @Persisted private freestyleIdentityId: string | null = null
    @Persisted private createdAt = 0
    @Persisted private updatedAt = 0

    @Atomic
    async upsertFromGithub(input: UpsertFromGithubInput): Promise<UpsertUserResult> {
        const args = v.parse(v.UpsertFromGithubInput, input, "input")
        if (this.id !== `u-${args.githubId}`) throw new Error("invalid_argument: githubId does not match the actor id")
        const created = this.profile === null
        const now = Date.now()
        const { githubTokenEnc, ...profile } = args
        this.profile = profile
        this.githubTokenEnc = githubTokenEnc
        if (created) this.createdAt = now
        this.updatedAt = now
        return { ok: true, created, sessionVersion: this.sessionVersion }
    }

    async get(): Promise<UserRecord | null> {
        if (!this.profile || !this.githubTokenEnc) return null
        return {
            id: this.id,
            profile: this.profile,
            githubTokenEnc: this.githubTokenEnc,
            sessionVersion: this.sessionVersion,
            teamIds: this.teamIds,
            relayHumanTokens: this.relayHumanTokens,
            freestyleIdentityId: this.freestyleIdentityId,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt
        }
    }

    /** Logout everywhere: every session cookie carrying an older version stops working. */
    @Atomic
    async bumpSessionVersion(): Promise<BumpSessionResult> {
        if (!this.profile) return { ok: false, reason: "unknown_user" }
        this.sessionVersion = this.sessionVersion + 1
        this.updatedAt = Date.now()
        return { ok: true, sessionVersion: this.sessionVersion }
    }

    @Atomic
    async addTeam(teamId: string): Promise<UserTeamsResult> {
        const id = v.parse(v.Id, teamId, "teamId")
        if (!this.profile) return { ok: false, reason: "unknown_user" }
        if (this.teamIds.includes(id)) return { ok: true, teamIds: this.teamIds }
        if (this.teamIds.length >= USER_TEAM_LIMIT) return { ok: false, reason: "too_many_teams" }
        this.teamIds = [...this.teamIds, id]
        this.updatedAt = Date.now()
        return { ok: true, teamIds: this.teamIds }
    }

    @Atomic
    async removeTeam(teamId: string): Promise<UserTeamsResult> {
        const id = v.parse(v.Id, teamId, "teamId")
        if (!this.profile) return { ok: false, reason: "unknown_user" }
        if (!this.teamIds.includes(id) && !(id in this.relayHumanTokens)) return { ok: true, teamIds: this.teamIds }
        this.teamIds = this.teamIds.filter(existing => existing !== id)
        const { [id]: _dropped, ...rest } = this.relayHumanTokens
        this.relayHumanTokens = rest
        this.updatedAt = Date.now()
        return { ok: true, teamIds: this.teamIds }
    }

    @Atomic
    async setRelayHumanToken(teamId: string, tokenEnc: string): Promise<SetRelayTokenResult> {
        const id = v.parse(v.Id, teamId, "teamId")
        const sealed = v.parse(v.Sealed, tokenEnc, "tokenEnc")
        if (!this.profile) return { ok: false, reason: "unknown_user" }
        if (!this.teamIds.includes(id)) return { ok: false, reason: "not_in_team" }
        this.relayHumanTokens = { ...this.relayHumanTokens, [id]: sealed }
        this.updatedAt = Date.now()
        return { ok: true }
    }

    /** Freestyle identity used to mint this user's private terminal tokens (architecture 8.4). */
    @Atomic
    async setFreestyleIdentity(identityId: string): Promise<UserWriteResult> {
        const id = v.parse(v.Id, identityId, "identityId")
        if (!this.profile) return { ok: false, reason: "unknown_user" }
        this.freestyleIdentityId = id
        this.updatedAt = Date.now()
        return { ok: true }
    }

    async onConnect(socket: Socket): Promise<void> {
        socket.reject(4003, "not available")
    }
}

// ============================================================================
// Team (id `t-<random>`). Emits a secret-free projection.
// ============================================================================

export class Team extends Actor<SocketMetadata, SocketIncoming, SocketOutgoing> {
    @Persisted @Emittable view: TeamProjection | null = null

    @Persisted private info: TeamState["info"] = null
    @Persisted private members: Record<string, Member> = {}
    @Persisted private invites: Record<string, Invite> = {}
    /** userId -> when they were removed or left. Blocks invites made before then (see blockedByRemoval). */
    @Persisted private removed: Record<string, number> = {}
    @Persisted private projects: Record<string, Project> = {}
    @Persisted private environments: Record<string, Environment> = {}
    @Persisted private relay: RelayState | null = null
    @Persisted private policy: TeamPolicy = { ...DEFAULT_POLICY }
    @Persisted private processed: Ledger = []

    @Atomic
    async create(input: CreateTeamInput, key: string): Promise<CreateTeamResult> {
        const args = v.parse(v.CreateTeamInput, input, "input")
        const k = v.parse(v.Key, key, "key")
        if (!/^t-[A-Za-z0-9._-]+$/.test(this.id)) throw new Error("invalid_argument: team ids start with t-")
        const ledgerKey = `create:${k}`
        const fp = fingerprint(args)
        const prior = ledgerLookup(this.processed, ledgerKey)
        if (prior) {
            if (prior.fp !== fp) throw new Error("idempotency_key_reused")
            return prior.result as CreateTeamResult
        }
        let result: CreateTeamResult = { ok: false, reason: "already_exists" }
        if (!this.info) {
            const now = Date.now()
            this.info = { name: args.name, slug: args.slug, createdBy: args.owner.userId, createdAt: now }
            this.members = { [args.owner.userId]: { ...args.owner, role: "owner", joinedAt: now } }
            result = { ok: true }
        }
        this.processed = ledgerRecord(this.processed, { key: ledgerKey, fp, result })
        this.#refreshView()
        return result
    }

    async getView(): Promise<TeamProjection | null> {
        return this.view
    }

    async getMember(userId: string): Promise<MemberLookup> {
        const id = v.parse(v.Id, userId, "userId")
        const member = this.members[id]
        return member ? { userId: member.userId, role: member.role } : null
    }

    /** Renames the team. The slug stays: it was minted once at creation and other names may derive from it. */
    @Atomic
    async rename(name: string): Promise<TeamWriteResult> {
        const next = v.parse(v.TeamName, name, "name")
        if (!this.info) return { ok: false, reason: "no_team" }
        if (this.info.name !== next) this.info = { ...this.info, name: next }
        this.#refreshView()
        return { ok: true }
    }

    /**
     * Makes a member an admin or a plain member. Setting the role a member already has is a no-op. The owner's
     * role never changes here (there is no ownership transfer); who may call this is the backend's decision.
     */
    @Atomic
    async setMemberRole(userId: string, role: AssignableRole): Promise<SetMemberRoleResult> {
        const id = v.parse(v.Id, userId, "userId")
        const next = v.parse(v.AssignableRole, role, "role")
        if (!this.info) return { ok: false, reason: "no_team" }
        const member = this.members[id]
        if (!member) return { ok: false, reason: "not_a_member" }
        if (member.role === "owner") return { ok: false, reason: "owner_role_fixed" }
        if (member.role === next) return { ok: true, role: next, changed: false }
        this.members = { ...this.members, [id]: { ...member, role: next } }
        this.#refreshView()
        return { ok: true, role: next, changed: true }
    }

    /** Refreshes a member's display fields (login, name, avatar) from their latest GitHub profile. */
    @Atomic
    async updateMemberProfile(identity: MemberIdentity): Promise<MemberWriteResult> {
        const args = v.parse(v.MemberIdentity, identity, "identity")
        if (!this.info) return { ok: false, reason: "no_team" }
        const member = this.members[args.userId]
        if (!member) return { ok: false, reason: "not_a_member" }
        const next = { ...member, login: args.login, name: args.name, avatarUrl: args.avatarUrl }
        if (!sameJson(next, member)) this.members = { ...this.members, [args.userId]: next }
        this.#refreshView()
        return { ok: true }
    }

    @Atomic
    async removeMember(userId: string): Promise<RemoveMemberResult> {
        const id = v.parse(v.Id, userId, "userId")
        const member = this.members[id]
        if (!member) return { ok: true, removed: false }
        if (member.role === "owner" && ownerCount(this.members) <= 1) return { ok: false, reason: "last_owner" }
        const { [id]: _removed, ...rest } = this.members
        this.members = rest
        const now = Date.now()
        this.removed = { ...pruneRemoved(this.removed, now, MAX_INVITE_LIFETIME_MS), [id]: now }
        this.#refreshView()
        return { ok: true, removed: true }
    }

    @Atomic
    async createInvite(input: CreateInviteInput): Promise<CreateInviteResult> {
        const args = v.parse(v.CreateInviteInput, input, "input")
        const now = Date.now()
        if (args.expiresAt <= now || args.expiresAt > now + MAX_INVITE_LIFETIME_MS)
            throw new Error("invalid_argument: expiresAt: out of range")
        if (!this.info) return { ok: false, reason: "no_team" }
        if (!this.members[args.createdBy]) return { ok: false, reason: "not_a_member" }
        const invites = pruneExpiredInvites(this.invites, now)
        if (invites !== this.invites) this.invites = invites
        if (invites[args.hash] || Object.values(invites).some(invite => invite.id === args.id)) return { ok: false, reason: "invite_exists" }
        if (Object.keys(invites).length >= TEAM_LIMITS.invites) return { ok: false, reason: "too_many_invites" }
        this.invites = { ...invites, [args.hash]: { id: args.id, createdBy: args.createdBy, expiresAt: args.expiresAt, uses: 0, maxUses: args.maxUses, createdAt: now } }
        return { ok: true }
    }

    /**
     * Joins the team with an invite. `hash` is the SHA-256 of a 32-byte random code, so looking it up by key leaks
     * nothing an attacker can use. Re-accepting as an existing member is a no-op that does not consume a use.
     * Someone who was removed (or left) cannot come back with an invite made before that; an invite made after
     * it is an owner or admin choosing to let them back, and clears the block.
     */
    @Atomic
    async acceptInvite(hash: string, identity: MemberIdentity): Promise<AcceptInviteResult> {
        const inviteHash = v.parse(v.InviteHash, hash, "hash")
        const member = v.parse(v.MemberIdentity, identity, "identity")
        if (!this.info) return { ok: false, reason: "no_team" }
        const existing = this.members[member.userId]
        if (existing) return { ok: true, role: existing.role, alreadyMember: true }
        const invite = this.invites[inviteHash]
        const now = Date.now()
        if (!invite || blockedByRemoval(this.removed, member.userId, invite)) return { ok: false, reason: "invalid_invite" }
        if (invite.expiresAt <= now) return { ok: false, reason: "expired" }
        if (invite.uses >= invite.maxUses) return { ok: false, reason: "exhausted" }
        if (Object.keys(this.members).length >= TEAM_LIMITS.members) return { ok: false, reason: "too_many_members" }
        this.invites = { ...this.invites, [inviteHash]: { ...invite, uses: invite.uses + 1 } }
        this.members = { ...this.members, [member.userId]: { ...member, role: "member", joinedAt: now } }
        if (this.removed[member.userId] !== undefined) {
            const { [member.userId]: _cleared, ...rest } = this.removed
            this.removed = rest
        }
        this.#refreshView()
        return { ok: true, role: "member", alreadyMember: false }
    }

    /**
     * What the join page shows `userId` before Accept. Same keyed lookup as `acceptInvite` (the key is a SHA-256 of
     * the secret code), and one null for every way the invite is unusable for them. Read only: nothing is consumed.
     */
    async getInviteByHash(hash: string, userId: string): Promise<InvitePreview> {
        const inviteHash = v.parse(v.InviteHash, hash, "hash")
        const viewer = v.parse(v.Id, userId, "userId")
        const invite = this.info ? this.invites[inviteHash] : undefined
        if (!this.info || !invite || invite.expiresAt <= Date.now() || invite.uses >= invite.maxUses) return null
        if (blockedByRemoval(this.removed, viewer, invite)) return null
        const creator = this.members[invite.createdBy]
        return {
            teamName: this.info.name,
            expiresAt: invite.expiresAt,
            createdBy: invite.createdBy,
            inviter: creator ? { login: creator.login, avatarUrl: creator.avatarUrl } : null
        }
    }

    /** Active invites (not expired, not used up), newest first. Never the hash. */
    async listInvites(): Promise<InviteView[]> {
        return this.info ? inviteViews(this.invites, Date.now()) : []
    }

    /** Revokes by the invite's public id. Revoking one that is already gone is a no-op (`revoked: false`). */
    @Atomic
    async revokeInvite(inviteId: string): Promise<RevokeInviteResult> {
        const id = v.parse(v.Id, inviteId, "inviteId")
        if (!this.info) return { ok: false, reason: "no_team" }
        const entry = Object.entries(this.invites).find(([, invite]) => invite.id === id)
        if (!entry) return { ok: true, revoked: false }
        const { [entry[0]]: _revoked, ...rest } = this.invites
        this.invites = rest
        return { ok: true, revoked: true }
    }

    @Atomic
    async linkProject(input: LinkProjectInput): Promise<LinkProjectResult> {
        const args = v.parse(v.LinkProjectInput, input, "input")
        if (!this.info) return { ok: false, reason: "no_team" }
        if (!this.members[args.createdBy]) return { ok: false, reason: "not_a_member" }
        const sameRepo = Object.values(this.projects).find(project => project.repoFullName.toLowerCase() === args.repoFullName.toLowerCase())
        if (sameRepo) return sameRepo.id === args.id || !this.projects[args.id] ? { ok: true, projectId: sameRepo.id, created: false } : { ok: false, reason: "project_exists" }
        if (this.projects[args.id]) return { ok: false, reason: "project_exists" }
        if (Object.keys(this.projects).length >= TEAM_LIMITS.projects) return { ok: false, reason: "too_many_projects" }
        this.projects = { ...this.projects, [args.id]: { ...args, createdAt: Date.now() } }
        this.#refreshView()
        return { ok: true, projectId: args.id, created: true }
    }

    @Atomic
    async unlinkProject(projectId: string): Promise<TeamWriteResult> {
        const id = v.parse(v.Id, projectId, "projectId")
        if (!this.info) return { ok: false, reason: "no_team" }
        if (this.projects[id]) {
            const { [id]: _unlinked, ...rest } = this.projects
            this.projects = rest
            this.#refreshView()
        }
        return { ok: true }
    }

    /** Sets or clears (null) a project's test command. Setting the command it already has is a no-op. */
    @Atomic
    async setProjectTestCommand(projectId: string, testCommand: string | null): Promise<SetProjectTestCommandResult> {
        const id = v.parse(v.Id, projectId, "projectId")
        const command = v.parse(v.TestCommand.nullable(), testCommand, "testCommand")
        if (!this.info) return { ok: false, reason: "no_team" }
        const project = this.projects[id]
        if (!project) return { ok: false, reason: "unknown_project" }
        const changed = project.testCommand !== command
        const next = changed ? { ...project, testCommand: command } : project
        if (changed) {
            this.projects = { ...this.projects, [id]: next }
            this.#refreshView()
        }
        return {
            ok: true,
            project: { id, repoFullName: next.repoFullName, defaultBranch: next.defaultBranch, testCommand: next.testCommand },
            changed
        }
    }

    async getProject(projectId: string): Promise<Project | null> {
        return this.projects[v.parse(v.Id, projectId, "projectId")] ?? null
    }

    @Atomic
    async createEnvironment(input: CreateEnvironmentInput): Promise<CreateEnvironmentResult> {
        const args = v.parse(v.CreateEnvironmentInput, input, "input")
        if (!this.info) return { ok: false, reason: "no_team" }
        if (!this.members[args.ownerUserId]) return { ok: false, reason: "not_a_member" }
        const existing = this.environments[args.id]
        if (existing) return existing.ownerUserId === args.ownerUserId ? { ok: true, created: false } : { ok: false, reason: "environment_exists" }
        const live = Object.values(this.environments).filter(env => env.phase !== "disconnected")
        if (live.length >= TEAM_LIMITS.environments || live.filter(env => env.ownerUserId === args.ownerUserId).length >= TEAM_LIMITS.environmentsPerOwner)
            return { ok: false, reason: "too_many_environments" }
        const now = Date.now()
        this.environments = {
            ...this.environments,
            [args.id]: {
                id: args.id,
                ownerUserId: args.ownerUserId,
                name: args.name,
                freestyleVmId: null,
                freestyleIdentityId: null,
                linuxUser: null,
                nodeName: null,
                phase: "provisioning",
                vmState: "unknown",
                nodeOnline: false,
                lastError: null,
                createdAt: now,
                updatedAt: now
            }
        }
        this.#refreshView()
        return { ok: true, created: true }
    }

    @Atomic
    async updateEnvironment(envId: string, patch: EnvironmentPatch): Promise<UpdateEnvironmentResult> {
        const id = v.parse(v.Id, envId, "envId")
        const args = v.parse(v.EnvironmentPatch, patch, "patch")
        const env = this.environments[id]
        if (!env) return { ok: false, reason: "unknown_environment" }
        const next = applyEnvironmentPatch(env, args, Date.now())
        if (!next) return { ok: false, reason: "environment_disconnected" }
        const { updatedAt: _a, ...nextComparable } = next
        const { updatedAt: _b, ...envComparable } = env
        if (!sameJson(nextComparable, envComparable)) {
            this.environments = { ...this.environments, [id]: next }
            this.#refreshView()
            return { ok: true, environment: next }
        }
        return { ok: true, environment: env }
    }

    @Atomic
    async removeEnvironment(envId: string): Promise<TeamWriteResult> {
        const id = v.parse(v.Id, envId, "envId")
        if (!this.info) return { ok: false, reason: "no_team" }
        if (this.environments[id]) {
            const { [id]: _removed, ...rest } = this.environments
            this.environments = rest
            this.#refreshView()
        }
        return { ok: true }
    }

    async getEnvironment(envId: string): Promise<Environment | null> {
        return this.environments[v.parse(v.Id, envId, "envId")] ?? null
    }

    async getEnvironments(): Promise<Environment[]> {
        return Object.values(this.environments).sort((a, b) => a.createdAt - b.createdAt)
    }

    @Atomic
    async setRelay(config: RelayConfig): Promise<TeamWriteResult> {
        const args = v.parse(v.RelayConfig, config, "config")
        if (!this.info) return { ok: false, reason: "no_team" }
        const cursor = this.relay && this.relay.workspaceId === args.workspaceId ? this.relay.cursor : null
        this.relay = { ...args, cursor }
        this.#refreshView()
        return { ok: true }
    }

    @Atomic
    async setRelayCursor(cursor: string): Promise<RelayWriteResult> {
        const value = v.parse(v.RelayCursor, cursor, "cursor")
        if (!this.relay) return { ok: false, reason: "relay_not_configured" }
        if (this.relay.cursor !== value) this.relay = { ...this.relay, cursor: value }
        return { ok: true }
    }

    /** Backend-only: includes the encrypted Relay credentials. */
    async getRelay(): Promise<RelayState | null> {
        return this.relay
    }

    /** Merges `patch` onto the current policy, so two admins changing different settings never undo each other. */
    @Atomic
    async setPolicy(patch: Partial<TeamPolicy>): Promise<TeamWriteResult> {
        const args = v.parse(v.TeamPolicyPatch, patch, "policy")
        if (!this.info) return { ok: false, reason: "no_team" }
        const next: TeamPolicy = {
            allowInspect: args.allowInspect ?? this.policy.allowInspect,
            maxParallelPerTask: args.maxParallelPerTask ?? this.policy.maxParallelPerTask
        }
        if (!sameJson(next, this.policy)) this.policy = next
        this.#refreshView()
        return { ok: true }
    }

    async onConnect(socket: Socket): Promise<void> {
        if (admit(socket)) this.setWebSocketAutoResponse(KEEPALIVE)
    }

    #refreshView(): void {
        const next = buildTeamView(this.id, {
            info: this.info,
            members: this.members,
            projects: this.projects,
            environments: this.environments,
            relay: this.relay,
            policy: this.policy
        })
        if (!sameJson(next, this.view)) this.view = next
    }
}

// ============================================================================
// TeamWorkforce (id = teamId). Lease authority and task state machine.
// ============================================================================

type Idempotency = { method: string; key: string; fp: string | null }

export class TeamWorkforce extends Actor<SocketMetadata, SocketIncoming, SocketOutgoing> {
    // Emitted in parts, so a change to one part does not resend the others. The backend composes
    // `{ profiles, tasks, leases }` (backend/src/actors/workforceState.ts). Never the ledger, the outbox or anything secret.
    @Persisted @Emittable profilesView: WorkforceView["profiles"] = {}
    @Persisted @Emittable tasksView: WorkforceView["tasks"] = {}
    @Persisted @Emittable leasesView: WorkforceView["leases"] = {}
    /** Lets the backend claim when an item is due instead of polling claimOutbox (lib/outbox-summary.ts). */
    @Persisted @Emittable outboxSummary: OutboxSummary = EMPTY_OUTBOX_SUMMARY

    /** Monotonic fencing generation. Never decremented, never reused. */
    @Persisted private epoch = 0
    /** Per task, the trace entry workers have been told about (architecture 9.8). Backend-only. */
    @Persisted private notified: Record<string, number> = {}
    /** 0 for an actor written before schema 2 (no stored value), SCHEMA_VERSION after `#upgrade`. Must default to 0. */
    @Persisted private schemaVersion = 0

    // Schema 1 kept every record in these fields, and the runtime rewrites a changed field whole, so every call
    // rewrote whole maps. `#upgrade` copies them into SQLite once and a later call empties them (`#dropLegacy`). They
    // stay declared so stored schema 1 data can still be read.
    @Persisted private view: WorkforceView | null = null
    @Persisted private profiles: Record<string, CliProfile> = {}
    @Persisted private tasks: Record<string, Task> = {}
    @Persisted private leases: Record<string, Lease> = {}
    @Persisted private outbox: Record<string, OutboxItem> = {}
    @Persisted private processed: Ledger = []

    /** Records and the idempotency ledger in this actor's SQLite (lib/store.ts). */
    @Ephemeral #store = new WorkforceStore(this.db)
    /** The records, loaded on first use. A failed call rebuilds the instance, so this never outlives a rollback. */
    @Ephemeral #records: StoredRecords | null = null

    // ---------- profiles ----------

    @Atomic
    async registerProfile(input: RegisterProfileInput): Promise<RegisterProfileResult> {
        const args = v.parse(v.RegisterProfileInput, input, "input")
        return this.#transition(null, d => wf.registerProfile(d, args))
    }

    @Atomic
    async updateProfileHealth(profileId: string, health: ProfileHealth, eventId: string): Promise<UpdateHealthResult> {
        const id = v.parse(v.Id, profileId, "profileId")
        const args = v.parse(v.ProfileHealth, health, "health")
        const key = v.parse(v.Key, eventId, "eventId")
        return this.#transition({ method: "updateProfileHealth", key, fp: null }, d => wf.updateProfileHealth(d, id, args))
    }

    /**
     * The latest subscription usage reading for a profile (percent of its 5-hour and weekly windows). No ledger
     * entry: a reading is idempotent by `observedAt`, and frequent readings must not push real keys out.
     */
    @Atomic
    async recordProfileUsage(profileId: string, usage: ProfileUsage): Promise<RecordUsageResult> {
        const id = v.parse(v.Id, profileId, "profileId")
        const args = v.parse(v.ProfileUsage, usage, "usage")
        if (args.observedAt > Date.now() + v.MAX_CLOCK_SKEW_MS) throw new Error("invalid_argument: usage.observedAt: in the future")
        if (args.windows.some(w => w.resetsAt !== null && w.resetsAt > args.observedAt + wf.WORKFORCE_TIMING.maxUsageResetMs))
            throw new Error("invalid_argument: usage.windows.resetsAt: too far in the future")
        return this.#transition(null, d => wf.recordProfileUsage(d, id, args))
    }

    /** Removing a profile with live leases expires them (their workstreams go to handoff) instead of refusing. */
    @Atomic
    async removeProfile(profileId: string): Promise<RemoveProfileResult> {
        const id = v.parse(v.Id, profileId, "profileId")
        return this.#transition(null, d => wf.removeProfile(d, id))
    }

    @Atomic
    async markProfileLimited(profileId: string, until: number, reason: string, source: LimitSource, eventId: string): Promise<MarkLimitedResult> {
        const id = v.parse(v.Id, profileId, "profileId")
        const deadline = v.parse(v.EpochMs, until, "until")
        const why = v.parse(v.Reason, reason, "reason")
        const from = v.parse(v.LimitSource, source, "source")
        const key = v.parse(v.Key, eventId, "eventId")
        if (deadline > Date.now() + wf.WORKFORCE_TIMING.maxCooldownMs) throw new Error("invalid_argument: until: too far in the future")
        return this.#transition({ method: "markProfileLimited", key, fp: null }, d => wf.markProfileLimited(d, id, deadline, why, from))
    }

    // ---------- tasks ----------

    @Atomic
    async createTask(input: CreateTaskInput, key: string): Promise<CreateTaskResult> {
        const args = v.parse(v.CreateTaskInput, input, "input")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "createTask", key: k, fp: fingerprint(args) }, d => wf.createTask(d, args))
    }

    /** A task's mode and pins, before any worker was placed (a re-plan, or Start with the composer's choice). */
    @Atomic
    async setTaskWorkforce(taskId: string, mode: WorkforceMode, pins: string[], key: string): Promise<SetTaskWorkforceResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const m = v.parse(v.WorkforceMode, mode, "mode")
        const p = v.parse(v.Pins, pins, "pins")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "setTaskWorkforce", key: k, fp: fingerprint([id, m, p]) }, d => wf.setTaskWorkforce(d, id, m, p))
    }

    /**
     * A plain-language trace note that a workstream waits, written by the actor from `reason`. No ledger entry: a
     * repeat of the latest note is a no-op, and the scheduler asks on every pass while the wait lasts.
     */
    @Atomic
    async noteWaiting(taskId: string, workstreamId: string, reason: WaitingReason): Promise<NoteWaitingResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const ws = v.parse(v.Id, workstreamId, "workstreamId")
        const why = v.parse(v.WaitingReason, reason, "reason")
        return this.#transition(null, d => wf.noteWaiting(d, id, ws, why))
    }

    /** Marks a task as planning; with a profile, holds one of its slots so the planner call cannot oversubscribe it. */
    @Atomic
    async beginPlanning(taskId: string, profileId: string | null, key: string): Promise<BeginPlanningResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const profile = v.parse(v.Id.nullable(), profileId, "profileId")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "beginPlanning", key: k, fp: fingerprint([id, profile]) }, d => wf.beginPlanning(d, id, profile))
    }

    @Atomic
    async recordPlan(taskId: string, plan: PlanInput, key: string): Promise<RecordPlanResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const args = v.parse(v.PlanInput, plan, "plan")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "recordPlan", key: k, fp: fingerprint([id, args]) }, d => wf.recordPlan(d, id, args))
    }

    @Atomic
    async reserveWorkers(taskId: string, picks: ReservePick[], key: string): Promise<ReserveResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const args = v.parse(v.ReservePicks, picks, "picks")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "reserveWorkers", key: k, fp: fingerprint([id, args]) }, d => wf.reserveWorkers(d, id, args))
    }

    /**
     * A person adds a worker to a running task with their message as its brief. A retry with the same key returns
     * the first result. The cap is left out of the fingerprint: a policy change between retries is not a new request.
     */
    @Atomic
    async addWorkstream(taskId: string, input: AddWorkstreamInput, key: string): Promise<AddWorkstreamResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const args = v.parse(v.AddWorkstreamInput, input, "input")
        const k = v.parse(v.Key, key, "key")
        const fp = fingerprint([id, args.profileIds, args.title, args.brief, args.byUserId])
        return this.#transition({ method: "addWorkstream", key: k, fp }, d => wf.addWorkstream(d, id, args))
    }

    @Atomic
    async requestHandoff(taskId: string, workstreamId: string, fromEpoch: number, toProfileId: string, key: string): Promise<RequestHandoffResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const ws = v.parse(v.Id, workstreamId, "workstreamId")
        const epoch = v.parse(v.Epoch, fromEpoch, "fromEpoch")
        const profile = v.parse(v.Id, toProfileId, "toProfileId")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "requestHandoff", key: k, fp: fingerprint([id, ws, epoch, profile]) }, d =>
            wf.requestHandoff(d, id, ws, epoch, profile)
        )
    }

    @Atomic
    async cancelTask(taskId: string, byUserId: string, key: string): Promise<CancelTaskResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const by = v.parse(v.Id, byUserId, "byUserId")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "cancelTask", key: k, fp: fingerprint([id, by]) }, d => wf.cancelTask(d, id, by))
    }

    /** Cancels the task if it has not ended, then removes it, its ended leases and its finished outbox items. */
    @Atomic
    async deleteTask(taskId: string, byUserId: string, key: string): Promise<DeleteTaskResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const by = v.parse(v.Id, byUserId, "byUserId")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "deleteTask", key: k, fp: fingerprint([id, by]) }, d => wf.deleteTask(d, id, by))
    }

    /** A compare task: ship one finished attempt and stop the rest, or (null) finish without shipping. */
    @Atomic
    async pickAttempt(taskId: string, workstreamId: string | null, byUserId: string, key: string): Promise<PickAttemptResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const ws = v.parse(v.Id.nullable(), workstreamId, "workstreamId")
        const by = v.parse(v.Id, byUserId, "byUserId")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "pickAttempt", key: k, fp: fingerprint([id, ws, by]) }, d => wf.pickAttempt(d, id, ws, by))
    }

    /** failed -> verifying (every workstream done) or back to the started states with unfinished workstreams pending. */
    @Atomic
    async retryTask(taskId: string, byUserId: string, key: string): Promise<RetryTaskResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const by = v.parse(v.Id, byUserId, "byUserId")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "retryTask", key: k, fp: fingerprint([id, by]) }, d => wf.retryTask(d, id, by))
    }

    @Atomic
    async submitVerification(taskId: string, evidence: VerificationView, key: string): Promise<SubmitVerificationResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const args = v.parse(v.VerificationInput, evidence, "evidence")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "submitVerification", key: k, fp: fingerprint([id, args]) }, d => wf.submitVerification(d, id, args))
    }

    /** A merge conflict during verification: verifying -> resolving (a resolver waits for a worker), or failed after the last attempt. */
    @Atomic
    async resolveConflict(taskId: string, evidence: VerificationView, conflict: ConflictInput, key: string): Promise<ResolveConflictResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const args = v.parse(v.VerificationInput, evidence, "evidence")
        const c = v.parse(v.ConflictInput, conflict, "conflict")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "resolveConflict", key: k, fp: fingerprint([id, args, c]) }, d => wf.resolveConflict(d, id, args, c))
    }

    // ---------- fenced worker reports: accepted only from the workstream's current lease epoch ----------

    @Atomic
    /** `detail`: why the backend ended it, one line (optional: older callers send five arguments). */
    async recordSpawnStatus(
        leaseId: string,
        epoch: number,
        status: SpawnStatus,
        invocationId: string | null,
        eventId: string,
        detail?: string | null
    ): Promise<FencedResult> {
        const id = v.parse(v.Id, leaseId, "leaseId")
        const e = v.parse(v.Epoch, epoch, "epoch")
        const s = v.parse(v.SpawnStatus, status, "status")
        const invocation = v.parse(v.line(1, 200).nullable(), invocationId, "invocationId")
        const key = v.parse(v.Key, eventId, "eventId")
        const why = v.parse(v.line(1, 120).nullable(), detail ?? null, "detail")
        return this.#transition({ method: "recordSpawnStatus", key, fp: null }, d => wf.recordSpawnStatus(d, id, e, s, invocation, why))
    }

    @Atomic
    async reportCheckpoint(leaseId: string, epoch: number, sha: string, summary: string, eventId: string): Promise<FencedResult> {
        const id = v.parse(v.Id, leaseId, "leaseId")
        const e = v.parse(v.Epoch, epoch, "epoch")
        const commit = v.parse(v.Sha, sha, "sha")
        const text = v.parse(v.Summary, summary, "summary")
        const key = v.parse(v.Key, eventId, "eventId")
        return this.#transition({ method: "reportCheckpoint", key, fp: null }, d => wf.reportCheckpoint(d, id, e, commit, text))
    }

    @Atomic
    async completeWorkstream(leaseId: string, epoch: number, sha: string, summary: string, eventId: string): Promise<FencedResult> {
        const id = v.parse(v.Id, leaseId, "leaseId")
        const e = v.parse(v.Epoch, epoch, "epoch")
        const commit = v.parse(v.Sha, sha, "sha")
        const text = v.parse(v.Summary, summary, "summary")
        const key = v.parse(v.Key, eventId, "eventId")
        return this.#transition({ method: "completeWorkstream", key, fp: null }, d => wf.completeWorkstream(d, id, e, commit, text))
    }

    @Atomic
    async ackHandoff(leaseId: string, epoch: number, eventId: string): Promise<FencedResult> {
        const id = v.parse(v.Id, leaseId, "leaseId")
        const e = v.parse(v.Epoch, epoch, "epoch")
        const key = v.parse(v.Key, eventId, "eventId")
        return this.#transition({ method: "ackHandoff", key, fp: null }, d => wf.ackHandoff(d, id, e))
    }

    /**
     * A worker's interface contract (`CONTRACT <leaseId> <summary>`, read by the backend from the task thread), fenced
     * like a checkpoint. Keyed by the Relay message, so a replayed message is answered from the ledger.
     */
    @Atomic
    async recordContract(leaseId: string, epoch: number, summary: string, messageId: string, eventId: string): Promise<FencedResult> {
        const id = v.parse(v.Id, leaseId, "leaseId")
        const e = v.parse(v.Epoch, epoch, "epoch")
        const text = v.parse(v.ContractSummary, summary, "summary")
        const message = v.parse(v.MessageId, messageId, "messageId")
        const key = v.parse(v.Key, eventId, "eventId")
        return this.#transition({ method: "recordContract", key, fp: null }, d => wf.recordContract(d, id, e, text, message))
    }

    // ---------- task thread (architecture 9.8) ----------

    /** The task thread's root (its kickoff post). First write wins; no ledger entry, a repeat is a no-op. */
    @Atomic
    async setTaskThread(taskId: string, messageId: string): Promise<SetTaskThreadResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const message = v.parse(v.MessageId, messageId, "messageId")
        return this.#transition(null, d => wf.setTaskThread(d, id, message))
    }

    // ---------- subagents (docs/subagents.md) ----------

    /** Idempotent on (parentLeaseId, clientRequestId) through the task's subagent records, so a retry sees the current status. */
    @Atomic
    async delegate(input: DelegateInput): Promise<DelegateResult> {
        const args = v.parse(v.DelegateInput, input, "input")
        return this.#transition(null, d => wf.delegate(d, args))
    }

    /** A subagent's own result, fenced by its lease and epoch. Records once and releases the subagent. */
    @Atomic
    async recordSubagentResult(leaseId: string, epoch: number, status: SubagentResultStatus, summary: string, eventId: string): Promise<SubagentResultResult> {
        const id = v.parse(v.Id, leaseId, "leaseId")
        const e = v.parse(v.Epoch, epoch, "epoch")
        const s = v.parse(v.SubagentResultStatus, status, "status")
        const text = v.parse(v.SubagentSummary, summary, "summary")
        const key = v.parse(v.Key, eventId, "eventId")
        return this.#transition({ method: "recordSubagentResult", key, fp: null }, d => wf.recordSubagentResult(d, id, e, s, text))
    }

    @Atomic
    async cancelSubagent(parentLeaseId: string, childLeaseId: string, reason: string | null): Promise<CancelSubagentResult> {
        const parent = v.parse(v.Id, parentLeaseId, "parentLeaseId")
        const child = v.parse(v.Id, childLeaseId, "childLeaseId")
        const why = v.parse(v.line(1, 300).nullable(), reason, "reason")
        return this.#transition(null, d => wf.cancelSubagent(d, parent, child, why))
    }

    // ---------- outbox ----------

    /** Returns due items and hides them for the visibility timeout; a crashed dispatcher's items come back after it. */
    @Atomic
    async claimOutbox(now: number, limit: number): Promise<OutboxClaim[]> {
        const at = v.parse(v.EpochMs, now, "now")
        const max = v.parse(v.OutboxLimit, limit, "limit")
        v.assertClock(at)
        return this.#transition(null, d => wf.claimOutbox(d, max), at)
    }

    @Atomic
    async completeOutbox(id: string, result: OutboxResult, key: string): Promise<CompleteOutboxResult> {
        const itemId = v.parse(v.Id, id, "id")
        const args = v.parse(v.OutboxResult, result, "result")
        const k = v.parse(v.Key, key, "key")
        return this.#transition({ method: "completeOutbox", key: k, fp: fingerprint([itemId, args]) }, d => wf.completeOutbox(d, itemId, args))
    }

    // ---------- worker updates ----------

    /**
     * Records that workers were told about `taskId`'s trace through entry `through`. Monotonic and capped, so a
     * replay is a no-op without a ledger entry (frequent marks must not push real keys out).
     */
    @Atomic
    async markNotified(taskId: string, through: number): Promise<MarkNotifiedResult> {
        const id = v.parse(v.Id, taskId, "taskId")
        const at = v.parse(v.TraceNumber, through, "through")
        const { notified, result } = wf.markNotified(this.notified, this.#state().tasks, id, at)
        if (!sameJson(notified, this.notified)) this.notified = notified
        return result
    }

    /** Every task's watermark. A task without one has never been marked. */
    async getNotified(): Promise<Record<string, number>> {
        this.#state()
        return this.notified
    }

    // ---------- time ----------

    /** Restores due cooldowns, fails leases that never started, re-arms the alarm. A no-op when nothing is due. */
    @Atomic
    async reconcile(now: number): Promise<ReconcileResult> {
        const at = v.parse(v.EpochMs, now, "now")
        v.assertClock(at)
        const { swept, deadline } = this.#run(at, () => undefined, null, { rebuildView: true, forceAlarm: false })
        return { restoredProfileIds: swept.restored, expiredLeaseIds: swept.expired, nextAlarmAt: deadline }
    }

    @Atomic
    async onAlarm(): Promise<void> {
        // The runtime clears the alarm after this callback unless it is set again, so always re-arm.
        this.#run(Date.now(), () => undefined, null, { rebuildView: true, forceAlarm: true })
    }

    // ---------- reads ----------

    async getView(): Promise<WorkforceView> {
        this.#state()
        return { profiles: this.profilesView, tasks: this.tasksView, leases: this.leasesView }
    }

    /** Full task (every stored trace entry, full workstreams), including finished tasks that dropped out of the view. */
    async getTask(taskId: string): Promise<TaskRecord | null> {
        const task = this.#state().tasks[v.parse(v.Id, taskId, "taskId")]
        return task ? wf.taskRecord(task) : null
    }

    async getLease(leaseId: string): Promise<Lease | null> {
        return this.#state().leases[v.parse(v.Id, leaseId, "leaseId")] ?? null
    }

    /**
     * The subagents of a lease that may still be writing to its tree: live, or ended with their stop still pending.
     * A DONE is only checkpointed once this is empty (docs/subagents.md).
     */
    async stoppingSubagents(parentLeaseId: string): Promise<string[]> {
        const state = this.#state()
        return wf.stoppingChildren(state.leases, state.outbox, v.parse(v.Id, parentLeaseId, "parentLeaseId"))
    }

    async getProfile(profileId: string): Promise<CliProfile | null> {
        return this.#state().profiles[v.parse(v.Id, profileId, "profileId")] ?? null
    }

    /** Backend-only diagnostics. */
    async getInternals(): Promise<WorkforceInternals> {
        const state = this.#state()
        return {
            epoch: this.epoch,
            alarmAt: this.alarm.get(),
            ledgerSize: this.#store.ledgerSize(),
            outbox: Object.values(state.outbox).sort((a, b) => a.seq - b.seq)
        }
    }

    // ---------- sockets ----------

    /** The first contact after a deploy may be a socket: upgrade first, so the snapshot is never the empty defaults. */
    @Atomic
    async onConnect(socket: Socket): Promise<void> {
        if (!admit(socket)) return
        this.#state()
        this.setWebSocketAutoResponse(KEEPALIVE)
    }

    // ---------- internals ----------

    /** The records (loaded once per instance), after running the storage upgrade if this actor still has schema 1. */
    #state(): StoredRecords {
        if (this.#records) return this.#records
        if (this.schemaVersion < SCHEMA_VERSION) this.#upgrade()
        else if (this.view !== null) this.#dropLegacy()
        this.#records = this.#store.load()
        return this.#records
    }

    /** Schema 1 to 2. Repeatable: SQLite is rewritten from the legacy fields until `schemaVersion` is stored. */
    #upgrade(): void {
        const records: StoredRecords = { profiles: this.profiles, tasks: this.tasks, leases: this.leases, outbox: this.outbox }
        this.#store.replaceAll(records)
        this.#store.replaceLedger(this.processed)
        this.#emit({ ...records, epoch: this.epoch })
        this.schemaVersion = SCHEMA_VERSION
    }

    /** Empties the schema 1 fields, in a later call than the upgrade, so a partly stored upgrade can never lose them. */
    #dropLegacy(): void {
        this.view = null
        this.profiles = {}
        this.tasks = {}
        this.leases = {}
        this.outbox = {}
        this.processed = []
    }

    /** Emits the view parts and the outbox summary that changed. */
    #emit(state: wf.WorkforceState): void {
        const view = wf.buildWorkforceView(state)
        if (!sameJson(view.profiles, this.profilesView)) this.profilesView = view.profiles
        if (!sameJson(view.tasks, this.tasksView)) this.tasksView = view.tasks
        if (!sameJson(view.leases, this.leasesView)) this.leasesView = view.leases
        const summary = summarizeOutbox(state.outbox)
        if (!sameJson(summary, this.outboxSummary)) this.outboxSummary = summary
    }

    #transition<T>(idempotency: Idempotency | null, run: (d: wf.WorkforceDraft) => T, now = Date.now()): T {
        this.#state()
        let ledgerKey: string | null = null
        if (idempotency) {
            ledgerKey = `${idempotency.method}:${idempotency.key}`
            const prior = this.#store.ledgerGet(ledgerKey)
            if (prior) {
                if (idempotency.fp !== null && prior.fp !== idempotency.fp) throw new Error("idempotency_key_reused")
                return prior.result as T
            }
        }
        let result!: T
        this.#run(
            now,
            d => {
                result = run(d)
                return result
            },
            ledgerKey === null ? null : { key: ledgerKey, fp: idempotency?.fp ?? "", resultOf: () => result },
            { rebuildView: false, forceAlarm: false }
        )
        return result
    }

    /** Sweep, run, finalize, check invariants, write changed fields, then (last) arm the alarm. */
    #run(
        now: number,
        run: (d: wf.WorkforceDraft) => unknown,
        ledger: { key: string; fp: string; resultOf: () => unknown } | null,
        options: { rebuildView: boolean; forceAlarm: boolean }
    ): { swept: { restored: string[]; expired: string[] }; deadline: number | null } {
        const before = this.#state()
        const d = new wf.WorkforceDraft({ ...before, epoch: this.epoch }, now)
        const swept = wf.sweep(d)
        run(d)
        wf.finalize(d)
        const violations = wf.workforceInvariantViolations(d)
        if (violations.length > 0) throw new Error(`invariant_violation: ${violations[0]}`)

        const after: StoredRecords = { profiles: d.profiles, tasks: d.tasks, leases: d.leases, outbox: d.outbox }
        if (d.changed.size > 0) this.#store.write(before, after)
        if (d.changed.has("epoch")) this.epoch = d.epoch
        this.#records = after
        if (d.changed.size > 0 || options.rebuildView) this.#emit(d)
        if (ledger) this.#store.ledgerPut({ key: ledger.key, fp: ledger.fp, result: ledger.resultOf() })

        const deadline = wf.nextDeadline(d)
        const armed = this.alarm.get()
        if (deadline === null) {
            if (armed !== null) this.alarm.delete()
        } else if (options.forceAlarm || armed !== deadline) {
            this.alarm.set(deadline)
        }
        return { swept, deadline }
    }
}
