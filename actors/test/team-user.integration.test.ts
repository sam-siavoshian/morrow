// Team and User actors against a real dev server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { TeamView } from "../../packages/contracts/src/domain.ts"
import { startTestServer, type TestServer } from "../scripts/test-server.ts"
import { actors, expectActorError, openSocket, socketOptions, transportFor, uid, waitFor, type Frame } from "./helpers.ts"

const TeamProjection = TeamView.omit({ viewerRole: true })

let server: TestServer

beforeAll(async () => {
    server = await startTestServer()
}, 90_000)

afterAll(async () => {
    await server?.stop()
})

const owner = { userId: "u-1001", login: "sam", name: "Sam", avatarUrl: "https://avatars.example/u/1001" }
const bea = { userId: "u-1002", login: "bea", name: null, avatarUrl: null }
const hash = (char: string) => char.repeat(64)
const SEALED = {
    workspaceKeyEnc: "v1.SEALED-WORKSPACE-KEY-aaaaaaaa",
    dispatcherTokenEnc: "v1.SEALED-DISPATCHER-bbbbbbbbbb",
    observerTokenEnc: "v1.SEALED-OBSERVER-cccccccccccc"
}

async function createdTeam() {
    const id = uid("t")
    const team = actors.Team.get(id, transportFor(server))
    expect(await team.create({ name: "Acme", slug: "acme", owner }, uid("k"))).toEqual({ ok: true })
    return { id, team }
}

