import { APP_NAME, Id, RETURN_TO_PROBE_ORIGIN, type MeView } from "@morrow/contracts";
import { safeReturnTo } from "@/lib/api";

/** Where the landing page remembers the team you were last in. Not a secret: just a team id. */
export const LAST_TEAM_COOKIE = "morrow_last_team";

/** Pages that would bounce straight back to sign-in. */
const AUTH_PATHS = new Set(["/login", "/api/auth/github", "/api/auth/github/callback"]);

/**
 * A `?returnTo=` value we are willing to send someone to after sign-in: a path on this site and
 * nothing else. Takes the first value when the param repeats, rejects protocol-relative and
 * backslash tricks (via `safeReturnTo`), anything that resolves off-origin, and the auth pages.
 */
export function returnToFrom(raw: string | string[] | null | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const safe = safeReturnTo(value);
  if (!safe) return null;
  let url: URL;
  try {
    url = new URL(safe, RETURN_TO_PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== RETURN_TO_PROBE_ORIGIN) return null;
  if (AUTH_PATHS.has(url.pathname.replace(/\/+$/, "") || "/")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The `morrow_last_team` cookie as a team id, or null when it is missing or not an id at all. */
export const lastTeamFrom = (raw: string | null | undefined): string | null => (Id.safeParse(raw).success ? raw! : null);

/**
 * The team a signed-in visitor lands in: the last one they used if they are still in it, else their first,
 * else onboarding. `lastTeamCookie` is the raw cookie; it is validated here and never trusted as a path.
 */
export function landingPath(me: Pick<MeView, "teams">, lastTeamCookie?: string | null): string {
  const lastTeamId = lastTeamFrom(lastTeamCookie);
  const last = lastTeamId ? me.teams.find((t) => t.id === lastTeamId) : undefined;
  const team = last ?? me.teams[0];
  return team ? `/t/${encodeURIComponent(team.id)}` : "/onboarding";
}

const LOGIN_ERRORS: Record<string, string> = {
  access_denied: "GitHub sign-in was cancelled. Try again when you're ready.",
  state_mismatch: "That sign-in link expired or was opened in another browser. Start again from here.",
  bad_request: "GitHub sent back a response we couldn't use. Try again.",
  github_unavailable: "We couldn't reach GitHub just now. Try again in a moment.",
  not_allowed: `${APP_NAME} is invite-only for now, and your GitHub account isn't on the list yet.`,
};

/** A plain sentence for `?error=` on /login. Unknown codes get a generic line, never the raw value. */
export function loginErrorMessage(code: string | string[] | null | undefined): string | null {
  const value = Array.isArray(code) ? code[0] : code;
  if (!value) return null;
  return LOGIN_ERRORS[value] ?? "Sign-in didn't finish. Try again.";
}
