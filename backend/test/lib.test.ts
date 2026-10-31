import { describe, expect, test } from "bun:test";
import { invoke, shouldRetryInvocation, translateInvocationError } from "../src/actors/invoke.ts";
import { EnvError, loadEnv } from "../src/env.ts";
import { detectTestCommand } from "../src/integrations/github/testCommand.ts";
import {
  constantTimeEqual,
  decodeKeyMaterial,
  decrypt,
  encrypt,
  importAesKey,
  randomBytes,
  sha256Hex,
} from "../src/lib/crypto.ts";
import { AppError } from "../src/lib/errors.ts";
import { newId, slugify } from "../src/lib/ids.ts";
import { createLogger, silentLogger } from "../src/lib/logger.ts";
import { backoffDelay, retry } from "../src/lib/retry.ts";
import { testEnvSource } from "./support/env.ts";

const key = () => importAesKey(randomBytes(32));

class FakeInvocationError extends Error {
  override name = "ActorInvocationError";
  constructor(
    readonly code: string,
    readonly requestId = "req-1",
  ) {
    super(`actor said ${code}`);
  }
}

describe("crypto", () => {
  test("round-trips and uses the v1.<iv>.<ct> format", async () => {
    const k = await key();
    const token = await encrypt(k, "hello wörld", "ctx");
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(await decrypt(k, token, "ctx")).toBe("hello wörld");
  });

  test("random IV: same plaintext encrypts differently", async () => {
    const k = await key();
    expect(await encrypt(k, "x", "c")).not.toBe(await encrypt(k, "x", "c"));
  });

  test("detects tampering with iv, ciphertext, tag, version", async () => {
    const k = await key();
    const token = await encrypt(k, "secret payload", "ctx");
    const [v, iv, ct] = token.split(".") as [string, string, string];
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    expect(await decrypt(k, `${v}.${flip(iv, 0)}.${ct}`, "ctx")).toBeNull();
    expect(await decrypt(k, `${v}.${iv}.${flip(ct, 0)}`, "ctx")).toBeNull();
    expect(await decrypt(k, `${v}.${iv}.${flip(ct, ct.length - 2)}`, "ctx")).toBeNull();
    expect(await decrypt(k, `v2.${iv}.${ct}`, "ctx")).toBeNull();
    expect(await decrypt(k, `${v}.${iv}`, "ctx")).toBeNull();
    expect(await decrypt(k, "garbage", "ctx")).toBeNull();
    expect(await decrypt(k, `${v}.${iv}.${ct}!`, "ctx")).toBeNull();
  });

  test("context (AAD) and key are bound", async () => {
    const k1 = await key();
    const k2 = await key();
    const token = await encrypt(k1, "p", "user:u-1");
    expect(await decrypt(k1, token, "user:u-2")).toBeNull();
    expect(await decrypt(k2, token, "user:u-1")).toBeNull();
  });

  test("key material must be 32 bytes of base64", () => {
    expect(decodeKeyMaterial(Buffer.alloc(32, 7).toString("base64")).length).toBe(32);
    expect(decodeKeyMaterial(Buffer.alloc(32, 7).toString("base64url")).length).toBe(32);
    expect(() => decodeKeyMaterial(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => decodeKeyMaterial("not base64 !!")).toThrow();
  });

  test("constant-time compare", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("ids", () => {
  test("ids match the contracts charset and are unique", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId("t")));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^t-[a-z0-9]{12}$/);
  });
  test("slugify", () => {
    expect(slugify("  Hello, Wörld!! ")).toBe("hello-world");
    expect(slugify("🚀🚀")).toBe("team");
    expect(slugify("a".repeat(80)).length).toBe(40);
  });
});

