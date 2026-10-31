import "server-only";
import { Id, InvitePreviewView, MeView, SESSION_COOKIE, TeamView, type Role } from "@morrow/contracts";
import { cacheLife } from "next/cache";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { ApiError, loginPath } from "./api";
import { backendUrl as resolveBackendUrl } from "./backend-url";

/** Throws in production when BACKEND_URL is missing, rather than quietly calling localhost. */
const backendUrl = resolveBackendUrl();
const TIMEOUT_MS = 5_000;
/** The backend mints `v1.<b64url>.<b64url>`; anything else is not worth a round trip. */
const COOKIE_VALUE = /^[A-Za-z0-9._~%-]{1,8192}$/;

/**
 * How long the browser's router may reuse a session-derived read (seconds). Five minutes or more puts it in the
 * route's per-session App Shell; below that it is fetched again on navigation (see cacheLife in the Next docs).
 */
export const SESSION_STALE_S = 300;

/**
 * The signed-in user, or null when signed out. Reads the request cookie, so with Cache Components
 * the calling component must sit inside `<Suspense>` (or a route `loading.tsx`). Deduped per request.
 * Throws ApiError when the backend cannot answer: a backend outage is not a sign-out.
 */
export const getSession = cache(async (): Promise<MeView | null> => {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value || !COOKIE_VALUE.test(value)) return null;

  let res: Response;
  try {
    res = await fetch(`${backendUrl}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${value}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError("dependency_unavailable", "Can't reach the server right now.", 503);
  }
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError("dependency_unavailable", "Can't load your account right now.", res.status);
  const parsed = MeView.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new ApiError("bad_response", "The server sent a response we could not read.", res.status);
  return parsed.data;
});

/** The signed-in user, or a redirect to `/login` that comes back to `returnTo`. */
export async function requireSession(returnTo?: string): Promise<MeView> {
  const me = await getSession();
  if (!me) redirect(loginPath(returnTo));
  return me;
}

/**
 * The full team view for a team the caller is a member of, or null when the backend cannot answer.
 * Only a head start for the client store: the socket's first `team.view` replaces it. Deduped per request.
 */
export const getTeamView = cache(async (teamId: string): Promise<TeamView | null> => {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value || !COOKIE_VALUE.test(value) || !Id.safeParse(teamId).success) return null;
  try {
    const res = await fetch(`${backendUrl}/api/teams/${encodeURIComponent(teamId)}`, {
      headers: { cookie: `${SESSION_COOKIE}=${value}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const parsed = TeamView.safeParse(await res.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
});

/**
 * The team layout's reads for a member: the session and the team head start, under `use cache: private`. In production
 * that result lives only in this browser's router cache, never on the server and never across users, so coming back to
 * a team within SESSION_STALE_S needs no backend round trip.
 *
 * Only a confirmed member is worth keeping. Signed out or not a member is null, and the caller re-checks uncached so
 * those answers come from fresh data. A backend failure is "unreachable" rather than a throw: an error crossing the cache
 * boundary loses its ApiError type, and asking again uncached would double the wait on a hung backend.
 */
export async function getCachedTeamMember(teamId: string): Promise<{ me: MeView; team: TeamView | null } | "unreachable" | null> {
  "use cache: private";
  cacheLife({ stale: SESSION_STALE_S });
  try {
    const [me, team] = await Promise.all([getSession(), getTeamView(teamId)]);
    return me?.teams.some((t) => t.id === teamId) ? { me, team } : null;
  } catch (error) {
    if (error instanceof ApiError) return "unreachable";
    throw error;
  }
}

/** Signed in and a member of `teamId`; non-members get the not-found page so team ids cannot be probed. */
export async function requireTeamMember(
  teamId: string,
  returnTo?: string,
): Promise<{ me: MeView; team: MeView["teams"][number]; role: Role }> {
  const me = await requireSession(returnTo);
  const team = me.teams.find((t) => t.id === teamId);
  if (!team) notFound();
  return { me, team, role: team.role };
}

/**
 * What an invite link leads to, for the join page: null when the link cannot be used (the backend answers every
 * such case with the same 404). Throws ApiError when the backend cannot answer. Needs a session.
 */
export async function getInvitePreview(token: string): Promise<InvitePreviewView | null> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value || !COOKIE_VALUE.test(value)) return null;
  let res: Response;
  try {
    res = await fetch(`${backendUrl}/api/invites/preview?token=${encodeURIComponent(token)}`, {
      headers: { cookie: `${SESSION_COOKIE}=${value}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError("dependency_unavailable", "Can't reach the server right now.", 503);
  }
  if (res.status === 404) return null;
  if (res.status === 429) throw new ApiError("rate_limited", "Too many tries. Wait a minute and reload.", 429);
  if (!res.ok) throw new ApiError("dependency_unavailable", "Can't load this invite right now.", res.status);
  const parsed = InvitePreviewView.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new ApiError("bad_response", "The server sent a response we could not read.", res.status);
  return parsed.data;
}
