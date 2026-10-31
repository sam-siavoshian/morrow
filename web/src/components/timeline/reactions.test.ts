import { describe, expect, test } from "bun:test";
import { mergeReactions, reactedBy } from "./reactions";

const API = "w-abc12345-api-e1";
const WEB = "w-abc12345-web-e1";
const QA = "w-abc12345-qa-e2";

describe("mergeReactions", () => {
  test("no history and no marks shows nothing", () => {
    expect(mergeReactions(undefined, undefined)).toEqual([]);
    expect(mergeReactions([], {})).toEqual([]);
  });

  test("history alone is shown as reported, zero-count groups hidden", () => {
    expect(
      mergeReactions(
        [
          { emoji: "👍", count: 2, agents: [API, WEB] },
          { emoji: "👀", count: 0, agents: [] },
        ],
        undefined,
      ),
    ).toEqual([{ emoji: "👍", count: 2, agents: [API, WEB] }]);
  });

  test("a live add bumps the count; a new emoji goes after history's, in arrival order", () => {
    const out = mergeReactions([{ emoji: "👍", count: 1, agents: [API] }], { "👍": { [WEB]: true }, "🚀": { [QA]: true }, "✅": { [API]: true } });
    expect(out.map((c) => [c.emoji, c.count])).toEqual([
      ["👍", 2],
      ["🚀", 1],
      ["✅", 1],
    ]);
    expect(out[0]!.agents).toEqual([API, WEB]);
  });

  test("a mark history already reflects changes nothing (no double count)", () => {
    expect(mergeReactions([{ emoji: "👍", count: 1, agents: [API] }], { "👍": { [API]: true } })).toEqual([{ emoji: "👍", count: 1, agents: [API] }]);
    expect(mergeReactions([{ emoji: "👍", count: 1, agents: [API] }], { "👍": { [WEB]: false } })).toEqual([{ emoji: "👍", count: 1, agents: [API] }]);
  });

  test("a live remove drops the agent; a group that reaches 0 is hidden", () => {
    expect(mergeReactions([{ emoji: "👍", count: 2, agents: [API, WEB] }], { "👍": { [API]: false } })).toEqual([{ emoji: "👍", count: 1, agents: [WEB] }]);
    expect(mergeReactions([{ emoji: "👍", count: 1, agents: [API] }], { "👍": { [API]: false } })).toEqual([]);
  });

  test("add then remove live (net false) shows nothing", () => {
    expect(mergeReactions(undefined, { "🎉": { [API]: false } })).toEqual([]);
  });

  test("history counts beyond the listed agents are kept and never go negative", () => {
    expect(mergeReactions([{ emoji: "👍", count: 5, agents: [API] }], { "👍": { [API]: false } })).toEqual([{ emoji: "👍", count: 4, agents: [] }]);
  });

  test("does not mutate its inputs", () => {
    const base = [{ emoji: "👍", count: 1, agents: [API] }];
    mergeReactions(base, { "👍": { [WEB]: true, [API]: false } });
    expect(base).toEqual([{ emoji: "👍", count: 1, agents: [API] }]);
  });
});

describe("reactedBy", () => {
  const name = (n: string) => n.replace("w-abc12345-", "").replace("-", " ");
  test("lists display names, never raw ids", () => {
    expect(reactedBy({ emoji: "👍", count: 1, agents: [API] }, name)).toBe("api e1");
    expect(reactedBy({ emoji: "👍", count: 2, agents: [API, WEB] }, name)).toBe("api e1 and web e1");
    expect(reactedBy({ emoji: "👍", count: 3, agents: [API, WEB, QA] }, name)).toBe("api e1, web e1 and qa e2");
    expect(reactedBy({ emoji: "👍", count: 4, agents: [API] }, name)).toBe("api e1 and 3 more");
    expect(reactedBy({ emoji: "👍", count: 2, agents: [] }, name)).toBe("2 agents");
  });
});
