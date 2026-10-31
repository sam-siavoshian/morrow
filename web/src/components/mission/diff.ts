// Unified diff text from GitHub turned into lines to draw. Patch text is repo content: it is only ever shown as
// text nodes, never parsed as markup.

export type DiffLineKind = "hunk" | "add" | "del" | "context" | "note";
export type DiffLine = { kind: DiffLineKind; text: string; oldNo: number | null; newNo: number | null };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Lines of one file's patch with old and new line numbers. Lines past `max` are dropped; `rest` says how many. */
export function parsePatch(patch: string, max = Infinity): { lines: DiffLine[]; rest: number } {
  const raw = patch.replace(/\r\n?/g, "\n").split("\n");
  if (raw.at(-1) === "") raw.pop();
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const text of raw) {
    if (lines.length >= max) break;
    const hunk = HUNK.exec(text);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: "hunk", text, oldNo: null, newNo: null });
    } else if (text.startsWith("+")) lines.push({ kind: "add", text: text.slice(1), oldNo: null, newNo: newNo++ });
    else if (text.startsWith("-")) lines.push({ kind: "del", text: text.slice(1), oldNo: oldNo++, newNo: null });
    else if (text.startsWith("\\")) lines.push({ kind: "note", text, oldNo: null, newNo: null });
    else lines.push({ kind: "context", text: text.startsWith(" ") ? text.slice(1) : text, oldNo: oldNo++, newNo: newNo++ });
  }
  return { lines, rest: raw.length - lines.length };
}

/** "+1.2k": short counts for chips. */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.floor(n / 1000)}k`;
}
