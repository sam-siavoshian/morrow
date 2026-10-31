// GitHub's REST shapes for pull requests, checks, reviews, comments and compares, and the pure mapping from them to
// the contracts the browser reads. Everything is validated leniently (unknown fields dropped, a malformed item
// skipped) because one odd comment must not hide a whole pull request. No I/O here.
import type {
  BranchCommit,
  BranchDiffFile,
  BranchDiffView,
  CheckState,
  ConversationItem,
  GithubUserRef,
  Mergeability,
  MergeMethod,
  PullCheck,
  PullChecks,
  PullFile,
  PullFileStatus,
  PullReviewer,
  PullState,
  PullSummary,
  ReviewDecision,
  ReviewerState,
} from "@morrow/contracts";
import { BRANCH_DIFF_FILES_MAX, BRANCH_DIFF_PATCH_MAX, BRANCH_DIFF_TOTAL_MAX } from "@morrow/contracts";
import { z } from "zod";

/** Comment bodies longer than this are cut (GitHub allows 65,536); the full text is one click away on GitHub. */
export const MAX_BODY_CHARS = 20_000;
export const MAX_CONVERSATION = 300;
const MAX_CODE_LINE = 300;

const User = z.object({ login: z.string().max(100), avatar_url: z.string().max(500).nullable().optional() }).nullable().optional();

export const WirePull = z.object({
  number: z.number().int().positive(),
  node_id: z.string().max(200).optional(),
  title: z.string().max(1_000),
  state: z.string(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  merged_by: User,
  user: User,
  head: z.object({ ref: z.string().max(300), sha: z.string() }),
  base: z.object({ ref: z.string().max(300) }),
  html_url: z.string().url(),
  created_at: z.string(),
  updated_at: z.string(),
  body: z.string().nullable().optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().nullable().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  commits: z.number().int().nonnegative().optional(),
  requested_reviewers: z.array(User).optional(),
});
export type WirePull = z.infer<typeof WirePull>;

export const WireRepo = z.object({
  allow_merge_commit: z.boolean().optional(),
  allow_squash_merge: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
  permissions: z.object({ admin: z.boolean().optional(), maintain: z.boolean().optional(), push: z.boolean().optional() }).optional(),
});
export type WireRepo = z.infer<typeof WireRepo>;

const WireFile = z.object({
  filename: z.string().max(1_000),
  previous_filename: z.string().max(1_000).optional(),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
/** A compare's file. GitHub leaves `patch` out for binary files, rename-only changes and files too big to diff. */
const WireDiffFile = WireFile.extend({ patch: z.string().optional() });

const WireReview = z.object({
  id: z.number().int().positive(),
  user: User,
  state: z.string(),
  body: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
  html_url: z.string().url(),
});

const WireIssueComment = z.object({
  id: z.number().int().positive(),
  user: User,
  body: z.string().nullable().optional(),
  created_at: z.string(),
  html_url: z.string().url(),
});

const WireReviewComment = WireIssueComment.extend({
  path: z.string().max(1_000),
  line: z.number().int().positive().nullable().optional(),
  original_line: z.number().int().positive().nullable().optional(),
  diff_hunk: z.string().nullable().optional(),
  in_reply_to_id: z.number().int().positive().optional(),
});

const WireCheckRuns = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(z.unknown()),
});
const WireCheckRun = z.object({
  name: z.string().max(300),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  details_url: z.string().nullable().optional(),
});

const WireCombinedStatus = z.object({ statuses: z.array(z.unknown()) });
const WireStatus = z.object({
  context: z.string().max(300),
  state: z.string(),
  description: z.string().nullable().optional(),
  target_url: z.string().nullable().optional(),
});

export const WireCompare = z.object({
  status: z.enum(["ahead", "behind", "identical", "diverged"]),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
  commits: z.array(z.unknown()).optional(),
  files: z.array(z.unknown()).optional(),
});
const WireCommit = z.object({
  sha: z.string(),
  html_url: z.string().nullable().optional(),
  author: User,
  commit: z.object({
    message: z.string(),
    author: z.object({ name: z.string().max(300).nullable().optional(), date: z.string().nullable().optional() }).nullable().optional(),
    committer: z.object({ date: z.string().nullable().optional() }).nullable().optional(),
  }),
});

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Parses a list leniently: items that do not match are dropped, not fatal. */
export function parseList<T extends z.ZodType>(schema: T, data: unknown): z.infer<T>[] {
  if (!Array.isArray(data)) return [];
  const out: z.infer<T>[] = [];
  for (const item of data) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function epoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= 0 ? at : null;
}

/** Only GitHub's avatar host: anything else would load from a host a commenter picked. */
export function avatarUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "avatars.githubusercontent.com" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** An http(s) link GitHub gave us (comment, check, commit pages). Anything else becomes null. */
export function webUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2_048) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function userRef(user: z.infer<typeof User>): GithubUserRef | null {
  return user ? { login: user.login, avatarUrl: avatarUrl(user.avatar_url) } : null;
}

