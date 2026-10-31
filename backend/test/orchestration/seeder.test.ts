import { describe, expect, test } from "bun:test";
import { silentLogger } from "../../src/lib/logger.ts";
import { createSeeder, SEED_RETRY_MS } from "../../src/orchestration/index.ts";

function harness(answers: (string[] | Error)[]) {
  let at = 0;
  let calls = 0;
  const tracked = new Set<string>();
  const seeder = createSeeder({
    listTeams: async () => {
      const answer = answers[Math.min(calls++, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    track: (id) => void tracked.add(id),
    now: () => at,
    reseedMs: 60_000,
    log: silentLogger,
  });
  return { seeder, tracked, calls: () => calls, advance: (ms: number) => void (at += ms) };
}

describe("team seeder", () => {
  test("an empty first answer is not final: teams that show up later are picked up on the next re-list", async () => {
    const h = harness([[], ["t-late"]]);
    await h.seeder.seed();
    expect(h.seeder.seeded()).toBe(true);
    expect(h.tracked.size).toBe(0);
    expect(h.seeder.seed()).toBeUndefined();
    h.advance(60_000);
    await h.seeder.seed();
    expect([...h.tracked]).toEqual(["t-late"]);
  });

  test("a failure waits SEED_RETRY_MS, not one tick, then tries again", async () => {
    const h = harness([new Error("control plane down"), ["t-1"]]);
    await h.seeder.seed();
    expect(h.seeder.seeded()).toBe(false);
    h.advance(SEED_RETRY_MS - 1);
    expect(h.seeder.seed()).toBeUndefined();
    h.advance(1);
    await h.seeder.seed();
    expect(h.seeder.seeded()).toBe(true);
    expect([...h.tracked]).toEqual(["t-1"]);
    expect(h.calls()).toBe(2);
  });

  test("one ask at a time", async () => {
    const h = harness([["t-1"]]);
    const first = h.seeder.seed();
    expect(h.seeder.seed()).toBeUndefined();
    await first;
    expect(h.calls()).toBe(1);
  });
});
