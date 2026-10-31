import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { errorBody } from "../lib/errors.ts";
import type { AppDeps, AppEnv } from "./context.ts";
import { errorHandler, notFoundHandler } from "./errors.ts";
import { csrf, rateLimitByMethod, requestContext, requireSession, securityHeaders } from "./middleware.ts";
import { authRoutes } from "./routes/auth.ts";
import { coreRoutes } from "./routes/core.ts";
import { healthRoutes } from "./routes/health.ts";
import { teamRoutes } from "./routes/teams.ts";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * A module that adds routes (environments, profiles, tasks, orchestration). It receives the
 * `/api/teams` router, which already runs requireSession + rate limiting; per-route handlers add
 * `requireTeam(...roles)` from ./middleware.ts and parse bodies with `readJson` from ./errors.ts.
 */
export type TeamRouteModule = (teams: Hono<AppEnv>) => void;

export function createApp(deps: AppDeps, modules: TeamRouteModule[] = []) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler(deps.log));
  app.notFound(notFoundHandler);
  app.use("*", requestContext(deps), securityHeaders);

  app.route("/", healthRoutes());

  app.use(
    "/api/*",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(errorBody("bad_request", "Request body too large."), 413) }),
    csrf(deps.env.appOrigin),
  );
  app.route("/api/auth", authRoutes());

  const signedIn = new Hono<AppEnv>();
  signedIn.use("*", requireSession);
  signedIn.route("/", coreRoutes());

  const teams = new Hono<AppEnv>();
  teams.use("*", rateLimitByMethod);
  teams.route("/", teamRoutes());
  for (const mount of modules) mount(teams);
  signedIn.route("/teams", teams);

  app.route("/api", signedIn);
  return app;
}
