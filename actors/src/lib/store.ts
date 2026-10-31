// TeamWorkforce's large state in the actor's own SQLite (`this.db`), one row per record (schema v2).
//
// Schema v1 kept profiles, tasks, leases, the outbox and the idempotency ledger as five `@Persisted` fields. Each
// assignment rewrites that field's whole JSON value, and the runtime reads every persisted field before and after
// every call, so one trace entry on one task cost the whole task map twice over (test/store-budget.test.ts measures
// it at the caps). Here a transition writes only what it changed:
//  - profiles, leases and outbox items: one row each, rewritten when the object changed;
//  - tasks: one row per top-level field, so a status change does not rewrite the prompt and plan;
//  - a task's workstreams: one row per workstream, so one worker's progress does not rewrite the others' briefs;
//  - a task's trace and checkpoints: one row per entry, appended and pruned from the front;
//  - the ledger: one row per key, looked up by key instead of loaded.
// Changes are found by reference: the state machine (workforce.ts) never mutates a stored object, it replaces it, so
// an unchanged object is the same object. Insertion order is kept with SQLite rowids (an upsert keeps its rowid),
// so iteration order, and with it every tie-break, survives a reload.
//
// Every write goes through `db.exec`, which joins the calling method's transaction: under `@Atomic` (atomic.ts)
// a throw rolls back these rows together with the `@Persisted` fields (test/store.integration.test.ts).
import type { ActorDatabase, SqliteValue } from "durable-actors"
import { LEDGER_LIMIT, type LedgerEntry } from "./ledger.ts"
import type { CliProfile, Lease, OutboxItem, Task } from "./types.ts"

/** Schema v2 moved the records below out of `@Persisted` fields. */
export const SCHEMA_VERSION = 2

/** The record maps this store holds (the state machine's `WorkforceState` without the epoch). */
export type StoredRecords = {
    profiles: Record<string, CliProfile>
    tasks: Record<string, Task>
    leases: Record<string, Lease>
    outbox: Record<string, OutboxItem>
}

type RecordTable = "wf_profile" | "wf_lease" | "wf_outbox"
const RECORD_TABLES: ReadonlyArray<readonly [Exclude<keyof StoredRecords, "tasks">, RecordTable]> = [
    ["profiles", "wf_profile"],
    ["leases", "wf_lease"],
    ["outbox", "wf_outbox"]
]

/**
 * Task fields stored as one row per entry. `append` lists only grow at the end and lose entries at the front, so a row
 * keeps its `ord` for life; `position` lists are rewritten entry by entry at `ord` = index.
 */
const LISTS = { trace: "append", checkpoints: "append", workstreams: "position" } as const
type ListName = keyof typeof LISTS
const LIST_NAMES = Object.keys(LISTS) as ListName[]
const isList = (name: string): name is ListName => Object.hasOwn(LISTS, name)

const SCHEMA = [
    "CREATE TABLE IF NOT EXISTS wf_profile (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS wf_lease (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS wf_outbox (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS wf_task (id TEXT PRIMARY KEY NOT NULL)",
    "CREATE TABLE IF NOT EXISTS wf_task_field (task_id TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (task_id, name))",
    "CREATE TABLE IF NOT EXISTS wf_task_item (task_id TEXT NOT NULL, list TEXT NOT NULL, ord INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (task_id, list, ord))",
    "CREATE TABLE IF NOT EXISTS wf_ledger (key TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, fp TEXT NOT NULL, result TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS wf_ledger_seq ON wf_ledger (seq)"
]

const json = (value: unknown): string => JSON.stringify(value)

export class WorkforceStore {
    readonly #db: ActorDatabase
    /** Per `<taskId>\n<list>`: the `ord` of the list's first stored entry. Kept in step with every write. */
    readonly #firstOrd = new Map<string, number>()

    /** Creates the tables if missing. Synchronous and repeatable, so it is safe in a field initializer. */
    constructor(db: ActorDatabase) {
        this.#db = db
        for (const statement of SCHEMA) db.exec(statement)
    }

    // ---------- records ----------

