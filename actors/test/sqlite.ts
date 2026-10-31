// An in-memory stand-in for an actor's `this.db` (bun:sqlite), for unit tests of code that only needs `exec`. It counts
// what write statements carry, so budgets can compare bytes written. Transactions and the runtime's restrictions are
// not modelled: store.integration.test.ts runs the same code on the real runtime.
import { Database } from "bun:sqlite"
import type { ActorDatabase, SqliteValue } from "durable-actors"

export type MemoryDatabase = ActorDatabase & {
    /** Bytes of text and blob values bound to write statements since the last `resetCounters`. */
    readonly writtenBytes: number
    readonly writeStatements: number
    /** Each write since the last `resetCounters`: the table it names and its bound values. */
    readonly writes: ReadonlyArray<{ table: string; bindings: SqliteValue[] }>
    resetCounters(): void
    close(): void
}

export function memoryDatabase(): MemoryDatabase {
    const sqlite = new Database(":memory:")
    let writtenBytes = 0
    let writeStatements = 0
    let writes: Array<{ table: string; bindings: SqliteValue[] }> = []
    return {
        exec<Row extends object = Record<string, SqliteValue>>(sql: string, ...bindings: SqliteValue[]): Row[] {
            if (!/^\s*SELECT\b/i.test(sql)) {
                writeStatements += 1
                writes.push({ table: /\b(?:INTO|FROM|UPDATE|TABLE IF NOT EXISTS|ON)\s+(\w+)/i.exec(sql)?.[1] ?? "?", bindings })
                for (const value of bindings) {
                    if (typeof value === "string") writtenBytes += Buffer.byteLength(value, "utf8")
                    else if (value instanceof Uint8Array) writtenBytes += value.byteLength
                    else if (value !== null) writtenBytes += 8
                }
            }
            return sqlite.query(sql).all(...(bindings as never[])) as Row[]
        },
        get writtenBytes() {
            return writtenBytes
        },
        get writeStatements() {
            return writeStatements
        },
        get writes() {
            return writes
        },
        resetCounters() {
            writtenBytes = 0
            writeStatements = 0
            writes = []
        },
        // Transactions are not modelled (see above): the operation runs and its writes stay.
        transaction<T>(operation: () => Promise<T>): Promise<T> {
            return operation()
        },
        close() {
            sqlite.close()
        }
    }
}