describe("Team", () => {
    test("create is idempotent by key, refuses a second create and non-t- ids", async () => {
        const id = uid("t")
        const team = actors.Team.get(id, transportFor(server))
        expect(await team.getView()).toBeNull()
        const key = uid("k")
        expect(await team.create({ name: "Acme", slug: "acme", owner }, key)).toEqual({ ok: true })
        expect(await team.create({ name: "Acme", slug: "acme", owner }, key)).toEqual({ ok: true })
        expect(await team.create({ name: "Other", slug: "other", owner: bea }, uid("k"))).toEqual({ ok: false, reason: "already_exists" })
        await expectActorError(team.create({ name: "Acme 2", slug: "acme", owner }, key), /idempotency_key_reused/)
        expect(await team.getMember(owner.userId)).toEqual({ userId: owner.userId, role: "owner" })
        expect(await team.getMember(bea.userId)).toBeNull()
        await expectActorError(actors.Team.get(uid("x"), transportFor(server)).create({ name: "A", slug: "a", owner }, uid("k")), /t-/)
    })

    test("invites: create, accept once per member, expiry, exhaustion, revoke", async () => {
        const { team } = await createdTeam()
        const expiresAt = Date.now() + 60 * 60_000
        const inviteA = uid("inv")
        expect(await team.createInvite({ id: inviteA, hash: hash("a"), createdBy: owner.userId, expiresAt, maxUses: 1 })).toEqual({ ok: true })
        expect(await team.createInvite({ id: uid("inv"), hash: hash("a"), createdBy: owner.userId, expiresAt, maxUses: 1 })).toEqual({ ok: false, reason: "invite_exists" })
        expect(await team.createInvite({ id: inviteA, hash: hash("9"), createdBy: owner.userId, expiresAt, maxUses: 1 })).toEqual({ ok: false, reason: "invite_exists" })
        expect(await team.createInvite({ id: uid("inv"), hash: hash("b"), createdBy: "u-stranger", expiresAt, maxUses: 1 })).toEqual({ ok: false, reason: "not_a_member" })
        await expectActorError(team.createInvite({ id: uid("inv"), hash: hash("c"), createdBy: owner.userId, expiresAt: Date.now() - 1, maxUses: 1 }), /expiresAt/)
        await expectActorError(team.createInvite({ id: uid("inv"), hash: "NOT-HEX", createdBy: owner.userId, expiresAt, maxUses: 1 }), /input\.hash/)

        expect(await team.acceptInvite(hash("f"), bea)).toEqual({ ok: false, reason: "invalid_invite" })
        expect(await team.acceptInvite(hash("a"), bea)).toEqual({ ok: true, role: "member", alreadyMember: false })
        expect(await team.acceptInvite(hash("a"), bea)).toEqual({ ok: true, role: "member", alreadyMember: true })
        expect(await team.acceptInvite(hash("a"), { userId: "u-1003", login: "cy", name: null, avatarUrl: null })).toEqual({ ok: false, reason: "exhausted" })
        expect(await team.revokeInvite(inviteA)).toEqual({ ok: true, revoked: true })
        expect(await team.revokeInvite(inviteA)).toEqual({ ok: true, revoked: false })
        await expectActorError(team.revokeInvite(hash("a").slice(0, 200) + " "), /inviteId/)
        expect(await team.acceptInvite(hash("a"), { userId: "u-1003", login: "cy", name: null, avatarUrl: null })).toEqual({ ok: false, reason: "invalid_invite" })

        const view = (await team.getView())!
        expect(view.members.map(member => [member.userId, member.role])).toEqual([
            [owner.userId, "owner"],
            [bea.userId, "member"]
        ])
    })

    test("members: the last owner cannot be removed; display fields refresh", async () => {
        const { team } = await createdTeam()
        await team.createInvite({ id: uid("inv"), hash: hash("d"), createdBy: owner.userId, expiresAt: Date.now() + 60_000, maxUses: 5 })
        await team.acceptInvite(hash("d"), bea)
        expect(await team.removeMember(owner.userId)).toEqual({ ok: false, reason: "last_owner" })
        expect(await team.updateMemberProfile({ ...bea, name: "Bea", login: "bea-new" })).toEqual({ ok: true })
        expect((await team.getView())!.members[1]).toEqual({ userId: bea.userId, login: "bea-new", name: "Bea", avatarUrl: null, role: "member" })
        expect(await team.removeMember(bea.userId)).toEqual({ ok: true, removed: true })
        expect(await team.removeMember(bea.userId)).toEqual({ ok: true, removed: false })
        expect(await team.updateMemberProfile(bea)).toEqual({ ok: false, reason: "not_a_member" })
    })

    test("listInvites: active only, newest first, never the hash", async () => {
        const { team } = await createdTeam()
        const expiresAt = Date.now() + 60 * 60_000
        await team.createInvite({ id: "inv-old", hash: hash("6"), createdBy: owner.userId, expiresAt, maxUses: 1 })
        await Bun.sleep(5)
        await team.createInvite({ id: "inv-new", hash: hash("7"), createdBy: owner.userId, expiresAt, maxUses: 3 })
        const listed = await team.listInvites()
        expect(listed.map(invite => [invite.id, invite.uses, invite.maxUses, invite.createdBy, invite.expiresAt])).toEqual([
            ["inv-new", 0, 3, owner.userId, expiresAt],
            ["inv-old", 0, 1, owner.userId, expiresAt]
        ])
        expect(JSON.stringify(listed)).not.toContain(hash("6"))
        expect(JSON.stringify(listed)).not.toContain(hash("7"))
        await team.acceptInvite(hash("6"), bea)
        expect((await team.listInvites()).map(invite => invite.id)).toEqual(["inv-new"])
        await team.revokeInvite("inv-new")
        expect(await team.listInvites()).toEqual([])
        expect(await actors.Team.get(uid("t"), transportFor(server)).listInvites()).toEqual([])
    })

    test("a removed member cannot rejoin with an old link; a fresh invite lets them back", async () => {
        const { team } = await createdTeam()
        const expiresAt = Date.now() + 60 * 60_000
        await team.createInvite({ id: uid("inv"), hash: hash("8"), createdBy: owner.userId, expiresAt, maxUses: 50 })
        expect(await team.acceptInvite(hash("8"), bea)).toEqual({ ok: true, role: "member", alreadyMember: false })
        expect(await team.removeMember(bea.userId)).toEqual({ ok: true, removed: true })
        // Same link, same person: refused with the generic answer, and the preview hides the team too.
        expect(await team.acceptInvite(hash("8"), bea)).toEqual({ ok: false, reason: "invalid_invite" })
        expect(await team.getInviteByHash(hash("8"), bea.userId)).toBeNull()
        // Anyone else can still use it.
        expect(await team.getInviteByHash(hash("8"), "u-1003")).not.toBeNull()
        expect(await team.acceptInvite(hash("8"), { userId: "u-1003", login: "cy", name: null, avatarUrl: null })).toMatchObject({ ok: true })
        // A link made after the removal is an explicit re-invite.
        await Bun.sleep(5)
        await team.createInvite({ id: uid("inv"), hash: hash("9"), createdBy: owner.userId, expiresAt, maxUses: 1 })
        expect(await team.getInviteByHash(hash("9"), bea.userId)).not.toBeNull()
        expect(await team.acceptInvite(hash("9"), bea)).toEqual({ ok: true, role: "member", alreadyMember: false })
        // Back in, the block is gone; leaving again sets a new one.
        expect(await team.removeMember(bea.userId)).toEqual({ ok: true, removed: true })
        expect(await team.acceptInvite(hash("8"), bea)).toEqual({ ok: false, reason: "invalid_invite" })
    })

    test("setMemberRole: promote, demote, idempotent, owner fixed, validated", async () => {
        const { team } = await createdTeam()
        await team.createInvite({ id: uid("inv"), hash: hash("1"), createdBy: owner.userId, expiresAt: Date.now() + 60_000, maxUses: 5 })
        await team.acceptInvite(hash("1"), bea)
        expect(await team.setMemberRole(bea.userId, "admin")).toEqual({ ok: true, role: "admin", changed: true })
        expect(await team.setMemberRole(bea.userId, "admin")).toEqual({ ok: true, role: "admin", changed: false })
        expect(await team.getMember(bea.userId)).toEqual({ userId: bea.userId, role: "admin" })
        expect((await team.getView())!.members.find(member => member.userId === bea.userId)!.role).toBe("admin")
        expect(await team.setMemberRole(bea.userId, "member")).toEqual({ ok: true, role: "member", changed: true })
        expect(await team.setMemberRole(owner.userId, "member")).toEqual({ ok: false, reason: "owner_role_fixed" })
        expect(await team.getMember(owner.userId)).toEqual({ userId: owner.userId, role: "owner" })
        expect(await team.setMemberRole("u-stranger", "admin")).toEqual({ ok: false, reason: "not_a_member" })
        await expectActorError(team.setMemberRole(bea.userId, "owner" as "admin"), /role/)
        await expectActorError(team.setMemberRole("__proto__", "admin"), /userId/)
        expect(await actors.Team.get(uid("t"), transportFor(server)).setMemberRole(bea.userId, "admin")).toEqual({ ok: false, reason: "no_team" })
    })

    test("rename: trims, keeps the slug, refuses bad names", async () => {
        const { team } = await createdTeam()
        expect(await team.rename("  Acme Rockets  ")).toEqual({ ok: true })
        expect(await team.rename("Acme Rockets")).toEqual({ ok: true })
        expect(await team.getView()).toMatchObject({ name: "Acme Rockets", slug: "acme" })
        await expectActorError(team.rename(""), /name/)
        await expectActorError(team.rename("   "), /name/)
        await expectActorError(team.rename("x".repeat(65)), /name/)
        await expectActorError(team.rename("two\nlines"), /name/)
        expect((await team.getView())!.name).toBe("Acme Rockets")
        expect(await actors.Team.get(uid("t"), transportFor(server)).rename("Ghost")).toEqual({ ok: false, reason: "no_team" })
    })

    test("setPolicy merges a partial patch atomically and validates it", async () => {
        const { team } = await createdTeam()
        expect((await team.getView())!.policy).toEqual({ allowInspect: true, maxParallelPerTask: 3 })
        expect(await team.setPolicy({ allowInspect: false })).toEqual({ ok: true })
        expect(await team.setPolicy({ maxParallelPerTask: 5 })).toEqual({ ok: true })
        expect((await team.getView())!.policy).toEqual({ allowInspect: false, maxParallelPerTask: 5 })
        // Two admins changing different settings at once: both land.
        await Promise.all([team.setPolicy({ allowInspect: true }), team.setPolicy({ maxParallelPerTask: 2 })])
        expect((await team.getView())!.policy).toEqual({ allowInspect: true, maxParallelPerTask: 2 })
        await expectActorError(team.setPolicy({}), /policy/)
        await expectActorError(team.setPolicy({ maxParallelPerTask: 6 }), /policy\.maxParallelPerTask/)
        await expectActorError(team.setPolicy({ maxParallelPerTask: 0 }), /policy\.maxParallelPerTask/)
        await expectActorError(team.setPolicy({ allowInspect: "yes" as unknown as boolean }), /policy\.allowInspect/)
        await expectActorError(team.setPolicy({ allowInspect: true, extra: 1 } as Partial<{ allowInspect: boolean }>), /policy/)
        expect((await team.getView())!.policy).toEqual({ allowInspect: true, maxParallelPerTask: 2 })
    })

    test("getInviteByHash: one null for unknown, expired and used up; never the hash; consumes nothing", async () => {
        const { team } = await createdTeam()
        const expiresAt = Date.now() + 60 * 60_000
        await team.createInvite({ id: uid("inv"), hash: hash("2"), createdBy: owner.userId, expiresAt, maxUses: 1 })
        const preview = await team.getInviteByHash(hash("2"), "u-1009")
        expect(preview).toEqual({ teamName: "Acme", expiresAt, createdBy: owner.userId, inviter: { login: "sam", avatarUrl: owner.avatarUrl } })
        expect(JSON.stringify(preview)).not.toContain(hash("2"))
        expect(await team.getInviteByHash(hash("2"), "u-1009")).toEqual(preview)
        expect(await team.acceptInvite(hash("2"), bea)).toEqual({ ok: true, role: "member", alreadyMember: false })
        expect(await team.getInviteByHash(hash("2"), "u-1009")).toBeNull()
        expect(await team.getInviteByHash(hash("3"), "u-1009")).toBeNull()
        // expiresAt is read off this host's clock but the actor checks it against the server's; the margins absorb about a second of skew either way.
        await team.createInvite({ id: uid("inv"), hash: hash("5"), createdBy: owner.userId, expiresAt: Date.now() + 1_500, maxUses: 5 })
        expect(await team.getInviteByHash(hash("5"), "u-1009")).not.toBeNull()
        await Bun.sleep(2_600)
        expect(await team.getInviteByHash(hash("5"), "u-1009")).toBeNull()
        await expectActorError(team.getInviteByHash("nope", "u-1009"), /hash/)
        expect(await actors.Team.get(uid("t"), transportFor(server)).getInviteByHash(hash("2"), "u-1009")).toBeNull()

        // An invite whose creator left still works, without an inviter card.
        await team.setMemberRole(bea.userId, "admin")
        await team.createInvite({ id: uid("inv"), hash: hash("4"), createdBy: bea.userId, expiresAt, maxUses: 3 })
        await team.removeMember(bea.userId)
        expect(await team.getInviteByHash(hash("4"), "u-1009")).toEqual({ teamName: "Acme", expiresAt, createdBy: bea.userId, inviter: null })
    })

    test("projects and environments", async () => {
        const { team } = await createdTeam()
        const project = { id: "pr-1", repoFullName: "acme/web", repoId: 42, defaultBranch: "main", testCommand: "bun test", createdBy: owner.userId }
        expect(await team.linkProject(project)).toEqual({ ok: true, projectId: "pr-1", created: true })
        expect(await team.linkProject({ ...project, id: "pr-2", repoFullName: "ACME/web" })).toEqual({ ok: true, projectId: "pr-1", created: false })
        expect(await team.linkProject({ ...project, id: "pr-1", repoFullName: "acme/api" })).toEqual({ ok: false, reason: "project_exists" })
        expect(await team.linkProject({ ...project, id: "pr-3", createdBy: "u-stranger" })).toEqual({ ok: false, reason: "not_a_member" })
        await expectActorError(team.linkProject({ ...project, repoFullName: "not a repo" }), /repoFullName/)
        expect(await team.getProject("pr-1")).toMatchObject({ repoId: 42 })

        // Test command: set (trimmed), same value is a no-op, clear with null, unknown project, bad input.
        const pv = { id: "pr-1", repoFullName: "acme/web", defaultBranch: "main" }
        expect(await team.setProjectTestCommand("pr-1", "  bun run test:ci  ")).toEqual({ ok: true, project: { ...pv, testCommand: "bun run test:ci" }, changed: true })
        expect(await team.setProjectTestCommand("pr-1", "bun run test:ci")).toEqual({ ok: true, project: { ...pv, testCommand: "bun run test:ci" }, changed: false })
        expect((await team.getView())!.projects).toEqual([{ ...pv, testCommand: "bun run test:ci" }])
        expect(await team.setProjectTestCommand("pr-1", null)).toEqual({ ok: true, project: { ...pv, testCommand: null }, changed: true })
        expect((await team.getProject("pr-1"))!.testCommand).toBeNull()
        expect(await team.setProjectTestCommand("pr-nope", "make test")).toEqual({ ok: false, reason: "unknown_project" })
        await expectActorError(team.setProjectTestCommand("pr-1", "bun test\nrm -rf ~"), /testCommand/)
        await expectActorError(team.setProjectTestCommand("pr-1", "bun test\u0000"), /testCommand/)
        await expectActorError(team.setProjectTestCommand("pr-1", "x".repeat(201)), /testCommand/)
        await expectActorError(team.setProjectTestCommand("pr-1", "   "), /testCommand/)
        await expectActorError(team.setProjectTestCommand("../x", "make"), /projectId/)
        expect(await actors.Team.get(uid("t"), transportFor(server)).setProjectTestCommand("pr-1", "make")).toEqual({ ok: false, reason: "no_team" })

        expect(await team.createEnvironment({ id: "env-1", ownerUserId: owner.userId, name: "Sam's box" })).toEqual({ ok: true, created: true })
        expect(await team.createEnvironment({ id: "env-1", ownerUserId: owner.userId, name: "Sam's box" })).toEqual({ ok: true, created: false })
        expect(await team.createEnvironment({ id: "env-1", ownerUserId: bea.userId, name: "x" })).toEqual({ ok: false, reason: "not_a_member" })
        for (let i = 2; i <= 5; i++) await team.createEnvironment({ id: `env-${i}`, ownerUserId: owner.userId, name: `box ${i}` })
        expect(await team.createEnvironment({ id: "env-6", ownerUserId: owner.userId, name: "one too many" })).toEqual({ ok: false, reason: "too_many_environments" })

        const updated = await team.updateEnvironment("env-1", { phase: "ready", vmState: "running", nodeOnline: true, freestyleVmId: "vm-123", linuxUser: "u1001", nodeName: "n-env1" })
        expect(updated.ok && updated.environment).toMatchObject({ phase: "ready", freestyleVmId: "vm-123" })
        expect(await team.updateEnvironment("env-nope", { phase: "ready" })).toEqual({ ok: false, reason: "unknown_environment" })
        await expectActorError(team.updateEnvironment("env-1", {}), /patch/)
        await expectActorError(team.updateEnvironment("env-1", { linuxUser: "root; rm -rf /" }), /patch\.linuxUser/)
        await team.updateEnvironment("env-2", { phase: "disconnected" })
        expect(await team.updateEnvironment("env-2", { phase: "ready" })).toEqual({ ok: false, reason: "environment_disconnected" })
        expect((await team.getEnvironment("env-1"))!.freestyleVmId).toBe("vm-123")
        expect((await team.getEnvironment("env-1"))!.freestyleIdentityId).toBeNull()
        expect(await team.updateEnvironment("env-1", { freestyleIdentityId: "id-term-1" })).toMatchObject({ ok: true, environment: { freestyleIdentityId: "id-term-1" } })
        await expectActorError(team.updateEnvironment("env-1", { freestyleIdentityId: "../bad id" }), /patch\.freestyleIdentityId/)
        expect((await team.getEnvironments()).map(env => env.id)).toEqual(["env-1", "env-2", "env-3", "env-4", "env-5"])
        expect(await team.removeEnvironment("env-5")).toEqual({ ok: true })
        expect(await team.unlinkProject("pr-1")).toEqual({ ok: true })
        expect(await team.getProject("pr-1")).toBeNull()
    })

    test("relay secrets stay private; the emitted projection matches TeamView without viewerRole", async () => {
        const { id, team } = await createdTeam()
        const grant = await actors.Team.prepareWebsocket({ actorId: id, metadata: { userId: "system.backend" } }, socketOptions(server))
        const socket = await openSocket(grant.websocketUrl)
        try {
            expect(await team.setRelayCursor("cursor-1")).toEqual({ ok: false, reason: "relay_not_configured" })
            const relay = { workspaceId: "ws-1", baseUrl: "https://relay.example", observerTokenId: "obs-1", ...SEALED }
            expect(await team.setRelay(relay)).toEqual({ ok: true })
            expect(await team.setRelayCursor("cursor-1")).toEqual({ ok: true })
            expect(await team.getRelay()).toEqual({ ...relay, cursor: "cursor-1" })
            // Same workspace keeps the cursor; a new workspace resets it.
            await team.setRelay({ ...relay, observerTokenId: "obs-2" })
            expect((await team.getRelay())!.cursor).toBe("cursor-1")
            await team.setRelay({ ...relay, workspaceId: "ws-2" })
            expect((await team.getRelay())!.cursor).toBeNull()
            await expectActorError(team.setRelay({ ...relay, workspaceKeyEnc: "short" }), /config\.workspaceKeyEnc/)
            await expectActorError(team.setRelay({ ...relay, baseUrl: "file:///etc/passwd" }), /config\.baseUrl/)

            await team.linkProject({ id: "pr-1", repoFullName: "acme/web", repoId: 42, defaultBranch: "main", testCommand: null, createdBy: owner.userId })
            await team.createEnvironment({ id: "env-1", ownerUserId: owner.userId, name: "box" })
            await team.updateEnvironment("env-1", { freestyleVmId: "vm-secret-123", freestyleIdentityId: "id-secret-456", phase: "awaiting_login" })
            await team.createInvite({ id: uid("inv"), hash: hash("e"), createdBy: owner.userId, expiresAt: Date.now() + 60_000, maxUses: 2 })
            expect(await team.setPolicy({ allowInspect: false, maxParallelPerTask: 2 })).toEqual({ ok: true })

            const view = (await team.getView())!
            expect(TeamProjection.parse(view)).toEqual(view)
            expect(view).toMatchObject({ id, name: "Acme", slug: "acme", relayReady: true, policy: { allowInspect: false, maxParallelPerTask: 2 } })
            expect(view.projects).toEqual([{ id: "pr-1", repoFullName: "acme/web", defaultBranch: "main", testCommand: null }])

            const latest = await waitFor(
                () => (socket.frames.filter(frame => frame.type === "state_update") as (Frame & { changes: { view?: unknown } })[]).at(-1)?.changes.view,
                emitted => JSON.stringify(emitted) === JSON.stringify(view)
            )
            expect(TeamProjection.parse(latest)).toEqual(view)
            const everything = JSON.stringify(socket.frames) + JSON.stringify(view)
            for (const secret of [...Object.values(SEALED), "vm-secret-123", "id-secret-456", hash("e"), "obs-1", "cursor-1"]) expect(everything).not.toContain(secret)
        } finally {
            socket.ws.close()
        }
    })

    test("onConnect rejects every socket but the backend's, members included", async () => {
        const { id } = await createdTeam()
        for (const metadata of [{}, { userId: owner.userId }]) {
            const grant = await actors.Team.prepareWebsocket({ actorId: id, metadata: metadata as { userId: string } }, socketOptions(server))
            const socket = await openSocket(grant.websocketUrl)
            expect((await socket.closed).code).toBe(4003)
            expect(socket.frames).toEqual([])
        }
    })
})

