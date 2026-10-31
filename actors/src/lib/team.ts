// Team helpers: the secret-free projection and small pure rules.
import type { Environment, EnvironmentPatch, EnvironmentView, Invite, InviteView, Member, Project, RelayState, TeamPolicy, TeamProjection } from "./types.ts"

export const TEAM_LIMITS = {
    members: 200,
    invites: 100,
    projects: 50,
    environments: 100,
    environmentsPerOwner: 5
} as const

export const DEFAULT_POLICY: TeamPolicy = { allowInspect: true, maxParallelPerTask: 3 }

export type TeamState = {
    info: { name: string; slug: string; createdBy: string; createdAt: number } | null
    members: Record<string, Member>
    projects: Record<string, Project>
    environments: Record<string, Environment>
    relay: RelayState | null
    policy: TeamPolicy
}

export function environmentView(env: Environment): EnvironmentView {
    return {
        id: env.id,
        ownerUserId: env.ownerUserId,
        name: env.name,
        linuxUser: env.linuxUser,
        nodeName: env.nodeName,
        phase: env.phase,
        vmState: env.vmState,
        nodeOnline: env.nodeOnline,
        lastError: env.lastError,
        createdAt: env.createdAt
    }
}

/** Everything a member may see. Encrypted blobs, invites and Freestyle VM and identity ids never appear here. */
export function buildTeamView(teamId: string, state: TeamState): TeamProjection | null {
    if (!state.info) return null
    return {
        id: teamId,
        name: state.info.name,
        slug: state.info.slug,
        members: Object.values(state.members)
            .sort((a, b) => a.joinedAt - b.joinedAt || (a.userId < b.userId ? -1 : 1))
            .map(member => ({ userId: member.userId, login: member.login, name: member.name, avatarUrl: member.avatarUrl, role: member.role })),
        projects: Object.values(state.projects)
            .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
            .map(project => ({ id: project.id, repoFullName: project.repoFullName, defaultBranch: project.defaultBranch, testCommand: project.testCommand })),
        environments: Object.values(state.environments)
            .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
            .map(environmentView),
        policy: state.policy,
        relayReady: state.relay !== null
    }
}

export function pruneExpiredInvites(invites: Record<string, Invite>, now: number): Record<string, Invite> {
    const kept = Object.entries(invites).filter(([, invite]) => invite.expiresAt > now && invite.uses < invite.maxUses)
    return kept.length === Object.keys(invites).length ? invites : Object.fromEntries(kept)
}

/** Active invites for the owners' list, newest first. The hash (the record key) is left out on purpose. */
export function inviteViews(invites: Record<string, Invite>, now: number): InviteView[] {
    return Object.values(pruneExpiredInvites(invites, now))
        .map(invite => ({ id: invite.id, createdBy: invite.createdBy, expiresAt: invite.expiresAt, uses: invite.uses, maxUses: invite.maxUses, createdAt: invite.createdAt }))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
}

/** An invite made at or before someone's removal cannot bring them back; a fresh one can. */
export function blockedByRemoval(removed: Record<string, number>, userId: string, invite: Invite): boolean {
    const removedAt = removed[userId]
    return removedAt !== undefined && invite.createdAt <= removedAt
}

/** Drops removal records older than the longest invite lifetime: no invite that old is still usable. */
export function pruneRemoved(removed: Record<string, number>, now: number, maxInviteAgeMs: number): Record<string, number> {
    const kept = Object.entries(removed).filter(([, at]) => at > now - maxInviteAgeMs)
    return kept.length === Object.keys(removed).length ? removed : Object.fromEntries(kept)
}

export function ownerCount(members: Record<string, Member>): number {
    return Object.values(members).filter(member => member.role === "owner").length
}

/** `disconnected` is terminal: a disconnected environment is replaced, never revived. */
export function applyEnvironmentPatch(env: Environment, patch: EnvironmentPatch, now: number): Environment | null {
    if (env.phase === "disconnected") return null
    const next: Environment = { ...env, updatedAt: now }
    if (patch.name !== undefined) next.name = patch.name
    if (patch.freestyleVmId !== undefined) next.freestyleVmId = patch.freestyleVmId
    if (patch.freestyleIdentityId !== undefined) next.freestyleIdentityId = patch.freestyleIdentityId
    if (patch.linuxUser !== undefined) next.linuxUser = patch.linuxUser
    if (patch.nodeName !== undefined) next.nodeName = patch.nodeName
    if (patch.phase !== undefined) next.phase = patch.phase
    if (patch.vmState !== undefined) next.vmState = patch.vmState
    if (patch.nodeOnline !== undefined) next.nodeOnline = patch.nodeOnline
    if (patch.lastError !== undefined) next.lastError = patch.lastError
    return next
}
