// The GitHub layer's internal event for the agent loop. GitHub sync hands each one to orchestration's
// `comms.reviewComment` (see `toReviewComment`), which decides which worker hears about it.
import type { ConversationItem } from "@morrow/contracts";
import type { ReviewCommentEvent } from "../orchestration/comms.ts";

/**
 * Someone commented on, reviewed, or left a review comment on the pull request Morrow opened for a task. One event
 * per new item, oldest first. Only items created after sync first saw the pull request are sent (a backend restart
 * starts a new baseline, so items posted while it was down are not replayed).
 *
 * `comment.body` is untrusted markdown from anyone who can comment on the repository: never log it, never put it in
 * a shell command, and fence it as quoted input before an agent reads it.
 */
export interface PullCommentEvent {
  teamId: string;
  projectId: string;
  taskId: string;
  repoFullName: string;
  pullNumber: number;
  pullUrl: string;
  /** The pull request's head branch (the task's integration branch). */
  headRef: string;
  comment: ConversationItem;
}

const REVIEW_TEXT: Record<"approved" | "changes_requested" | "commented" | "dismissed", string> = {
  approved: "approved the pull request",
  changes_requested: "requested changes",
  commented: "left a review",
  dismissed: "had a review dismissed",
};

/** The agent loop's shape for one comment. A review with no text says what the review decided. */
export function toReviewComment(event: PullCommentEvent): ReviewCommentEvent {
  const c = event.comment;
  const body = c.body.trim() || (c.kind === "review" ? `(${REVIEW_TEXT[c.state]}, no text)` : "(no text)");
  return {
    teamId: event.teamId,
    taskId: event.taskId,
    // Issue comments, reviews and review comments have separate id spaces on GitHub.
    commentId: `${c.kind}-${c.id}`,
    author: c.author?.login ?? "ghost",
    path: c.kind === "review_comment" ? c.path.slice(0, 500) || null : null,
    line: c.kind === "review_comment" ? c.line : null,
    body,
    url: c.url,
  };
}
