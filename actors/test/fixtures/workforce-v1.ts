// Test-only entrypoint (never deployed): TeamWorkforce with the storage layout of schema 1, where every record lived
// in five @Persisted fields and `view` was the one emitted field. `seed` writes those fields as they were, so the
// upgrade test can stop this server, start the real entrypoint on the same data, and check what schema 2 makes of it.
import { Actor, Emittable, Persisted } from "durable-actors"
import type { Ledger } from "../../src/lib/ledger.ts"
import type { CliProfile, Lease, OutboxItem, Task, WorkforceView } from "../../src/lib/types.ts"

export type V1Fields = {
    view: WorkforceView
    profiles: Record<string, CliProfile>
    tasks: Record<string, Task>
    leases: Record<string, Lease>
    outbox: Record<string, OutboxItem>
    epoch: number
    processed: Ledger
    notified: Record<string, number>
}

export class TeamWorkforce extends Actor {
    @Persisted @Emittable view: WorkforceView = { profiles: {}, tasks: {}, leases: {} }
    @Persisted private profiles: Record<string, CliProfile> = {}
    @Persisted private tasks: Record<string, Task> = {}
    @Persisted private leases: Record<string, Lease> = {}
    @Persisted private outbox: Record<string, OutboxItem> = {}
    @Persisted private epoch = 0
    @Persisted private processed: Ledger = []
    @Persisted private notified: Record<string, number> = {}

    async seed(fields: V1Fields): Promise<void> {
        this.view = fields.view
        this.profiles = fields.profiles
        this.tasks = fields.tasks
        this.leases = fields.leases
        this.outbox = fields.outbox
        this.epoch = fields.epoch
        this.processed = fields.processed
        this.notified = fields.notified
    }
}
