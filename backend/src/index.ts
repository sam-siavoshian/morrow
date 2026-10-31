import { createActorGateway } from "./actors/gateway.ts";
import { EnvError, loadEnv, type Env } from "./env.ts";
import { createGithubLayer } from "./github/index.ts";
import type { TeamRouteModule } from "./http/app.ts";
import { environmentRoutes } from "./http/routes/environments.ts";
import { createLogger } from "./lib/logger.ts";
import { createTeamDirectoryClient } from "./orchestration/directory.ts";
import { createOrchestration } from "./orchestration/index.ts";
import { buildDeps, startServer } from "./server.ts";

let env: Env;
try {
  env = loadEnv();
} catch (error) {
  if (error instanceof EnvError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const log = createLogger({ level: env.logLevel, bindings: { svc: "backend" } });
const deps = await buildDeps(env, { log, actors: createActorGateway(env.terse, log.child({ mod: "actors" })) });
const orchestration = createOrchestration({
  deps,
  runtime: deps.runtime,
  bus: deps.bus,
  options: { feed: "actors", directory: createTeamDirectoryClient(env.terse, log.child({ mod: "directory" })) },
});
const github = createGithubLayer({
  deps,
  workforce: orchestration.ctx.wf,
  reviewComment: (event) => orchestration.comms.reviewComment(event),
});
const modules: TeamRouteModule[] = [environmentRoutes, orchestration.routes, github.routes];
const running = startServer(deps, { modules });
orchestration.start();
github.start();
log.info("listening", {
  url: running.url.toString(),
  features: { freestyle: env.freestyle !== null, relay: env.relay !== null },
});
process.on("unhandledRejection", (error) => log.error("unhandled rejection", { error }));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    // Drain orchestration first so no loop touches the runtime after it stops.
    void Promise.all([orchestration.stop(), github.stop()])
      .catch((error) => log.error("background stop failed", { error }))
      .then(() => running.shutdown(signal))
      .then(() => process.exit(0));
  });
}
