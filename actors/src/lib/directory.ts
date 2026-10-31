// TeamDirectory: one instance (id `DIRECTORY_ID`), the durable list of teams and which of them may have unfinished
// work. The backend reads it at boot and on every re-list to find TeamWorkforce actors to resume.
//
// Why it exists: the control plane's actor inventory (`/observe/actors`) is a per-process, in-memory cache that starts
// empty after a Terse restart and forgets idle actors (Terse configuration reference, "Host lifecycle reports"), so it
// can only ever be a hint. This list lives in the actor's SQLite and survives both restarts.
//
// A team is `active` from `noteWork` (a task was created) until `noteIdle` with the generation the caller last saw.
// A `noteWork` in between bumps the generation, so a stale idle report can never hide new work.
import { Actor, type ActorContext, type ActorSocket } from "durable-actors"
import type { DirectoryPage, DirectoryStats, NoteIdleResult, NoteTeamResult, NoteWorkResult } from "./directory-types.ts"
import type { SocketIncoming, SocketMetadata, SocketOutgoing } from "./types.ts"
import { z } from "zod"

// Only package value imports here. Re-exporting this class from an entrypoint makes the generated client's type
// bundle compile this file as source, without the project's `allowImportingTsExtensions`, so a value import of
// "./validation.ts" would break the build. The rules below match validation.ts (`Id`, `EpochMs`, `parse`).
const Id = z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,128}$/, "invalid id")
    .refine(value => !(value in Object.prototype), "reserved id")
const TeamId = Id.refine(id => id.startsWith("t-"), "team ids start with t-")
const Gen = z.number().int().nonnegative().max(8.64e15)
const Cursor = Id.nullable()
const Limit = z.number().int().min(1)

function parse<T extends z.ZodType>(schema: T, value: unknown, name: string): z.output<T> {
    const result = schema.safeParse(value)
    if (result.success) return result.data
    const issue = result.error.issues[0]
    throw new Error(`invalid_argument: ${[name, ...(issue?.path ?? []).map(String)].join(".")}: ${issue?.message ?? "invalid"}`)
}

export const DIRECTORY_ID = "teams"
export const DIRECTORY_PAGE_MAX = 500

type Socket = ActorSocket<SocketMetadata, SocketOutgoing>

export class TeamDirectory extends Actor<SocketMetadata, SocketIncoming, SocketOutgoing> {
    constructor(context: ActorContext) {
        super(context)
        this.db.exec(
            "CREATE TABLE IF NOT EXISTS dir_team (id TEXT PRIMARY KEY NOT NULL, gen INTEGER NOT NULL, active INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
        )
        this.db.exec("CREATE INDEX IF NOT EXISTS dir_team_active ON dir_team (active, id)")
    }

    /** Records that a team exists (no work yet). A no-op for a known team. */
    async noteTeam(teamId: string): Promise<NoteTeamResult> {
        return this.db.transaction(async () => {
            const id = this.#teamId(teamId)
            const known = this.#row(id) !== null
            if (!known) {
                const now = Date.now()
                this.db.exec("INSERT INTO dir_team (id, gen, active, created_at, updated_at) VALUES (?, 0, 0, ?, ?)", id, now, now)
            }
            return { ok: true, created: !known }
        })
    }

    /** Marks a team as having work and returns its new generation. Safe to replay: it only bumps the generation. */
    async noteWork(teamId: string): Promise<NoteWorkResult> {
        return this.db.transaction(async () => {
            const id = this.#teamId(teamId)
            const now = Date.now()
            const row = this.#row(id)
            const gen = (row?.gen ?? 0) + 1
            if (row) this.db.exec("UPDATE dir_team SET gen = ?, active = 1, updated_at = ? WHERE id = ?", gen, now, id)
            else this.db.exec("INSERT INTO dir_team (id, gen, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)", id, gen, now, now)
            return { ok: true, gen }
        })
    }

    /** Clears `active` only if nothing noted work since generation `gen` was read. */
    async noteIdle(teamId: string, gen: number): Promise<NoteIdleResult> {
        return this.db.transaction(async () => {
            const id = this.#teamId(teamId)
            const seen = parse(Gen, gen, "gen")
            const row = this.#row(id)
            if (!row || row.active === 0 || row.gen !== seen) return { ok: true, cleared: false }
            this.db.exec("UPDATE dir_team SET active = 0, updated_at = ? WHERE id = ?", Date.now(), id)
            return { ok: true, cleared: true }
        })
    }

    /** Active teams in id order, `limit` at a time; pass the previous page's `next` to continue. */
    async listActive(after: string | null, limit: number): Promise<DirectoryPage> {
        this.#assertSingleton()
        const from = parse(Cursor, after, "after") ?? ""
        const max = parse(Limit.max(DIRECTORY_PAGE_MAX), limit, "limit")
        const rows = this.db.exec<{ id: string; gen: number }>("SELECT id, gen FROM dir_team WHERE active = 1 AND id > ? ORDER BY id LIMIT ?", from, max)
        return { teams: rows.map(row => ({ teamId: row.id, gen: Number(row.gen) })), next: rows.length === max ? rows.at(-1)!.id : null }
    }

    async stats(): Promise<DirectoryStats> {
        this.#assertSingleton()
        const row = this.db.exec<{ teams: number; active: number | null }>("SELECT COUNT(*) AS teams, SUM(active) AS active FROM dir_team")[0]
        return { teams: Number(row?.teams ?? 0), active: Number(row?.active ?? 0) }
    }

    async onConnect(socket: Socket): Promise<void> {
        socket.reject(4003, "not available")
    }

    #teamId(teamId: string): string {
        this.#assertSingleton()
        return parse(TeamId, teamId, "teamId")
    }

    #row(id: string): { gen: number; active: number } | null {
        const row = this.db.exec<{ gen: number; active: number }>("SELECT gen, active FROM dir_team WHERE id = ?", id)[0]
        return row ? { gen: Number(row.gen), active: Number(row.active) } : null
    }

    #assertSingleton(): void {
        if (this.id !== DIRECTORY_ID) throw new Error(`invalid_argument: the team directory is the single actor "${DIRECTORY_ID}"`)
    }
}
