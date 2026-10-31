import { afterEach, describe, expect, test } from "bun:test";
import type { TeamView } from "@morrow/contracts";
import { getTeamStore } from "./session";

const team = (name: string) => ({ id: "t-1", name }) as unknown as TeamView;
const scope = globalThis as { window?: unknown };

describe("getTeamStore", () => {
  afterEach(() => {
    delete scope.window;
  });

  test("on the server every render gets a fresh store seeded with its own team view", () => {
    expect(scope.window).toBeUndefined();
    const first = getTeamStore("t-1", team("Before"));
    const second = getTeamStore("t-1", team("After"));
    expect(second).not.toBe(first);
    expect(second.getState().team?.name).toBe("After");
    expect(first.getState().team?.name).toBe("Before");
  });

  test("in the browser the team's store is shared and keeps its first seed", () => {
    scope.window = {};
    const first = getTeamStore("t-browser", team("First"));
    const again = getTeamStore("t-browser", team("Ignored"));
    expect(again).toBe(first);
    expect(again.getState().team?.name).toBe("First");
  });
});
