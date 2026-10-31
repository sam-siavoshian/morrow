// Idempotency ledger: request keys and event ids with the result they produced. Stored as an array (newest last)
// so pruning keeps insertion order; object keys would reorder integer-like ids.

export const LEDGER_LIMIT = 500

export type LedgerEntry = {
    key: string
    /** Fingerprint of the arguments for request keys; empty for event ids (an event id is the event). */
    fp: string
    result: unknown
}

export type Ledger = LedgerEntry[]

export function ledgerLookup(ledger: readonly LedgerEntry[], key: string): LedgerEntry | undefined {
    for (let i = ledger.length - 1; i >= 0; i--) if (ledger[i]!.key === key) return ledger[i]
    return undefined
}

export function ledgerRecord(ledger: readonly LedgerEntry[], entry: LedgerEntry, limit = LEDGER_LIMIT): Ledger {
    const next = [...ledger.filter(existing => existing.key !== entry.key), entry]
    return next.length > limit ? next.slice(next.length - limit) : next
}

/** Stable fingerprint of JSON arguments (sorted keys, 53-bit hash). Detects a key reused with different arguments. */
export function fingerprint(value: unknown): string {
    return cyrb53(stableJson(value)).toString(36)
}

export function stableJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`
}

function cyrb53(input: string, seed = 0): number {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < input.length; i++) {
        const ch = input.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}
