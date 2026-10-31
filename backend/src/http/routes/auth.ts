import { RETURN_TO_PROBE_ORIGIN } from "@morrow/contracts";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { signupAllowed } from "../../env.ts";
import { constantTimeEqual, decrypt, encrypt, randomToken } from "../../lib/crypto.ts";
import { unauthenticated } from "../../lib/errors.ts";
import { userIdFromGithub } from "../../lib/ids.ts";
import type { AppEnv } from "../context.ts";
import { encryptGithubToken } from "../githubAccess.ts";
import { rateLimit } from "../middleware.ts";

export const OAUTH_STATE_COOKIE = "morrow_oauth_state";
const OAUTH_STATE_CONTEXT = "morrow:oauth-state:v1";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_COOKIE_PATH = "/api/auth";

const StatePayload = z.object({ s: z.string().min(32).max(128), exp: z.number().int(), rt: z.string().max(512) });

/** Only same-site relative paths: blocks open redirects like `//evil.com` or `/\evil.com`. */
export function safeReturnTo(value: string | undefined | null): string {
  if (!value || value.length > 512) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const url = new URL(value, RETURN_TO_PROBE_ORIGIN);
    if (url.origin !== RETURN_TO_PROBE_ORIGIN) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function authRoutes() {
  const r = new Hono<AppEnv>();

  const redirectUri = (c: Context<AppEnv>) => `${c.get("deps").env.appOrigin}/api/auth/github/callback`;
  const loginError = (c: Context<AppEnv>, error: string) =>
    c.redirect(`${c.get("deps").env.appOrigin}/login?error=${encodeURIComponent(error)}`, 302);
  const stateCookieOptions = (c: Context<AppEnv>, maxAgeMs: number) => ({
    httpOnly: true,
    secure: c.get("deps").env.secureCookies,
    sameSite: "Lax" as const,
    path: OAUTH_COOKIE_PATH,
    maxAge: Math.floor(maxAgeMs / 1000),
  });

  r.get("/github", rateLimit("auth"), async (c) => {
    const deps = c.get("deps");
    const state = randomToken(32);
    const payload = JSON.stringify({ s: state, exp: deps.now() + OAUTH_STATE_TTL_MS, rt: safeReturnTo(c.req.query("returnTo")) });
    setCookie(c, OAUTH_STATE_COOKIE, await encrypt(deps.keys.session, payload, OAUTH_STATE_CONTEXT), stateCookieOptions(c, OAUTH_STATE_TTL_MS));
    return c.redirect(deps.github.authorizeUrl(state, redirectUri(c)), 302);
  });

  r.get("/github/callback", rateLimit("auth"), async (c) => {
    const deps = c.get("deps");
    const log = c.get("log");
    const cookie = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, stateCookieOptions(c, 0));

    if (c.req.query("error")) return loginError(c, "access_denied");

    const raw = cookie ? await decrypt(deps.keys.session, cookie, OAUTH_STATE_CONTEXT) : null;
    let payload: z.infer<typeof StatePayload> | null = null;
    try {
      payload = raw ? StatePayload.parse(JSON.parse(raw)) : null;
    } catch {
      payload = null;
    }
    const queryState = c.req.query("state") ?? "";
    if (!payload || payload.exp <= deps.now() || !constantTimeEqual(payload.s, queryState)) {
      log.warn("oauth state mismatch", { stateCookiePresent: Boolean(cookie) });
      return loginError(c, "state_mismatch");
    }
    const code = c.req.query("code") ?? "";
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(code)) return loginError(c, "bad_request");

    try {
      const { accessToken } = await deps.github.exchangeCode(code, redirectUri(c));
      const gh = await deps.github.getUser(accessToken);
      // Checked before anything is stored: a refused login leaves no user record behind.
      if (!signupAllowed(deps.env, gh.login)) {
        log.info("sign-in refused: not on the signup allowlist", { githubId: gh.id });
        return loginError(c, "not_allowed");
      }
      const userId = userIdFromGithub(gh.id);
      const user = await deps.actors.upsertUserFromGithub(
        { githubId: gh.id, login: gh.login, name: gh.name, avatarUrl: gh.avatarUrl, email: gh.email },
        await encryptGithubToken(deps, userId, accessToken),
      );
      deps.sessions.rememberVersion(user.id, user.sessionVersion);
      await deps.sessions.issue(c, user.id, user.sessionVersion);
      log.info("signed in", { userId: user.id });
      return c.redirect(`${deps.env.appOrigin}${payload.rt}`, 302);
    } catch (error) {
      log.error("oauth callback failed", { error });
      return loginError(c, "github_unavailable");
    }
  });

  r.post("/logout", rateLimit("auth"), async (c) => {
    const deps = c.get("deps");
    const everywhere = c.req.query("everywhere") === "1";
    if (everywhere) {
      const uid = await deps.sessions.authenticate(c);
      if (!uid) throw unauthenticated();
      await deps.actors.bumpSessionVersion(uid);
      deps.sessions.forgetVersion(uid);
      deps.hub.disconnectUser(uid);
      // Terminal tokens left behind still expire within 15 min; the failure is logged loudly.
      await deps.runtime.signOutEverywhere(uid).catch((error) => c.get("log").error("sign-out cleanup failed", { userId: uid, error }));
      c.get("log").info("signed out everywhere", { userId: uid });
    }
    deps.sessions.clear(c);
    return c.body(null, 204);
  });

  return r;
}
