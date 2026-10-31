import { projectShort, RESOLVER_ROLE, taskShort } from "@morrow/contracts";
import { projectChannelName } from "../integrations/relay/index.ts";
import { randomSlug } from "../lib/ids.ts";

/** Workstream roles end up in agent names (`[a-z0-9]{1,16}`) and branches. */
export const ROLE_PATTERN = /^[a-z][a-z0-9]{0,15}$/;

// One rule for web, backend and actors: the browser matches Relay traffic to tasks with these.
export { projectShort, RESOLVER_ROLE, taskShort };

/** The workstream the actor adds to resolve a merge conflict (it works on the integration branch). */
export const isResolver = (ws: { role: string }) => ws.role === RESOLVER_ROLE;

/** The Relay channel every worker and member of a project talks in (validated by the Relay naming rules). */
export function projectChannel(projectId: string): string {
  return projectChannelName(projectShort(projectId));
}

export function workstreamBranch(taskId: string, role: string): string {
  return `morrow/${taskShort(taskId)}/${role}`;
}

export function integrationBranch(taskId: string): string {
  return `morrow/${taskShort(taskId)}/integration`;
}

export function newTaskId(): string {
  return `tk-${randomSlug(12)}`;
}

/** Idempotency key for one logical request. Keys share the actor id charset. */
export function newKey(prefix: string): string {
  return `${prefix}-${randomSlug(16)}`;
}

/** Stable short digest for event ids derived from content (e.g. a classifier match). */
export function digest(value: string, length = 16): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, length);
}

export const briefNotePath = (workstreamId: string) => `.morrow/briefs/${workstreamId}.md`;
export const handoffNotePath = (workstreamId: string) => `.morrow/handoff/${workstreamId}.md`;
