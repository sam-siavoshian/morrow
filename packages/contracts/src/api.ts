import { z } from "zod";
import {
  CliKind,
  COMPARE_HARNESSES,
  EnvironmentView,
  EpochMs,
  Id,
  LeaseState,
  LeaseView,
  MAX_TASK_WORKSTREAMS,
  PROFILE_DEFAULT_CONCURRENT,
  PROFILE_MAX_CONCURRENT,
  ProfileAuth,
  ProfileScopes,
  ProfileView,
  TaskStatus,
  TaskStrategy,
  TeamPolicy,
  TraceKind,
} from "./domain.ts";
import { RelayMessageView } from "./realtime.ts";

/** Header every mutating request must carry (with a same-origin Origin). */
export const CSRF_HEADER = "x-morrow-csrf";

/** The httpOnly session cookie. The web server forwards only this cookie when it calls the backend. */
export const SESSION_COOKIE = "morrow_session";

/** A throwaway base for resolving `returnTo` paths: anything that resolves off this origin is not a same-site path. */
export const RETURN_TO_PROBE_ORIGIN = "http://x.invalid";

export const ErrorCode = z.enum([
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "feature_disabled",
  "dependency_unavailable",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({ code: ErrorCode, message: z.string() }),
});
export type ApiError = z.infer<typeof ApiError>;

// Half of a surrogate pair is not text (and JSON escapes it to six bytes); the actors reject it too.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const trimmed = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((value) => !LONE_SURROGATE.test(value), "contains broken characters");

export const TEAM_NAME_MAX = 64;

/** Team names: 1-64 characters after trimming. The backend also refuses control characters. */
export const TeamName = trimmed(1, TEAM_NAME_MAX);

export const CreateTeamBody = z.object({ name: TeamName });
export type CreateTeamBody = z.infer<typeof CreateTeamBody>;

/** `PATCH /api/teams/:teamId` (owner or admin). Answers with the updated TeamView. */
export const RenameTeamBody = z.object({ name: TeamName });
export type RenameTeamBody = z.infer<typeof RenameTeamBody>;

/** Roles the owner can hand out. Nobody becomes owner this way: there is no ownership transfer. */
export const AssignableRole = z.enum(["admin", "member"]);
export type AssignableRole = z.infer<typeof AssignableRole>;

/** `PATCH /api/teams/:teamId/members/:userId` (owner only). Answers with the updated TeamView. */
export const UpdateMemberRoleBody = z.object({ role: AssignableRole });
export type UpdateMemberRoleBody = z.infer<typeof UpdateMemberRoleBody>;

/** `PATCH /api/teams/:teamId/policy` (owner or admin): any subset, at least one field. Answers with the updated TeamView. */
export const UpdatePolicyBody = TeamPolicy.partial().refine(
  (body) => body.allowInspect !== undefined || body.maxParallelPerTask !== undefined,
  "Change at least one setting.",
);
export type UpdatePolicyBody = z.infer<typeof UpdatePolicyBody>;

/** One person per link unless the creator raises it: a forwarded link should not let a crowd in. */
export const INVITE_MAX_USES = { min: 1, max: 50, default: 1 } as const;
/** Invite links work for at most a week. */
export const INVITE_MAX_HOURS = 168;

export const CreateInviteBody = z.object({
  maxUses: z.number().int().min(INVITE_MAX_USES.min).max(INVITE_MAX_USES.max).default(INVITE_MAX_USES.default),
  expiresInHours: z.number().int().min(1).max(INVITE_MAX_HOURS).default(INVITE_MAX_HOURS),
});
export type CreateInviteBody = z.infer<typeof CreateInviteBody>;

/** `url` carries the secret code and is shown once. `id` is the invite's public handle for listing and revoking. */
export const CreateInviteResponse = z.object({ id: Id, url: z.string().url(), expiresAt: EpochMs });
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;

/** An active invite as owners and admins see it. Never the code or its hash. */
export const InviteView = z.object({
  id: Id,
  createdBy: Id,
  expiresAt: EpochMs,
  uses: z.number().int().nonnegative(),
  maxUses: z.number().int().min(1),
  createdAt: EpochMs,
});
export type InviteView = z.infer<typeof InviteView>;

