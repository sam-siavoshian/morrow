/**
 * Short names derived from ids. Workers, branches and Relay channels are named from these, so the
 * browser can tell which Relay traffic belongs to which task without asking the server.
 */

/** Last 8 lowercase alphanumerics of a task id. Worker names look like `w-<taskShort>-<role>-e<epoch>`. */
export function taskShort(taskId: string): string {
  return taskId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8) || "task";
}

/** Project ids end in their random part (`p-<12 chars>`). */
export function projectShort(projectId: string): string {
  return projectId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-12) || "project";
}

/** The Relay channel every worker and member of a project talks in. */
export function projectChannel(projectId: string): string {
  return `proj-${projectShort(projectId)}`;
}

/** Prefix shared by every worker agent name a task ever spawns. */
export function taskWorkerPrefix(taskId: string): string {
  return `w-${taskShort(taskId)}-`;
}

/** A member's Relay identity (`h-<login>`, lowercased because GitHub logins are case-insensitive). */
export function humanRelayName(githubLogin: string): string {
  return `h-${githubLogin.toLowerCase()}`;
}
