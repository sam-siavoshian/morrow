import type { ITheme } from "@xterm/xterm";

/**
 * A fixed dark terminal palette, in day and night alike: coding CLIs draw for a dark terminal (their background
 * fills, dim text and selection bars assume one), so a light theme turns their fills into dark blocks.
 */
export const TERMINAL_THEME: ITheme = {
  background: "#101216",
  foreground: "#d5d9e0",
  cursor: "#d5d9e0",
  cursorAccent: "#101216",
  selectionBackground: "rgba(122, 162, 220, 0.32)",
  black: "#1c1f26",
  red: "#e0787e",
  green: "#8cc59a",
  yellow: "#dfc07f",
  blue: "#7ea6e0",
  magenta: "#c49de0",
  cyan: "#72c0cc",
  white: "#c8cdd6",
  brightBlack: "#5d6470",
  brightRed: "#ec9095",
  brightGreen: "#a5d6b1",
  brightYellow: "#e9cf9c",
  brightBlue: "#9cbcec",
  brightMagenta: "#d4b6ec",
  brightCyan: "#92d1da",
  brightWhite: "#f0f2f5",
};

export const MIN_FONT_PX = 9;
export const MAX_FONT_PX = 15;

/**
 * The font size that fits `cols` columns in `width` pixels, given a glyph's advance as a fraction of the font size
 * (0.6 for most monospace fonts). Below `MIN_FONT_PX` it stays there and the terminal scrolls sideways instead.
 */
export function fitFontSize(width: number, cols: number, advance: number): { fontSize: number; overflow: boolean } {
  if (!(width > 0) || !(cols > 0) || !(advance > 0)) return { fontSize: MIN_FONT_PX, overflow: false };
  const exact = width / (cols * advance);
  const fontSize = Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, Math.floor(exact * 4) / 4));
  return { fontSize, overflow: exact < MIN_FONT_PX };
}

/** RIS: a full terminal reset, written in order with the data around it (unlike `terminal.reset()`, which is immediate). */
export const RESET = "\x1bc";

/**
 * Batches inspect output into one terminal write per animation frame, however many frames the socket delivers.
 * A reset frame drops what is still pending (the reset clears it anyway) and starts with RIS. `schedule` runs the
 * flush on the next frame and returns a cancel; the default also falls back to a timer, because a hidden tab gets
 * no animation frames and the output would pile up.
 */
export function createOutputBatcher(
  write: (data: string) => void,
  schedule: (flush: () => void) => () => void = nextFrame,
): { push(data: string, reset: boolean): void; dispose(): void } {
  let pending = "";
  let cancel: (() => void) | null = null;
  const flush = () => {
    cancel = null;
    const data = pending;
    pending = "";
    if (data) write(data);
  };
  return {
    push(data, reset) {
      pending = reset ? RESET + data : pending + data;
      if (!pending) return;
      cancel ??= schedule(flush);
    },
    dispose() {
      cancel?.();
      cancel = null;
      pending = "";
    },
  };
}

function nextFrame(flush: () => void): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    flush();
  };
  const raf = requestAnimationFrame(run);
  const timer = setTimeout(run, 100);
  return () => {
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
}

/** A monospace glyph's advance as a fraction of the font size, measured once per font. */
export function measureAdvance(fontFamily: string): number {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0.6;
  ctx.font = `100px ${fontFamily}`;
  const advance = ctx.measureText("M".repeat(10)).width / 1000;
  return advance > 0.3 && advance < 1 ? advance : 0.6;
}
