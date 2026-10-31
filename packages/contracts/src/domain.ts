import { z } from "zod";

/** Every id we mint or accept: safe for Terse actor ids, URLs and file names. */
export const Id = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/, "invalid id");
export type Id = z.infer<typeof Id>;

/** Unix epoch milliseconds. */
export const EpochMs = z.number().int().nonnegative();

export const Role = z.enum(["owner", "admin", "member"]);
export type Role = z.infer<typeof Role>;

export const CliKind = z.enum(["claude", "codex", "opencode", "cursor", "gemini", "grok"]);
export type CliKind = z.infer<typeof CliKind>;

/** How people name each harness in plain text (messages, briefs, traces). */
export const CLI_LABEL: Record<CliKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  cursor: "Cursor Agent",
  gemini: "Gemini CLI",
  grok: "Grok",
};

export const ProfileAuth = z.enum(["unknown", "ok", "auth_required"]);
export type ProfileAuth = z.infer<typeof ProfileAuth>;

export const ProfileAvailability = z.enum(["ready", "busy", "limited", "offline"]);
export type ProfileAvailability = z.infer<typeof ProfileAvailability>;

/** Where a limit came from. */
export const LimitSource = z.enum(["detected", "manual"]);
export type LimitSource = z.infer<typeof LimitSource>;

export const ProfileScopes = z.union([z.literal("all"), z.array(Id).max(100)]);
export type ProfileScopes = z.infer<typeof ProfileScopes>;

