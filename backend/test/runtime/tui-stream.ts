/**
 * A synthetic Claude Code session as its PTY writes it (Ink on the main screen): finished output printed once above,
 * and a live region below that is redrawn in place on every tick by moving the cursor up over the previous frame and
 * erasing each line, with a spinner, 256-colour and truecolour fills, a bordered input box, and lines that fill the
 * full width (so autowrap matters). Rendered in a terminal of any other width, or started mid-stream, the cursor-up
 * redraws land on the wrong lines.
 */
const ESC = "\x1b";
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽"];
const VERBS = ["Thinking", "Generating", "Reading files", "Editing", "Running tests"];

export interface TuiOptions {
  cols?: number;
  steps?: number;
}

function box(cols: number, text: string): string[] {
  const inner = cols - 4;
  const body = text.length > inner ? text.slice(0, inner) : text.padEnd(inner, " ");
  return [
    `${ESC}[38;5;244m╭${"─".repeat(cols - 2)}╮${ESC}[39m`,
    `${ESC}[38;5;244m│${ESC}[39m ${ESC}[48;2;38;42;50m${body}${ESC}[49m ${ESC}[38;5;244m│${ESC}[39m`,
    `${ESC}[38;5;244m╰${"─".repeat(cols - 2)}╯${ESC}[39m`,
  ];
}

/** The live region for one tick: spinner line, a status line, the input box, and a hint. */
function frame(cols: number, tick: number): string[] {
  const verb = VERBS[Math.floor(tick / 6) % VERBS.length]!;
  const spin = SPINNER[tick % SPINNER.length]!;
  return [
    `${ESC}[38;2;215;119;87m${spin}${ESC}[39m ${ESC}[1m${verb}…${ESC}[22m ${ESC}[2m(${tick}s · ↑ ${tick * 37} tokens · esc to interrupt)${ESC}[22m`,
    "",
    ...box(cols, `> ${"Tell me what you plan next".slice(0, (tick % 26) + 1)}`),
    `${ESC}[2m  ? for shortcuts${" ".repeat(Math.max(0, cols - 40))}auto-accept on${ESC}[22m`,
  ];
}

/** Ink's log-update: erase the previous frame line by line going up, then write the new one. */
function redraw(previous: number, lines: string[]): string {
  let out = "";
  for (let i = 0; i < previous; i += 1) out += `${ESC}[2K${i < previous - 1 ? `${ESC}[1A` : ""}`;
  if (previous > 0) out += `${ESC}[G`;
  return out + lines.join("\r\n") + "\r\n";
}

/** The session as chunks, the way the PTY hands them to the broker (one per write). */
export function claudeCodeSession(options: TuiOptions = {}): string[] {
  const cols = options.cols ?? 80;
  const steps = options.steps ?? 60;
  const chunks: string[] = [`${ESC}[?25l`, `${ESC}[38;2;215;119;87m✻${ESC}[39m Welcome to ${ESC}[1mClaude Code${ESC}[22m!\r\n\r\n`];
  let previous = 0;
  for (let tick = 0; tick < steps; tick += 1) {
    if (tick > 0 && tick % 7 === 0) {
      // Finished work scrolls out above the live region: erase the frame, print it once, redraw below.
      const done = [
        `${ESC}[32m⏺${ESC}[39m ${ESC}[1mUpdate${ESC}[22m(src/app/page-${tick}.tsx)`,
        `  ⎿  Updated src/app/page-${tick}.tsx with ${tick} additions and ${tick % 5} removals`,
        `${ESC}[48;5;22m${`  ${tick} + const plan = buildPlan(task, { step: ${tick} });`.padEnd(cols, " ")}${ESC}[49m`,
        `${ESC}[48;5;52m${`  ${tick} - const plan = draft(task);`.padEnd(cols, " ")}${ESC}[49m`,
        "",
      ];
      chunks.push(redraw(previous, done));
      previous = 0;
    }
    const lines = frame(cols, tick);
    chunks.push(redraw(previous, lines));
    previous = lines.length + 1;
  }
  return chunks;
}