/** `GET /api/teams/:teamId/invites` (owner or admin): invites that still work, newest first. */
export const InviteListResponse = z.object({ invites: z.array(InviteView) });
export type InviteListResponse = z.infer<typeof InviteListResponse>;

export const AcceptInviteBody = z.object({ token: trimmed(10, 300) });
export type AcceptInviteBody = z.infer<typeof AcceptInviteBody>;

/**
 * `GET /api/invites/preview?token=`: what the join page shows before Accept. Every unusable invite (unknown team,
 * wrong code, expired, used up) gets the same 404 `not_found` with one fixed message, so team ids cannot be probed.
 * `inviter` is null only when the person who made the link can no longer be looked up.
 */
export const InvitePreviewView = z.object({
  teamName: z.string(),
  inviter: z.object({ login: z.string(), avatarUrl: z.string().url().nullable() }).nullable(),
  expiresAt: EpochMs,
});
export type InvitePreviewView = z.infer<typeof InvitePreviewView>;

export const RepoFullName = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "expected owner/name");

/**
 * A project's test command: one line, 1-200 characters after trimming, no control characters (so no newline or NUL).
 * It runs on the VM as the engineer's Linux user, the same uid the agents already have, so this caps size, not power.
 */
export const TEST_COMMAND_MAX = 200;
/** Control, zero-width, bidi and line-separator characters: they could make the command shown differ from what bash runs. */
export const TEST_COMMAND_HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;
export const TestCommand = trimmed(1, TEST_COMMAND_MAX).refine((v) => !TEST_COMMAND_HIDDEN.test(v), "must be one visible line, without control or direction-changing characters");

export const LinkProjectBody = z.object({
  repoFullName: RepoFullName,
  testCommand: TestCommand.nullable().default(null),
});
export type LinkProjectBody = z.infer<typeof LinkProjectBody>;

/** `PATCH /api/teams/:teamId/projects/:projectId` (owner or admin). Null clears the command. Answers with the updated TeamView. */
export const UpdateProjectBody = z.object({ testCommand: TestCommand.nullable() });
export type UpdateProjectBody = z.infer<typeof UpdateProjectBody>;