/** A subscription usage window: how much of the plan's 5-hour or weekly allowance is spent. Never a token count. */
export const UsageWindow = z.object({
  kind: z.enum(["five_hour", "weekly", "other"]),
  /** Short name as the vendor puts it ("5-hour", "Weekly", "Weekly Opus"). */
  label: z.string().min(1).max(40),
  usedPercent: z.number().min(0).max(100),
  resetsAt: EpochMs.nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/** Where a reading came from: the usage probe on the VM, or a worker's own output. */
export const UsageSource = z.enum(["probe", "worker"]);
export type UsageSource = z.infer<typeof UsageSource>;

/** The latest usage reading for one CLI login. Older than `USAGE_STALE_MS` is shown as stale, never as current. */
export const ProfileUsage = z.object({
  windows: z.array(UsageWindow).max(6),
  observedAt: EpochMs,
  source: UsageSource,
});
export type ProfileUsage = z.infer<typeof ProfileUsage>;

export const USAGE_STALE_MS = 30 * 60_000;

/**
 * Workers one CLI login may run at once (its leases, subagents included). A VM has 4 vCPU and 8 GiB, and one CLI
 * session with its builds and tests peaks around 1 GiB, so 8 is the most one login can run before the VM swaps.
 * The actors keep the same ceiling.
 */
export const PROFILE_MAX_CONCURRENT = 8;
/** A new login runs this many at once unless its owner picks otherwise. */
export const PROFILE_DEFAULT_CONCURRENT = 4;

export const ProfileView = z.object({
  id: Id,
  envId: Id,
  ownerUserId: Id,
  cli: CliKind,
  label: z.string(),
  auth: ProfileAuth,
  availability: ProfileAvailability,
  cooldownUntil: EpochMs.nullable(),
  limitedReason: z.string().nullable(),
  limitedSource: LimitSource.nullable(),
  maxConcurrent: z.number().int().min(1).max(PROFILE_MAX_CONCURRENT),
  activeLeases: z.number().int().nonnegative(),
  scopes: ProfileScopes,
  lastSeenAt: EpochMs.nullable(),
  /** Absent from views written before usage existed; null until the first reading. */
  usage: ProfileUsage.nullable().optional(),
});
export type ProfileView = z.infer<typeof ProfileView>;

export const EnvironmentPhase = z.enum([
  "provisioning",
  "bootstrapping",
  "awaiting_login",
  "ready",
  "paused",
  "error",
  "disconnected",
]);
export type EnvironmentPhase = z.infer<typeof EnvironmentPhase>;

export const VmState = z.enum(["starting", "running", "pausing", "paused", "stopped", "unknown"]);
export type VmState = z.infer<typeof VmState>;

export const EnvironmentView = z.object({
  id: Id,
  ownerUserId: Id,
  name: z.string(),
  linuxUser: z.string().nullable(),
  nodeName: z.string().nullable(),
  phase: EnvironmentPhase,
  vmState: VmState,
  nodeOnline: z.boolean(),
  lastError: z.string().nullable(),
  createdAt: EpochMs,
});
export type EnvironmentView = z.infer<typeof EnvironmentView>;

export const TaskStatus = z.enum([
  "draft",
  "planning",
  "planned",
  "starting",
  "running",
  "handoff",
  "verifying",
  /** The workstream branches conflicted on the integration branch; a resolver worker is merging them (section 9.5). */
  "resolving",
  /** A compare task: every attempt has ended, at least one finished, and nobody picked one yet (docs/multi-harness.md). */
  "choosing",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const WorkstreamStatus = z.enum(["pending", "active", "handoff", "done", "failed"]);
export type WorkstreamStatus = z.infer<typeof WorkstreamStatus>;

export const LeaseState = z.enum(["reserved", "spawning", "running", "released", "expired", "failed"]);
export type LeaseState = z.infer<typeof LeaseState>;

export const Checkpoint = z.object({
  sha: z.string().regex(/^[0-9a-f]{7,64}$/),
  summary: z.string(),
  epoch: z.number().int().positive(),
  at: EpochMs,
});
export type Checkpoint = z.infer<typeof Checkpoint>;

/**
 * The newest interface contract a workstream's worker posted (`CONTRACT <leaseId> <summary>` in the task thread,
 * docs/architecture.md 9.8). The summary is agent text, shown as text; the full contract is the Relay message.
 */
export const WorkstreamContract = z.object({
  summary: z.string(),
  messageId: z.string(),
  agentName: z.string(),
  leaseId: Id,
  at: EpochMs,
});
export type WorkstreamContract = z.infer<typeof WorkstreamContract>;

/** A workstream in the live view: only what lists and lanes need. Its text comes with the task detail. */
export const WorkstreamView = z.object({
  id: Id,
  branch: z.string(),
  status: WorkstreamStatus,
  leaseId: Id.nullable(),
  /** The harness a compare attempt is bound to. Absent on split workstreams (any CLI may take them). */
  harness: CliKind.optional(),
});
export type WorkstreamView = z.infer<typeof WorkstreamView>;

/** A workstream in the task detail. Its brief and file ownership stay server-side: only workers and the planner read them. */
export const WorkstreamDetail = WorkstreamView.extend({
  role: z.string(),
  title: z.string(),
  why: z.string(),
  dependsOn: z.array(Id),
  lastCheckpoint: Checkpoint.nullable(),
  /** The newest interface contract its worker published in the task thread. Absent before one. */
  contract: WorkstreamContract.nullable().optional(),
});
export type WorkstreamDetail = z.infer<typeof WorkstreamDetail>;

export const LeaseView = z.object({
  id: Id,
  taskId: Id,
  workstreamId: Id,
  profileId: Id,
  epoch: z.number().int().positive(),
  agentName: z.string(),
  nodeName: z.string(),
  state: LeaseState,
  createdAt: EpochMs,
  /**
   * Set on a subagent's lease: the worker that started it. Absent on workers. Only live subagents are in the view;
   * finished ones, and every subagent's role, task and result, are in `TaskDetail.subagents`.
   */
  parentLeaseId: Id.optional(),
});
export type LeaseView = z.infer<typeof LeaseView>;

/** What a worker asked a subagent to do (docs/subagents.md). Review and research never edit files. */
export const SubagentRole = z.enum(["review", "research", "implementation", "test", "general"]);
export type SubagentRole = z.infer<typeof SubagentRole>;

export const SubagentStatus = z.enum(["running", "completed", "failed", "cancelled"]);
export type SubagentStatus = z.infer<typeof SubagentStatus>;

/** One subagent of a task, in the task detail. `task` and `summary` are agent-written text: show them as text. */
export const SubagentView = z.object({
  /** The subagent's lease, and the id its parent uses for `task_status` and `task_cancel`. */
  leaseId: Id,
  parentLeaseId: Id,
  agentName: z.string(),
  parentAgentName: z.string(),
  cli: CliKind,
  profileId: Id,
  role: SubagentRole,
  task: z.string(),
  status: SubagentStatus,
  /** The result the subagent reported, or why it ended without one. Null while it runs. */
  summary: z.string().nullable(),
  createdAt: EpochMs,
  finishedAt: EpochMs.nullable(),
});
export type SubagentView = z.infer<typeof SubagentView>;

/**
 * How a task shares the work between harnesses (docs/multi-harness.md). `split`: the planner divides it into
 * workstreams. `compare`: every picked harness attempts the whole task on its own branch, and a person picks one.
 */
export const TaskStrategy = z.enum(["split", "compare"]);
export type TaskStrategy = z.infer<typeof TaskStrategy>;

/** Harnesses a compare task runs at once. */
export const COMPARE_HARNESSES = { min: 2, max: 3 } as const;

/**
 * Hard ceiling on one plan's workstreams. The planner splits a task into as many as the work needs, up to this and
 * the team's worker slots; past it every extra branch is one more merge to get right. The actors hold plans to the
 * same number, and a task's view (plus a conflict resolver) is sized for it.
 */
export const MAX_TASK_WORKSTREAMS = 5;

/** `compare`: the plan of a compare task, one attempt per picked harness, made without a planner call. */
export const PlanSource = z.enum(["cli", "fallback", "compare"]);
export type PlanSource = z.infer<typeof PlanSource>;

export const PlanView = z.object({
  source: PlanSource,
  /** The profile whose subscription produced the plan, when source is "cli". */
  profileId: Id.nullable(),
  rationale: z.string(),
  warnings: z.array(z.string()),
});
export type PlanView = z.infer<typeof PlanView>;

export const CheckStatus = z.enum(["pending", "passed", "failed", "skipped"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const VerificationView = z.object({
  status: CheckStatus,
  checks: z.array(
    z.object({
      name: z.string(),
      status: CheckStatus,
      detail: z.string(),
      url: z.string().url().nullable(),
    }),
  ),
});
export type VerificationView = z.infer<typeof VerificationView>;

export const TraceKind = z.enum([
  "task.created",
  /** Planning began on a CLI profile (`profileId`); the profile gives the CLI and environment. */
  "task.planning",
  /** The deterministic planner was used; the message says why. */
  "task.planner_fallback",
  "task.planned",
  "worker.reserved",
  "worker.ready",
  "worker.blocked",
  "worker.quota_limited",
  "worker.offline",
  "task.checkpointed",
  "task.handoff_requested",
  "task.handoff_acked",
  "task.verified",
  "task.failed",
  "task.cancelled",
  "worker.capacity_restored",
  /** A member retried a failed task: verification again, or new workers for its unfinished workstreams. */
  "task.retried",
  /** Verification hit a merge conflict; a resolution attempt starts (message names the branches and the attempt). */
  "task.conflict_detected",
  /** A worker was reserved to resolve the conflict (`profileId`). */
  "task.resolver_reserved",
  /** The resolver pushed its merge; verification runs again. */
  "task.conflict_resolved",
  /** The conflict is still there after the last allowed attempt; the task failed. */
  "task.conflict_gave_up",
  /** A worker handed part of its job to another CLI on its machine (`leaseId` is the subagent's lease). */
  "subagent.started",
  /** A subagent ended: its result, a failure, or a cancel. The whole result is in `TaskDetail.subagents`. */
  "subagent.finished",
  /** A person picked a compare attempt to ship, or finished the task without shipping one. */
  "task.attempt_picked",
  /** A manual task's workstream waits: none of its pinned profiles is free, or all of them were removed. */
  "worker.waiting",
  /** A worker posted its interface contract in the task thread (`leaseId`); the summary is in the message. */
  "contract.published",
]);
export type TraceKind = z.infer<typeof TraceKind>;

/** One line of a task's decision trace: why the system did what it did. */
export const TraceEntry = z.object({
  at: EpochMs,
  kind: TraceKind,
  message: z.string(),
  leaseId: Id.nullable(),
  profileId: Id.nullable(),
  epoch: z.number().int().nullable(),
});
export type TraceEntry = z.infer<typeof TraceEntry>;

/**
 * A task in the live view, resent to every member on every change, so it holds no long text: the prompt,
 * acceptance, plan, workstream text, verification and the whole trace come with the task detail
 * (`GET /api/teams/:teamId/tasks/:taskId`). Its size has a fixed ceiling whatever anyone types.
 */
export const TaskView = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  createdBy: Id,
  status: TaskStatus,
  /** The most workstreams its plan may have: `MAX_TASK_WORKSTREAMS` for a split task, the harness count for a compare. */
  maxAgents: z.number().int().min(1).max(MAX_TASK_WORKSTREAMS),
  /** Absent from tasks stored before strategies existed: those are `split`. */
  strategy: TaskStrategy.optional(),
  /** A compare task's picked attempt; null before a pick (and after a finish without shipping). Absent on split tasks. */
  pickedWorkstreamId: Id.nullable().optional(),
  workstreams: z.array(WorkstreamView),
  /** The newest few trace entries, oldest first, each message clipped to a short preview. */
  trace: z.array(TraceEntry),
  /**
   * Entries the task has recorded in all, so `trace[i]` is entry number `traceTotal - trace.length + i`.
   * Absent from views written before the view capped the trace (those carry the whole stored trace).
   */
  traceTotal: z.number().int().nonnegative().optional(),
  /** When the current run started: the first reservation after the latest plan. Null before one. Read from the whole stored trace. */
  runStartedAt: EpochMs.nullable().optional(),
  /** The latest `task.retried`, null if never retried. Read from the whole stored trace. */
  retriedAt: EpochMs.nullable().optional(),
  /** The latest `task.planned`, null before a plan. Read from the whole stored trace. Absent from older views. */
  plannedAt: EpochMs.nullable().optional(),
  /** Merge-conflict resolution attempts since the last retry (at most `MAX_CONFLICT_RESOLUTIONS`). Absent from older views. */
  resolutionAttempts: z.number().int().nonnegative().optional(),
  createdAt: EpochMs,
  updatedAt: EpochMs,
});
export type TaskView = z.infer<typeof TaskView>;

/** `GET /api/teams/:teamId/tasks/:taskId`: the task with its full text, for members only. */
export const TaskDetail = TaskView.extend({
  prompt: z.string(),
  acceptance: z.array(z.string()),
  plan: PlanView.nullable(),
  workstreams: z.array(WorkstreamDetail),
  verification: VerificationView.nullable(),
  /** Every stored trace entry (the newest ones a task keeps), oldest first, messages whole. */
  trace: z.array(TraceEntry),
  /** The task's newest subagents, oldest first. Absent from tasks stored before subagents existed. */
  subagents: z.array(SubagentView).optional(),
  /** The Relay id of the task's kickoff post in the project channel: its replies are the task thread. Null before a worker starts. */
  threadId: z.string().nullable().optional(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

/** TeamWorkforce's emitted projection, resent on every change. Tasks are summaries; see `TaskView`. */
export const WorkforceView = z.object({
  profiles: z.record(z.string(), ProfileView),
  tasks: z.record(z.string(), TaskView),
  leases: z.record(z.string(), LeaseView),
});
export type WorkforceView = z.infer<typeof WorkforceView>;

export const MemberView = z.object({
  userId: Id,
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  role: Role,
});
export type MemberView = z.infer<typeof MemberView>;

export const ProjectView = z.object({
  id: Id,
  repoFullName: z.string(),
  defaultBranch: z.string(),
  testCommand: z.string().nullable(),
});
export type ProjectView = z.infer<typeof ProjectView>;

export const MAX_PARALLEL_PER_TASK = 5;

/** Resolution attempts per task (per retry) before a merge conflict fails the task. Mirrors the actor's limit. */
export const MAX_CONFLICT_RESOLUTIONS = 2;
/** Role of the workstream the actor adds to resolve a merge conflict. Its branch is the task's integration branch. */
export const RESOLVER_ROLE = "resolver";

export const TeamPolicy = z.object({
  allowInspect: z.boolean(),
  maxParallelPerTask: z.number().int().min(1).max(MAX_PARALLEL_PER_TASK),
});
export type TeamPolicy = z.infer<typeof TeamPolicy>;

export const TeamView = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  viewerRole: Role,
  members: z.array(MemberView),
  projects: z.array(ProjectView),
  environments: z.array(EnvironmentView),
  policy: TeamPolicy,
  relayReady: z.boolean(),
});
export type TeamView = z.infer<typeof TeamView>;

export const UserView = z.object({
  id: Id,
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
});
export type UserView = z.infer<typeof UserView>;

export const DEFAULT_GITHUB_WEB_URL = "https://github.com";

/** An http(s) URL with no query, hash or credentials, trailing slashes dropped. Anything else (javascript:, data:) is refused. */
export const GithubWebUrl = z
  .string()
  .trim()
  .max(200)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.search && !url.hash && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "must be an http(s) URL")
  .transform((value) => value.replace(/\/+$/, ""));

export const MeView = z.object({
  user: UserView,
  teams: z.array(z.object({ id: Id, name: z.string(), slug: z.string(), role: Role })),
  features: z.object({
    freestyle: z.boolean(),
    relay: z.boolean(),
    /** Where repo, branch and commit links point (`GITHUB_WEB_URL`). Only http(s); no trailing slash. */
    githubWebUrl: GithubWebUrl.default(DEFAULT_GITHUB_WEB_URL),
  }),
});
export type MeView = z.infer<typeof MeView>;
