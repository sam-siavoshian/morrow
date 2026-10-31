/**
 * GitHub-flavored markdown from pull requests and comments, parsed into a small tree the renderer turns into React
 * elements. Comments are written by anyone who can comment on the repo, so nothing here ever becomes HTML: raw
 * HTML stays literal text, links keep only http(s) targets (via `safeHref`), and images become plain links (the
 * page never loads a third-party image). Bounded work: input is clipped, nesting is capped, and every scan for a
 * closing delimiter is remembered when it fails, so hostile input stays linear-ish.
 */
import { linkify, safeHref } from "@/components/timeline/linkify";

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; href: string | null; alt: string }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "code"; lang: string | null; text: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Array<{ task: boolean | null; c: Block[] }> }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

export const MAX_MARKDOWN_CHARS = 20_000;
const MAX_DEPTH = 6;
const MAX_TABLE_COLUMNS = 20;

/** Parses `source` into blocks. Never throws. */
export function parseMarkdown(source: string): Block[] {
  const text = source
    .slice(0, MAX_MARKDOWN_CHARS)
    .replace(/\r\n?/g, "\n")
    // GitHub hides HTML comments (PR templates are full of them); dropping text is always safe.
    .replace(/<!--[\s\S]*?-->/g, "");
  return blocks(text.split("\n"), 0);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]{0,30})?.*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^( {0,3})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function blocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence (or past the end)
      out.push({ t: "code", lang: fence[2] || null, text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: "h", level: heading[1]!.length as 1, c: inline(heading[2] ?? "", depth) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim() && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      out.push(depth < MAX_DEPTH ? { t: "quote", c: blocks(body, depth + 1) } : { t: "p", c: [{ t: "text", v: body.join("\n") }] });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i, depth);
      out.push(list);
      i = next;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = cells(line).map((c) => inline(c, depth));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) rows.push(cells(lines[i++]!).map((c) => inline(c, depth)));
      out.push({ t: "table", head, rows });
      continue;
    }
    // Paragraph: until a blank line or the start of another block.
    const body: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) body.push(lines[i++]!);
    out.push({ t: "p", c: inline(body.map((l) => l.trim()).join("\n"), depth) });
  }
  return out;
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line);
}

function parseList(lines: string[], start: number, depth: number): [Block, number] {
  const first = lines[start]!;
  const ordered = !BULLET.test(first);
  const marker = ordered ? ORDERED : BULLET;
  const indent = marker.exec(first)![1]!.length;
  const startNumber = ordered ? Math.min(Number(ORDERED.exec(first)![2]), 1e9) : 1;
  const items: Array<{ task: boolean | null; c: Block[] }> = [];
  let i = start;
  while (i < lines.length) {
    const m = marker.exec(lines[i]!);
    if (!m || m[1]!.length !== indent) break;
    let content = m[3]!;
    let task: boolean | null = null;
    const box = /^\[([ xX])\]\s+/.exec(content);
    if (box) {
      task = box[1] !== " ";
      content = content.slice(box[0].length);
    }
    const body = [content];
    i++;
    // Continuation: indented lines (nested lists, wrapped text), or one blank line followed by indented text.
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() && /^\s{2,}/.test(next) && !(marker.test(next) && marker.exec(next)![1]!.length === indent)) {
        body.push(next.replace(/^\s{2,4}/, ""));
        i++;
      } else if (!next.trim() && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!)) {
        body.push("");
        i++;
      } else if (next.trim() && !startsBlock(next) && body.length > 0 && !/^\s*$/.test(body[body.length - 1]!)) {
        // A lazy continuation line of the item's paragraph.
        body.push(next.trim());
        i++;
      } else break;
    }
    items.push({ task, c: depth < MAX_DEPTH ? blocks(body, depth + 1) : [{ t: "p", c: [{ t: "text", v: body.join("\n") }] }] });
    // A blank line between items of the same list.
    if (i < lines.length && !lines[i]!.trim() && i + 1 < lines.length && marker.test(lines[i + 1]!) && marker.exec(lines[i + 1]!)![1]!.length === indent) i++;
  }
  return [{ t: "list", ordered, start: startNumber, items }, i];
}

