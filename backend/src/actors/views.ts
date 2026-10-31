import type { MeView, TeamView, UserView } from "@morrow/contracts";
import type { TeamRecord, UserRecord } from "./types.ts";

/** The browser's view of a team. Null when `viewerId` is not a member (callers treat that as not found). */
export function toTeamView(team: TeamRecord, viewerId: string): TeamView | null {
  const viewer = team.members.find((m) => m.userId === viewerId);
  if (!viewer) return null;
  return {
    id: team.id,
    name: team.name,
    slug: team.slug,
    viewerRole: viewer.role,
    members: team.members.map((m) => ({
      userId: m.userId,
      login: m.login,
      name: m.name,
      avatarUrl: m.avatarUrl,
      role: m.role,
    })),
    projects: team.projects.map((p) => ({
      id: p.id,
      repoFullName: p.repoFullName,
      defaultBranch: p.defaultBranch,
      testCommand: p.testCommand,
    })),
    environments: team.environments,
    policy: team.policy,
    relayReady: team.relayReady,
  };
}

export function toUserView(user: UserRecord): UserView {
  return { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl };
}

export function toMeTeam(team: TeamRecord, viewerId: string): MeView["teams"][number] | null {
  const viewer = team.members.find((m) => m.userId === viewerId);
  return viewer ? { id: team.id, name: team.name, slug: team.slug, role: viewer.role } : null;
}
