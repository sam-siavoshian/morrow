import { z } from "zod";
import { EpochMs, Id } from "./domain.ts";

// The GitHub layer: pull requests, branches and a worktree's uncommitted changes, read and written with the signed-in
// member's own GitHub token so GitHub enforces their real permissions (architecture section 8.6).

/** Longest comment body accepted (under GitHub's 65,536 and under the API's 64 KiB request cap). */
export const GITHUB_COMMENT_MAX = 60_000;
/** What a member may type as a commit message from the web app (subject plus body). */
export const COMMIT_MESSAGE_MAX = 2_000;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const text = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((value) => !LONE_SURROGATE.test(value) && !value.includes("\0"), "contains broken characters");

export const GitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "expected a full commit SHA");

/** A GitHub account as shown next to a comment or commit. The avatar is only ever a GitHub avatar URL. */
export const GithubUserRef = z.object({ login: z.string().max(100), avatarUrl: z.string().url().nullable() });
export type GithubUserRef = z.infer<typeof GithubUserRef>;

/**
 * How current a GitHub read is. `stale` means GitHub could not be asked just now (rate limit or outage) and this is
 * the last good copy, from `fetchedAt`. `rateLimitedUntil` is set while the member's GitHub rate limit is spent.
 */
export const GithubFreshness = z.object({ fetchedAt: EpochMs, stale: z.boolean(), rateLimitedUntil: EpochMs.nullable() });
export type GithubFreshness = z.infer<typeof GithubFreshness>;

export const PullState = z.enum(["open", "draft", "merged", "closed"]);
export type PullState = z.infer<typeof PullState>;

export const PullStateFilter = z.enum(["open", "closed", "all"]);
export type PullStateFilter = z.infer<typeof PullStateFilter>;

export const PullSummary = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: PullState,
  author: GithubUserRef.nullable(),
  headRef: z.string(),
  baseRef: z.string(),
  url: z.string().url(),
  createdAt: EpochMs,
  updatedAt: EpochMs,
  /** The task whose integration branch this pull request merges, when Morrow opened it. */
  taskId: Id.nullable(),
});
export type PullSummary = z.infer<typeof PullSummary>;

/** `GET /api/teams/:teamId/projects/:projectId/pulls?state=`. */
export const PullListQuery = z.object({ state: PullStateFilter.default("open") });
export type PullListQuery = z.infer<typeof PullListQuery>;

export const PullListResponse = z.object({
  projectId: Id,
  repoFullName: z.string(),
  /** Open (and draft) first, then most recently updated. */
  pulls: z.array(PullSummary),
  /** GitHub has more than this page; the rest are on GitHub. */
  truncated: z.boolean(),
  freshness: GithubFreshness,
});
export type PullListResponse = z.infer<typeof PullListResponse>;

export const CheckState = z.enum(["passed", "failed", "pending", "neutral"]);
export type CheckState = z.infer<typeof CheckState>;

/** One check run or commit status on the pull request's head commit. */
export const PullCheck = z.object({
  name: z.string(),
  state: CheckState,
  /** GitHub's conclusion or status description, e.g. "timed out". */
  detail: z.string().nullable(),
  url: z.string().url().nullable(),
});
export type PullCheck = z.infer<typeof PullCheck>;

export const PullChecks = z.object({
  state: z.enum(["passed", "failed", "pending", "none"]),
  items: z.array(PullCheck).max(100),
  truncated: z.boolean(),
});
export type PullChecks = z.infer<typeof PullChecks>;

export const ReviewerState = z.enum(["approved", "changes_requested", "commented", "dismissed", "requested"]);
export type ReviewerState = z.infer<typeof ReviewerState>;

export const PullReviewer = GithubUserRef.extend({ state: ReviewerState });
export type PullReviewer = z.infer<typeof PullReviewer>;