function cells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < r.length; i++) {
    if (r[i] === "\\" && r[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (r[i] === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += r[i];
  }
  out.push(cur.trim());
  return out.slice(0, MAX_TABLE_COLUMNS);
}

// ---------- inline ----------

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!|~<>\"'");

/** Inline markdown. `depth` bounds emphasis-in-link-in-emphasis nesting. */
export function inline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (!plain) return;
    for (const part of linkify(plain)) out.push(part.kind === "text" ? { t: "text", v: part.text } : { t: "link", href: part.href, c: [{ t: "text", v: part.text }] });
    plain = "";
  };
  /** Delimiters known to have no closer from where they were last searched: never searched again. */
  const noCloser = new Map<string, number>();
  const closer = (delim: string, from: number): number => {
    const known = noCloser.get(delim);
    if (known !== undefined && from >= known) return -1;
    const at = text.indexOf(delim, from);
    if (at === -1) noCloser.set(delim, Math.min(known ?? Infinity, from));
    return at;
  };
  const nested = (inner: string): Inline[] => (depth < MAX_DEPTH ? inline(inner, depth + 1) : [{ t: "text", v: inner }]);

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length && ESCAPABLE.has(text[i + 1]!)) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const end = closer(fence, i + run);
      if (end !== -1) {
        flush();
        out.push({ t: "code", v: text.slice(i + run, end).replace(/\n/g, " ").replace(/^ (.+) $/, "$1") });
        i = end + run;
        continue;
      }
      plain += fence;
      i += run;
      continue;
    }
    if ((ch === "!" && text[i + 1] === "[") || ch === "[") {
      const image = ch === "!";
      const link = linkAt(text, image ? i + 1 : i);
      if (link) {
        flush();
        const href = safeHref(link.url);
        if (image) out.push({ t: "image", href, alt: link.label.slice(0, 200) });
        else if (href) out.push({ t: "link", href, c: depth < MAX_DEPTH ? stripLinks(inline(link.label, depth + 1)) : [{ t: "text", v: link.label }] });
        else out.push(...nested(link.label));
        i = link.end;
        continue;
      }
    }
    if (ch === "<") {
      const auto = /^<(https?:\/\/[^\s<>]{1,2048})>/i.exec(text.slice(i, i + 2060));
      const href = auto ? safeHref(auto[1]!) : null;
      if (auto && href) {
        flush();
        out.push({ t: "link", href, c: [{ t: "text", v: auto[1]! }] });
        i += auto[0].length;
        continue;
      }
    }
    if (ch === "~" && text[i + 1] === "~") {
      const end = closer("~~", i + 2);
      if (end > i + 2 && text[i + 2] !== " ") {
        flush();
        out.push({ t: "del", c: nested(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const double = text[i + 1] === ch;
      const delim = double ? ch + ch : ch;
      const open = i + delim.length;
      // `_` only at a word edge, so snake_case_names stay as they are.
      const edgeOk = ch === "*" || i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1]!);
      if (edgeOk && open < text.length && !/\s/.test(text[open]!)) {
        let end = closer(delim, open + 1);
        // For `*`, skip a `**` when looking for a single closer.
        while (end !== -1 && !double && text[end + 1] === ch) end = closer(delim, end + 2);
        const closeOk = end !== -1 && !/\s/.test(text[end - 1]!) && (ch === "*" || end + delim.length >= text.length || !/[\p{L}\p{N}]/u.test(text[end + delim.length]!));
        if (closeOk) {
          flush();
          const c = nested(text.slice(open, end));
          out.push(double ? { t: "strong", c } : { t: "em", c });
          i = end + delim.length;
          continue;
        }
      }
      plain += delim;
      i += delim.length;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

/** `[label](url)` starting at `start` (the `[`), with balanced brackets in the label and parens in the url. */
function linkAt(text: string, start: number): { label: string; url: string; end: number } | null {
  let depth = 0;
  let j = start;
  const limit = Math.min(text.length, start + 2_000);
  for (; j < limit; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
    else if (c === "\n" && text[j + 1] === "\n") return null;
  }
  if (j >= limit || text[j + 1] !== "(") return null;
  const label = text.slice(start + 1, j);
  let k = j + 2;
  let parens = 1;
  const urlLimit = Math.min(text.length, k + 2_100);
  for (; k < urlLimit; k++) {
    const c = text[k];
    if (c === "(") parens++;
    else if (c === ")" && --parens === 0) break;
    else if (c === "\n") return null;
  }
  if (k >= urlLimit) return null;
  // Drop an optional title: `(url "title")`.
  const url = text.slice(j + 2, k).trim().replace(/\s+(?:"[^"]*"|'[^']*')$/, "").replace(/^<(.*)>$/, "$1");
  return { label, url, end: k + 1 };
}

/** A link's text cannot hold another link. */
function stripLinks(nodes: Inline[]): Inline[] {
  return nodes.flatMap((n): Inline[] => {
    if (n.t === "link") return stripLinks(n.c);
    if (n.t === "strong" || n.t === "em" || n.t === "del") return [{ ...n, c: stripLinks(n.c) }];
    return [n];
  });
}

/** Plain text of a tree (for previews and accessible names). */
export function plainText(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
        case "code":
          return n.v;
        case "br":
          return " ";
        case "image":
          return n.alt;
        default:
          return plainText(n.c);
      }
    })
    .join("");
}
