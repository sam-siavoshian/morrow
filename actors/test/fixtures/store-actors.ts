// Test-only entrypoint (never deployed). StoreProbe writes TeamWorkforce records through WorkforceStore the way the
// actor does (an in-memory copy, written back by diff) so a test can prove, on the real runtime, that a throw inside
// @Atomic rolls back the SQLite rows with the @Persisted fields and that the in-memory copy cannot outlive them.
// TeamDirectory is the real actor, re-exported so it can be tested before it is wired into src/actors.ts.
import { Actor, Ephemeral, Persisted } from "durable-actors"
import { Atomic } from "../../src/lib/atomic.ts"
import { WorkforceStore, type StoredRecords } from "../../src/lib/store.ts"
import * as wf from "../../src/lib/workforce.ts"

export { TeamDirectory } from "../../src/lib/directory.ts"

export type StoreProbeState = { marker: number; tasks: string[]; ledger: number; cached: string[] }

export class StoreProbe extends Actor {
    @Persisted private marker = 0
    @Persisted private epoch = 0
    @Ephemeral #store = new WorkforceStore(this.db)
    @Ephemeral #cache: StoredRecords | null = null

    @Atomic
    async create(taskId: string): Promise<void> {
        this.#createTask(taskId)
    }

    @Atomic
    async createThenThrow(taskId: string): Promise<void> {
        this.#createTask(taskId)
        throw new Error("boom after writes")
    }

    async plainCreateThenThrow(taskId: string): Promise<void> {
        this.#createTask(taskId)
        throw new Error("boom after writes")
    }

    /** What SQLite holds (a fresh load) and what this instance's in-memory copy holds. */
    async read(): Promise<StoreProbeState> {
        const stored = new WorkforceStore(this.db).load()
        return { marker: this.marker, tasks: Object.keys(stored.tasks), ledger: this.#store.ledgerSize(), cached: Object.keys(this.#records().tasks) }
    }

    #records(): StoredRecords {
        this.#cache ??= this.#store.load()
        return this.#cache
    }

    #createTask(taskId: string): void {
        const base = this.#records()
        const d = new wf.WorkforceDraft({ ...base, epoch: this.epoch }, Date.now())
        const result = wf.createTask(d, { id: taskId, projectId: "pr-1", title: "T", prompt: "P", acceptance: [], createdBy: "u-1", maxAgents: 1 })
        if (!result.ok) throw new Error(result.reason)
        wf.finalize(d)
        const next = { profiles: d.profiles, tasks: d.tasks, leases: d.leases, outbox: d.outbox }
        this.#store.write(base, next)
        this.#store.ledgerPut({ key: `create:${taskId}`, fp: "", result })
        this.marker = this.marker + 1
        // Updated before the throw on purpose: a failed call must not leave this copy ahead of SQLite.
        this.#cache = next
    }
}