describe("env", () => {
  test("valid env parses with defaults", () => {
    const env = loadEnv(testEnvSource({ RELAY_BASE_URL: undefined, PORT: undefined, LOG_LEVEL: undefined }));
    expect(env.port).toBe(8787);
    expect(env.relay).toEqual({ baseUrl: "https://cast.agentrelay.com" });
    expect(env.freestyle).toBeNull();
    expect(env.secureCookies).toBe(false);
    expect(env.logLevel).toBe("info");
  });

  test("lists every missing and invalid variable, never values", () => {
    try {
      loadEnv(testEnvSource({ APP_ORIGIN: "https://app.example.com/path", SESSION_SECRET: "c2hvcnQ=", GITHUB_CLIENT_ID: undefined, REALTIME_URL: "http://x" }));
      throw new Error("expected EnvError");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const issues = (error as EnvError).issues.join("\n");
      expect(issues).toContain("GITHUB_CLIENT_ID is missing");
      expect(issues).toContain("APP_ORIGIN is invalid");
      expect(issues).toContain("SESSION_SECRET is invalid");
      expect(issues).toContain("REALTIME_URL is invalid");
      expect(issues).not.toContain("c2hvcnQ=");
    }
  });

  test("the Terse admin secret never goes over plain http off this machine; a remote server needs a project id", () => {
    const issues = (source: Record<string, string | undefined>) => {
      try {
        loadEnv(testEnvSource(source));
        return "";
      } catch (error) {
        return (error as EnvError).issues.join("\n");
      }
    };
    expect(issues({ DURABLE_ACTORS_CONTROL_PLANE_URL: "http://terse.internal:7100", DURABLE_ACTORS_PROJECT_ID: "morrow" })).toContain(
      "DURABLE_ACTORS_CONTROL_PLANE_URL is invalid",
    );
    expect(issues({ DURABLE_ACTORS_CONTROL_PLANE_URL: "https://terse.example.com", DURABLE_ACTORS_PROJECT_ID: undefined })).toContain(
      "DURABLE_ACTORS_PROJECT_ID",
    );
    expect(issues({ DURABLE_ACTORS_CONTROL_PLANE_URL: "https://terse.example.com", DURABLE_ACTORS_PROJECT_ID: "morrow" })).toBe("");
    expect(issues({ DURABLE_ACTORS_CONTROL_PLANE_URL: "http://127.0.0.1:7100", DURABLE_ACTORS_PROJECT_ID: undefined })).toBe("");
  });

  test("Terse Cloud: the deploy URL and API key stand in for the DURABLE_ACTORS_* settings", () => {
    const cloud = { DURABLE_ACTORS_CONTROL_PLANE_URL: undefined, DURABLE_ACTORS_SECRET: undefined };
    const key = "tk_live_0123456789abcdef";
    const issues = (source: Record<string, string | undefined>) => {
      try {
        loadEnv(testEnvSource(source));
        return "";
      } catch (error) {
        return (error as EnvError).issues.join("\n");
      }
    };
    // Exactly what `terse deploy` prints.
    expect(loadEnv(testEnvSource({ ...cloud, TERSE_ACTOR_URL: "https://api.useterse.ai/prj_42/actors", TERSE_API_KEY: key })).terse).toEqual({
      kind: "cloud",
      actorUrl: "https://api.useterse.ai/prj_42/actors",
      projectId: "prj_42",
      apiKey: key,
    });
    expect(loadEnv(testEnvSource({ ...cloud, TERSE_ACTOR_URL: "https://api.useterse.ai/prj_42/actors/", TERSE_API_KEY: key })).terse).toMatchObject({
      actorUrl: "https://api.useterse.ai/prj_42/actors",
    });
    // The runtime's own path, a nested or odd path, a query, plain http off this machine, or half a pair: refused, key never echoed.
    for (const url of [
      "https://api.useterse.ai/v1/projects/p/actors",
      "https://api.useterse.ai/edge/p/actors",
      "https://api.useterse.ai/../actors",
      "https://api.useterse.ai/%E0%A4%A/actors",
      "https://api.useterse.ai/p/actors?x=1",
      "https://user:pw@api.useterse.ai/p/actors",
      "http://terse.example.com/p/actors",
    ])
      expect(issues({ ...cloud, TERSE_ACTOR_URL: url, TERSE_API_KEY: key })).toContain("TERSE_ACTOR_URL is invalid");
    expect(issues({ ...cloud, TERSE_ACTOR_URL: "https://api.useterse.ai/p/actors" })).toContain("TERSE_API_KEY");
    expect(issues({ ...cloud, TERSE_API_KEY: key })).toContain("TERSE_ACTOR_URL");
    expect(issues({ ...cloud, TERSE_ACTOR_URL: "https://api.useterse.ai/p/actors", TERSE_API_KEY: "short" })).toContain("TERSE_API_KEY is invalid");
    expect(issues({ TERSE_ACTOR_URL: "https://api.useterse.ai/p/actors", TERSE_API_KEY: key })).toContain("not both");
    expect(issues(cloud)).toContain("DURABLE_ACTORS_CONTROL_PLANE_URL");
    expect(issues({ ...cloud, TERSE_ACTOR_URL: "https://api.useterse.ai/edge/p/actors", TERSE_API_KEY: key })).not.toContain(key);
  });

  test("feature flags by presence; https origin means secure cookies; identical keys rejected", () => {
    const env = loadEnv(testEnvSource({ FREESTYLE_API_KEY: "fs_key", APP_ORIGIN: "https://app.example.com" }));
    expect(env.freestyle).toEqual({ apiKey: "fs_key", baseSnapshot: "morrow-base" });
    expect(env.secureCookies).toBe(true);
    const k = Buffer.alloc(32, 1).toString("base64");
    expect(() => loadEnv(testEnvSource({ SESSION_SECRET: k, DATA_ENCRYPTION_KEY: k }))).toThrow(/must be different/);
    expect(() => loadEnv(testEnvSource({ RELAY_BASE_URL: "http://relay.example.com" }))).toThrow(EnvError);
  });

  test("TRUSTED_PROXY_HOPS: default 0, integer 0..5; the old TRUST_PROXY is refused, not ignored", () => {
    expect(loadEnv(testEnvSource()).trustedProxyHops).toBe(0);
    expect(loadEnv(testEnvSource({ TRUSTED_PROXY_HOPS: "2" })).trustedProxyHops).toBe(2);
    for (const bad of ["-1", "6", "1.5", "yes"]) {
      expect(() => loadEnv(testEnvSource({ TRUSTED_PROXY_HOPS: bad }))).toThrow(/TRUSTED_PROXY_HOPS is invalid/);
    }
    expect(() => loadEnv(testEnvSource({ TRUST_PROXY: "1" }))).toThrow(/TRUST_PROXY is invalid: was replaced by TRUSTED_PROXY_HOPS/);
  });
});

