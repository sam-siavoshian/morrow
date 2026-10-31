import { describe, expect, test } from "bun:test";
import { githubAvatar, githubAvatarByLogin, githubAvatarFromUrl } from "./github-avatar";

describe("githubAvatarByLogin", () => {
  test("builds the avatar host URL from a plain login, sized for dense screens", () => {
    expect(githubAvatarByLogin("octocat", 28)).toBe("https://avatars.githubusercontent.com/octocat?s=64");
    expect(githubAvatarByLogin("a-b", 14)).toBe("https://avatars.githubusercontent.com/a-b?s=40");
    expect(githubAvatarByLogin("x", 400)).toBe("https://avatars.githubusercontent.com/x?s=460");
  });

  test("refuses anything that is not a GitHub login", () => {
    for (const bad of [null, undefined, "", "-lead", "trail-", "a--b", "a/b", "../x", "a b", "evil.com", "a".repeat(40), "日本"]) {
      expect(githubAvatarByLogin(bad, 28)).toBeNull();
    }
  });
});

describe("githubAvatarFromUrl", () => {
  test("keeps GitHub avatar URLs and sets the size", () => {
    expect(githubAvatarFromUrl("https://avatars.githubusercontent.com/u/583231?v=4", 34)).toBe("https://avatars.githubusercontent.com/u/583231?v=4&s=96");
    expect(githubAvatarFromUrl("https://avatars.githubusercontent.com/u/1?s=999", 20)).toBe("https://avatars.githubusercontent.com/u/1?s=40");
  });

  test("drops every other origin, scheme or credentialed URL", () => {
    for (const bad of [
      null,
      "",
      "not a url",
      "http://avatars.githubusercontent.com/u/1",
      "https://avatars.githubusercontent.com.evil.com/u/1",
      "https://evil.com/avatars.githubusercontent.com/u/1",
      "https://user:pass@avatars.githubusercontent.com/u/1",
      "https://avatars.githubusercontent.com:8443/u/1",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
    ]) {
      expect(githubAvatarFromUrl(bad, 28)).toBeNull();
    }
  });
});

describe("githubAvatar", () => {
  test("prefers the stored URL, falls back to the login, else nothing", () => {
    expect(githubAvatar({ avatarUrl: "https://avatars.githubusercontent.com/u/9", login: "ada" }, 28)).toBe("https://avatars.githubusercontent.com/u/9?s=64");
    expect(githubAvatar({ avatarUrl: null, login: "ada" }, 28)).toBe("https://avatars.githubusercontent.com/ada?s=64");
    expect(githubAvatar({ avatarUrl: "https://evil.com/x.png", login: "ada" }, 28)).toBe("https://avatars.githubusercontent.com/ada?s=64");
    expect(githubAvatar({ avatarUrl: null, login: null }, 28)).toBeNull();
  });
});