    /** Every stored record, in insertion order. */
    load(): StoredRecords {
        const records: StoredRecords = { profiles: {}, tasks: {}, leases: {}, outbox: {} }
        for (const [field, table] of RECORD_TABLES) {
            const target = records[field] as Record<string, unknown>
            for (const row of this.#db.exec<{ id: string; body: string }>(`SELECT id, body FROM ${table} ORDER BY rowid`)) target[row.id] = JSON.parse(row.body)
        }

        const tasks: Record<string, Record<string, unknown>> = {}
        for (const row of this.#db.exec<{ id: string }>("SELECT id FROM wf_task ORDER BY rowid")) tasks[row.id] = {}
        for (const row of this.#db.exec<{ task_id: string; name: string; body: string }>("SELECT task_id, name, body FROM wf_task_field ORDER BY rowid")) {
            const task = tasks[row.task_id]
            if (task) task[row.name] = JSON.parse(row.body)
        }
        this.#firstOrd.clear()
        for (const task of Object.values(tasks)) for (const list of LIST_NAMES) task[list] = []
        for (const row of this.#db.exec<{ task_id: string; list: string; ord: number; body: string }>(
            "SELECT task_id, list, ord, body FROM wf_task_item ORDER BY task_id, list, ord"
        )) {
            const task = tasks[row.task_id]
            if (!task || !isList(row.list)) continue
            const entries = task[row.list] as unknown[]
            if (entries.length === 0) this.#firstOrd.set(listKey(row.task_id, row.list), row.ord)
            entries.push(JSON.parse(row.body))
        }
        records.tasks = tasks as unknown as Record<string, Task>
        return records
    }

    /** Writes what changed between `before` and `after`. Unchanged objects (same reference) cost nothing. */
    write(before: StoredRecords, after: StoredRecords): void {
        for (const [field, table] of RECORD_TABLES) if (before[field] !== after[field]) this.#writeRecords(table, before[field], after[field])
        if (before.tasks !== after.tasks) this.#writeTasks(before.tasks, after.tasks)
    }

    /** Replaces everything with `records` (the v1 to v2 upgrade). Repeatable: rows are upserted, then extras removed. */
    replaceAll(records: StoredRecords): void {
        const current = this.load()
        const empty: StoredRecords = { profiles: {}, tasks: {}, leases: {}, outbox: {} }
        // Write against an empty base so every row is (re)written, then drop rows that are no longer wanted.
        for (const [field, table] of RECORD_TABLES) {
            this.#writeRecords(table, empty[field], records[field])
            for (const id of Object.keys(current[field])) if (!(id in records[field])) this.#db.exec(`DELETE FROM ${table} WHERE id = ?`, id)
        }
        for (const id of Object.keys(current.tasks)) this.#deleteTask(id)
        this.#writeTasks({}, records.tasks)
    }

    #writeRecords(table: RecordTable, before: Record<string, unknown>, after: Record<string, unknown>): void {
        for (const id of Object.keys(before)) if (!(id in after)) this.#db.exec(`DELETE FROM ${table} WHERE id = ?`, id)
        for (const [id, record] of Object.entries(after)) {
            if (before[id] === record) continue
            this.#db.exec(`INSERT INTO ${table} (id, body) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body`, id, json(record))
        }
    }

