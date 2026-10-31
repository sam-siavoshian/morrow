/** Runs at most one `fn` per key at a time; concurrent callers for the same key share its result. */
export class SingleFlight<T> {
  readonly #inflight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const run = Promise.resolve()
      .then(fn)
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, run);
    return run;
  }

  has(key: string): boolean {
    return this.#inflight.has(key);
  }

  /** Settles when every call in flight right now has settled. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#inflight.values()]);
  }
}

/** Serializes work per key: each call runs after the previous one for that key settled. */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }
}
