// Test-only entrypoint (never deployed). It writes TeamWorkforce's persisted fields the same way the real actor does,
// using the real state machine, and then throws, so the test can prove the runtime rolls every write back for an
// @Atomic method and keeps them for a plain one. The real actors expose no method that throws after writing.
import { Actor, Persisted } from "durable-actors"
import { Atomic } from "../../src/lib/atomic.ts"
import type { CliProfile, Lease, OutboxItem, Task } from "../../src/lib/types.ts"
import * as wf from "../../src/lib/workforce.ts"

export type ProbeState = { epoch: number; leases: number; outbox: number; workstreamStatus: string | null; profileBusy: boolean }

export class RollbackProbe extends Actor {
    @Persisted private profiles: Record<string, CliProfile> = {}
    @Persisted private tasks: Record<string, Task> = {}
    @Persisted private leases: Record<string, Lease> = {}
    @Persisted private outbox: Record<string, OutboxItem> = {}
    @Persisted private epoch = 0

    @Atomic
    async seed(): Promise<void> {
        this.#apply(d => {
            wf.registerProfile(d, { id: "p1", envId: "e1", ownerUserId: "u-1", nodeName: "n-e1", cli: "claude", label: "P1", scopes: "all", maxConcurrent: 1 })
            wf.createTask(d, { id: "tk-1", projectId: "pr-1", title: "T", prompt: "P", acceptance: [], createdBy: "u-1", maxAgents: 1 })
            wf.recordPlan(d, "tk-1", {
                source: "fallback",
                profileId: null,
                rationale: "r",
                warnings: [],
                workstreams: [{ id: "ws", role: "api", title: "API", brief: "b", why: "w", branch: "morrow/tk1/api", dependsOn: [], ownership: [] }]
            })
        })
    }

    @Atomic
    async reserveThenThrow(): Promise<void> {
        this.#reserve()
        throw new Error("boom after writes")
    }

    async plainReserveThenThrow(): Promise<void> {
        this.#reserve()
        throw new Error("boom after writes")
    }

    async read(): Promise<ProbeState> {
        const lease = Object.values(this.leases)[0]
        return {
            epoch: this.epoch,
            leases: Object.keys(this.leases).length,
            outbox: Object.keys(this.outbox).length,
            workstreamStatus: this.tasks["tk-1"]?.workstreams[0]?.status ?? null,
            profileBusy: lease !== undefined && wf.isLiveLease(lease)
        }
    }

    #reserve(): void {
        this.#apply(d => {
            const result = wf.reserveWorkers(d, "tk-1", [{ workstreamId: "ws", profileId: "p1" }])
            if (!result.ok) throw new Error("reserve rejected")
        })
    }

    #apply(run: (d: wf.WorkforceDraft) => void): void {
        const d = new wf.WorkforceDraft({ profiles: this.profiles, tasks: this.tasks, leases: this.leases, outbox: this.outbox, epoch: this.epoch }, Date.now())
        run(d)
        wf.finalize(d)
        if (d.changed.has("profiles")) this.profiles = d.profiles
        if (d.changed.has("tasks")) this.tasks = d.tasks
        if (d.changed.has("leases")) this.leases = d.leases
        if (d.changed.has("outbox")) this.outbox = d.outbox
        if (d.changed.has("epoch")) this.epoch = d.epoch
    }
}
