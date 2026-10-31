import type { InspectFrame } from "@morrow/contracts";
import { Terminal } from "@xterm/headless";

type Output = Extract<InspectFrame, { kind: "inspect.output" }>;

/** Writes `data` into a fresh headless terminal and resolves with its parsed state. */
export async function render(data: string, cols = 80, rows = 40, scrollback = 1_000): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(data, resolve));
  return term;
}

/** What a browser shows after these frames, as the web client writes them (a reset is RIS, then the data). */
export function framesToBytes(frames: Output[]): string {
  return frames.map((f) => (f.reset ? `\x1bc${f.data}` : f.data)).join("");
}

/** Every line of the buffer (scrollback included), right-trimmed, without trailing blank lines. */
export function linesOf(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** The lines a browser shows after these frames. */
export async function screenOf(frames: Output[], cols = 80, rows = 40): Promise<string[]> {
  const term = await render(framesToBytes(frames), cols, rows);
  const lines = linesOf(term);
  term.dispose();
  return lines;
}
