import { loadEnv, type Env } from "../../src/env.ts";

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

/** A complete, valid env source with fresh random keys. Override anything per test. */
export function testEnvSource(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    APP_ORIGIN: "http://localhost:3000",
    REALTIME_URL: "ws://localhost:8787",
    PORT: "0",
    SESSION_SECRET: key(),
    DATA_ENCRYPTION_KEY: key(),
    GITHUB_CLIENT_ID: "fake-client-id",
    GITHUB_CLIENT_SECRET: "fake-client-secret",
    GITHUB_API_URL: "http://127.0.0.1:9",
    GITHUB_WEB_URL: "http://127.0.0.1:9",
    DURABLE_ACTORS_CONTROL_PLANE_URL: "http://127.0.0.1:9",
    DURABLE_ACTORS_SECRET: "test-secret-test-secret",
    RELAY_BASE_URL: "disabled",
    LOG_LEVEL: "error",
    ...overrides,
  };
}

export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return loadEnv(testEnvSource(overrides));
}
