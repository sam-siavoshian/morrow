// The SQLite store and the team directory on a real dev server (test-only entrypoint test/fixtures/store-actors.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DIRECTORY_ID, DIRECTORY_PAGE_MAX } from "../src/lib/directory.ts"
import type { DirectoryPage } from "../src/lib/directory-types.ts"
import { startTestServer, type TestServer } from "../scripts/test-server.ts"
import type { StoreProbeState } from "./fixtures/store-actors.ts"
import { uid } from "./helpers.ts"

let server: TestServer

beforeAll(async () => {
    server = await startTestServer({ entrypoint: "test/fixtures/store-actors.ts" })
}, 300_000)

afterAll(async () => {
    await server?.stop()
})

type Outcome = { type: string; result?: unknown; code?: string; message?: string }

async function invoke(actor: string, id: string, method: string, args: unknown[] = []): Promise<Outcome> {
    const response = await fetch(`${server.url}/v1/projects/local/actors/${actor}/${id}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.secret}` },
        body: JSON.stringify({ requestId: crypto.randomUUID(), method, args })
    })
    return ((await response.json()) as { outcome: Outcome }).outcome
}

async function result<T>(actor: string, id: string, method: string, args: unknown[] = []): Promise<T> {
    const outcome = await invoke(actor, id, method, args)
    if (outcome.type !== "completed") throw new Error(`${actor}.${method}: ${JSON.stringify(outcome)}`)
    return outcome.result as T
}

describe("WorkforceStore on the runtime", () => {
    test("a throw inside @Atomic rolls back the rows, the ledger and the fields; the in-memory copy goes with them", async () => {
        const id = uid("probe")
        await result("StoreProbe", id, "create", ["tk-1"])
        const seeded = await result<StoreProbeState>("StoreProbe", id, "read")
        expect(seeded).toEqual({ marker: 1, tasks: ["tk-1"], ledger: 1, cached: ["tk-1"] })

        expect(await invoke("StoreProbe", id, "createThenThrow", ["tk-2"])).toMatchObject({ type: "failed", message: "boom after writes" })
        // The runtime rebuilt the instance from the rolled-back database, so the copy updated before the throw is gone.
        expect(await result<StoreProbeState>("StoreProbe", id, "read")).toEqual(seeded)

        // Control: without @Atomic the writes made before the throw stay.
        expect(await invoke("StoreProbe", id, "plainCreateThenThrow", ["tk-3"])).toMatchObject({ type: "failed" })
        expect(await result<StoreProbeState>("StoreProbe", id, "read")).toEqual({ marker: 2, tasks: ["tk-1", "tk-3"], ledger: 2, cached: ["tk-1", "tk-3"] })
    })
})

describe("TeamDirectory", () => {
    const call = <T>(method: string, args: unknown[] = []) => result<T>("TeamDirectory", DIRECTORY_ID, method, args)

    test("work makes a team active; only an idle report with the current generation clears it", async () => {
        const team = uid("t")
        expect(await call("noteTeam", [team])).toEqual({ ok: true, created: true })
        expect(await call("noteTeam", [team])).toEqual({ ok: true, created: false })
        const listed = async () => {
            const teams: { teamId: string; gen: number }[] = []
            let after: string | null = null
            do {
                const page: { teams: { teamId: string; gen: number }[]; next: string | null } = await call("listActive", [after, 2])
                teams.push(...page.teams)
                after = page.next
            } while (after)
            return teams.filter(t => t.teamId === team)
        }
        expect(await listed()).toEqual([])
        const first = await call<{ gen: number }>("noteWork", [team])
        expect(await listed()).toEqual([{ teamId: team, gen: first.gen }])
        // Work noted after the backend read generation `first.gen`: its idle report must not hide it.
        const second = await call<{ gen: number }>("noteWork", [team])
        expect(second.gen).toBe(first.gen + 1)
        expect(await call("noteIdle", [team, first.gen])).toEqual({ ok: true, cleared: false })
        expect(await listed()).toEqual([{ teamId: team, gen: second.gen }])
        expect(await call("noteIdle", [team, second.gen])).toEqual({ ok: true, cleared: true })
        expect(await listed()).toEqual([])
        expect(await call("noteIdle", [team, second.gen])).toEqual({ ok: true, cleared: false })
    })

    test("pages through many teams in id order", async () => {
        const prefix = uid("t-page")
        const teams = Array.from({ length: 7 }, (_, i) => `${prefix}-${i}`)
        for (const team of teams) await call("noteWork", [team])
        const seen: string[] = []
        let after: string | null = null
        do {
            const page: { teams: { teamId: string }[]; next: string | null } = await call("listActive", [after, 3])
            seen.push(...page.teams.map(t => t.teamId))
            after = page.next
        } while (after)
        expect(seen.filter(id => id.startsWith(prefix))).toEqual(teams)
        expect((await call<{ active: number }>("stats")).active).toBeGreaterThanOrEqual(teams.length)
    })

    test("rejects bad input and any instance but the singleton", async () => {
        for (const [method, args] of [
            ["noteWork", ["not-a-team"]],
            ["noteIdle", ["t-x", -1]],
            ["listActive", [null, DIRECTORY_PAGE_MAX + 1]],
            ["listActive", ["bad id", 1]]
        ] as const)
            expect(await invoke("TeamDirectory", DIRECTORY_ID, method, [...args])).toMatchObject({ type: "failed", message: expect.stringMatching(/^invalid_argument/) })
        expect(await invoke("TeamDirectory", "other", "noteWork", ["t-x"])).toMatchObject({ type: "failed", message: expect.stringContaining("single actor") })
    })

    test("survives a server restart", async () => {
        const team = uid("t")
        const { gen } = await call<{ gen: number }>("noteWork", [team])
        await server.restart()
        const page = await call<DirectoryPage>("listActive", [null, DIRECTORY_PAGE_MAX])
        let found = page.teams.find(t => t.teamId === team)
        let after = page.next
        while (!found && after) {
            const next: DirectoryPage = await call("listActive", [after, DIRECTORY_PAGE_MAX])
            found = next.teams.find(t => t.teamId === team)
            after = next.next
        }
        expect(found).toEqual({ teamId: team, gen })
    }, 300_000)
})
