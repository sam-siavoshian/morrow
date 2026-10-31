// Compare tasks (docs/multi-harness.md) through the generated client against a real `durable-actors dev`:
// races between two pickers, idempotent replays, argument validation and a restart.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { WorkforceView } from "../../packages/contracts/src/domain.ts"
import { startTestServer, type TestServer } from "../scripts/test-server.ts"
import { actors, expectActorError, plan, profileInput, taskInput, transportFor, uid, workstream } from "./helpers.ts"
import type { CliKind } from "../src/lib/types.ts"

let server: TestServer

beforeAll(async () => {
    server = await startTestServer()
}, 90_000)

afterAll(async () => {
    await server?.stop()
})

const CLIS: CliKind[] = ["claude", "codex", "opencode"]

/** A compare task over every CLI, each attempt running on its own profile; returns the lease per CLI. */
async function running(teamId: string) {
    const wf = actors.TeamWorkforce.get(teamId, transportFor(server))
    for (const cli of CLIS) await wf.registerProfile(profileInput(`p-${cli}`, { cli }))
    expect(await wf.createTask(taskInput("tk-1", { strategy: "compare", maxAgents: 3 }), uid("k"))).toEqual({ ok: true, taskId: "tk-1" })
    const attempts = CLIS.map(cli => workstream(`ws-${cli}`, cli, { branch: `morrow/tk1/${cli}`, ownership: ["**"], harness: cli }))
    expect(await wf.recordPlan("tk-1", plan(attempts, { source: "compare" }), uid("k"))).toEqual({ ok: true, generation: 1 })
    const reserved = await wf.reserveWorkers("tk-1", CLIS.map(cli => ({ workstreamId: `ws-${cli}`, profileId: `p-${cli}` })), uid("k"))
    if (!reserved.ok) throw new Error(JSON.stringify(reserved))
    const leases = Object.fromEntries(reserved.leases.map(l => [l.workstreamId.slice(3), l])) as Record<CliKind, (typeof reserved.leases)[number]>
    for (const lease of reserved.leases) await wf.recordSpawnStatus(lease.id, lease.epoch, "running", "inv", uid("e"))
    return { wf, leases }
}

test("two people pick at once: exactly one pick applies, the other is told it was already picked", async () => {
    const { wf, leases } = await running(uid("t"))
    await wf.completeWorkstream(leases.claude.id, leases.claude.epoch, "abc1234", "Claude done", uid("e"))
    await wf.completeWorkstream(leases.codex.id, leases.codex.epoch, "def5678", "Codex done", uid("e"))
    const results = await Promise.all([wf.pickAttempt("tk-1", "ws-claude", "u-1", uid("k")), wf.pickAttempt("tk-1", "ws-codex", "u-2", uid("k"))])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, reason: "already_picked" }])
    const view = await wf.getView()
    expect(WorkforceView.safeParse(view).success).toBe(true)
    expect(view.tasks["tk-1"]).toMatchObject({ status: "verifying", strategy: "compare" })
    expect(["ws-claude", "ws-codex"]).toContain(view.tasks["tk-1"]!.pickedWorkstreamId!)
    expect(view.leases[leases.opencode.id]!.state).toBe("released")
})

test("a replayed pick returns the first result; reusing its key with other arguments throws", async () => {
    const { wf, leases } = await running(uid("t"))
    await wf.completeWorkstream(leases.codex.id, leases.codex.epoch, "abc1234", "done", uid("e"))
    const key = uid("k")
    const first = await wf.pickAttempt("tk-1", "ws-codex", "u-1", key)
    expect(first).toEqual({ ok: true, status: "verifying", releasedLeaseIds: [leases.claude.id, leases.opencode.id].sort() })
    expect(await wf.pickAttempt("tk-1", "ws-codex", "u-1", key)).toEqual(first)
    await expectActorError(wf.pickAttempt("tk-1", null, "u-1", key), /key/i)
})

test("arguments are validated", async () => {
    const { wf } = await running(uid("t"))
    await expectActorError(wf.pickAttempt("tk 1", null, "u-1", uid("k")), /taskId/)
    await expectActorError(wf.pickAttempt("tk-1", "../x", "u-1", uid("k")), /workstreamId/)
    await expectActorError(wf.pickAttempt("tk-1", null, "", uid("k")), /byUserId/)
})

test("strategy, harnesses and the pick survive a restart", async () => {
    const teamId = uid("t")
    const { leases } = await running(teamId)
    let wf = actors.TeamWorkforce.get(teamId, transportFor(server))
    await wf.completeWorkstream(leases.opencode.id, leases.opencode.epoch, "abc1234", "done", uid("e"))
    await wf.pickAttempt("tk-1", "ws-opencode", "u-1", uid("k"))
    await server.restart()
    wf = actors.TeamWorkforce.get(teamId, transportFor(server))
    const task = await wf.getTask("tk-1")
    expect(task).toMatchObject({ strategy: "compare", pickedWorkstreamId: "ws-opencode", status: "verifying" })
    expect(task!.workstreams.map(ws => ws.harness)).toEqual(CLIS)
}, 120_000)
