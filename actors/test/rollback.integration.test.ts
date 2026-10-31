// @Atomic rollback on throw, on a real dev server, using the test-only RollbackProbe entrypoint.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startTestServer, type TestServer } from "../scripts/test-server.ts"
import type { ProbeState } from "./fixtures/rollback-actors.ts"
import { uid } from "./helpers.ts"

let server: TestServer

beforeAll(async () => {
    server = await startTestServer({ entrypoint: "test/fixtures/rollback-actors.ts" })
}, 90_000)

afterAll(async () => {
    await server?.stop()
})

async function invoke(id: string, method: string): Promise<{ type: string; result?: unknown; code?: string; message?: string }> {
    const response = await fetch(`${server.url}/v1/projects/local/actors/RollbackProbe/${id}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.secret}` },
        body: JSON.stringify({ requestId: crypto.randomUUID(), method, args: [] })
    })
    return ((await response.json()) as { outcome: { type: string; result?: unknown; code?: string; message?: string } }).outcome
}

test("a throw inside @Atomic rolls back every write; the same code in a plain method keeps them", async () => {
    const id = uid("probe")
    expect((await invoke(id, "seed")).type).toBe("completed")
    const seeded = (await invoke(id, "read")).result as ProbeState
    expect(seeded).toEqual({ epoch: 0, leases: 0, outbox: 0, workstreamStatus: "pending", profileBusy: false })

    const atomic = await invoke(id, "reserveThenThrow")
    expect(atomic).toMatchObject({ type: "failed", code: "actor_error", message: "boom after writes" })
    expect((await invoke(id, "read")).result).toEqual(seeded)

    // Control: without @Atomic the runtime keeps writes made before the throw.
    const plain = await invoke(id, "plainReserveThenThrow")
    expect(plain).toMatchObject({ type: "failed", message: "boom after writes" })
    expect((await invoke(id, "read")).result).toEqual({ epoch: 1, leases: 1, outbox: 1, workstreamStatus: "active", profileBusy: true })
})
