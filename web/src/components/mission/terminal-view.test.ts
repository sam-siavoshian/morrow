import { describe, expect, test } from "bun:test";
import { createOutputBatcher, fitFontSize, MAX_FONT_PX, MIN_FONT_PX, RESET, TERMINAL_THEME } from "./terminal-view";

describe("fitFontSize", () => {
  test("fits the full width of the worker's columns", () => {
    // 80 columns of a 0.6em glyph in the default 540px panel (about 500px inside).
    const { fontSize, overflow } = fitFontSize(500, 80, 0.6);
    expect(overflow).toBe(false);
    expect(fontSize * 0.6 * 80).toBeLessThanOrEqual(500);
    expect(fontSize).toBeGreaterThan(10);
  });

  test("never shrinks below the readable floor: it scrolls sideways instead", () => {
    expect(fitFontSize(300, 80, 0.6)).toEqual({ fontSize: MIN_FONT_PX, overflow: true });
  });

  test("caps the size on a wide panel, and survives a hidden one", () => {
    expect(fitFontSize(5_000, 80, 0.6)).toEqual({ fontSize: MAX_FONT_PX, overflow: false });
    expect(fitFontSize(0, 80, 0.6)).toEqual({ fontSize: MIN_FONT_PX, overflow: false });
    expect(fitFontSize(Number.NaN, 80, 0.6).fontSize).toBe(MIN_FONT_PX);
  });
});

describe("createOutputBatcher", () => {
  function harness() {
    const writes: string[] = [];
    let flush: (() => void) | null = null;
    let cancelled = 0;
    const batch = createOutputBatcher(
      (data) => writes.push(data),
      (f) => {
        flush = f;
        return () => {
          cancelled += 1;
          flush = null;
        };
      },
    );
    return { batch, writes, frame: () => flush?.(), scheduled: () => flush !== null, cancelled: () => cancelled };
  }

  test("many socket frames become one write per animation frame, in order", () => {
    const h = harness();
    h.batch.push("a", false);
    h.batch.push("b", false);
    h.batch.push("c", false);
    expect(h.writes).toEqual([]);
    h.frame();
    expect(h.writes).toEqual(["abc"]);
    h.batch.push("d", false);
    h.frame();
    expect(h.writes).toEqual(["abc", "d"]);
  });

  test("a reset drops what is pending and starts with RIS, written in order", () => {
    const h = harness();
    h.batch.push("old screen", false);
    h.batch.push("snapshot", true);
    h.batch.push(" then more", false);
    h.frame();
    expect(h.writes).toEqual([`${RESET}snapshot then more`]);
    // A reset with nothing after it still clears the screen.
    h.batch.push("", true);
    h.frame();
    expect(h.writes.at(-1)).toBe(RESET);
  });

  test("nothing pending schedules nothing; dispose cancels a scheduled write", () => {
    const h = harness();
    h.batch.push("", false);
    expect(h.scheduled()).toBe(false);
    h.batch.push("x", false);
    expect(h.scheduled()).toBe(true);
    h.batch.dispose();
    expect(h.cancelled()).toBe(1);
    expect(h.writes).toEqual([]);
  });
});

test("the palette is dark in every scene: black is not the page's text colour", () => {
  const lum = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };
  expect(lum(TERMINAL_THEME.background!)).toBeLessThan(40);
  expect(lum(TERMINAL_THEME.foreground!)).toBeGreaterThan(180);
  expect(lum(TERMINAL_THEME.black!)).toBeLessThan(lum(TERMINAL_THEME.brightBlack!));
});
