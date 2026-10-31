import type { Role, TeamPolicy } from "@morrow/contracts";
import type { TeamField } from "@/lib/store";

/** The team fields settings edits optimistically (see `optimisticTeamField`). */
export const nameField: TeamField<string> = {
  read: (team) => team.name,
  write: (team, name) => ({ ...team, name }),
};

export function policyField<K extends keyof TeamPolicy>(key: K): TeamField<TeamPolicy[K]> {
  return {
    read: (team) => team.policy[key],
    write: (team, value) => ({ ...team, policy: { ...team.policy, [key]: value } }),
  };
}

/** A project's test command; a project that is gone reads as null and is left alone on write. */
export function projectTestCommandField(projectId: string): TeamField<string | null> {
  return {
    read: (team) => team.projects.find((p) => p.id === projectId)?.testCommand ?? null,
    write: (team, testCommand) => ({ ...team, projects: team.projects.map((p) => (p.id === projectId ? { ...p, testCommand } : p)) }),
  };
}

/** A member's role; a member who is gone reads as null and is left alone on write. */
export function memberRoleField(userId: string): TeamField<Role | null> {
  return {
    read: (team) => team.members.find((m) => m.userId === userId)?.role ?? null,
    write: (team, role) => (role === null ? team : { ...team, members: team.members.map((m) => (m.userId === userId ? { ...m, role } : m)) }),
  };
}
