import type { ActorGateway } from "../../src/actors/types.ts";
import { createApp, type TeamRouteModule } from "../../src/http/app.ts";
import type { AppDeps } from "../../src/http/context.ts";
import { silentLogger, type Logger } from "../../src/lib/logger.ts";
import { buildDeps, type BuildOptions } from "../../src/server.ts";
import { testEnv } from "./env.ts";

export const ORIGIN = "http://localhost:3000";

/**
 * A gateway that fails loudly if touched. Used where a request must be rejected before it reaches
 * Terse (CSRF, OAuth state, ...): any call means the guard under test did not hold.
 */
export function unreachableActors(overrides: Partial<ActorGateway> = {}): ActorGateway {
  return new Proxy(overrides as ActorGateway, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof ActorGateway];
      if (prop === "then") return undefined;
      return () => {
        throw new Error(`actor gateway must not be called here (${String(prop)})`);
      };
    },
  });
}

export interface TestApp {
  deps: AppDeps;
  request(path: string, init?: RequestInit & { csrf?: boolean; cookie?: string }): Promise<Response>;
}

export async function makeTestApp(
  options: {
    actors?: ActorGateway;
    env?: Record<string, string | undefined>;
    now?: () => number;
    log?: Logger;
    /** Route modules, or a factory for modules that need the built deps. */
    modules?: TeamRouteModule[] | ((deps: AppDeps) => TeamRouteModule[]);
    build?: Pick<BuildOptions, "runtimeActors" | "runtime" | "rateLimits">;
  } = {},
): Promise<TestApp> {
  const env = testEnv(options.env);
  const deps = await buildDeps(env, { ...options.build, actors: options.actors ?? unreachableActors(), log: options.log ?? silentLogger, now: options.now });
  const app = createApp(deps, typeof options.modules === "function" ? options.modules(deps) : options.modules);
  return {
    deps,
    request: (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (init.csrf) {
        headers.set("x-morrow-csrf", "1");
        headers.set("origin", env.appOrigin);
      }
      if (init.cookie) headers.set("cookie", init.cookie);
      return Promise.resolve(app.request(`http://backend.test${path}`, { ...init, headers }));
    },
  };
}

/** `name=value` pairs from Set-Cookie headers, for replaying cookies. */
export function cookiesFrom(res: Response): Record<string, { value: string; raw: string }> {
  const out: Record<string, { value: string; raw: string }> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair!.indexOf("=");
    out[pair!.slice(0, eq).trim()] = { value: pair!.slice(eq + 1), raw };
  }
  return out;
}
