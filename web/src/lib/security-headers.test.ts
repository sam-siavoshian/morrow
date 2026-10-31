import { describe, expect, test } from "bun:test";
import { contentSecurityPolicy, realtimeOrigin, securityHeaders } from "./security-headers";

const directives = (csp: string) => new Map(csp.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1)]));

describe("content security policy", () => {
  test("production: no eval, inline scripts for the RSC payload, every origin listed", () => {
    const csp = directives(contentSecurityPolicy({ dev: false, realtimeUrl: "wss://rt.morrow.dev/socket?x=1" }));
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp.get("img-src")).toEqual(["'self'", "data:", "blob:", "https://avatars.githubusercontent.com"]);
    expect(csp.get("font-src")).toEqual(["'self'"]);
    expect(csp.get("connect-src")).toEqual(["'self'", "wss://rt.morrow.dev", "https://api.freestyle.sh", "wss://api.freestyle.sh"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("form-action")).toEqual(["'self'", "https://github.com"]);
    expect(csp.get("upgrade-insecure-requests")).toEqual([]);
  });

  test("dev: eval for React's debug stacks, the local realtime port, no HTTPS upgrade", () => {
    const csp = directives(contentSecurityPolicy({ dev: true, realtimeUrl: "ws://127.0.0.1:8787" }));
    expect(csp.get("script-src")).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'"]);
    expect(csp.get("connect-src")).toContain("ws://127.0.0.1:8787");
    expect(csp.has("upgrade-insecure-requests")).toBe(false);
  });

  test("no realtime URL: same-origin sockets only", () => {
    expect(directives(contentSecurityPolicy({ dev: false })).get("connect-src")).toEqual(["'self'", "https://api.freestyle.sh", "wss://api.freestyle.sh"]);
    expect(realtimeOrigin("  ")).toBeNull();
  });

  test("a bad realtime URL fails boot instead of opening a hole", () => {
    expect(() => realtimeOrigin("not a url")).toThrow("not a URL");
    expect(() => realtimeOrigin("https://rt.example")).toThrow("ws:// or wss://");
    expect(() => realtimeOrigin("ws://a.com; script-src *")).toThrow();
  });
});

describe("security headers", () => {
  const WSS = "wss://rt.morrow.dev";
  const keys = (dev: boolean, realtimeUrl = WSS) => securityHeaders({ dev, realtimeUrl }).map((h) => h.key);
  test("production adds HSTS; dev never pins localhost", () => {
    expect(keys(false)).toEqual([
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "X-Frame-Options",
      "Strict-Transport-Security",
    ]);
    expect(keys(true)).not.toContain("Strict-Transport-Security");
  });
  test("a production build served over plain http (ws:// realtime) pins nothing, so the socket is not upgraded", () => {
    expect(keys(false, "ws://127.0.0.1:8797")).not.toContain("Strict-Transport-Security");
    expect(keys(false, "")).not.toContain("Strict-Transport-Security");
    expect(directives(contentSecurityPolicy({ dev: false, realtimeUrl: "ws://127.0.0.1:8797" })).has("upgrade-insecure-requests")).toBe(false);
  });
  test("values", () => {
    const h = Object.fromEntries(securityHeaders({ dev: false, realtimeUrl: WSS }).map((x) => [x.key, x.value]));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=()");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains");
  });
});
