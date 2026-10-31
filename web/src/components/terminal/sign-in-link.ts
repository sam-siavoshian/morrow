/**
 * Finds the sign-in link an agent CLI prints (Claude Code, Codex device auth, opencode, Cursor Agent, Gemini CLI,
 * Grok device auth), so the terminal can offer it as a button instead of a URL to drag-select across wrapped lines.
 *
 * The VM is also where agents run, so anything in the terminal is untrusted text: only an https link on one of the
 * vendors' own sign-in hosts becomes a button. Anything else stays plain terminal output.
 */
const SIGN_IN_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  "platform.claude.com",
  "console.anthropic.com",
  "auth.openai.com",
  "github.com",
  "accounts.google.com",
  "cursor.com",
  "auth.x.ai",
  "accounts.x.ai",
]);

/** How far short of the right edge a hard-wrapped line may stop (TUIs often keep a column free). */
const EDGE_SLACK = 2;
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;
const TRAILING_PUNCTUATION = /[.,;:!?'")\]]+$/;

export type TerminalLine = {
  /** The row's text, trailing blanks trimmed. */
  text: string;
  /** xterm soft-wrapped this row onto the one before it. */
  wrapped: boolean;
};

export type SignInLink = { url: string; host: string };

/** Whether `raw` is a link the terminal may offer as a sign-in button. */
export function signInLink(raw: string): SignInLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!SIGN_IN_HOSTS.has(url.hostname)) return null;
  return { url: url.href, host: url.hostname };
}

/**
 * The last allowed sign-in link in `lines` (top to bottom), rejoined across rows. A row continues the link when xterm
 * soft-wrapped it, or when the link ran to the right edge (a TUI hard-wrapping it) and the next row starts with URL
 * characters at column 0.
 */
export function findSignInLink(lines: readonly TerminalLine[], cols: number): SignInLink | null {
  let found: SignInLink | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;
    let from = 0;
    for (;;) {
      const start = text.indexOf("https://", from);
      if (start < 0) break;
      let url = text.slice(start).match(URL_CHARS)![0];
      from = start + url.length;
      let end = from;
      let row = i;
      while (end === lines[row]!.text.length && row + 1 < lines.length) {
        const next = lines[row + 1]!;
        if (!next.wrapped && lines[row]!.text.length < cols - EDGE_SLACK) break;
        const more = next.text.match(URL_CHARS)?.[0];
        if (!more) break;
        url += more;
        row += 1;
        end = more.length;
      }
      const link = signInLink(url.replace(TRAILING_PUNCTUATION, ""));
      if (link) found = link;
    }
  }
  return found;
}
