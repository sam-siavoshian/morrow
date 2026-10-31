import { INVITE_MAX_HOURS, INVITE_MAX_USES, MAX_PARALLEL_PER_TASK, TEAM_NAME_MAX, TEST_COMMAND_HIDDEN, TEST_COMMAND_MAX, type AssignableRole, type InviteView, type MemberView, type Role } from "@morrow/contracts";
import { formatResetTime } from "@/components/workforce/status";

/** Team settings, invites and projects: owner and admins (architecture section 4). */
export const canManageTeam = (role: Role) => role === "owner" || role === "admin";

/** Cancel and retry a task: its creator, the owner or an admin (the backend's rule; both spend teammates' usage). */
export const canManageTask = (role: Role, viewerId: string | null | undefined, createdBy: string) => canManageTeam(role) || (!!viewerId && viewerId === createdBy);

/** The owner hands out admin and member; nobody else changes roles, and the owner's role never changes. */
export const canChangeRole = (viewer: Role, target: Role): target is AssignableRole => viewer === "owner" && target !== "owner";

/** Same bounds as the backend, the policy's `maxParallelPerTask`. */
export const MAX_PARALLEL_CHOICES = Array.from({ length: MAX_PARALLEL_PER_TASK }, (_, i) => i + 1);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The rule team creation uses (the contract's `TeamName`, plus one line). Null when fine, else what to fix. */
export function teamNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Give the team a name.";
  if (name.length > TEAM_NAME_MAX) return `Keep it to ${TEAM_NAME_MAX} characters.`;
  if (CONTROL_CHARS.test(name)) return "Use a single line of text.";
  return null;
}

/**
 * A typed test command, checked like the backend does: trimmed, one line, at most `TEST_COMMAND_MAX` characters. An empty field
 * means "no command" (tests are skipped). `{ value }` is what to send, `{ problem }` what to fix.
 */
export function parseTestCommand(raw: string): { value: string | null } | { problem: string } {
  const command = raw.trim();
  if (!command) return { value: null };
  if (command.length > TEST_COMMAND_MAX) return { problem: `Keep it to ${TEST_COMMAND_MAX} characters.` };
  if (CONTROL_CHARS.test(command)) return { problem: "Use one line, with no tabs or line breaks." };
  if (TEST_COMMAND_HIDDEN.test(command)) return { problem: "Remove invisible or direction-changing characters." };
  return { value: command };
}

export type MemberAction = "remove" | "leave" | null;

/**
 * What the viewer may do to a member row, mirroring the backend: the owner removes anyone but
 * themselves, admins remove plain members only, anyone but the owner may leave.
 */
export function memberAction(viewer: { userId: string; role: Role }, target: { userId: string; role: Role }): MemberAction {
  if (target.role === "owner") return null;
  if (target.userId === viewer.userId) return "leave";
  if (viewer.role === "owner") return "remove";
  if (viewer.role === "admin" && target.role === "member") return "remove";
  return null;
}

export const INVITE_EXPIRY_CHOICES = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "1 day" },
  { hours: INVITE_MAX_HOURS, label: "7 days" },
] as const;

/** Clamp a typed max-uses value to what the backend accepts; null when it is not a number at all. */
export function parseMaxUses(value: string): number | null {
  if (!/^\d{1,3}$/.test(value.trim())) return null;
  return Math.min(INVITE_MAX_USES.max, Math.max(INVITE_MAX_USES.min, Number(value)));
}

/** "Works for 10 people until Tue 4:10 PM." Never echoes the token. */
export function inviteSummary(maxUses: number, expiresAt: number, now: number, locale?: string): string {
  const people = maxUses === 1 ? "1 person" : `${maxUses} people`;
  return `Works for ${people} until ${formatResetTime(expiresAt, now, locale)}.`;
}

/** One active-invite row: who made it, how much of it is left, when it stops working. Never the link. */
export function inviteRow(invite: InviteView, members: readonly Pick<MemberView, "userId" | "login">[], now: number, locale?: string) {
  const maker = members.find((m) => m.userId === invite.createdBy);
  return {
    title: maker ? `Made by @${maker.login}` : "Made by someone who left",
    detail: `${invite.uses} of ${invite.maxUses} used. Expires ${formatResetTime(invite.expiresAt, now, locale)}.`,
  };
}