/** Worked out from the reviews and review requests GitHub lists; branch protection may ask for more (see `mergeable`). */
export const ReviewDecision = z.enum(["approved", "changes_requested", "review_required", "none"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

export const PullFileStatus = z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);
export type PullFileStatus = z.infer<typeof PullFileStatus>;

export const PullFile = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: PullFileStatus,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type PullFile = z.infer<typeof PullFile>;

const ConversationBase = z.object({
  id: z.number().int().positive(),
  author: GithubUserRef.nullable(),
  /** GitHub-flavored markdown written by anyone who can comment: render it as untrusted text, never as HTML. */
  body: z.string(),
  createdAt: EpochMs,
  url: z.string().url(),
});

export const ConversationItem = z.discriminatedUnion("kind", [
  ConversationBase.extend({ kind: z.literal("comment") }),
  ConversationBase.extend({ kind: z.literal("review"), state: ReviewerState.exclude(["requested"]) }),
  ConversationBase.extend({
    kind: z.literal("review_comment"),
    path: z.string(),
    line: z.number().int().positive().nullable(),
    /** The commented line from the diff, with its `+`, `-` or space marker. */
    codeLine: z.string().nullable(),
    inReplyTo: z.number().int().positive().nullable(),
  }),
]);
export type ConversationItem = z.infer<typeof ConversationItem>;

export const MergeMethod = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethod>;

/** GitHub's `mergeable` and `mergeable_state` in one word. `unknown` while GitHub is still working it out. */
export const Mergeability = z.enum(["clean", "conflicts", "blocked", "behind", "unstable", "draft", "unknown"]);
export type Mergeability = z.infer<typeof Mergeability>;

export const PullDetail = PullSummary.extend({
  body: z.string(),
  headSha: GitSha,
  mergeable: Mergeability,
  mergedAt: EpochMs.nullable(),
  mergedBy: GithubUserRef.nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  reviewDecision: ReviewDecision,
  reviewers: z.array(PullReviewer).max(100),
  checks: PullChecks,
  /** The first 100 changed files; `changedFiles` counts them all. */
  files: z.array(PullFile).max(300),
  /** Issue comments, reviews and review comments, oldest first. */
  conversation: z.array(ConversationItem).max(300),
  conversationTruncated: z.boolean(),
  /** What the repository allows. Empty when the viewer cannot see its merge settings (no write access). */
  mergeMethods: z.array(MergeMethod),
  /** The viewer has write access to the repository on GitHub. */
  viewerCanWrite: z.boolean(),
  freshness: GithubFreshness,
});
export type PullDetail = z.infer<typeof PullDetail>;

/** `GET /api/teams/:teamId/tasks/:taskId/pull`: the task's pull request, null until the verifier opens one. */
export const TaskPullResponse = z.object({ projectId: Id, pull: PullDetail.nullable() });
export type TaskPullResponse = z.infer<typeof TaskPullResponse>;

/** `POST .../pulls/:number/comments`. `inReplyTo` answers a review comment in its thread. */
export const PullCommentBody = z.object({ body: text(1, GITHUB_COMMENT_MAX), inReplyTo: z.number().int().positive().max(2 ** 53 - 1).optional() });
export type PullCommentBody = z.infer<typeof PullCommentBody>;

/** `POST .../pulls/:number/merge`. `headSha` is the commit the member reviewed: a newer push makes GitHub refuse. */
export const PullMergeBody = z.object({ method: MergeMethod, headSha: GitSha });
export type PullMergeBody = z.infer<typeof PullMergeBody>;

/** `PATCH .../pulls/:number`: close or reopen. */
export const PullStateBody = z.object({ state: z.enum(["open", "closed"]) });
export type PullStateBody = z.infer<typeof PullStateBody>;

export const BranchCommit = z.object({
  sha: GitSha,
  /** First line of the message. */
  message: z.string(),
  author: GithubUserRef.nullable(),
  authorName: z.string().nullable(),
  committedAt: EpochMs.nullable(),
  url: z.string().url().nullable(),
});
export type BranchCommit = z.infer<typeof BranchCommit>;

/** `GET .../tasks/:taskId/workstreams/:workstreamId/branch`: the workstream's branch on GitHub against the default branch. */
export const BranchView = z.object({
  branch: z.string(),
  base: z.string(),
  /** False until the branch is pushed. */
  exists: z.boolean(),
  aheadBy: z.number().int().nonnegative(),
  behindBy: z.number().int().nonnegative(),
  headSha: GitSha.nullable(),
  /** Newest first, at most 10. */
  commits: z.array(BranchCommit).max(20),
  freshness: GithubFreshness,
});
export type BranchView = z.infer<typeof BranchView>;

/** Most files a branch diff lists; `changedFiles` still counts them all. */
export const BRANCH_DIFF_FILES_MAX = 100;
/** Longest patch kept for one file; longer ones are cut at a line break and marked truncated. */
export const BRANCH_DIFF_PATCH_MAX = 24_000;
/** Most patch text one branch diff carries in total; files past the budget come without a patch. */
export const BRANCH_DIFF_TOTAL_MAX = 400_000;

/** One file a workstream's branch changed against the task base. */
export const BranchDiffFile = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: PullFileStatus,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /**
   * Unified diff hunks from GitHub, as plain text: repo content anyone with push access wrote, so render it as text,
   * never as HTML. Null for binary files, files GitHub sent no patch for, and files past the size budget.
   */
  patch: z.string().nullable(),
  /** The patch was cut to fit, or left out because the diff was over budget. */
  patchTruncated: z.boolean(),
});
export type BranchDiffFile = z.infer<typeof BranchDiffFile>;

