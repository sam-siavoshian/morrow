import { randomToken, sha256Hex } from "../lib/crypto.ts";

export const TICKET_TTL_MS = 30_000;

export interface Ticket {
  userId: string;
  teamId: string;
  expiresAt: number;
  /** Only on inspect tickets: the one lease they open. */
  leaseId?: string;
}

/**
 * What a ticket may open. A `/realtime` ticket cannot be replayed on `/realtime/inspect`, and an
 * inspect ticket opens only the lease it was issued for.
 */
export type TicketScope = { purpose: "realtime" } | { purpose: "inspect"; leaseId: string };

interface StoredTicket extends Ticket {
  purpose: TicketScope["purpose"];
}

/**
 * Single-use, short-lived realtime tickets bound to one user and one team. Stored by SHA-256 so a heap
 * dump does not hand out live tickets. In memory: single backend instance (architecture section 13).
 */
export class TicketStore {
  readonly #tickets = new Map<string, StoredTicket>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxTotal: number;
  readonly #maxPerUser: number;
  #sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(options: { now?: () => number; ttlMs?: number; maxTotal?: number; maxPerUser?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? TICKET_TTL_MS;
    this.#maxTotal = options.maxTotal ?? 20_000;
    this.#maxPerUser = options.maxPerUser ?? 10;
  }

  issue(userId: string, teamId: string, scope: TicketScope = { purpose: "realtime" }): { ticket: string; expiresAt: number } {
    this.sweep();
    const mine = [...this.#tickets].filter(([, t]) => t.userId === userId);
    // Oldest first (Map preserves insertion order): a user spamming tickets only invalidates their own.
    for (const [hash] of mine.slice(0, Math.max(0, mine.length - this.#maxPerUser + 1))) this.#tickets.delete(hash);
    while (this.#tickets.size >= this.#maxTotal) {
      const oldest = this.#tickets.keys().next().value;
      if (oldest === undefined) break;
      this.#tickets.delete(oldest);
    }
    const ticket = randomToken(32);
    const expiresAt = this.#now() + this.#ttlMs;
    const stored: StoredTicket = { userId, teamId, expiresAt, purpose: scope.purpose };
    if (scope.purpose === "inspect") stored.leaseId = scope.leaseId;
    this.#tickets.set(sha256Hex(ticket), stored);
    return { ticket, expiresAt };
  }

  /**
   * Returns the binding and deletes the ticket. Null when unknown, used, expired, or issued for another
   * purpose (a mismatched ticket is still burned: single use means single use).
   */
  consume(ticket: string | null | undefined, purpose: TicketScope["purpose"] = "realtime"): Ticket | null {
    if (!ticket || ticket.length > 128) return null;
    const hash = sha256Hex(ticket);
    const entry = this.#tickets.get(hash);
    if (!entry) return null;
    this.#tickets.delete(hash);
    if (entry.purpose !== purpose || entry.expiresAt <= this.#now()) return null;
    const { purpose: _purpose, ...binding } = entry;
    return binding;
  }

  /** Burns every unused ticket a user holds (for one team, or all). Returns how many. */
  revokeUser(userId: string, teamId?: string): number {
    let revoked = 0;
    for (const [hash, t] of this.#tickets) {
      if (t.userId === userId && (teamId === undefined || t.teamId === teamId)) {
        this.#tickets.delete(hash);
        revoked++;
      }
    }
    return revoked;
  }

  sweep(): void {
    const now = this.#now();
    for (const [hash, t] of this.#tickets) if (t.expiresAt <= now) this.#tickets.delete(hash);
  }

  start(intervalMs = 30_000): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => this.sweep(), intervalMs);
    this.#sweeper.unref?.();
  }

  stop(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  get size(): number {
    return this.#tickets.size;
  }
}
