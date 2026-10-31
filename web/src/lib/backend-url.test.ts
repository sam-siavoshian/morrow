import { describe, expect, test } from "bun:test";
import { backendUrl, requiredSetting } from "./backend-url";

describe("backend URL", () => {
  test("production without BACKEND_URL throws instead of using localhost", () => {
    expect(() => backendUrl({ NODE_ENV: "production" })).toThrow("BACKEND_URL must be set");
    expect(() => backendUrl({ NODE_ENV: "production", BACKEND_URL: "   " })).toThrow("BACKEND_URL must be set");
    expect(() => requiredSetting("NEXT_PUBLIC_REALTIME_URL", "ws://x", { NODE_ENV: "production" })).toThrow("NEXT_PUBLIC_REALTIME_URL");
  });

  test("dev falls back to the local stack", () => {
    expect(backendUrl({ NODE_ENV: "development" })).toBe("http://127.0.0.1:8787");
    expect(backendUrl({})).toBe("http://127.0.0.1:8787");
  });

  test("a set value is trimmed and loses trailing slashes", () => {
    expect(backendUrl({ NODE_ENV: "production", BACKEND_URL: " https://api.example.com// " })).toBe("https://api.example.com");
    expect(requiredSetting("NEXT_PUBLIC_REALTIME_URL", "ws://x", { NODE_ENV: "production", NEXT_PUBLIC_REALTIME_URL: "wss://rt.example.com" })).toBe(
      "wss://rt.example.com",
    );
  });
});