/** `GET .../tasks/:taskId/workstreams/:workstreamId/diff`: what the workstream's branch changed against the default branch. */
export const BranchDiffView = z.object({
  branch: z.string(),
  base: z.string(),
  /** False until the branch is pushed. */
  exists: z.boolean(),
  /** GitHub's answer was over the size the backend reads: counts are zero and no files are listed. */
  tooLarge: z.boolean(),
  headSha: GitSha.nullable(),
  aheadBy: z.number().int().nonnegative(),
  behindBy: z.number().int().nonnegative(),
  /** Totals over every changed file GitHub reported, not only the listed ones. */
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  files: z.array(BranchDiffFile).max(BRANCH_DIFF_FILES_MAX),
  /** More files changed than `files` lists. */
  filesTruncated: z.boolean(),
  freshness: GithubFreshness,
});
export type BranchDiffView = z.infer<typeof BranchDiffView>;

export const WorktreeFileStatus = z.enum(["added", "modified", "deleted", "conflicted"]);
export type WorktreeFileStatus = z.infer<typeof WorktreeFileStatus>;

export const WorktreeFile = z.object({
  path: z.string(),
  status: WorktreeFileStatus,
  /** Null for binary files. */
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type WorktreeFile = z.infer<typeof WorktreeFile>;

/**
 * `GET .../workstreams/:workstreamId/changes`: what is in the agent's worktree on its VM and not yet pushed.
 * `missing`: the VM has no worktree for this branch (never started there, or the VM was replaced).
 */
export const WorktreeChanges = z.object({
  state: z.enum(["ready", "missing"]),
  headSha: GitSha.nullable(),
  /** Commits on the worktree's branch that GitHub does not have yet. */
  unpushed: z.number().int().nonnegative(),
  files: z.array(WorktreeFile).max(500),
  truncated: z.boolean(),
  /** Someone is working there now: a commit captures their work in progress. */
  agentLive: z.boolean(),
  checkedAt: EpochMs,
});
export type WorktreeChanges = z.infer<typeof WorktreeChanges>;

/** `POST .../workstreams/:workstreamId/commit`: commit everything in the worktree, then push the branch. */
export const CommitWorkBody = z.object({ message: text(1, COMMIT_MESSAGE_MAX) });
export type CommitWorkBody = z.infer<typeof CommitWorkBody>;

/** Commit (when there was anything to commit) and push. `sha` is what GitHub now has on the branch. */
export const CommitWorkResponse = z.object({ sha: GitSha, committed: z.boolean() });
export type CommitWorkResponse = z.infer<typeof CommitWorkResponse>;

/** `github.changed` realtime frame: these pull requests (or the project's list) changed on GitHub. Refetch them. */
export const GithubChangeView = z.object({
  projectId: Id,
  pulls: z.array(z.number().int().positive()).max(100),
  list: z.boolean(),
  at: EpochMs,
});
export type GithubChangeView = z.infer<typeof GithubChangeView>;