export const RepoSummary = z.object({
  id: z.number().int(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  description: z.string().nullable(),
  pushedAt: z.string().nullable(),
});
export type RepoSummary = z.infer<typeof RepoSummary>;

export const ENVIRONMENT_NAME_MAX = 48;
export const CreateEnvironmentBody = z.object({ name: trimmed(1, ENVIRONMENT_NAME_MAX).optional() });
export type CreateEnvironmentBody = z.infer<typeof CreateEnvironmentBody>;

export const TerminalTokenResponse = z.object({
  vmId: z.string(),
  linuxUser: z.string(),
  token: z.string(),
  session: z.string(),
  expiresAt: EpochMs,
});
export type TerminalTokenResponse = z.infer<typeof TerminalTokenResponse>;

/** One environment with its CLI profiles and how many live leases run on its node. */
export const WorkforceEnvironmentView = EnvironmentView.extend({
  profiles: z.array(ProfileView),
  liveLeases: z.number().int().nonnegative(),
});
export type WorkforceEnvironmentView = z.infer<typeof WorkforceEnvironmentView>;

/** `GET /api/teams/:teamId/workforce`: every environment, its profiles and node status, flattened. */
export const WorkforceResponse = z.object({
  environments: z.array(WorkforceEnvironmentView),
  features: z.object({ freestyle: z.boolean(), relay: z.boolean() }),
});
export type WorkforceResponse = z.infer<typeof WorkforceResponse>;

export const PROFILE_LABEL_MAX = 48;
export const RegisterProfileBody = z.object({
  cli: CliKind,
  label: trimmed(1, PROFILE_LABEL_MAX),
  scopes: ProfileScopes.default("all"),
  maxConcurrent: z.number().int().min(1).max(PROFILE_MAX_CONCURRENT).default(PROFILE_DEFAULT_CONCURRENT),
});
export type RegisterProfileBody = z.infer<typeof RegisterProfileBody>;

/** `PATCH /profiles/:profileId`: how many workers the login runs at once. Applies to the next placement. */
export const UpdateProfileBody = z.object({
  maxConcurrent: z.number().int().min(1).max(PROFILE_MAX_CONCURRENT),
});
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

/** Result of `POST /profiles/:profileId/check`. `probe.ok` false means the VM could not be asked; health was left as is. */
export const ProfileCheckResponse = z.object({
  profile: ProfileView,
  probe: z.object({
    ok: z.boolean(),
    error: z.enum(["timeout", "exec_failed", "bad_output"]).nullable(),
    installed: z.boolean(),
    version: z.string().nullable(),
    auth: ProfileAuth,
    node: z.enum(["active", "starting", "inactive", "unknown"]),
    probedAt: EpochMs,
  }),
});
export type ProfileCheckResponse = z.infer<typeof ProfileCheckResponse>;

export const WorkforceMode = z.enum(["auto", "manual"]);
export type WorkforceMode = z.infer<typeof WorkforceMode>;

export const TASK_PROMPT_MAX = 8000;
export const TASK_CRITERIA_MAX = 20;
export const TASK_CRITERION_MAX = 300;
export const TASK_PINS_MAX = 5;

export const CreateTaskBody = z
  .object({
    projectId: Id,
    prompt: trimmed(1, TASK_PROMPT_MAX),
    title: trimmed(1, 120).optional(),
    acceptance: z.array(trimmed(1, TASK_CRITERION_MAX)).max(TASK_CRITERIA_MAX).default([]),
    /**
     * Ignored, kept so older clients still validate. The planner splits a task into as many workstreams as the work
     * needs, bounded by the team's worker slots and `MAX_TASK_WORKSTREAMS`; a compare runs one attempt per harness.
     */
    maxAgents: z.number().int().min(1).max(MAX_TASK_WORKSTREAMS).optional(),
    /** Manual: only the pinned profiles may take the work, enforced by the backend for the whole run. Needs a pin. */
    mode: WorkforceMode.default("auto"),
    /** Profiles the human wants used (manual mode, or a preference in auto mode; in compare, which profile runs a harness). */
    pins: z.array(Id).max(TASK_PINS_MAX).default([]),
    strategy: TaskStrategy.default("split"),
    /** Compare only: the harnesses that each attempt the whole task, 2 or 3 different ones. */
    harnesses: z.array(CliKind).max(COMPARE_HARNESSES.max).default([]),
  })
  .superRefine((body, ctx) => {
    if (body.strategy === "split") {
      if (body.harnesses.length > 0) ctx.addIssue({ code: "custom", path: ["harnesses"], message: "Harnesses are only picked for Compare." });
      return;
    }
    if (new Set(body.harnesses).size !== body.harnesses.length)
      ctx.addIssue({ code: "custom", path: ["harnesses"], message: "Pick each harness once." });
    else if (body.harnesses.length < COMPARE_HARNESSES.min)
      ctx.addIssue({ code: "custom", path: ["harnesses"], message: `Pick at least ${COMPARE_HARNESSES.min} harnesses to compare.` });
  });
export type CreateTaskBody = z.infer<typeof CreateTaskBody>;

export const ReplanBody = z.object({
  /** Plan at most this many workstreams ("Start with fewer agents"). Omitted, the planner decides. */
  maxAgents: z.number().int().min(1).max(MAX_TASK_WORKSTREAMS).optional(),
  /** Replaces the task's pins (it has not started yet). */
  pins: z.array(Id).max(TASK_PINS_MAX).default([]),
  /** Replaces the task's mode; omitted keeps it. */
  mode: WorkforceMode.optional(),
  /** Refine the current plan: the planner sees the previous plan, the original prompt and this. At most 4 KB. */
  feedback: trimmed(1, 4000).optional(),
});
export type ReplanBody = z.infer<typeof ReplanBody>;

export const StartTaskBody = z.object({
  /** Manual placement: which profile runs which workstream. Omit for automatic placement. */
  picks: z.array(z.object({ workstreamId: Id, profileId: Id })).max(MAX_TASK_WORKSTREAMS).optional(),
  /**
   * The composer's mode and pins as the person sees them at Start. They replace the task's before anything is
   * reserved, and are fixed from then on. Omitted keeps the task's own.
   */
  mode: WorkforceMode.optional(),
  pins: z.array(Id).max(TASK_PINS_MAX).optional(),
});
export type StartTaskBody = z.infer<typeof StartTaskBody>;

/**
 * `POST /tasks/:id/pick` (compare tasks; the creator, an owner or an admin). A workstream id ships that finished
 * attempt and stops the others; null finishes the task without shipping any (a review or analysis run).
 */
export const PickAttemptBody = z.object({ workstreamId: Id.nullable() });
export type PickAttemptBody = z.infer<typeof PickAttemptBody>;

export const PickAttemptResponse = z.object({ status: TaskStatus, releasedLeaseIds: z.array(Id) });
export type PickAttemptResponse = z.infer<typeof PickAttemptResponse>;

/** A worker's Relay agent name. A direct message only ever reaches a live worker of the task. */
const AgentName = z.string().regex(/^[a-z0-9-]{1,64}$/);

/**
 * Who a task message is for, past the team channel. `worker`: steer a live worker of this task (a direct message).
 * `profile`: add a worker on that CLI profile, with the message as its brief. `env`: the same on the best free profile
 * of that VM.
 */
export const TaskMessageTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worker"), name: AgentName }),
  z.object({ kind: z.literal("profile"), id: Id }),
  z.object({ kind: z.literal("env"), id: Id }),
]);
export type TaskMessageTarget = z.infer<typeof TaskMessageTarget>;

