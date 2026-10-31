// Test-only entrypoint (never deployed): TeamWorkforce as the version before task modes stored it. Same schema 2
// layout as src/actors.ts (records in SQLite through WorkforceStore, `schemaVersion` set), but its tasks have no
// `mode` or `pins` rows. `seed` writes such records, so a test can stop this server, start the real entrypoint on
// the same data and check that the old tasks load as auto with no pins.
import { Actor, Ephemeral, Persisted } from "durable-actors"
import { SCHEMA_VERSION, WorkforceStore } from "../../src/lib/store.ts"
import type { CliProfile, Lease, OutboxItem, Task } from "../../src/lib/types.ts"

// Spelled out here, not imported from store.ts: a public method's types are bundled into the actor's declarations.
type Records = { profiles: Record<string, CliProfile>; tasks: Record<string, Task>; leases: Record<string, Lease>; outbox: Record<string, OutboxItem> }

export class TeamWorkforce extends Actor {
    @Persisted private epoch = 0
    @Persisted private schemaVersion = 0
    @Ephemeral #store = new WorkforceStore(this.db)

    async seed(records: Records, epoch: number): Promise<void> {
        for (const task of Object.values(records.tasks)) if ("mode" in task || "pins" in task) throw new Error("seed tasks as the old version stored them")
        this.#store.replaceAll(records)
        this.epoch = epoch
        this.schemaVersion = SCHEMA_VERSION
    }
}
