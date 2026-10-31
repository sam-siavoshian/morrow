import type { Server } from "bun";
import type { ActorGateway } from "./actors/types.ts";
import type { Env } from "./env.ts";
import { createApp, type TeamRouteModule } from "./http/app.ts";
import type { AppDeps } from "./http/context.ts";
import { RateLimiter, type BucketConfig, type RateGroup } from "./http/rateLimit.ts";
import { SessionService } from "./http/session.ts";
import { TeamEvents } from "./http/teamEvents.ts";
import { GithubClient } from "./integrations/github/client.ts";
import { importAesKey } from "./lib/crypto.ts";
import { createLogger, type Logger } from "./lib/logger.ts";
import { RealtimeHub, type SocketData } from "./realtime/hub.ts";
import { TicketStore } from "./realtime/tickets.ts";
import { createRuntimeActors, type RuntimeActors } from "./runtime/actors.ts";
import { RuntimeBus } from "./runtime/bus.ts";
import { INSPECT_PATH_PREFIX, isInspectSocket, type InspectSocketData } from "./runtime/inspect.ts";
import { TeamRuntime, type TeamRuntimeOptions } from "./runtime/teamRuntime.ts";

export interface BuildOptions {
  actors: ActorGateway;
  log?: Logger;
  githubFetch?: typeof globalThis.fetch;
  now?: () => number;
  rateLimits?: Partial<Record<RateGroup, BucketConfig>>;
  /** The runtime's Terse door; defaults to a client on the same Terse as `actors`. */
  runtimeActors?: RuntimeActors;
  /** Test seams for the team runtime (Freestyle client, loop timings, fake observers). */
  runtime?: Pick<TeamRuntimeOptions, "freestyleClient" | "timing" | "createObserver" | "observerFlushMs" | "vmWait" | "backoffMs" | "reprobeDelayMs">;
}

/** Wires every dependency from validated env. Pure construction: no listeners, no timers started. */
export async function buildDeps(env: Env, options: BuildOptions): Promise<AppDeps> {
  const log = options.log ?? createLogger({ level: env.logLevel, bindings: { svc: "backend" } });
  const now = options.now ?? Date.now;
  const keys = { session: await importAesKey(env.sessionSecret), data: await importAesKey(env.dataEncryptionKey) };
  const actors = options.actors;
  const tickets = new TicketStore({ now });
  const hub = new RealtimeHub({ actors, tickets, appOrigin: env.appOrigin, log: log.child({ mod: "realtime" }), now });
  const teamEvents = new TeamEvents(log);
  const bus = new RuntimeBus(log.child({ mod: "bus" }));
  const github = new GithubClient({ ...env.github, fetch: options.githubFetch });
  const runtime = new TeamRuntime({
    github,
    ...options.runtime,
    env,
    log: log.child({ mod: "runtime" }),
    keys,
    gateway: actors,
    actors: options.runtimeActors ?? createRuntimeActors(env.terse, log.child({ mod: "actors" })),
    hub,
    tickets,
    bus,
    teamEvents,
    now,
  });
  return {
    env,
    log,
    keys,
    actors,
    github,
    sessions: new SessionService({ key: keys.session, actors, secure: env.secureCookies, now }),
    tickets,
    hub,
    rateLimiter: new RateLimiter({ now, limits: options.rateLimits }),
    teamEvents,
    runtime,
    bus,
    now,
  };
}

type ServerSocketData = SocketData | InspectSocketData;

export interface RunningServer {
  server: Server<ServerSocketData>;
  deps: AppDeps;
  url: URL;
  shutdown(reason?: string): Promise<void>;
}

/** Starts Bun.serve with the Hono app and the /realtime hub on one port. */
export function startServer(deps: AppDeps, options: { port?: number; hostname?: string; modules?: TeamRouteModule[] } = {}): RunningServer {
  const app = createApp(deps, options.modules);
  const { hub, log, runtime } = deps;
  const hubWs = hub.websocket;
  const inspect = runtime.inspect;
  const server = Bun.serve<ServerSocketData>({
    port: options.port ?? deps.env.port,
    hostname: options.hostname ?? deps.env.host,
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (path === "/realtime") return hub.handleUpgrade(req, srv as Server<SocketData>);
      if (path.startsWith(INSPECT_PATH_PREFIX)) return inspect.handleUpgrade(req, srv as Server<InspectSocketData>);
      return app.fetch(req, { server: srv });
    },
    // One handler per server in Bun: inspect sockets are told apart by their upgrade data.
    websocket: {
      ...hubWs,
      open: (ws) => (isInspectSocket(ws.data) ? inspect.open(ws as never) : hubWs.open?.(ws as never)),
      message: (ws, message) => (isInspectSocket(ws.data) ? inspect.message(ws as never, message) : hubWs.message?.(ws as never, message)),
      close: (ws, code, reason) => (isInspectSocket(ws.data) ? inspect.close(ws as never) : hubWs.close?.(ws as never, code, reason)),
    },
    error(error) {
      log.error("unhandled server error", { error });
      return Response.json({ error: { code: "internal", message: "Something went wrong." } }, { status: 500 });
    },
  });
  deps.tickets.start();
  deps.rateLimiter.start();
  runtime.start();

  let stopping: Promise<void> | null = null;
  const shutdown = (reason = "shutdown") =>
    (stopping ??= (async () => {
      log.info("shutting down", { reason });
      // Observers flush their Relay cursors; runner loops finish their current step.
      await runtime.stop().catch((error) => log.error("runtime stop failed", { error }));
      hub.close();
      deps.tickets.stop();
      deps.rateLimiter.stop();
      // Stop accepting, let in-flight requests finish for a moment, then force the rest closed.
      const graceful = server.stop(false);
      const timedOut = await Promise.race([graceful.then(() => false), Bun.sleep(5_000).then(() => true)]);
      if (timedOut) await server.stop(true);
      log.info("stopped");
      await log.flush();
    })());

  return { server, deps, url: server.url, shutdown };
}