/** Idempotency key of one add-an-agent request: a retry with the same key adds the worker once. */
export const AddAgentKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const TaskMessageBody = z
  .object({
    /** "team" posts to the task's channel; a bare string is a worker's agent name (the older form of `{ kind: "worker" }`). */
    to: z.union([z.literal("team"), AgentName, TaskMessageTarget]),
    text: trimmed(1, 4000),
    /** Required to add an agent (`profile` or `env`), ignored otherwise. */
    key: AddAgentKey.optional(),
  })
  .refine((body) => typeof body.to === "string" || body.to.kind === "worker" || body.key !== undefined, {
    message: "Adding an agent needs a request key.",
    path: ["key"],
  });
export type TaskMessageBody = z.infer<typeof TaskMessageBody>;

/** `POST /tasks` and `POST /tasks/:id/plan`: planning runs in the background; watch `workforce.view`. */
export const PlanAcceptedResponse = z.object({ taskId: Id });
export type PlanAcceptedResponse = z.infer<typeof PlanAcceptedResponse>;

export const StartTaskResponse = z.object({ leases: z.array(LeaseView) });
export type StartTaskResponse = z.infer<typeof StartTaskResponse>;

export const CancelTaskResponse = z.object({ releasedLeaseIds: z.array(Id) });
export type CancelTaskResponse = z.infer<typeof CancelTaskResponse>;

/** `DELETE /tasks/:id` (the creator, an owner or an admin). `releasedLeaseIds`: workers a task that had not ended stopped. */
export const DeleteTaskResponse = z.object({ releasedLeaseIds: z.array(Id) });
export type DeleteTaskResponse = z.infer<typeof DeleteTaskResponse>;

/**
 * `POST /tasks/:id/retry` (any member, failed tasks only). `verify`: every workstream was done, verification runs
 * again. `replan`: unfinished workstreams went back to pending; `leases` are the workers started right away
 * (empty when no profile had a free slot; the scheduler adds them as slots free up).
 */
export const RetryTaskResponse = z.object({ mode: z.enum(["verify", "replan"]), leases: z.array(LeaseView) });
export type RetryTaskResponse = z.infer<typeof RetryTaskResponse>;

export const TaskMessageResponse = z.object({
  /** The message as posted. When an agent was added: the channel notice saying so, or null if it could not be posted. */
  message: RelayMessageView.nullable(),
  /** The added worker's lease. Absent when the request only sent a message. */
  lease: LeaseView.optional(),
});
export type TaskMessageResponse = z.infer<typeof TaskMessageResponse>;

export const RealtimeTicketBody = z.object({ teamId: Id });
export type RealtimeTicketBody = z.infer<typeof RealtimeTicketBody>;

export const RealtimeTicketResponse = z.object({
  url: z.string(),
  expiresAt: EpochMs,
});
export type RealtimeTicketResponse = z.infer<typeof RealtimeTicketResponse>;

