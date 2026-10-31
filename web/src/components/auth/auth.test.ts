import { describe, expect, test } from "bun:test";
import { inviteFromInput, joinPath, parseInviteToken } from "./invite-token";
import { landingPath, lastTeamFrom, loginErrorMessage, returnToFrom } from "./return-to";

const CODE = "a".repeat(40) + "_-9";

describe("returnToFrom: only same-origin paths survive", () => {
  test.each([
    ["/t/abc", "/t/abc"],
    ["/t/abc?tab=x#y", "/t/abc?tab=x#y"],
    ["/join/t1.code", "/join/t1.code"],
    ["/onboarding?team=t1&step=agents", "/onboarding?team=t1&step=agents"],
    ["/a/../t/x", "/t/x"],
  ])("keeps %s", (raw, expected) => {
    expect(returnToFrom(raw)).toBe(expected);
  });

  test.each([
    "https://evil.com",
    "http://evil.com/t/x",
    "//evil.com",
    "//evil.com/t",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/%0a/x\u0000",
    "javascript:alert(1)",
    "evil.com",
    "",
    "/" + "a".repeat(600),
  ])("rejects %p", (raw) => {
    expect(returnToFrom(raw)).toBeNull();
  });

  test.each(["/login", "/login/", "/login?returnTo=/t/x", "/api/auth/github", "/api/auth/github?returnTo=/x", "/api/auth/github/callback"])(
    "rejects auth page %s so sign-in never loops",
    (raw) => {
      expect(returnToFrom(raw)).toBeNull();
    },
  );

  test("first value wins when the param repeats", () => {
    expect(returnToFrom(["/t/one", "https://evil.com"])).toBe("/t/one");
    expect(returnToFrom(["//evil.com", "/t/one"])).toBeNull();
  });

  test("missing values", () => {
    expect(returnToFrom(null)).toBeNull();
    expect(returnToFrom(undefined)).toBeNull();
    expect(returnToFrom([])).toBeNull();
  });
});

describe("landingPath", () => {
  const me = { teams: [{ id: "t1" }, { id: "t2" }] } as never;
  test("last team when still a member", () => expect(landingPath(me, "t2")).toBe("/t/t2"));
  test("first team when last is unknown", () => expect(landingPath(me, "gone")).toBe("/t/t1"));
  test("first team without cookie", () => expect(landingPath(me)).toBe("/t/t1"));
  test("onboarding with no teams", () => expect(landingPath({ teams: [] } as never, "t1")).toBe("/onboarding"));
  test("the cookie is only ever a team id", () => {
    expect(lastTeamFrom("t-1.a_b")).toBe("t-1.a_b");
    for (const bad of [undefined, null, "", "/evil", "//evil.com", "t1/../x", "t1?x=1", "t 1", "%2Fevil", "x".repeat(129)]) {
      expect(lastTeamFrom(bad)).toBeNull();
    }
    expect(landingPath({ teams: [{ id: "/evil" }, { id: "t1" }] } as never, "/evil")).toBe("/t/%2Fevil");
  });
});

describe("loginErrorMessage", () => {
  test("known codes map to sentences", () => {
    for (const code of ["access_denied", "state_mismatch", "bad_request", "github_unavailable", "not_allowed"]) {
      const message = loginErrorMessage(code);
      expect(message).toBeString();
      expect(message).not.toContain(code);
    }
  });
  test("not on the signup allowlist says so plainly", () => {
    expect(loginErrorMessage("not_allowed")).toBe("Morrow is invite-only for now, and your GitHub account isn't on the list yet.");
  });
  test("unknown code never echoes raw input", () => {
    const message = loginErrorMessage("<script>alert(1)</script>");
    expect(message).toBe("Sign-in didn't finish. Try again.");
  });
  test("no code, no message", () => {
    expect(loginErrorMessage(null)).toBeNull();
    expect(loginErrorMessage("")).toBeNull();
  });
});

describe("invite tokens", () => {
  test("parses <teamId>.<code>", () => {
    expect(parseInviteToken(`t-8btcbqu94a23.${CODE}`)).toEqual({ token: `t-8btcbqu94a23.${CODE}`, teamId: "t-8btcbqu94a23" });
  });
  test("team ids with dots split on the last dot", () => {
    expect(parseInviteToken(`team.with.dots.${CODE}`)?.teamId).toBe("team.with.dots");
  });
  test("url-encoded segment decodes", () => {
    expect(parseInviteToken(encodeURIComponent(`t1.${CODE}`))?.teamId).toBe("t1");
  });
  test.each([
    "",
    "nodot",
    `.${CODE}`,
    `...${CODE}`,
    "t1.short",
    `t1.${CODE}x`,
    `t1.${CODE.slice(0, 42)}=`,
    `t/1.${CODE}`,
    `t1 .${CODE}`,
    "%E0%A4%A",
    `${"t".repeat(300)}.${CODE}`,
  ])("rejects %p", (raw) => {
    expect(parseInviteToken(raw)).toBeNull();
  });

  test("pasted full link keeps only the token, never the host", () => {
    const invite = inviteFromInput(`https://evil.example/join/t1.${CODE}?x=1#y`);
    expect(invite).toEqual({ token: `t1.${CODE}`, teamId: "t1" });
    expect(joinPath(invite!)).toBe(`/join/t1.${CODE}`);
  });
  test("pasted path or bare token", () => {
    expect(inviteFromInput(`  /join/t1.${CODE}  `)?.teamId).toBe("t1");
    expect(inviteFromInput(`t1.${CODE}`)?.teamId).toBe("t1");
  });
  test("garbage input", () => {
    expect(inviteFromInput("")).toBeNull();
    expect(inviteFromInput("https://evil.example/")).toBeNull();
    expect(inviteFromInput("/join/")).toBeNull();
  });
  test("joinPath output is a same-origin path", () => {
    const path = joinPath(parseInviteToken(`t1.${CODE}`)!);
    expect(returnToFrom(path)).toBe(path);
  });
});
