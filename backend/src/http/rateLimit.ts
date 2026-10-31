export interface BucketConfig {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

/**
 * `agentUpdate`, `agentStatus`, `agentDelegate` and `agentPeer` are per worker: system updates pushed to it, its
 * STATUS answers (architecture 9.8), its subagent requests (docs/subagents.md), and the peer protocol lines it posts
 * (CONTRACT). `agentActivity` is per task: the system lines Morrow posts in its thread (every one reaches every
 * worker in the channel, so they are capped).
 */
export type RateGroup = "auth" | "read" | "mutation" | "github" | "ticket" | "terminal" | "workerLog" | "agentUpdate" | "agentStatus" | "agentDelegate" | "agentPeer" | "agentActivity";

export const DEFAULT_LIMITS: Record<RateGroup, BucketConfig> = {
  auth: { capacity: 20, refillPerSecond: 20 / 60 },
  read: { capacity: 120, refillPerSecond: 2 },
  mutation: { capacity: 30, refillPerSecond: 0.5 },
  github: { capacity: 30, refillPerSecond: 0.5 },
  ticket: { capacity: 20, refillPerSecond: 20 / 60 },
  terminal: { capacity: 10, refillPerSecond: 10 / 60 },
  /** Each ended-worker log read can be a VM exec: a burst for flipping between workers, then 20 a minute. */
  workerLog: { capacity: 20, refillPerSecond: 20 / 60 },
  agentUpdate: { capacity: 6, refillPerSecond: 1 / 30 },
  agentStatus: { capacity: 2, refillPerSecond: 1 / 60 },
  agentDelegate: { capacity: 8, refillPerSecond: 1 / 15 },
  agentPeer: { capacity: 6, refillPerSecond: 1 / 60 },
  agentActivity: { capacity: 8, refillPerSecond: 1 / 30 },
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export type TakeResult = { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number };

/**
 * In-memory token buckets keyed by `<group>:<subject>`. Single instance only (architecture section 13).
 * Memory is bounded: idle full buckets are swept and the map is capped, evicting least recently used.
 */
export class RateLimiter {
  readonly #limits: Record<RateGroup, BucketConfig>;
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxKeys: number;
  readonly #now: () => number;
  #sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(options: { limits?: Partial<Record<RateGroup, BucketConfig>>; maxKeys?: number; now?: () => number } = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#maxKeys = options.maxKeys ?? 50_000;
    this.#now = options.now ?? Date.now;
  }

  take(group: RateGroup, subject: string, cost = 1): TakeResult {
    const config = this.#limits[group];
    const key = `${group}:${subject}`;
    const now = this.#now();
    const existing = this.#buckets.get(key);
    const bucket = existing ? this.#refilled(existing, config, now) : { tokens: config.capacity, updatedAt: now };
    // Re-insert to keep Map order as recency for LRU eviction.
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    if (this.#buckets.size > this.#maxKeys) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest !== undefined) this.#buckets.delete(oldest);
    }
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true, remaining: Math.floor(bucket.tokens) };
    }
    return { ok: false, retryAfterSeconds: Math.ceil((cost - bucket.tokens) / config.refillPerSecond) };
  }

  /** Drops buckets that have refilled completely; they carry no information. */
  sweep(): void {
    const now = this.#now();
    for (const [key, bucket] of this.#buckets) {
      const group = key.slice(0, key.indexOf(":")) as RateGroup;
      const config = this.#limits[group];
      if (this.#refilled(bucket, config, now).tokens >= config.capacity) this.#buckets.delete(key);
    }
  }

  start(intervalMs = 60_000): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => this.sweep(), intervalMs);
    this.#sweeper.unref?.();
  }

  stop(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  get size(): number {
    return this.#buckets.size;
  }

  #refilled(bucket: Bucket, config: BucketConfig, now: number): Bucket {
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    return { tokens: Math.min(config.capacity, bucket.tokens + elapsed * config.refillPerSecond), updatedAt: now };
  }
}
