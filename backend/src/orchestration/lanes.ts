// Bounded, per-team concurrency for background work. A job is keyed (e.g. "claim", "spawn:<itemId>"); a key that
// is already running is skipped, never queued twice. Each team has its own cap and the whole process a global
// one, so one slow vendor call for team A never stalls team B.
import type { Logger } from "../lib/logger.ts";

export interface LaneLimits {
  perTeam: number;
  global: number;
}

export class Lanes {
  readonly #limits: LaneLimits;
  readonly #log: Logger;
  readonly #running = new Map<string, Promise<void>>();
  readonly #perTeam = new Map<string, number>();
  #total = 0;
  #closed = false;

  constructor(limits: LaneLimits, log: Logger) {
    this.#limits = limits;
    this.#log = log;
  }

  /** Whether `key` is running for `teamId`. */
  busy(teamId: string, key: string): boolean {
    return this.#running.has(`${teamId}\u0000${key}`);
  }

  /** Free slots for a team right now. */
  free(teamId: string): number {
    return Math.max(0, Math.min(this.#limits.perTeam - (this.#perTeam.get(teamId) ?? 0), this.#limits.global - this.#total));
  }

  /**
   * Starts `fn` unless the key is already running, the lanes are closed, or there is no free slot.
   * Returns whether it started. Errors are logged, never thrown.
   */
  run(teamId: string, key: string, fn: () => Promise<unknown>): boolean {
    const id = `${teamId}\u0000${key}`;
    if (this.#closed || this.#running.has(id) || this.free(teamId) === 0) return false;
    this.#total += 1;
    this.#perTeam.set(teamId, (this.#perTeam.get(teamId) ?? 0) + 1);
    const job = (async () => {
      try {
        await fn();
      } catch (error) {
        this.#log.error("background job failed", { teamId, job: key.split(":")[0], error });
      } finally {
        this.#total -= 1;
        const left = (this.#perTeam.get(teamId) ?? 1) - 1;
        if (left <= 0) this.#perTeam.delete(teamId);
        else this.#perTeam.set(teamId, left);
        this.#running.delete(id);
      }
    })();
    this.#running.set(id, job);
    return true;
  }

  get size(): number {
    return this.#total;
  }

  /** Stops new work and waits (up to `timeoutMs`) for running jobs. Returns how many were still running. */
  async drain(timeoutMs: number): Promise<number> {
    this.#closed = true;
    const all = Promise.allSettled([...this.#running.values()]);
    await Promise.race([all, Bun.sleep(timeoutMs)]);
    return this.#running.size;
  }
}