describe("logger", () => {
  test("redacts secrets at any depth and keeps structure", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), bindings: { reqId: "r1" } });
    log.child({ userId: "u-1" }).info("hello", {
      teamId: "t-1",
      githubToken: "gho_x",
      headers: { cookie: "a=b", authorization: "Bearer y", "x-morrow-csrf": "1" },
      nested: { deeper: { websocketUrl: "ws://x?key=jwt", apiKey: "k" } },
      body: "user message",
      text: "agent text",
    });
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: "info", msg: "hello", reqId: "r1", userId: "u-1", teamId: "t-1" });
    const raw = lines[0]!;
    for (const secret of ["gho_x", "a=b", "Bearer y", "jwt", '"k"', "user message", "agent text"]) expect(raw).not.toContain(secret);
  });

  test("respects level and serializes errors with stack", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", write: (l) => lines.push(l) });
    log.info("dropped");
    log.error("boom", { error: new Error("bad") });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).error).toMatchObject({ name: "Error", message: "bad" });
  });
});

describe("retry + actor invocation policy", () => {
  const noSleep = async () => {};

  test("backoff is bounded and jittered", () => {
    expect(backoffDelay(1, 100, 1000, () => 0.999)).toBeLessThan(100);
    expect(backoffDelay(10, 100, 1000, () => 0.999)).toBeLessThan(1000);
    expect(backoffDelay(3, 100, 1000, () => 0)).toBe(0);
  });

  test("retries until success within attempts", async () => {
    let n = 0;
    const out = await retry(async () => (++n < 3 ? Promise.reject(new Error("x")) : "ok"), {
      attempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 1,
      shouldRetry: () => true,
      sleep: noSleep,
    });
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  test("unavailable is retried; outcome_unknown only when idempotent; actor_error never", () => {
    expect(shouldRetryInvocation(new FakeInvocationError("unavailable"), false)).toBe(true);
    expect(shouldRetryInvocation(new FakeInvocationError("outcome_unknown"), false)).toBe(false);
    expect(shouldRetryInvocation(new FakeInvocationError("outcome_unknown"), true)).toBe(true);
    expect(shouldRetryInvocation(new FakeInvocationError("actor_error"), true)).toBe(false);
    expect(shouldRetryInvocation(new Error("plain"), true)).toBe(false);
  });

  test("invoke retries unavailable then surfaces a safe AppError", async () => {
    let calls = 0;
    const err = await invoke(
      async () => {
        calls++;
        throw new FakeInvocationError("unavailable");
      },
      { op: "Team.get", idempotent: true },
      { log: silentLogger, retry: { attempts: 3, sleep: noSleep } },
    ).catch((e) => e);
    expect(calls).toBe(3);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("dependency_unavailable");
    expect(err.message).not.toContain("actor said");
  });

  test("non-idempotent outcome_unknown runs exactly once", async () => {
    let calls = 0;
    const err = await invoke(
      async () => {
        calls++;
        throw new FakeInvocationError("outcome_unknown");
      },
      { op: "Team.createInvite", idempotent: false },
      { log: silentLogger, retry: { sleep: noSleep } },
    ).catch((e) => e);
    expect(calls).toBe(1);
    expect(err.code).toBe("dependency_unavailable");
  });

  test("actor_error becomes internal without the actor's message", () => {
    const e = translateInvocationError(new FakeInvocationError("actor_error"), "x", silentLogger);
    expect(e.code).toBe("internal");
    expect(e.message).toBe("Something went wrong.");
  });
});

describe("test command detection", () => {
  const pkg = (o: object) => JSON.stringify(o);
  test("package.json test script through the repo's package manager", () => {
    expect(detectTestCommand(["package.json", "bun.lock"], pkg({ scripts: { test: "bun test" } }))).toBe("bun run test");
    expect(detectTestCommand(["package.json", "pnpm-lock.yaml"], pkg({ scripts: { test: "vitest" } }))).toBe("pnpm test");
    expect(detectTestCommand(["package.json", "yarn.lock"], pkg({ scripts: { test: "jest" } }))).toBe("yarn test");
    expect(detectTestCommand(["package.json"], pkg({ scripts: { test: "jest" } }))).toBe("npm test");
    expect(detectTestCommand(["package.json", "yarn.lock"], pkg({ packageManager: "bun@1.4.4", scripts: { test: "x" } }))).toBe("bun run test");
  });
  test("npm init placeholder, missing script, junk JSON, other ecosystems", () => {
    expect(detectTestCommand(["package.json"], pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))).toBeNull();
    expect(detectTestCommand(["package.json"], pkg({ scripts: {} }))).toBeNull();
    expect(detectTestCommand(["package.json"], "{nope")).toBeNull();
    expect(detectTestCommand(["Cargo.toml"], null)).toBe("cargo test");
    expect(detectTestCommand(["go.mod"], null)).toBe("go test ./...");
    expect(detectTestCommand([], null)).toBeNull();
  });
});
