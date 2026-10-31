import { SESSION_COOKIE } from "@morrow/contracts";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { ActorGateway } from "../actors/types.ts";
import { decrypt, encrypt } from "../lib/crypto.ts";

export { SESSION_COOKIE };
export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_CONTEXT = "morrow:session:v1";
const VERSION_CACHE_TTL_MS = 30_000;
const VERSION_CACHE_MAX = 20_000;

const Claims = z.object({
  uid: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  sv: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type SessionClaims = z.infer<typeof Claims>;

export interface SessionServiceOptions {
  key: CryptoKey;
  actors: Pick<ActorGateway, "getUser">;
  secure: boolean;
  now?: () => number;
  maxAgeMs?: number;
  versionCacheTtlMs?: number;
}

/**
 * Stateless encrypted session cookie `{ uid, sv, exp }`. `sv` must match the User actor's session
 * version (cached briefly per process), which is how logout-everywhere revokes old cookies.
 */
export class SessionService {
  readonly #o: Required<Omit<SessionServiceOptions, "actors" | "key">> & Pick<SessionServiceOptions, "actors" | "key">;
  readonly #versions = new Map<string, { sv: number; at: number }>();

  constructor(options: SessionServiceOptions) {
    this.#o = {
      ...options,
      now: options.now ?? Date.now,
      maxAgeMs: options.maxAgeMs ?? SESSION_MAX_AGE_MS,
      versionCacheTtlMs: options.versionCacheTtlMs ?? VERSION_CACHE_TTL_MS,
    };
  }

  async encode(claims: SessionClaims): Promise<string> {
    return encrypt(this.#o.key, JSON.stringify(claims), SESSION_CONTEXT);
  }

  /** Null for missing, tampered, malformed or expired cookies. Does not check the session version. */
  async decode(token: string | undefined): Promise<SessionClaims | null> {
    if (!token) return null;
    const plaintext = await decrypt(this.#o.key, token, SESSION_CONTEXT);
    if (plaintext === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(plaintext);
    } catch {
      return null;
    }
    const parsed = Claims.safeParse(raw);
    if (!parsed.success || parsed.data.exp <= this.#o.now()) return null;
    return parsed.data;
  }

  async issue(c: Context, uid: string, sv: number): Promise<void> {
    const exp = this.#o.now() + this.#o.maxAgeMs;
    setCookie(c, SESSION_COOKIE, await this.encode({ uid, sv, exp }), this.#cookieOptions(this.#o.maxAgeMs));
  }

  clear(c: Context): void {
    deleteCookie(c, SESSION_COOKIE, this.#cookieOptions(0));
  }

  /**
   * Resolves the signed-in user id, or null. Refreshes the cookie when it is past half its life.
   * Throws (AppError from the gateway) only when Terse is unreachable, never for a bad cookie.
   */
  async authenticate(c: Context): Promise<string | null> {
    const claims = await this.decode(getCookie(c, SESSION_COOKIE));
    if (!claims) return null;
    const current = await this.#currentVersion(claims.uid);
    if (current === null || current !== claims.sv) return null;
    if (claims.exp - this.#o.now() < this.#o.maxAgeMs / 2) await this.issue(c, claims.uid, claims.sv);
    return claims.uid;
  }

  /** Call after bumping a user's session version so this process stops honoring old cookies at once. */
  forgetVersion(uid: string): void {
    this.#versions.delete(uid);
  }

  rememberVersion(uid: string, sv: number): void {
    this.#remember(uid, sv);
  }

  async #currentVersion(uid: string): Promise<number | null> {
    const cached = this.#versions.get(uid);
    if (cached && this.#o.now() - cached.at < this.#o.versionCacheTtlMs) return cached.sv;
    const user = await this.#o.actors.getUser(uid);
    if (!user) {
      this.#versions.delete(uid);
      return null;
    }
    this.#remember(uid, user.sessionVersion);
    return user.sessionVersion;
  }

  #remember(uid: string, sv: number): void {
    this.#versions.delete(uid);
    this.#versions.set(uid, { sv, at: this.#o.now() });
    if (this.#versions.size > VERSION_CACHE_MAX) {
      const oldest = this.#versions.keys().next().value;
      if (oldest !== undefined) this.#versions.delete(oldest);
    }
  }

  #cookieOptions(maxAgeMs: number) {
    return {
      httpOnly: true,
      secure: this.#o.secure,
      sameSite: "Lax" as const,
      path: "/",
      maxAge: Math.floor(maxAgeMs / 1000),
    };
  }
}