    #writeTasks(before: Record<string, Task>, after: Record<string, Task>): void {
        for (const id of Object.keys(before)) if (!(id in after)) this.#deleteTask(id)
        for (const [id, task] of Object.entries(after)) {
            const old = before[id]
            if (old === task) continue
            if (!old) this.#db.exec("INSERT INTO wf_task (id) VALUES (?) ON CONFLICT (id) DO NOTHING", id)
            const prev = (old ?? {}) as Record<string, unknown>
            const next = task as Record<string, unknown>
            for (const name of new Set([...Object.keys(prev), ...Object.keys(next)])) {
                if (isList(name) || prev[name] === next[name]) continue
                if (next[name] === undefined) this.#db.exec("DELETE FROM wf_task_field WHERE task_id = ? AND name = ?", id, name)
                else
                    this.#db.exec(
                        "INSERT INTO wf_task_field (task_id, name, body) VALUES (?, ?, ?) ON CONFLICT (task_id, name) DO UPDATE SET body = excluded.body",
                        id,
                        name,
                        json(next[name])
                    )
            }
            for (const list of LIST_NAMES) {
                const before = (old?.[list] ?? []) as readonly unknown[]
                const after = (task[list] ?? []) as readonly unknown[]
                if (LISTS[list] === "append") this.#writeAppendList(id, list, before, after)
                else this.#writePositionList(id, list, before, after)
            }
        }
    }

    #deleteTask(id: string): void {
        this.#db.exec("DELETE FROM wf_task WHERE id = ?", id)
        this.#db.exec("DELETE FROM wf_task_field WHERE task_id = ?", id)
        this.#db.exec("DELETE FROM wf_task_item WHERE task_id = ?", id)
        for (const list of LIST_NAMES) this.#firstOrd.delete(listKey(id, list))
    }

    /**
     * `after` is normally `before` minus some entries at the front plus some at the end: only those rows are deleted
     * and inserted. Anything else (an entry replaced in the middle) rewrites the list under fresh ords.
     */
    #writeAppendList(taskId: string, list: ListName, before: readonly unknown[], after: readonly unknown[]): void {
        if (before === after) return
        const key = listKey(taskId, list)
        const first = this.#firstOrd.get(key) ?? 0
        const shift = alignment(before, after)
        if (shift === null) {
            this.#db.exec("DELETE FROM wf_task_item WHERE task_id = ? AND list = ?", taskId, list)
            const base = first + before.length
            after.forEach((entry, i) => this.#insertItem(taskId, list, base + i, entry))
            this.#firstOrd.set(key, base)
            return
        }
        const kept = Math.min(before.length - shift, after.length)
        if (shift > 0) this.#db.exec("DELETE FROM wf_task_item WHERE task_id = ? AND list = ? AND ord < ?", taskId, list, first + shift)
        // Entries dropped from the end (never done today, handled so the rows always match the list).
        if (before.length - shift > kept) this.#db.exec("DELETE FROM wf_task_item WHERE task_id = ? AND list = ? AND ord >= ?", taskId, list, first + shift + kept)
        for (let i = kept; i < after.length; i++) this.#insertItem(taskId, list, first + shift + i, after[i])
        this.#firstOrd.set(key, first + shift)
    }

    /** Rewrites the entries that changed (by reference) at their index and drops any past the new end. */
    #writePositionList(taskId: string, list: ListName, before: readonly unknown[], after: readonly unknown[]): void {
        if (before === after) return
        for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) this.#insertItem(taskId, list, i, after[i])
        if (before.length > after.length) this.#db.exec("DELETE FROM wf_task_item WHERE task_id = ? AND list = ? AND ord >= ?", taskId, list, after.length)
    }

    #insertItem(taskId: string, list: ListName, ord: number, entry: unknown): void {
        this.#db.exec(
            "INSERT INTO wf_task_item (task_id, list, ord, body) VALUES (?, ?, ?, ?) ON CONFLICT (task_id, list, ord) DO UPDATE SET body = excluded.body",
            taskId,
            list,
            ord,
            json(entry)
        )
    }

    // ---------- idempotency ledger ----------

    ledgerGet(key: string): LedgerEntry | undefined {
        const row = this.#db.exec<{ fp: string; result: string }>("SELECT fp, result FROM wf_ledger WHERE key = ?", key)[0]
        return row ? { key, fp: row.fp, result: JSON.parse(row.result) } : undefined
    }

    /** Records `entry` as the newest and keeps the newest `limit` (same policy as `ledgerRecord`). */
    ledgerPut(entry: LedgerEntry, limit = LEDGER_LIMIT): void {
        this.#db.exec(
            `INSERT INTO wf_ledger (key, seq, fp, result) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM wf_ledger), ?, ?)
             ON CONFLICT (key) DO UPDATE SET seq = excluded.seq, fp = excluded.fp, result = excluded.result`,
            entry.key,
            entry.fp,
            json(entry.result ?? null)
        )
        this.#db.exec("DELETE FROM wf_ledger WHERE seq <= (SELECT seq FROM wf_ledger ORDER BY seq DESC LIMIT 1 OFFSET ?)", limit)
    }

    ledgerSize(): number {
        return Number(this.#db.exec<{ n: SqliteValue }>("SELECT COUNT(*) AS n FROM wf_ledger")[0]?.n ?? 0)
    }

    /** Replaces the ledger with `entries` (oldest first), for the v1 to v2 upgrade. */
    replaceLedger(entries: readonly LedgerEntry[]): void {
        this.#db.exec("DELETE FROM wf_ledger")
        for (const entry of entries) this.ledgerPut(entry, Math.max(LEDGER_LIMIT, entries.length))
    }
}

function listKey(taskId: string, list: ListName): string {
    return `${taskId}\n${list}`
}

/**
 * How many entries `after` dropped from the front of `before`, when the rest of `before` lines up with the start of
 * `after` entry by entry (same objects). Null when they do not line up.
 */
export function alignment(before: readonly unknown[], after: readonly unknown[]): number | null {
    if (after.length === 0) return before.length
    const shift = before.indexOf(after[0])
    if (shift < 0) return before.length === 0 ? 0 : null
    const overlap = Math.min(before.length - shift, after.length)
    for (let i = 0; i < overlap; i++) if (before[shift + i] !== after[i]) return null
    return shift
}
