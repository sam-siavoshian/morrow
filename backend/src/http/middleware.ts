import { CSRF_HEADER, Id, type Role } from "@morrow/contracts";
import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import { forbidden, notFound, rateLimited, unauthenticated } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { AppDeps, AppEnv } from "./context.ts";
import type { RateGroup } from "./rateLimit.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Request id, per-request logger, access log. Never logs query strings (OAuth codes, tickets). */
export function requestContext(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const reqId = newId("req");
    const log = deps.log.child({ reqId });
    c.set("deps", deps);
    c.set("reqId", reqId);
    c.set("log", log);
    const started = performance.now();
    try {
      await next();
    } finally {
      const userId = c.get("userId");
      const teamId = c.get("team")?.id;
      log.info("http", {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
        ...(userId ? { userId } : {}),
        ...(teamId ? { teamId } : {}),
      });
      // Off at the default level: addresses are personal data. Turned on briefly to pick TRUSTED_PROXY_HOPS
      // against the live proxy chain (deploy/README.md, "Client IP check").
      log.debug("http.client", {
        forwardedFor: c.req.header("x-forwarded-for") ?? null,
        peer: c.env?.server?.requestIP(c.req.raw)?.address ?? null,
        clientIp: clientIp(c, deps.env.trustedProxyHops),
      });
      c.header("x-request-id", reqId);
    }
  };
}

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("referrer-policy", "no-referrer");
  c.header("cross-origin-resource-policy", "same-origin");
  if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
};

/**
 * Mutating requests need `x-morrow-csrf: 1` and an Origin equal to APP_ORIGIN. SameSite=Lax plus a
 * custom header (which forces a CORS preflight we never approve) blocks cross-site form posts and fetches.
 */
export function csrf(appOrigin: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      if (c.req.header(CSRF_HEADER) !== "1") throw forbidden("Missing CSRF header.");
      if (c.req.header("origin") !== appOrigin) throw forbidden("Cross-origin request rejected.");
    }
    await next();
  };
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const uid = await c.get("deps").sessions.authenticate(c);
  if (!uid) throw unauthenticated();
  c.set("userId", uid);
  c.set("log", c.get("log").child({ userId: uid }));
  await next();
};

/**
 * The caller's address for pre-auth rate limits. The chain is [X-Forwarded-For entries..., socket peer];
 * every trusted proxy appends one entry, so the client is `hops` places from the right. Entries further
 * left are whatever the client sent and are never used. A chain shorter than that yields its leftmost
 * entry; a selected entry that is not an IP falls back to the peer, so garbage never mints a fresh bucket
 * per request.
 */
export function resolveClientIp(forwardedFor: string | undefined, peer: string | undefined, hops: number): string {
  const peerIp = normalizeIp(peer) ?? "unknown";
  if (hops <= 0) return peerIp;
  const chain = [...(forwardedFor ?? "").split(",").map((part) => part.trim()).filter(Boolean), peerIp];
  return normalizeIp(chain[Math.max(0, chain.length - 1 - hops)]) ?? peerIp;
}

/** Bare IPv4/IPv6, also from `1.2.3.4:5678`, `[::1]:5678` and IPv4-mapped IPv6. Null for anything else. */
function normalizeIp(value: string | undefined): string | null {
  if (!value || value.length > 64) return null;
  let ip = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(ip);
  if (bracketed) ip = bracketed[1]!;
  else if (/^[\d.]+:\d{1,5}$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  ip = ip.toLowerCase();
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) === 0 ? null : ip;
}

export function clientIp(c: Context<AppEnv>, hops: number): string {
  return resolveClientIp(c.req.header("x-forwarded-for"), c.env?.server?.requestIP(c.req.raw)?.address, hops);
}

/** Token bucket per signed-in user, or per client IP before sign-in. */
export function rateLimit(group: RateGroup): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get("deps");
    const subject = c.get("userId") ?? `ip:${clientIp(c, deps.env.trustedProxyHops)}`;
    const result = deps.rateLimiter.take(group, subject);
    if (!result.ok) throw rateLimited(result.retryAfterSeconds);
    await next();
  };
}

/** Writes are limited separately from reads. */
export const rateLimitByMethod: MiddlewareHandler<AppEnv> = async (c, next) =>
  rateLimit(SAFE_METHODS.has(c.req.method) ? "read" : "mutation")(c, next);

/**
 * Loads `:teamId` and the caller's membership. Non-members get 404, not 403, so team ids cannot be
 * probed. Members without one of `roles` get 403.
 */
export function requireTeam(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const teamId = c.req.param("teamId");
    if (!teamId || !Id.safeParse(teamId).success) throw notFound("Team not found.");
    const team = await c.get("deps").actors.getTeam(teamId);
    const member = team?.members.find((m) => m.userId === c.get("userId"));
    if (!team || !member) throw notFound("Team not found.");
    if (roles.length > 0 && !roles.includes(member.role)) throw forbidden("Your role in this team cannot do that.");
    c.set("team", team);
    c.set("role", member.role);
    c.set("log", c.get("log").child({ teamId }));
    await next();
  };
}
