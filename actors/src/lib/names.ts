// Names that leave the actor: Relay agent names and git branches.

export const AGENT_NAME_PATTERN = /^[a-z0-9-]{1,64}$/
const AGENT_NAME_MAX = 64
const ROLE_SLUG_MAX = 16

/** Last 8 lowercase alphanumerics of the task id (ids usually end in their random part). */
export function taskShort(taskId: string): string {
    const compact = taskId.toLowerCase().replace(/[^a-z0-9]/g, "")
    return compact.slice(-8) || "task"
}

export function roleSlug(role: string): string {
    const slug = role
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, ROLE_SLUG_MAX)
        .replace(/-+$/g, "")
    return slug || "worker"
}

/**
 * `w-<taskShort>-<role>-e<epoch>`. Relay names are workspace-wide and stay taken after release, so the epoch makes
 * every lease's name unique. Always matches AGENT_NAME_PATTERN.
 */
export function agentName(taskId: string, role: string, epoch: number): string {
    const suffix = `-e${epoch}`
    const prefix = `w-${taskShort(taskId)}-`
    const room = AGENT_NAME_MAX - prefix.length - suffix.length
    const roleText = roleSlug(role).slice(0, Math.max(1, room)).replace(/-+$/g, "") || "w"
    return `${prefix}${roleText}${suffix}`.slice(0, AGENT_NAME_MAX)
}

/**
 * A subagent's name: `w-<taskShort>-<role>-sub-e<epoch>`, its workstream's role plus `-sub`. Planned roles have no
 * dashes, so it never equals a worker's name, and it still matches Relay's worker-name rule (ends in `-e<epoch>`).
 */
export function subagentName(taskId: string, role: string, epoch: number): string {
    return agentName(taskId, `${roleSlug(role).slice(0, ROLE_SLUG_MAX - 4).replace(/-+$/g, "") || "w"}-sub`, epoch)
}

/** `morrow/<taskShort>/<role>`, the backend's `workstreamBranch` (backend/test/naming.test.ts keeps them equal). */
export function workstreamBranch(taskId: string, role: string): string {
    return `morrow/${taskShort(taskId)}/${role}`
}

/** A conservative subset of `git check-ref-format --branch`. */
export function isValidBranch(name: string): boolean {
    if (name.length < 1 || name.length > 200) return false
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false
    if (name.includes("..") || name.includes("//")) return false
    if (name.startsWith("/") || name.startsWith("-") || name.endsWith("/") || name.endsWith(".")) return false
    if (name.endsWith(".lock") || name === "HEAD") return false
    return name.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
}