describe("User", () => {
    const github = { githubId: 1001, login: "sam", name: "Sam", avatarUrl: "https://avatars.example/u/1001", email: "sam@example.com", githubTokenEnc: "v1.SEALED-GITHUB-TOKEN-xxxxxxxx" }

    test("upsert, read, session version, teams and relay tokens", async () => {
        const user = actors.User.get("u-1001", transportFor(server))
        expect(await user.get()).toBeNull()
        expect(await user.bumpSessionVersion()).toEqual({ ok: false, reason: "unknown_user" })
        expect(await user.addTeam("t-1")).toEqual({ ok: false, reason: "unknown_user" })
        expect(await user.upsertFromGithub(github)).toEqual({ ok: true, created: true, sessionVersion: 1 })
        expect(await user.upsertFromGithub({ ...github, login: "sam-renamed", githubTokenEnc: "v1.SEALED-GITHUB-TOKEN-rotated" })).toEqual({ ok: true, created: false, sessionVersion: 1 })
        expect(await user.bumpSessionVersion()).toEqual({ ok: true, sessionVersion: 2 })

        expect(await user.setRelayHumanToken("t-1", "v1.SEALED-RELAY-HUMAN-xxxx")).toEqual({ ok: false, reason: "not_in_team" })
        expect(await user.addTeam("t-1")).toEqual({ ok: true, teamIds: ["t-1"] })
        expect(await user.addTeam("t-1")).toEqual({ ok: true, teamIds: ["t-1"] })
        expect(await user.addTeam("t-2")).toEqual({ ok: true, teamIds: ["t-1", "t-2"] })
        expect(await user.setRelayHumanToken("t-1", "v1.SEALED-RELAY-HUMAN-xxxx")).toEqual({ ok: true })
        expect(await user.setFreestyleIdentity("fsid-1")).toEqual({ ok: true })

        const record = (await user.get())!
        expect(record).toMatchObject({
            id: "u-1001",
            profile: { githubId: 1001, login: "sam-renamed", name: "Sam", email: "sam@example.com" },
            githubTokenEnc: "v1.SEALED-GITHUB-TOKEN-rotated",
            sessionVersion: 2,
            teamIds: ["t-1", "t-2"],
            relayHumanTokens: { "t-1": "v1.SEALED-RELAY-HUMAN-xxxx" },
            freestyleIdentityId: "fsid-1"
        })
        expect(await user.removeTeam("t-1")).toEqual({ ok: true, teamIds: ["t-2"] })
        expect((await user.get())!.relayHumanTokens).toEqual({})
    })

    test("validation: id must match the GitHub id; bad inputs throw", async () => {
        const user = actors.User.get("u-2002", transportFor(server))
        await expectActorError(user.upsertFromGithub(github), /githubId does not match/)
        await expectActorError(user.upsertFromGithub({ ...github, githubId: 2002, login: "bad login!" }), /input\.login/)
        await expectActorError(user.upsertFromGithub({ ...github, githubId: 2002, email: "not-an-email" }), /input\.email/)
        await expectActorError(user.upsertFromGithub({ ...github, githubId: 2002, avatarUrl: "javascript:alert(1)" }), /input\.avatarUrl/)
        await expectActorError(user.upsertFromGithub({ ...github, githubId: 2002, githubTokenEnc: "" }), /input\.githubTokenEnc/)
        await expectActorError(user.upsertFromGithub({ ...github, githubId: -5 }), /input\.githubId/)
        await expectActorError(user.addTeam("__proto__"), /teamId: reserved id/)
        expect(await user.get()).toBeNull()
    })

    test("User emits nothing and refuses every socket", async () => {
        const grant = await actors.User.prepareWebsocket({ actorId: "u-1001", metadata: { userId: "u-1001" } }, socketOptions(server))
        const socket = await openSocket(grant.websocketUrl)
        expect((await socket.closed).code).toBe(4003)
        expect(socket.frames).toEqual([])
    })
})
