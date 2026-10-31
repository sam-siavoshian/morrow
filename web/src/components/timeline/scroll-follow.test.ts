import { describe, expect, test } from "bun:test";
import { newSince } from "./relay-timeline";
import { anchorShift, distanceFromEnd, FOLLOW_THRESHOLD_PX, followAfterScroll, isNearEnd } from "./scroll-follow";

const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight });

describe("scroll follow", () => {
  test("distance from the end never goes negative (overscroll, rounding)", () => {
    expect(distanceFromEnd(at(1500))).toBe(0);
    expect(distanceFromEnd(at(1400))).toBe(100);
    expect(distanceFromEnd(at(1600))).toBe(0);
  });

  test("near the end means within the threshold, inclusive", () => {
    expect(FOLLOW_THRESHOLD_PX).toBe(120);
    expect(isNearEnd(at(1500 - 120))).toBe(true);
    expect(isNearEnd(at(1500 - 121))).toBe(false);
  });

  test("a new message growing the content under a following reader keeps following", () => {
    // Was at the end (top 1500 of 2000); a 400px message landed: now 400px from the end, scrollTop unchanged.
    expect(followAfterScroll(true, 1500, at(1500, 2400))).toBe(true);
  });

  test("the reader scrolling up past the threshold stops following", () => {
    expect(followAfterScroll(true, 1500, at(1200))).toBe(false);
  });

  test("a small scroll up that stays near the end keeps following", () => {
    expect(followAfterScroll(true, 1500, at(1420))).toBe(true);
  });

  test("subpixel jitter is not a scroll up", () => {
    expect(followAfterScroll(true, 1000.5, at(1000, 3000))).toBe(true);
  });

  test("scrolling back down to the end resumes following; part way down does not", () => {
    expect(followAfterScroll(false, 800, at(1450))).toBe(true);
    expect(followAfterScroll(false, 800, at(1000))).toBe(false);
  });

  test("a smooth scroll on its way to the end keeps following through its in-between positions", () => {
    let following = true;
    let previous = 200;
    for (const top of [400, 700, 1000, 1300, 1500]) {
      following = followAfterScroll(following, previous, at(top));
      previous = top;
      expect(following).toBe(true);
    }
  });

  test("the browser clamping scrollTop after content shrank keeps following", () => {
    // At the end of 2000px; content shrinks to 1700: scrollTop clamps from 1500 to 1200, still at the end.
    expect(followAfterScroll(true, 1500, at(1200, 1700))).toBe(true);
  });

  test("content shorter than the pane always follows", () => {
    expect(followAfterScroll(false, 0, at(0, 300, 500))).toBe(true);
  });

  test("anchor shift keeps the old first row in place after older rows go in above", () => {
    expect(anchorShift(16, 916)).toBe(900);
    expect(anchorShift(16, 16)).toBe(0);
    expect(anchorShift(16, 16.4)).toBe(0);
    expect(anchorShift(null, 500)).toBe(0);
    expect(anchorShift(16, null)).toBe(0);
  });
});

describe("pill count", () => {
  const rows = (...keys: string[]) => keys.map((key) => ({ key }));
  test("counts rows after the newest one the reader saw", () => {
    expect(newSince(rows("a", "b", "c", "d"), "b")).toBe(2);
    expect(newSince(rows("a", "b"), "b")).toBe(0);
  });
  test("older pages loading in above are not new", () => {
    expect(newSince(rows("x", "y", "z", "a", "b", "c"), "b")).toBe(1);
  });
  test("an unknown row counts nothing; no row seen counts everything", () => {
    expect(newSince(rows("a", "b"), "gone")).toBe(0);
    expect(newSince(rows("a", "b"), null)).toBe(2);
  });
});
