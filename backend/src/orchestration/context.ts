// The shared handles every orchestration loop gets, plus small lookups they all need.
import type { EnvironmentView, ProjectView } from "@morrow/contracts";
import type { ActorGateway } from "../actors/types.ts";
import { FreestyleIntegrationError, type EnvironmentRecord } from "../integrations/freestyle/index.ts";
import { GithubError, type GithubErrorKind } from "../integrations/github/client.ts";
import { asRelayError, RelayIntegrationError, type RelayIntegrationErrorCode } from "../integrations/relay/errors.ts";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import type { TeamRuntimeApi } from "../runtime/types.ts";
import type { Lanes } from "./lanes.ts";
import type { Memory } from "./memory.ts";
import type { Ports, VmTarget } from "./ports.ts";
import type { WorkforceApi } from "./workforce.ts";

export interface Timing {
  /** Outbox poll for teams with recent activity, and for the rest. */
  claimHotMs: number;
  claimIdleMs: number;
  hotWindowMs: number;
  /** Reconcile, scheduling, handoff and verification pass. */
  reconcileMs: number;
  /** Lease watch pass (spawn reconcile, liveness, log classification). */
  monitorMs: number;
  /**
   * With a pushed view (feed.ts): scheduling passes run when the view changes, at most this often, and claims run
   * when the pushed outbox summary says something is due. `safetyMs` is the slowest any team then goes without a
   * claim, an actor sweep, a scheduling pass and a notify pass, in case a push was missed.
   */
  decideMinMs: number;
  safetyMs: number;
  logPollMs: number;
  spawnReconcileAfterMs: number;
  /** A node offline this long, or this many `unknown` reads with a crash in the log, kills its leases. */
  nodeDeadMs: number;
  unknownDeadReads: number;
  /** A subagent still running this long after it was started is stopped and reported to its parent as failed. */
  subagentMaxMs: number;
  heartbeatMs: number;
  plannerTimeoutMs: number;
  testTimeoutMs: number;
  verifyRetryMs: number;
}

export const DEFAULT_TIMING: Timing = {
  claimHotMs: 1_000,
  claimIdleMs: 10_000,
  hotWindowMs: 60_000,
  reconcileMs: 15_000,
  monitorMs: 5_000,
  decideMinMs: 5_000,
  safetyMs: 60_000,
  logPollMs: 20_000,
  spawnReconcileAfterMs: 120_000,
  nodeDeadMs: 90_000,
  unknownDeadReads: 3,
  subagentMaxMs: 3_600_000,
  heartbeatMs: 60_000,
  plannerTimeoutMs: 120_000,
  testTimeoutMs: 285_000,
  verifyRetryMs: 60_000,
};

export interface Ctx {
  wf: WorkforceApi;
  runtime: TeamRuntimeApi;
  teams: Pick<ActorGateway, "getTeam">;
  ports: Ports;
  memory: Memory;
  lanes: Lanes;
  log: Logger;
  now: () => number;
  timing: Timing;
  /** `GITHUB_WEB_URL`: http(s), no trailing slash. Every repo, branch and commit link starts here. */
  githubWebUrl: string;
  /** Add review and research partners to a one-workstream plan when slots are free. Omitted means on. */
  partners?: boolean;
}

/** A link into a repo on the configured GitHub, e.g. `tree/<branch>` or `commit/<sha>`. */
export function repoWebUrl(ctx: Pick<Ctx, "githubWebUrl">, repoFullName: string, path: string): string {
  return `${ctx.githubWebUrl}/${repoFullName}/${path}`;
}

export async function findProject(ctx: Ctx, teamId: string, projectId: string): Promise<ProjectView | null> {
  const team = await ctx.teams.getTeam(teamId);
  return team?.projects.find((p) => p.id === projectId) ?? null;
}

export async function teamEnvironments(ctx: Ctx, teamId: string): Promise<Map<string, EnvironmentView>> {
  const team = await ctx.teams.getTeam(teamId);
  return new Map((team?.environments ?? []).map((env) => [env.id, env]));
}

export type VmLookup = { ok: true; env: EnvironmentRecord; target: VmTarget } | { ok: false; reason: string };

/** The VM and Linux user to run on for an environment, or why there is none. */
export async function vmTarget(ctx: Ctx, teamId: string, envId: string): Promise<VmLookup> {
  if (!ctx.ports.vm.enabled()) return { ok: false, reason: "Freestyle is not configured" };
  const env = await ctx.runtime.environment(teamId, envId);
  if (!env) return { ok: false, reason: "the environment no longer exists" };
  if (!env.freestyleVmId) return { ok: false, reason: "the environment has no VM yet" };
  return { ok: true, env, target: { vmId: env.freestyleVmId, linuxUser: env.linuxUser } };
}

/**
 * The environment owner's GitHub token, or null when they have none that works. A VM only ever gets its
 * owner's token: the agents on it run as the owner, so another member's token would be theirs to read.
 */
export function ownerGithubToken(ctx: Ctx, env: Pick<EnvironmentRecord, "ownerUserId">): Promise<string | null> {
  return memberGithubToken(ctx, env.ownerUserId);
}

/** A member's GitHub token for a backend-side GitHub API call (never sent to a VM), or null. */
export async function memberGithubToken(ctx: Ctx, userId: string): Promise<string | null> {
  try {
    return await ctx.ports.githubToken(userId);
  } catch {
    return null;
  }
}

/** Why a VM git step cannot run, in words a member can act on. */
export const NO_OWNER_GITHUB_ACCESS =
  "The environment owner's GitHub sign-in expired or cannot access this repository. They need to sign in again or be given access.";

const RELAY_CODE_TEXT: Record<RelayIntegrationErrorCode, string> = {
  invalid_input: "Relay refused the request",
  brief_too_large: "the brief is too large for Relay",
  identity_conflict: "a Relay identity with that name already exists",
  identity_token_invalid: "Relay credentials are no longer valid",
  provision_failed: "Relay could not set up the workspace",
  relay_unavailable: "Relay is unavailable",
};

const GITHUB_KIND_TEXT: Record<GithubErrorKind, string> = {
  unauthorized: "GitHub access expired; sign in again",
  forbidden: "GitHub denied access",
  not_found: "not found on GitHub",
  rate_limited: "GitHub rate limit reached",
  unavailable: "GitHub is unavailable",
  bad_response: "GitHub returned an unexpected response",
};

/**
 * A browser-safe, single-line description of a failure, for outbox errors and traces that every member
 * sees. Only our own user-safe messages pass through (Freestyle integration errors and AppErrors); vendor
 * and unknown errors become fixed text. Callers log the raw error server-side.
 */
export function describeFailure(step: string, error: unknown): string {
  const message = `${step}: ${safeReason(error)}`;
  return message.length <= 300 ? message : `${message.slice(0, 299)}…`;
}

/** Our own user-safe message, or fixed text for vendor and unknown errors. */
export function safeReason(error: unknown): string {
  if (error instanceof FreestyleIntegrationError || error instanceof AppError) return oneLine(error.message) || "failed";
  if (error instanceof RelayIntegrationError) return RELAY_CODE_TEXT[error.code];
  if (error instanceof GithubError) return GITHUB_KIND_TEXT[error.kind];
  const relay = asRelayError(error);
  if (relay) return /^[a-z_]{1,40}$/.test(relay.code) ? `Relay returned an error (${relay.code})` : "Relay returned an error";
  return "failed unexpectedly";
}

function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

export function isRetryable(error: unknown): boolean {
  if (error && typeof error === "object" && "retryable" in error && typeof error.retryable === "boolean") return error.retryable;
  return true;
}
