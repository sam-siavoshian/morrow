import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessageEvent } from "./classify";
import { buildTimelineRows, ALL_MESSAGES } from "./classify";
import { readableText } from "./conversation";
import { buildDirectory, readableNames } from "./directory";
import { distanceFromEnd, windowStart } from "./relay-timeline";
import { TimelineRowView } from "./rows";

const names = buildDirectory(null, null).displayName;

describe("raw worker names never reach the screen", () => {
  test("bare names in free text read as display names", () => {
    expect(readableNames("w-mvwx9xi7-core-e1 hit its usage limit. Checkpointed at 3f9a2c1", names)).toBe("Core hit its usage limit. Checkpointed at 3f9a2c1");
    expect(readableNames("w-ab12-cli-sub-e1 finished for w-ab12-cli-e1: 14 tests", names)).toBe("CLI helper finished for CLI: 14 tests");
    expect(readableNames("handing w-ab12-web-ui-e10 over (w-ab12-api-e2).", names)).toBe("handing Web UI #10 over (API #2).");
  });

  test("leaves everything else alone", () => {
    for (const text of ["", "no names here", "branch morrow/ab12/core", "new-w-ab12-core-e1x", "w-", "aw-ab12-core-e1", "lease ls-ab12-core", "w-ab12-core-e1b", "mail@w-ab12-core-e1", "refs/w-ab12-core-e1"]) {
      expect(readableNames(text, names)).toBe(text);
    }
  });

  test("chat text: @mentions and bare names both read as display names", () => {
    expect(readableText("@w-ab12-api-e2 took over from w-ab12-api-e1", [], names)).toBe("@API #2 took over from API");
  });

  test("a system line in the feed shows the display name", () => {
    const event: MessageEvent = {
      type: "message",
      id: "m1",
      channel: "proj-abc",
      conversationId: null,
      threadId: null,
      parentId: null,
      from: { name: "morrow", kind: "system" },
      text: "w-mvwx9xi7-core-e1 hit its usage limit. Checkpointed at 3f9a2c1, handing core to Maya's Claude Code",
      mentions: [],
      createdAt: 1,
    };
    const rows = buildTimelineRows([event], ALL_MESSAGES);
    const html = rows.map((row) => renderToStaticMarkup(createElement(TimelineRowView, { row, directory: buildDirectory(null, null), expanded: false, onToggle: () => {} }))).join("");
    expect(html).toContain("Core hit its usage limit");
    expect(html).not.toContain("w-mvwx9xi7");
  });
});

describe("timeline scrolling", () => {
  test("distance from the end", () => {
    expect(distanceFromEnd({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(0);
    expect(distanceFromEnd({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })).toBe(100);
    // Overscroll (rubber band) never reads as negative.
    expect(distanceFromEnd({ scrollTop: 700, scrollHeight: 1000, clientHeight: 400 })).toBe(0);
  });

  test("the window is the newest rows", () => {
    expect(windowStart(10, 150)).toBe(0);
    expect(windowStart(400, 150)).toBe(250);
    expect(windowStart(400, 450)).toBe(0);
    expect(windowStart(5, -1)).toBe(5);
  });
});
