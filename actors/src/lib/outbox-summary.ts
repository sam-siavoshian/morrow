// The small emitted summary of TeamWorkforce's outbox. The backend holds a socket to each tracked team and claims
// when this says something is due, instead of calling claimOutbox on a timer.
//
// Type-only imports on purpose: TeamWorkforce emits this type, so the generated client's type bundle compiles this
// file as source (see directory.ts for why a `.ts` value import would break that build).
import type { OutboxItem } from "./types.ts"

export type OutboxSummary = {
    /** Pending or inflight items. */
    open: number
    /**
     * Earliest time claimOutbox would act on an item: a pending item's `nextAt` once its blocker allows it, or an
     * inflight item's `claimedUntil` (its claim expires and it is retried). Null when nothing open can become due
     * without another call changing the outbox first, which emits a new summary anyway.
     */
    nextDueAt: number | null
}

export const EMPTY_OUTBOX_SUMMARY: OutboxSummary = { open: 0, nextDueAt: null }

const isOpen = (item: OutboxItem): boolean => item.state === "pending" || item.state === "inflight"

// Same rule as workforce.ts `isUnblocked`; the cross-check test in outbox-summary.test.ts keeps them in step.
function unblocked(outbox: Readonly<Record<string, OutboxItem>>, item: OutboxItem): boolean {
    if (!item.blockedBy) return true
    const blocker = outbox[item.blockedBy]
    if (!blocker || blocker.state === "done") return true
    if (blocker.state === "failed" || blocker.state === "cancelled") return !item.hardBlock
    return false
}

export function summarizeOutbox(outbox: Readonly<Record<string, OutboxItem>>): OutboxSummary {
    let open = 0
    let nextDueAt: number | null = null
    for (const item of Object.values(outbox)) {
        if (!isOpen(item)) continue
        open++
        const due =
            item.state === "pending" ? (unblocked(outbox, item) ? item.nextAt : null) : (item.claimedUntil ?? 0)
        if (due !== null && (nextDueAt === null || due < nextDueAt)) nextDueAt = due
    }
    return { open, nextDueAt }
}