export function pullState(pr: Pick<WirePull, "state" | "draft" | "merged" | "merged_at">): PullState {
  if (pr.merged || pr.merged_at) return "merged";
  if (pr.state !== "open") return "closed";
  return pr.draft ? "draft" : "open";
}

/**
 * `mergeable` (null while GitHub computes it) and `mergeable_state` in one word. A known conflict wins over
 * everything; `has_hooks` merges like `clean`.
 */
export function mergeability(pr: Pick<WirePull, "state" | "draft" | "mergeable" | "mergeable_state">): Mergeability {
  if (pr.draft) return "draft";
  if (pr.mergeable === false) return "conflicts";
  switch (pr.mergeable_state) {
    case "clean":
    case "has_hooks":
      return "clean";
    case "dirty":
      return "conflicts";
    case "blocked":
      return "blocked";
    case "behind":
      return "behind";
    case "unstable":
      return "unstable";
    case "draft":
      return "draft";
    default:
      return "unknown";
  }
}

export function toPullSummary(pr: WirePull, taskId: string | null): PullSummary {
  return {
    number: pr.number,
    title: pr.title,
    state: pullState(pr),
    author: userRef(pr.user),
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    url: pr.html_url,
    createdAt: epoch(pr.created_at) ?? 0,
    updatedAt: epoch(pr.updated_at) ?? 0,
    taskId,
  };
}

/** Open and draft first, then most recently updated. */
export function sortPulls<T extends Pick<PullSummary, "state" | "updatedAt" | "number">>(pulls: readonly T[]): T[] {
  const live = (p: T) => (p.state === "open" || p.state === "draft" ? 0 : 1);
  return [...pulls].sort((a, b) => live(a) - live(b) || b.updatedAt - a.updatedAt || b.number - a.number);
}

export function mergeMethods(repo: WireRepo | null): MergeMethod[] {
  if (!repo) return [];
  const out: MergeMethod[] = [];
  if (repo.allow_merge_commit) out.push("merge");
  if (repo.allow_squash_merge) out.push("squash");
  if (repo.allow_rebase_merge) out.push("rebase");
  return out;
}

export function canWrite(repo: WireRepo | null): boolean {
  const p = repo?.permissions;
  return Boolean(p && (p.push || p.maintain || p.admin));
}

const FILE_STATUS = new Set<PullFileStatus>(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);

export function toFiles(data: unknown): PullFile[] {
  return parseList(WireFile, data)
    .slice(0, 300)
    .map((f) => ({
      path: f.filename,
      previousPath: f.previous_filename ?? null,
      status: FILE_STATUS.has(f.status as PullFileStatus) ? (f.status as PullFileStatus) : "changed",
      additions: f.additions,
      deletions: f.deletions,
    }));
}

/** GitHub lists at most this many changed files in a compare; past it the rest are left out of the answer. */
const COMPARE_FILES_MAX = 300;

export interface DiffLimits {
  /** Most files listed. */
  files: number;
  /** Longest patch kept for one file, in characters. */
  patch: number;
  /** Most patch text kept over all listed files, in characters. */
  total: number;
}

const DIFF_LIMITS: DiffLimits = { files: BRANCH_DIFF_FILES_MAX, patch: BRANCH_DIFF_PATCH_MAX, total: BRANCH_DIFF_TOTAL_MAX };

/**
 * A compare's `files` as the diff panel lists them. Totals count every file GitHub reported; the first `limits.files`
 * are listed. A patch longer than `limits.patch` is cut at its last line break inside the limit (one longer line is
 * left out whole). Once the patch text kept would pass `limits.total`, this file and every later one come without a
 * patch. Both mark the file `patchTruncated`. With no patch from GitHub, a file is truncated only when it counts
 * changed lines (too big to diff): binary files and rename-only changes count none. NUL characters are dropped. The
 * patch stays plain text from the repo; the browser renders it as text.
 */
