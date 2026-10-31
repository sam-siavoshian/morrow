import type { Role } from "@morrow/contracts";
import type { Server } from "bun";
import type { ActorGateway, TeamRecord } from "../actors/types.ts";
import type { Env } from "../env.ts";
import type { GithubClient } from "../integrations/github/client.ts";
import type { Logger } from "../lib/logger.ts";
import type { RealtimeHub } from "../realtime/hub.ts";
import type { TicketStore } from "../realtime/tickets.ts";
import type { RuntimeBus } from "../runtime/bus.ts";
import type { TeamRuntime } from "../runtime/teamRuntime.ts";
import type { RateLimiter } from "./rateLimit.ts";
import type { SessionService } from "./session.ts";
import type { TeamEvents } from "./teamEvents.ts";

export interface Keys {
  /** SESSION_SECRET: session and OAuth state cookies. */
  session: CryptoKey;
  /** DATA_ENCRYPTION_KEY: secrets stored in actors. */
  data: CryptoKey;
}

export interface AppDeps {
  env: Env;
  log: Logger;
  keys: Keys;
  actors: ActorGateway;
  github: GithubClient;
  sessions: SessionService;
  tickets: TicketStore;
  hub: RealtimeHub;
  rateLimiter: RateLimiter;
  teamEvents: TeamEvents;
  /** Relay workspaces + observers, environments, profiles, inspect. Orchestration uses it as `TeamRuntimeApi`. */
  runtime: TeamRuntime;
  /** Relay signals per team (observer -> orchestration). */
  bus: RuntimeBus;
  now: () => number;
}

export interface AppVariables {
  deps: AppDeps;
  reqId: string;
  log: Logger;
  userId: string;
  team: TeamRecord;
  role: Role;
}

export interface AppBindings {
  server?: Server<unknown>;
}

export type AppEnv = { Variables: AppVariables; Bindings: AppBindings };
