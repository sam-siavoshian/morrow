import { describe, expect, test } from "bun:test";
import { KeyedMutex, SingleFlight } from "../../src/runtime/keyed.ts";
import { TicketStore } from "../../src/realtime/tickets.ts";

describe("SingleFlight", () => {
  test("concurrent callers for one key share one run; other keys run on their own", async () => {
    const flights = new SingleFlight<number>();
    let runs = 0;
    const work = async () => {
      runs++;
      await Bun.sleep(10);
      return runs;
    };
    const results = await Promise.all([flights.run("a", work), flights.run("a", work), flights.run("b", work)]);
    expect(runs).toBe(2);
    expect(results[0]).toBe(results[1]);
    expect(flights.has("a")).toBe(false);
    expect(await flights.run("a", work)).toBe(3);
  });

  test("a failure is shared, then the key is free again", async () => {
    const flights = new SingleFlight<void>();
    const boom = () => Promise.reject(new Error("boom"));
    const both = await Promise.allSettled([flights.run("k", boom), flights.run("k", boom)]);
    expect(both.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    await expect(flights.run("k", async () => {})).resolves.toBeUndefined();
  });
});

describe("KeyedMutex", () => {
  test("serializes per key, even after a failure; different keys overlap", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const step = (name: string, ms: number, fail = false) => async () => {
      log.push(`${name}:start`);
      await Bun.sleep(ms);
      log.push(`${name}:end`);
      if (fail) throw new Error(name);
    };
    await Promise.allSettled([mutex.run("k", step("a", 15, true)), mutex.run("k", step("b", 1)), mutex.run("other", step("c", 1))]);
    expect(log.indexOf("a:end")).toBeLessThan(log.indexOf("b:start"));
    expect(log.indexOf("c:end")).toBeLessThan(log.indexOf("a:end"));
  });
});

describe("TicketStore purposes", () => {
  test("an inspect ticket carries its lease and opens nothing else", () => {
    const store = new TicketStore();
    const inspect = store.issue("u-1", "t-1", { purpose: "inspect", leaseId: "l-1" }).ticket;
    expect(store.consume(inspect, "inspect")).toMatchObject({ userId: "u-1", teamId: "t-1", leaseId: "l-1" });
    expect(store.consume(inspect, "inspect")).toBeNull();

    const misused = store.issue("u-1", "t-1", { purpose: "inspect", leaseId: "l-1" }).ticket;
    expect(store.consume(misused)).toBeNull();
    // Burned by the wrong use.
    expect(store.consume(misused, "inspect")).toBeNull();

    const realtime = store.issue("u-1", "t-1").ticket;
    expect(store.consume(realtime, "inspect")).toBeNull();
    expect(store.consume(realtime)).toBeNull();
  });
});