/** Ticket for `/realtime/inspect/:leaseId`. Bound to the user, the team and this one lease. */
export const InspectTicketBody = z.object({ leaseId: Id });
export type InspectTicketBody = z.infer<typeof InspectTicketBody>;

/** The most of an ended worker's log `GET /api/teams/:teamId/leases/:leaseId/log` returns (the VM read's own cap). */
export const WORKER_LOG_MAX_BYTES = 64 * 1024;

/**
 * Why an ended worker's log could not be read. The UI maps each to plain words.
 * - `not_configured`: this server has no cloud environments.
 * - `environment_gone`: the worker's environment was disconnected or deleted, with its VM.
 * - `environment_paused`: the VM is paused; its owner can resume it (reading never wakes it).
 * - `environment_unavailable`: the VM is still provisioning or in error.
 * - `log_missing`: the VM has no log for this worker (it never started, or the file was removed).
 * - `log_refused`: the log file is not the plain file the broker writes; it was not read.
 * - `vm_unreachable`: the VM or Freestyle did not answer; try again shortly.
 */
export const WorkerLogUnavailable = z.enum([
  "not_configured",
  "environment_gone",
  "environment_paused",
  "environment_unavailable",
  "log_missing",
  "log_refused",
  "vm_unreachable",
]);
export type WorkerLogUnavailable = z.infer<typeof WorkerLogUnavailable>;

/**
 * An ended worker: why it ended, what it left behind, and the tail of its log (secrets redacted, ANSI kept for a
 * terminal view). `log` is null with `unavailable` set when it could not be read; the rest still says what happened.
 */
export const WorkerLogResponse = z.object({
  leaseId: Id,
  agentName: z.string(),
  state: LeaseState,
  end: z.object({
    /** The actor's one-line reason ("agent exited: CLI not signed in"), or null for leases that ended before it was kept. */
    reason: z.string().nullable(),
    /** When the lease ended (its last change). */
    at: EpochMs.nullable(),
    /** The trace entry that ended it, when the task still has it. */
    trace: z.object({ kind: TraceKind, message: z.string(), at: EpochMs }).nullable(),
  }),
  contribution: z
    .object({
      workstreamId: Id,
      workstreamTitle: z.string().nullable(),
      branch: z.string().nullable(),
      /** Checkpoints this worker pushed that the task's trace still lists. */
      checkpoints: z.number().int().nonnegative(),
      /** Its newest checkpoint: the full SHA when the workstream's last checkpoint is its own, else the trace's short one. */
      lastCheckpoint: z.object({ sha: z.string(), summary: z.string().nullable(), at: EpochMs }).nullable(),
      /** It finished its workstream (DONE accepted). */
      completed: z.boolean(),
    })
    .nullable(),
  log: z
    .object({
      text: z.string(),
      /** Older output was cut to fit `WORKER_LOG_MAX_BYTES`. */
      truncated: z.boolean(),
      size: z.number().int().nonnegative(),
      modifiedAt: z.string(),
      /** `vm`: read now. `archive`: the copy the backend kept from its last read (the VM is gone or paused). */
      source: z.enum(["vm", "archive"]),
    })
    .nullable(),
  unavailable: WorkerLogUnavailable.nullable(),
});
export type WorkerLogResponse = z.infer<typeof WorkerLogResponse>;

export const ArtifactsView = z.object({
  branches: z.array(
    z.object({
      workstreamId: Id,
      branch: z.string(),
      headSha: z.string().nullable(),
      url: z.string().url().nullable(),
    }),
  ),
  pullRequest: z.object({ number: z.number().int(), url: z.string().url(), state: z.string() }).nullable(),
  previewUrl: z.string().url().nullable(),
});
export type ArtifactsView = z.infer<typeof ArtifactsView>;

/** `GET /api/github/repos`: one page; `nextPage` is null on the last one. */
export const ReposResponse = z.object({ repos: z.array(RepoSummary), nextPage: z.number().int().positive().nullable() });
export type ReposResponse = z.infer<typeof ReposResponse>;

/** `GET /api/teams/:teamId/environments`: every environment that is not disconnected. */
export const EnvironmentListResponse = z.object({ environments: z.array(EnvironmentView) });
export type EnvironmentListResponse = z.infer<typeof EnvironmentListResponse>;
