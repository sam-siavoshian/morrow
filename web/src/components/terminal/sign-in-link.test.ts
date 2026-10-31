import { describe, expect, test } from "bun:test";
import { findSignInLink, signInLink, type TerminalLine } from "./sign-in-link";

const CLAUDE_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code" +
  "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile" +
  "&code_challenge=YVdc-4g4R6-qu86fsSdRCbOUufv9tPpZXv6wDFLv2js&code_challenge_method=S256&state=TubeY6rusSEKBh8TA";

/** Rows as a TUI hard-wraps them: full-width chunks, each a new line. */
function hardWrap(text: string, cols: number): TerminalLine[] {
  const rows: TerminalLine[] = [];
  for (let i = 0; i < text.length; i += cols) rows.push({ text: text.slice(i, i + cols), wrapped: false });
  return rows;
}

const row = (text: string, wrapped = false): TerminalLine => ({ text, wrapped });

describe("signInLink", () => {
  test("accepts https links on the vendors' sign-in hosts", () => {
    expect(signInLink("https://claude.ai/oauth/authorize?x=1")).toEqual({ url: "https://claude.ai/oauth/authorize?x=1", host: "claude.ai" });
    expect(signInLink("https://auth.openai.com/codex/device")?.host).toBe("auth.openai.com");
    expect(signInLink("https://github.com/login/device")?.host).toBe("github.com");
  });

  test("accepts the Gemini CLI, Cursor Agent and Grok sign-in hosts", () => {
    expect(signInLink("https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code")?.host).toBe("accounts.google.com");
    expect(signInLink("https://cursor.com/loginDeepControl?challenge=x&uuid=y&mode=login")?.host).toBe("cursor.com");
    expect(signInLink("https://auth.x.ai/device?user_code=ABCD-EFGH")?.host).toBe("auth.x.ai");
    expect(signInLink("https://accounts.x.ai/device")?.host).toBe("accounts.x.ai");
  });

  test("refuses lookalikes of the Gemini CLI, Cursor Agent and Grok hosts", () => {
    for (const raw of [
      "https://accounts.google.com.evil.example/o/oauth2/v2/auth",
      "https://google.com/o/oauth2/v2/auth",
      "https://docs.google.com/forms/d/x",
      "http://accounts.google.com/o/oauth2/v2/auth",
      "https://cursor.com@evil.example/loginDeepControl",
      "https://cursor.com.evil.example/",
      "https://www.cursor.com/loginDeepControl",
      "http://cursor.com/loginDeepControl",
      "https://cursor.com:444/loginDeepControl",
      "https://x.ai/device",
      "https://evil-x.ai/device",
      "https://auth.x.ai.evil.example/device",
      "https://user:pass@auth.x.ai/device",
    ])
      expect(signInLink(raw)).toBeNull();
  });

  test("finds a Gemini CLI link a TUI hard-wrapped", () => {
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&access_type=offline" +
      "&code_challenge_method=S256&code_challenge=dn5N7hHSUYb76&state=b3793635&response_type=code&client_id=681255809395.apps.googleusercontent.com";
    const cols = 80;
    const lines = [row("Please visit the following URL to authorize the application:"), row(""), ...hardWrap(url, cols), row(""), row("Enter the authorization code:")];
    expect(findSignInLink(lines, cols)).toEqual({ url: new URL(url).href, host: "accounts.google.com" });
  });

  test("refuses other hosts, lookalikes, http, credentials and ports", () => {
    for (const raw of [
      "https://evil.example/claude.ai",
      "https://claude.ai.evil.example/",
      "https://notclaude.ai/",
      "https://sub.claude.ai/",
      "http://claude.ai/oauth",
      "https://user:pass@claude.ai/",
      "https://claude.ai@evil.example/",
      "https://claude.ai:8443/",
      "javascript:alert(1)",
      "not a url",
    ])
      expect(signInLink(raw)).toBeNull();
  });
});

describe("findSignInLink", () => {
  test("rejoins a link a TUI hard-wrapped at the right edge", () => {
    const cols = 100;
    const lines = [row(" Browser didn't open? Use the url below to sign in (c to copy)"), row(""), ...hardWrap(CLAUDE_URL, cols), row(""), row(" Paste code here if prompted >")];
    expect(findSignInLink(lines, cols)).toEqual({ url: new URL(CLAUDE_URL).href, host: "claude.com" });
  });

  test("rejoins a link xterm soft-wrapped", () => {
    const lines = [row("open https://github.com/login/"), row("device then enter the code", true)];
    expect(findSignInLink(lines, 30)?.url).toBe("https://github.com/login/device");
  });

  test("does not join the next row when the link stops short of the edge", () => {
    const lines = [row("Go to https://auth.openai.com/codex/device"), row("ABCD-12345")];
    expect(findSignInLink(lines, 120)?.url).toBe("https://auth.openai.com/codex/device");
  });

  test("stops at a row that starts with a space", () => {
    const cols = 40;
    const lines = [...hardWrap("https://claude.ai/oauth/authorize?a=1&b=2", cols), row(" Paste code here")];
    expect(findSignInLink(lines, cols)?.url).toBe("https://claude.ai/oauth/authorize?a=1&b=2");
  });

  test("drops trailing punctuation", () => {
    expect(findSignInLink([row("Open https://github.com/login/device.")], 80)?.url).toBe("https://github.com/login/device");
    expect(findSignInLink([row("(see https://claude.ai/login)")], 80)?.url).toBe("https://claude.ai/login");
  });

  test("returns the last allowed link and skips disallowed ones", () => {
    const lines = [row("https://claude.ai/first"), row("https://evil.example/phish"), row("https://claude.ai/second"), row("https://evil.example/later")];
    expect(findSignInLink(lines, 80)?.url).toBe("https://claude.ai/second");
  });

  test("an allowed host cannot be smuggled in by a wrapped continuation", () => {
    // The link starts on an attacker's host; the next row's text does not change where it points.
    const cols = 30;
    const lines = [row("https://evil.example/aaaaaaaaa"), row("@claude.ai/oauth", true)];
    expect(findSignInLink(lines, cols)).toBeNull();
  });

  test("finds two links on one row", () => {
    expect(findSignInLink([row("https://evil.example/x or https://claude.ai/y")], 80)?.url).toBe("https://claude.ai/y");
  });

  test("nothing to find", () => {
    expect(findSignInLink([], 80)).toBeNull();
    expect(findSignInLink([row("$ claude"), row("Welcome to Claude Code")], 80)).toBeNull();
  });
});
