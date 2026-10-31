import { afterEach, describe, expect, test } from "bun:test";
import { carryToast, clearCarriedToast, MAX_AGE_MS, parseCarriedToast, peekCarriedToast } from "./carried-toast";

const NOW = 1_800_000_000_000;
const stored = (value: Record<string, unknown>) => JSON.stringify({ at: NOW, ...value });

describe("parseCarriedToast", () => {
  test("reads what carryToast writes", () => {
    expect(parseCarriedToast(stored({ kind: "error", title: "You no longer have access to this team." }), NOW)).toEqual({
      kind: "error",
      title: "You no longer have access to this team.",
    });
    expect(parseCarriedToast(stored({ kind: "success", title: "  You joined Acme  " }), NOW + 1000)).toEqual({ kind: "success", title: "You joined Acme" });
  });

  test("a stale entry, or one from the future, is never shown", () => {
    const raw = stored({ kind: "neutral", title: "You left Acme" });
    expect(parseCarriedToast(raw, NOW + MAX_AGE_MS)).not.toBeNull();
    expect(parseCarriedToast(raw, NOW + MAX_AGE_MS + 1)).toBeNull();
    expect(parseCarriedToast(raw, NOW - 1)).toBeNull();
  });

  test("refuses anything else", () => {
    const bad = [
      null,
      "",
      "not json",
      "null",
      "[]",
      '"text"',
      stored({ kind: "warning", title: "x" }),
      stored({ kind: "__proto__", title: "x" }),
      stored({ kind: "error" }),
      stored({ kind: "error", title: 42 }),
      stored({ kind: "error", title: "   " }),
      stored({ kind: "error", title: "x".repeat(201) }),
      stored({ kind: "error", title: "x", at: "soon" }),
      stored({ kind: "error", title: "x", at: Number.NaN }),
      JSON.stringify({ kind: "error", title: "no timestamp" }),
      "x".repeat(2000),
    ];
    for (const raw of bad) expect(parseCarriedToast(raw, NOW)).toBeNull();
  });
});

describe("carryToast / peekCarriedToast / clearCarriedToast", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  function fakeStorage(): Map<string, string> {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    };
    Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
    return data;
  }

  test("a page that leaves before clearing hands the toast to the next one; clearing ends it", () => {
    const data = fakeStorage();
    carryToast("neutral", "You left Acme", NOW);
    expect(peekCarriedToast(NOW + 100)).toEqual({ kind: "neutral", title: "You left Acme" });
    // The landing page redirected with a full load before the toast counted as seen.
    expect(peekCarriedToast(NOW + 900)).toEqual({ kind: "neutral", title: "You left Acme" });
    clearCarriedToast();
    expect(data.size).toBe(0);
    expect(peekCarriedToast(NOW + 1000)).toBeNull();
  });

  test("a stale or tampered value is dropped, not shown", () => {
    const data = fakeStorage();
    carryToast("error", "Old news", NOW);
    expect(peekCarriedToast(NOW + MAX_AGE_MS + 1)).toBeNull();
    expect(data.size).toBe(0);
    data.set("morrow:carried-toast", stored({ kind: "error", title: { html: "<b>x</b>" } }));
    expect(peekCarriedToast(NOW)).toBeNull();
    expect(data.size).toBe(0);
  });

  test("storage that throws (private mode, blocked) never breaks the caller", () => {
    const fail = () => {
      throw new Error("SecurityError");
    };
    Object.defineProperty(globalThis, "sessionStorage", { value: { getItem: fail, setItem: fail, removeItem: fail }, configurable: true });
    expect(() => carryToast("error", "x")).not.toThrow();
    expect(peekCarriedToast()).toBeNull();
    expect(() => clearCarriedToast()).not.toThrow();
  });
});
