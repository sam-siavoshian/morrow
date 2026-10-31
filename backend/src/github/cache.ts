// Conditional-request cache for GitHub reads. Every entry is keyed by the member whose token read it (GitHub answers
// each person by their own permissions, so one member's copy is never served to another) and the API path. Reads
// revalidate with If-None-Match: a 304 costs no rate limit. While a member's limit is spent, or GitHub is down, the
// last good copy is served marked stale; with no copy the error goes up. Memory is bounded by entries and bytes, and
// losing it all (a restart) only means the next reads go to GitHub again.
import { GithubError, type ConditionalResponse, type GithubRate } from "../integrations/github/client.ts";

export interface CachedRead {
  body: unknown;
  link: string | null;
  fetchedAt: number;
  stale: boolean;
  rateLimitedUntil: number | null;
  /** The token's scopes from the last response, when GitHub sent them. */
  scopes: string[] | null;
}

interface Entry {
  etag: string | null;
  body: unknown;
  link: string | null;
  bytes: number;
  fetchedAt: number;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  hits: number;
  notModified: number;
  fetched: number;
  stale: number;
}

export type ConditionalGet = (token: string, path: string, etag: string | null) => Promise<ConditionalResponse>;

export interface GithubCacheOptions {
  get: ConditionalGet;
  now: () => number;
  maxEntries?: number;
  maxBytes?: number;
  /** Reads newer than this are answered from memory without asking GitHub (dedupes bursts of refetches). */
  freshMs?: number;
  /** Below this many requests left, background polling for the member pauses until the reset. */
  lowWater?: number;
}

/** Most users at once whose rate state is remembered (oldest dropped first). */
const MAX_RATE_STATES = 5_000;

export class GithubCache {
  readonly #o: Required<GithubCacheOptions>;
  readonly #entries = new Map<string, Entry>();
  readonly #inflight = new Map<string, Promise<CachedRead>>();
  /** Per user: rate limited until (hard stop), budget low until (polling pauses). */
  readonly #limited = new Map<string, number>();
  readonly #low = new Map<string, number>();
  readonly #scopes = new Map<string, string[]>();
  #bytes = 0;
  readonly #stats = { hits: 0, notModified: 0, fetched: 0, stale: 0 };

  constructor(options: GithubCacheOptions) {
    this.#o = {
      ...options,
      maxEntries: options.maxEntries ?? 2_000,
      maxBytes: options.maxBytes ?? 32 * 1024 * 1024,
      freshMs: options.freshMs ?? 5_000,
      lowWater: options.lowWater ?? 200,
    };
  }

  /** A read through the cache. Concurrent identical reads share one request. */
  read(userId: string, token: string, path: string): Promise<CachedRead> {
    const key = `${userId}\u0000${path}`;
    const running = this.#inflight.get(key);
    if (running) return running;
    const task = this.#read(key, userId, token, path).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, task);
    return task;
  }

  /** Forgets every copy of paths under `prefix` (for all users), e.g. after a write changed them. */
  invalidate(prefix: string): void {
    for (const [key, entry] of this.#entries) {
      if (key.slice(key.indexOf("\u0000") + 1).startsWith(prefix)) this.#drop(key, entry);
    }
  }

  /** Whether background work should leave this member's GitHub budget alone right now. */
  budgetLow(userId: string): boolean {
    const now = this.#o.now();
    return (this.#limited.get(userId) ?? 0) > now || (this.#low.get(userId) ?? 0) > now;
  }

  /** The member's token scopes from GitHub's last answer, or null when GitHub never said. */
  scopesOf(userId: string): string[] | null {
    return this.#scopes.get(userId) ?? null;
  }

  rateLimitedUntil(userId: string): number | null {
    const until = this.#limited.get(userId) ?? 0;
    return until > this.#o.now() ? until : null;
  }

  stats(): CacheStats {
    return { entries: this.#entries.size, bytes: this.#bytes, ...this.#stats };
  }

  async #read(key: string, userId: string, token: string, path: string): Promise<CachedRead> {
    const now = this.#o.now();
    const entry = this.#entries.get(key);
    const limitedUntil = this.rateLimitedUntil(userId);
    if (entry && now - entry.fetchedAt < this.#o.freshMs) {
      this.#stats.hits++;
      return this.#answer(entry, userId, false, limitedUntil);
    }
    if (limitedUntil !== null) {
      if (entry) return this.#serveStale(entry, userId, limitedUntil);
      throw new GithubError("rate_limited", "rate limited (backing off)", 403, Math.ceil((limitedUntil - now) / 1000));
    }
    let res: ConditionalResponse;
    try {
      res = await this.#o.get(token, path, entry?.etag ?? null);
    } catch (error) {
      if (error instanceof GithubError && error.kind === "rate_limited") {
        const until = this.#o.now() + (error.retryAfterSeconds ?? 60) * 1000;
        this.#remember(this.#limited, userId, until);
        if (entry) return this.#serveStale(entry, userId, until);
      } else if (error instanceof GithubError && error.kind === "unavailable" && entry) {
        return this.#serveStale(entry, userId, null);
      } else if (entry && error instanceof GithubError && (error.kind === "not_found" || error.kind === "forbidden" || error.kind === "unauthorized")) {
        // Access is gone: the old copy must not outlive it.
        this.#drop(key, entry);
      }
      throw error;
    }
    this.#noteRate(userId, res.rate);
    if (res.status === 304 && entry) {
      this.#stats.notModified++;
      entry.fetchedAt = this.#o.now();
      this.#touch(key, entry);
      return this.#answer(entry, userId, false, null);
    }
    if (res.status === 304) throw new GithubError("bad_response", "304 without a cached copy", 304);
    this.#stats.fetched++;
    const next: Entry = { etag: res.etag, body: res.body, link: res.link, bytes: res.bytes, fetchedAt: this.#o.now() };
    if (entry) this.#drop(key, entry);
    // A single huge answer is returned but not kept: it would push out everything else.
    if (res.etag && res.bytes <= this.#o.maxBytes / 8) this.#store(key, next);
    return this.#answer(next, userId, false, null);
  }

  #serveStale(entry: Entry, userId: string, until: number | null): CachedRead {
    this.#stats.stale++;
    return this.#answer(entry, userId, true, until);
  }

  #answer(entry: Entry, userId: string, stale: boolean, rateLimitedUntil: number | null): CachedRead {
    return { body: entry.body, link: entry.link, fetchedAt: entry.fetchedAt, stale, rateLimitedUntil, scopes: this.#scopes.get(userId) ?? null };
  }

  #noteRate(userId: string, rate: GithubRate): void {
    if (rate.scopes) this.#remember(this.#scopes, userId, rate.scopes);
    if (rate.remaining !== null && rate.resetAt !== null && rate.remaining < this.#o.lowWater) this.#remember(this.#low, userId, rate.resetAt);
    else this.#low.delete(userId);
  }

  #remember<V>(map: Map<string, V>, userId: string, value: V): void {
    map.delete(userId);
    map.set(userId, value);
    if (map.size > MAX_RATE_STATES) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  #store(key: string, entry: Entry): void {
    this.#entries.set(key, entry);
    this.#bytes += entry.bytes;
    while (this.#entries.size > this.#o.maxEntries || this.#bytes > this.#o.maxBytes) {
      const oldest = this.#entries.entries().next().value;
      if (!oldest) break;
      this.#drop(oldest[0], oldest[1]);
    }
  }

  #touch(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  #drop(key: string, entry: Entry): void {
    if (this.#entries.get(key) !== entry) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }
}
