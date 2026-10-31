// `@Atomic`: runs an actor method in one SQLite transaction, so a throw rolls back its `db.exec` rows and its
// `@Persisted` writes together. durable-actors 0.14.5 removed its own decorator; outside `db.transaction` every
// statement autocommits, so without this a method that throws halfway keeps the writes made before the throw.
// src/lib/directory.ts cannot import this (see its header) and calls `db.transaction` itself.
import type { Actor } from "durable-actors"

export function Atomic<This extends Actor, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Promise<Result>,
    _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Result>>
): (this: This, ...args: Args) => Promise<Result> {
    // An async function: the runtime refuses an actor method that is not one.
    return async function (this: This, ...args: Args): Promise<Result> {
        return this.db.transaction(() => method.apply(this, args))
    }
}