export function toDiffFiles(data: unknown, limits: DiffLimits = DIFF_LIMITS): Pick<BranchDiffView, "additions" | "deletions" | "changedFiles" | "files" | "filesTruncated"> {
  const all = parseList(WireDiffFile, data);
  const files: BranchDiffFile[] = [];
  let budget = limits.total;
  let spent = false;
  for (const f of all.slice(0, limits.files)) {
    const base = {
      path: f.filename,
      previousPath: f.previous_filename ?? null,
      status: FILE_STATUS.has(f.status as PullFileStatus) ? (f.status as PullFileStatus) : "changed",
      additions: f.additions,
      deletions: f.deletions,
    };
    if (f.patch === undefined) {
      files.push({ ...base, patch: null, patchTruncated: f.additions + f.deletions > 0 });
      continue;
    }
    const clipped = clipPatch(f.patch, limits.patch);
    if (spent || (clipped.text?.length ?? 0) > budget) {
      spent = true;
      files.push({ ...base, patch: null, patchTruncated: true });
      continue;
    }
    budget -= clipped.text?.length ?? 0;
    files.push({ ...base, patch: clipped.text, patchTruncated: clipped.cut });
  }
  return {
    additions: all.reduce((n, f) => n + f.additions, 0),
    deletions: all.reduce((n, f) => n + f.deletions, 0),
    changedFiles: all.length,
    files,
    filesTruncated: all.length > files.length || (Array.isArray(data) && data.length >= COMPARE_FILES_MAX),
  };
}

/** NULs dropped, then cut at the last line break inside `max`; null when the first line alone is longer. */
function clipPatch(raw: string, max: number): { text: string | null; cut: boolean } {
  const text = raw.replaceAll("\0", "");
  if (text.length <= max) return { text, cut: false };
  const end = text.lastIndexOf("\n", max);
  return { text: end > 0 ? text.slice(0, end) : null, cut: true };
}

const RUN_FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

function runState(status: string, conclusion: string | null | undefined): CheckState {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "passed";
  if (conclusion && RUN_FAILED.has(conclusion)) return "failed";
  return "neutral";
}

function statusState(state: string): CheckState {
  if (state === "success") return "passed";
  if (state === "failure" || state === "error") return "failed";
  return "pending";
}

/** Check runs (GitHub Actions and apps) plus legacy commit statuses on one commit. */
export function toChecks(checkRuns: unknown, combined: unknown): PullChecks {
  const items: PullCheck[] = [];
  const runs = WireCheckRuns.safeParse(checkRuns);
  let total = 0;
  if (runs.success) {
    total += runs.data.total_count;
    for (const run of parseList(WireCheckRun, runs.data.check_runs)) {
      const state = runState(run.status, run.conclusion);
      const detail = run.status === "completed" ? (run.conclusion ?? null) : run.status;
      items.push({ name: run.name, state, detail: detail ? detail.replace(/_/g, " ") : null, url: webUrl(run.html_url ?? run.details_url) });
    }
  }
  const statuses = WireCombinedStatus.safeParse(combined);
  if (statuses.success) {
    const list = parseList(WireStatus, statuses.data.statuses);
    total += list.length;
    // GitHub lists every status ever set, newest first; only the newest per context counts.
    const seen = new Set<string>();
    for (const status of list) {
      if (seen.has(status.context)) continue;
      seen.add(status.context);
      items.push({ name: status.context, state: statusState(status.state), detail: status.description?.slice(0, 200) || null, url: webUrl(status.target_url) });
    }
  }
  const shown = items.slice(0, 100);
  const state: PullChecks["state"] = shown.some((c) => c.state === "failed")
    ? "failed"
    : shown.some((c) => c.state === "pending")
      ? "pending"
      : shown.length > 0
        ? "passed"
        : "none";
  return { state, items: shown, truncated: items.length > shown.length || total > items.length };
}

const REVIEW_STATE: Record<string, Exclude<ReviewerState, "requested"> | undefined> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/**
 * Each reviewer's standing: their latest approval, change request or dismissal (a later plain comment does not undo
 * either), else "commented". A reviewer asked again shows as "requested". The decision follows GitHub's rule of
 * thumb: any open change request blocks, else any approval approves, else an open request means a review is needed.
 */
