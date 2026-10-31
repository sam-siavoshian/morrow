import type { RelayAgentType } from "@agent-relay/sdk";
import { isRelayNotFound } from "./errors.ts";
import { DISPATCHER_NAME } from "./names.ts";
import type { SenderKind } from "./normalize.ts";

/** Registry lookup: the agent's registered type, or null when the name is not registered (e.g. deleted). */
export type AgentTypeLookup = (name: string) => Promise<RelayAgentType | null>;

export interface SenderKindResolver {
  kindOf(name: string): Promise<SenderKind>;
  /** Seed from facts we already know (our own sends, registrations) to skip a lookup. */
  remember(name: string, kind: SenderKind): void;
  readonly size: number;
}

export interface SenderKindResolverOptions {
  lookup: AgentTypeLookup;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Display classification only. Within one workspace every node and agent holds the admin key, so an agent can
 * register any name with any type; kinds are never an authorization signal.
 */
export function createSenderKindResolver(options: SenderKindResolverOptions): SenderKindResolver {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const maxEntries = options.maxEntries ?? 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { kind: SenderKind; expiresAt: number }>();
  const inflight = new Map<string, Promise<SenderKind>>();

  const put = (name: string, kind: SenderKind, ttl: number) => {
    cache.delete(name);
    cache.set(name, { kind, expiresAt: now() + ttl });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
  };

  const resolve = async (name: string): Promise<SenderKind> => {
    try {
      const type = await options.lookup(name);
      const kind = type === null ? conventionKind(name) : typeToKind(name, type);
      put(name, kind, type === null ? Math.min(ttlMs, 60_000) : ttlMs);
      return kind;
    } catch (error) {
      // A registry outage must not stall the event stream; the convention is right for every name we mint.
      put(name, conventionKind(name), isRelayNotFound(error) ? Math.min(ttlMs, 60_000) : 5_000);
      return conventionKind(name);
    }
  };

  return {
    async kindOf(name) {
      const hit = cache.get(name);
      if (hit && hit.expiresAt > now()) return hit.kind;
      const pending = inflight.get(name);
      if (pending) return pending;
      const run = resolve(name).finally(() => inflight.delete(name));
      inflight.set(name, run);
      return run;
    },
    remember(name, kind) {
      put(name, kind, ttlMs);
    },
    get size() {
      return cache.size;
    },
  };
}

function typeToKind(name: string, type: RelayAgentType): SenderKind {
  if (type === "system") return "system";
  // A broker registers itself as a human named after its node.
  if (type === "human") return name.startsWith("n-") ? "system" : "human";
  return "agent";
}

/** Our naming scheme: `h-` humans, `dispatcher` system, `n-` brokers, everything else an agent. */
export function conventionKind(name: string): SenderKind {
  if (name === DISPATCHER_NAME || name.startsWith("n-")) return "system";
  if (name.startsWith("h-")) return "human";
  return "agent";
}
