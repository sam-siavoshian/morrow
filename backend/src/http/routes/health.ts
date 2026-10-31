import { Hono } from "hono";
import type { AppEnv } from "../context.ts";

const READY_TIMEOUT_MS = 3_000;

/** Liveness and readiness. Public, so they report up/down only: no latency, counts or error details. */
export function healthRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/healthz", (c) => c.json({ ok: true }));

  r.get("/readyz", async (c) => {
    const deps = c.get("deps");
    const started = performance.now();
    let terseOk = false;
    try {
      await Promise.race([
        deps.actors.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("terse ping timed out")), READY_TIMEOUT_MS).unref?.()),
      ]);
      terseOk = true;
    } catch (error) {
      c.get("log").warn("readiness: terse unreachable", { error });
    }
    // Counts and latency are operational detail: logs only, never in this public response.
    c.get("log").info("readiness", { terseOk, terseLatencyMs: Math.round(performance.now() - started), realtime: deps.hub.stats() });
    const body = {
      ok: terseOk,
      checks: {
        terse: terseOk ? "up" : "down",
        freestyle: deps.env.freestyle ? "configured" : "disabled",
        relay: deps.env.relay ? "configured" : "disabled",
      },
    };
    return c.json(body, terseOk ? 200 : 503);
  });

  return r;
}
