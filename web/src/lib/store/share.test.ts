import { describe, expect, test } from "bun:test";
import { replaceEqualDeep } from "./share";

describe("replaceEqualDeep", () => {
  test("equal data returns the previous object", () => {
    const prev = { a: 1, b: [1, { c: "x" }], d: null };
    expect(replaceEqualDeep(prev, structuredClone(prev))).toBe(prev);
  });

  test("a change keeps the untouched branches", () => {
    const prev = { keep: { n: 1 }, list: [{ id: 1 }, { id: 2 }], change: { n: 1 } };
    const next = replaceEqualDeep(prev, { keep: { n: 1 }, list: [{ id: 1 }, { id: 3 }], change: { n: 2 } });
    expect(next).not.toBe(prev);
    expect(next.keep).toBe(prev.keep);
    expect(next.list).not.toBe(prev.list);
    expect(next.list[0]).toBe(prev.list[0]!);
    expect(next.change).toEqual({ n: 2 });
  });

  test("added, removed and reordered keys and items are changes", () => {
    const prev: Record<string, number> = { a: 1, b: 2 };
    expect(replaceEqualDeep(prev, { a: 1 })).toEqual({ a: 1 });
    expect(replaceEqualDeep(prev, { a: 1, b: 2, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
    // Same count, different keys: `undefined` on one side must not count as equal.
    expect(replaceEqualDeep({ a: 1, b: undefined }, { a: 1, c: undefined })).toEqual({ a: 1, c: undefined });
    const list = [1, 2, 3];
    expect(replaceEqualDeep(list, [1, 2])).toEqual([1, 2]);
    expect(replaceEqualDeep(list, [3, 2, 1])).toEqual([3, 2, 1]);
  });

  test("type changes and non-plain values take the new value", () => {
    expect(replaceEqualDeep([1], { 0: 1 })).toEqual({ 0: 1 });
    expect(replaceEqualDeep({ a: 1 }, null)).toBeNull();
    expect(replaceEqualDeep(null, { a: 1 })).toEqual({ a: 1 });
    const date = new Date(0);
    expect(replaceEqualDeep(new Date(0), date)).toBe(date);
  });
});
