/**
 * Splits untrusted text into plain runs and http(s) links. Nothing here ever becomes HTML: the
 * caller renders `text` parts as text and `link` parts as anchors with a vetted href.
 */
export type TextPart = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

/** Candidates start at a scheme or `www.`; anything else (javascript:, data:, mailto:) stays text. */
const CANDIDATE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
/** Trailing characters that usually close the sentence, not the URL. */
const TRAILING = /[.,;:!?'")\]}>]+$/;
const MAX_URL_LENGTH = 2048;

/** A safe absolute href for `raw`, or null. Only http and https survive, with no credentials. */
export function safeHref(raw: string): string | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.href;
}

/** Keeps a closing paren that has a matching open one inside the URL (wiki-style links). */
function trimTrailing(match: string): string {
  let url = match.replace(TRAILING, "");
  const rest = match.slice(url.length);
  if (rest.startsWith(")") && (url.match(/\(/g)?.length ?? 0) > (url.match(/\)/g)?.length ?? 0)) url += ")";
  return url;
}

export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index;
    const url = trimTrailing(match[0]);
    const href = safeHref(url);
    if (!href) continue;
    if (start > last) parts.push({ kind: "text", text: text.slice(last, start) });
    parts.push({ kind: "link", text: url, href });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}
