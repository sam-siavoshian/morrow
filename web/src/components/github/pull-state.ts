/** Pure words and tones for pull request state, checks, reviews, merge readiness and freshness. No React here. */
import type { BadgeTone } from "@/components/ui/badge";
import type { GithubFreshness, MergeMethod, PullChecks, PullDetail, PullState, ReviewDecision, WorktreeFileStatus } from "@morrow/contracts";
import { isApiError } from "@/lib/api";

export const PULL_STATE: Record<PullState, { label: string; tone: BadgeTone }> = {
  open: { label: "Open", tone: "mint" },
  draft: { label: "Draft", tone: "neutral" },
  merged: { label: "Merged", tone: "lilac" },
  closed: { label: "Closed", tone: "rose" },
};

export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

export const REVIEW_LABEL: Record<ReviewDecision, { label: string; tone: BadgeTone }> = {
  approved: { label: "Approved", tone: "mint" },
  changes_requested: { label: "Changes requested", tone: "rose" },
  review_required: { label: "Review requested", tone: "lemon" },
  none: { label: "No reviews yet", tone: "outline" },
};

export const WORKTREE_STATUS: Record<WorktreeFileStatus, { letter: string; label: string; className: string }> = {
  added: { letter: "A", label: "Added", className: "text-success" },
  modified: { letter: "M", label: "Modified", className: "text-warning" },
  deleted: { letter: "D", label: "Deleted", className: "text-danger" },
  conflicted: { letter: "!", label: "Has merge conflicts", className: "text-danger" },
};

/** "3 of 4 checks passed", "1 check failing", "2 checks running", or null when there are none. */
export function checksSummary(checks: PullChecks): { text: string; tone: BadgeTone } | null {
  const items = checks.items;
  if (items.length === 0) return null;
  const failed = items.filter((c) => c.state === "failed").length;
  const pending = items.filter((c) => c.state === "pending").length;
  const passed = items.filter((c) => c.state === "passed").length;
  if (failed > 0) return { text: failed === 1 ? "1 check failing" : `${failed} checks failing`, tone: "rose" };
  if (pending > 0) return { text: pending === 1 ? "1 check running" : `${pending} checks running`, tone: "lemon" };
  return { text: passed === items.length ? (items.length === 1 ? "Check passed" : `All ${items.length} checks passed`) : `${passed} of ${items.length} checks passed`, tone: "mint" };
}

export type MergeReadiness = {
  /** Why the merge button is off, or null when a merge can be tried. */
  blocker: string | null;
  /** Something to know before merging that does not stop it. */
  warning: string | null;
};

/**
 * Whether to offer a merge, in words. GitHub has the last word (branch protection can still refuse), so this only
 * holds back what is certain to fail and says why.
 */
export function mergeReadiness(pr: Pick<PullDetail, "state" | "mergeable" | "viewerCanWrite" | "mergeMethods" | "baseRef" | "checks">): MergeReadiness {
  if (pr.state === "merged") return { blocker: "Already merged.", warning: null };
  if (pr.state === "closed") return { blocker: "This pull request is closed. Reopen it to merge.", warning: null };
  if (pr.state === "draft" || pr.mergeable === "draft") return { blocker: "This is a draft. Mark it ready for review first.", warning: null };
  if (!pr.viewerCanWrite || pr.mergeMethods.length === 0) return { blocker: "Merging needs write access to this repository on GitHub.", warning: null };
  if (pr.mergeable === "conflicts") return { blocker: `This branch has conflicts with ${pr.baseRef}. Resolve them before merging.`, warning: null };
  if (pr.mergeable === "blocked") return { blocker: "GitHub is blocking the merge until required reviews or checks pass.", warning: null };
  if (pr.mergeable === "behind") return { blocker: null, warning: `This branch is behind ${pr.baseRef}. GitHub may ask for it to be updated first.` };
  if (pr.mergeable === "unknown") return { blocker: null, warning: "GitHub is still checking whether this can merge." };
  if (pr.checks.state === "failed" || pr.mergeable === "unstable") return { blocker: null, warning: "Some checks are failing." };
  if (pr.checks.state === "pending") return { blocker: null, warning: "Some checks are still running." };
  return { blocker: null, warning: null };
}

/** The method to preselect: squash when allowed (what most teams use), else the first the repo allows. */
export function defaultMergeMethod(methods: readonly MergeMethod[]): MergeMethod | null {
  if (methods.includes("squash")) return "squash";
  return methods[0] ?? null;
}

/** What to say about data that is not live, or null when it is. */
export function freshnessNote(freshness: GithubFreshness, now: number, format: (ms: number) => string): string | null {
  if (freshness.rateLimitedUntil && freshness.rateLimitedUntil > now)
    return `Your GitHub rate limit is used up until ${format(freshness.rateLimitedUntil)}. Showing what was loaded ${format(freshness.fetchedAt)}.`;
  if (freshness.stale) return `GitHub is not answering right now. Showing what was loaded ${format(freshness.fetchedAt)}.`;
  return null;
}

/** "just now", "5m ago", "3h ago", "4d ago", or the date for anything older than a month. */
export function relativeAge(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export type GithubFailure =
  | { kind: "reconnect"; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "disabled"; message: string }
  | { kind: "other"; message: string };

/** How a GitHub-layer call failed, so the view can offer the one thing that fixes it. */
export function githubFailure(error: unknown, fallback: string): GithubFailure {
  if (!isApiError(error)) return { kind: "other", message: fallback };
  switch (error.code) {
    case "unauthenticated":
      return { kind: "reconnect", message: error.message };
    case "rate_limited":
      return { kind: "rate_limited", message: error.message };
    case "forbidden":
      return { kind: "forbidden", message: error.message };
    case "not_found":
      return { kind: "not_found", message: error.message };
    case "feature_disabled":
      return { kind: "disabled", message: error.message };
    default:
      return { kind: "other", message: error.message };
  }
}

/** A commit message as typed: trimmed, at least something, within the server's limit. */
export function commitMessageError(message: string, max: number): string | null {
  const trimmed = message.trim();
  if (!trimmed) return "Write a commit message.";
  if (trimmed.length > max) return `Keep it under ${max.toLocaleString()} characters.`;
  return null;
}
