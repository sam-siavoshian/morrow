import type { MeView, TeamView } from "@morrow/contracts";
import { cacheLife } from "next/cache";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { RememberTeam } from "@/components/auth/remember-team";
import { AppShell } from "@/components/shell/app-shell";
import { ServerUnreachable } from "@/components/shell/server-unreachable";
import { ShellSkeleton } from "@/components/shell/shell-skeleton";
import { parseSidebarCookie, SIDEBAR_COOKIE } from "@/components/shell/sidebar-store";
import { isApiError } from "@/lib/api";
import { getCachedTeamMember, getTeamView, requireTeamMember, SESSION_STALE_S } from "@/lib/server-session";
import { TeamProvider } from "@/lib/store";

type Member = { me: MeView; team: TeamView | null };

/** Every team page: membership checked on the server, then the live team store and the app shell. */
export default function TeamLayout({ children, params }: LayoutProps<"/t/[teamId]">) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <TeamGate params={params}>{children}</TeamGate>
    </Suspense>
  );
}

async function TeamGate({ params, children }: Pick<LayoutProps<"/t/[teamId]">, "params" | "children">) {
  const { teamId } = await params;
  const member = await resolveMember(teamId);
  if (!member) {
    // Rendered per request, so the browser never keeps an outage page as a cached shell.
    await connection();
    return <ServerUnreachable />;
  }
  return (
    <TeamProvider teamId={teamId} initialTeam={member.team}>
      {/* Only after membership is confirmed, so `/` never remembers a team you cannot open. */}
      <RememberTeam teamId={teamId} />
      <AppShell me={member.me} teamId={teamId} defaultOpen={await readSidebarOpen()}>
        {children}
      </AppShell>
    </TeamProvider>
  );
}

/**
 * The member, or null when the backend cannot answer. A member comes from the private cache, so the browser can reuse
 * this shell for SESSION_STALE_S. Anything else is decided uncached: signed out goes to /login and back, and a team you
 * are not in is a 404, so ids cannot be probed. Both run per request, so neither answer is kept as a cached shell.
 */
async function resolveMember(teamId: string): Promise<Member | null> {
  const cached = await getCachedTeamMember(teamId);
  if (cached === "unreachable") return null;
  if (cached) return cached;
  try {
    await connection();
    const [{ me }, team] = await Promise.all([requireTeamMember(teamId, `/t/${encodeURIComponent(teamId)}`), getTeamView(teamId)]);
    return { me, team };
  } catch (error) {
    unstable_rethrow(error);
    if (isApiError(error)) return null;
    throw error;
  }
}

/** The sidebar's saved open state, cached alongside the member so it does not pull the shell out of the cache. */
async function readSidebarOpen(): Promise<boolean> {
  "use cache: private";
  cacheLife({ stale: SESSION_STALE_S });
  return parseSidebarCookie((await cookies()).get(SIDEBAR_COOKIE)?.value);
}
