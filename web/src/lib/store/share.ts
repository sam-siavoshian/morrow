/**
 * Structural sharing for JSON data (TanStack Query's replaceEqualDeep): returns `next`, except that every part
 * deep-equal to the same part of `prev` is `prev`'s object. A server frame that changed one task then hands
 * every other task, lease and profile back with its old identity, so selectors and memoized rows skip them,
 * and a frame that changed nothing returns `prev` itself.
 */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
  if (prev === next) return next;
  const arrays = Array.isArray(prev) && Array.isArray(next);
  if (!arrays && !(isPlainObject(prev) && isPlainObject(next))) return next;

  const before = prev as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = arrays ? null : Object.keys(after);
  const size = arrays ? (next as unknown[]).length : keys!.length;
  const prevSize = arrays ? (prev as unknown[]).length : Object.keys(before).length;
  const copy: Record<string, unknown> | unknown[] = arrays ? [] : {};
  let equal = 0;
  for (let i = 0; i < size; i++) {
    const key = arrays ? i : keys![i]!;
    const value = replaceEqualDeep(before[key as string], after[key as string]);
    (copy as Record<string | number, unknown>)[key] = value;
    if (value === before[key as string] && (arrays || Object.hasOwn(before, key))) equal++;
  }
  return (size === prevSize && equal === size ? prev : copy) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