export function toReviews(reviewsData: unknown, requested: WirePull["requested_reviewers"]): { reviewers: PullReviewer[]; decision: ReviewDecision } {
  const byLogin = new Map<string, PullReviewer>();
  for (const review of parseList(WireReview, reviewsData)) {
    const state = REVIEW_STATE[review.state];
    if (!state || !review.user) continue;
    const prev = byLogin.get(review.user.login);
    const decisive = state !== "commented";
    if (!prev || decisive || prev.state === "commented") {
      byLogin.set(review.user.login, { login: review.user.login, avatarUrl: avatarUrl(review.user.avatar_url), state });
    }
  }
  for (const user of requested ?? []) {
    if (!user) continue;
    byLogin.set(user.login, { login: user.login, avatarUrl: avatarUrl(user.avatar_url), state: "requested" });
  }
  const reviewers = [...byLogin.values()].slice(0, 100);
  const decision: ReviewDecision = reviewers.some((r) => r.state === "changes_requested")
    ? "changes_requested"
    : reviewers.some((r) => r.state === "approved")
      ? "approved"
      : reviewers.some((r) => r.state === "requested")
        ? "review_required"
        : "none";
  return { reviewers, decision };
}

function clip(body: string | null | undefined): string {
  const text = body ?? "";
  return text.length <= MAX_BODY_CHARS ? text : `${text.slice(0, MAX_BODY_CHARS)}\n\n…`;
}

/** The commented line: the last line of the diff hunk GitHub sends with a review comment. */
export function codeLineOf(hunk: string | null | undefined): string | null {
  if (!hunk) return null;
  const last = hunk.replace(/\r?\n$/, "").split("\n").at(-1) ?? "";
  if (!last || last.startsWith("@@")) return null;
  return last.length <= MAX_CODE_LINE ? last : `${last.slice(0, MAX_CODE_LINE)}…`;
}

/**
 * Issue comments, reviews (with a body, or an approval or change request) and review comments, oldest first. When
 * there are more than `MAX_CONVERSATION`, the newest are kept and `truncated` says so.
 */
export function toConversation(issueComments: unknown, reviewsData: unknown, reviewComments: unknown): { items: ConversationItem[]; truncated: boolean } {
  const items: ConversationItem[] = [];
  for (const c of parseList(WireIssueComment, issueComments)) {
    items.push({ kind: "comment", id: c.id, author: userRef(c.user), body: clip(c.body), createdAt: epoch(c.created_at) ?? 0, url: c.html_url });
  }
  for (const r of parseList(WireReview, reviewsData)) {
    const state = REVIEW_STATE[r.state];
    if (!state || (!r.body?.trim() && state === "commented")) continue;
    items.push({ kind: "review", id: r.id, author: userRef(r.user), body: clip(r.body), createdAt: epoch(r.submitted_at) ?? 0, url: r.html_url, state });
  }
  for (const c of parseList(WireReviewComment, reviewComments)) {
    items.push({
      kind: "review_comment",
      id: c.id,
      author: userRef(c.user),
      body: clip(c.body),
      createdAt: epoch(c.created_at) ?? 0,
      url: c.html_url,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      codeLine: codeLineOf(c.diff_hunk),
      inReplyTo: c.in_reply_to_id ?? null,
    });
  }
  items.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const truncated = items.length > MAX_CONVERSATION;
  return { items: truncated ? items.slice(-MAX_CONVERSATION) : items, truncated };
}

/** The newest commits on a branch, newest first, from a `base...head` compare (which lists them oldest first). */
export function toBranchCommits(commits: unknown, limit = 10): BranchCommit[] {
  return parseList(WireCommit, commits)
    .filter((c) => FULL_SHA.test(c.sha))
    .slice(-limit)
    .reverse()
    .map((c) => ({
      sha: c.sha,
      message: (c.commit.message.split("\n", 1)[0] ?? "").slice(0, 300),
      author: userRef(c.author),
      authorName: c.commit.author?.name ?? null,
      committedAt: epoch(c.commit.committer?.date ?? c.commit.author?.date),
      url: webUrl(c.html_url),
    }));
}

/** A stable fingerprint of what a viewer would see change in a pull request's list row. */
export function rowSignature(pr: WirePull): string {
  return `${pullState(pr)}|${pr.updated_at}|${pr.head.sha}`;
}

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value);
}
