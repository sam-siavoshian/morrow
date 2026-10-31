// Pull requests and branches for one team's linked repos, read and written as the signed-in member with their own
// GitHub token, so GitHub enforces exactly what that person may do. Reads go through the conditional-request cache;
// writes go straight to GitHub and then drop the cached copies they changed. Every repo path is built from the
// team's linked project (validated at link time), never from request input.
import type {
  BranchDiffView,
  BranchView,
  GithubFreshness,
  MergeMethod,
  ProjectView,
  PullDetail,
  PullListResponse,
  PullStateFilter,
  TaskView,
} from "@morrow/contracts";
import { APP_NAME, RepoFullName } from "@morrow/contracts";
import { GithubError, type GithubClient } from "../integrations/github/client.ts";
import { AppError, conflict, dependencyUnavailable, forbidden, notFound } from "../lib/errors.ts";
import { integrationBranch } from "../orchestration/names.ts";
import type { WorkforceApi } from "../orchestration/workforce.ts";
import type { CachedRead, GithubCache } from "./cache.ts";
import {
  canWrite,
  isFullSha,
  mergeability,
  mergeMethods,
  parseList,
  pullState,
  sortPulls,
  toBranchCommits,
  toChecks,
  toConversation,
  toDiffFiles,
  toFiles,
  toPullSummary,
  toReviews,
  userRef,
  epoch,
  WireCompare,
  WirePull,
  WireRepo,
} from "./pulls.ts";

const LIST_PAGE = 50;

const READY_FOR_REVIEW = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;

const METHOD_LABEL: Record<MergeMethod, string> = { merge: "merge commits", squash: "squash merging", rebase: "rebase merging" };

export interface GithubServiceDeps {
  client: Pick<GithubClient, "write" | "graphql">;
  cache: GithubCache;
  /** The member's GitHub token, decrypted for one call. Throws an AppError when they have none. */
  token: (userId: string) => Promise<string>;
  workforce: Pick<WorkforceApi, "getView">;
  now: () => number;
  /** A write changed this pull request: tell the team's viewers (GitHub sync publishes `github.changed`). */
  onWrite?: (teamId: string, projectId: string, number: number) => void;
}

type Who = { teamId: string; userId: string };

export class GithubService {
  readonly #d: GithubServiceDeps;

  constructor(deps: GithubServiceDeps) {
    this.#d = deps;
  }

  /** The project's pull requests, open first. Pull requests Morrow opened carry their task's id. */
  async listPulls(who: Who, project: ProjectView, state: PullStateFilter): Promise<PullListResponse> {
    const repo = repoPath(project.repoFullName);
    const params = new URLSearchParams({ state, sort: "updated", direction: "desc", per_page: String(LIST_PAGE) });
    const read = await this.#read(who.userId, `/repos/${repo}/pulls?${params}`, "pull requests");
    const tasks = await this.#taskBranches(who.teamId, project.id);
    const pulls = sortPulls(parseList(WirePull, read.body).map((pr) => toPullSummary(pr, tasks.get(pr.head.ref) ?? null)));
    return {
      projectId: project.id,
      repoFullName: project.repoFullName,
      pulls,
      truncated: /\brel="next"/.test(read.link ?? ""),
      freshness: freshness([read]),
    };
  }

  /** Everything the pull request panel shows, in one answer. */
  async pullDetail(who: Who, project: ProjectView, number: number): Promise<PullDetail> {
    const repo = repoPath(project.repoFullName);
    const base = `/repos/${repo}/pulls/${number}`;
    const pullRead = await this.#read(who.userId, base, "pull request");
    const parsed = WirePull.safeParse(pullRead.body);
    if (!parsed.success) throw dependencyUnavailable("GitHub sent a pull request we could not read. Try again shortly.");
    const pr = parsed.data;
    const sha = isFullSha(pr.head.sha) ? pr.head.sha : null;
    const optional = (path: string) => this.#optional(who.userId, path);
    const [files, reviews, reviewComments, issueComments, runs, statuses, repoRead] = await Promise.all([
      optional(`${base}/files?per_page=100`),
      optional(`${base}/reviews?per_page=100`),
      optional(`${base}/comments?per_page=100`),
      optional(`/repos/${repo}/issues/${number}/comments?per_page=100`),
      sha ? optional(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`) : Promise.resolve(null),
      sha ? optional(`/repos/${repo}/commits/${sha}/status?per_page=100`) : Promise.resolve(null),
      optional(`/repos/${repo}`),
    ]);
    if (!sha) throw dependencyUnavailable("GitHub sent a pull request we could not read. Try again shortly.");
    const repoInfo = WireRepo.safeParse(repoRead?.body);
    const wireRepo = repoInfo.success ? repoInfo.data : null;
    const review = toReviews(reviews?.body, pr.requested_reviewers);
    const conversation = toConversation(issueComments?.body, reviews?.body, reviewComments?.body);
    const tasks = await this.#taskBranches(who.teamId, project.id);
    return {
      ...toPullSummary(pr, tasks.get(pr.head.ref) ?? null),
      body: pr.body ?? "",
      headSha: sha,
      mergeable: mergeability(pr),
      mergedAt: epoch(pr.merged_at),
      mergedBy: userRef(pr.merged_by),
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changed_files ?? 0,
      commits: pr.commits ?? 0,
      reviewDecision: review.decision,
      reviewers: review.reviewers,
      checks: toChecks(runs?.body, statuses?.body),
      files: toFiles(files?.body),
      conversation: conversation.items,
      conversationTruncated: conversation.truncated,
      mergeMethods: mergeMethods(wireRepo),
      viewerCanWrite: canWrite(wireRepo),
      freshness: freshness([pullRead, files, reviews, reviewComments, issueComments, runs, statuses, repoRead]),
    };
  }

  /** The pull request the verifier opened for this task (integration branch into the default branch), or null. */
  async taskPull(who: Who, project: ProjectView, task: Pick<TaskView, "id">): Promise<PullDetail | null> {
    const repo = repoPath(project.repoFullName);
    const owner = project.repoFullName.split("/")[0]!;
    const params = new URLSearchParams({ head: `${owner}:${integrationBranch(task.id)}`, base: project.defaultBranch, state: "all", per_page: "5" });
    const read = await this.#read(who.userId, `/repos/${repo}/pulls?${params}`, "pull request");
    const pr = parseList(WirePull, read.body)[0];
    return pr ? this.pullDetail(who, project, pr.number) : null;
  }

  /** `branch` on GitHub against the project's default branch: ahead/behind and its newest commits. */
  async branch(who: Who, project: ProjectView, branch: string): Promise<BranchView> {
    if (!isBranchName(branch) || !isBranchName(project.defaultBranch)) throw notFound("Branch not found.");
    const repo = repoPath(project.repoFullName);
    const empty = { branch, base: project.defaultBranch, aheadBy: 0, behindBy: 0, headSha: null, commits: [] };
    let read: CachedRead;
    try {
      read = await this.#d.cache.read(who.userId, await this.#d.token(who.userId), comparePath(repo, project.defaultBranch, branch));
    } catch (error) {
      if (!(error instanceof GithubError) || error.kind !== "not_found") throw this.#failure(who.userId, error, "branch");
      // GitHub says 404 both for a branch that is not pushed yet and for a repo the member cannot see.
      const repoRead = await this.#read(who.userId, `/repos/${repo}`, "repository");
      return { ...empty, exists: false, freshness: freshness([repoRead]) };
    }
    const compare = WireCompare.safeParse(read.body);
    if (!compare.success) throw dependencyUnavailable("GitHub sent a comparison we could not read. Try again shortly.");
    const commits = toBranchCommits(compare.data.commits);
    return {
      ...empty,
      exists: true,
      aheadBy: compare.data.ahead_by,
      behindBy: compare.data.behind_by,
      headSha: commits[0]?.sha ?? null,
      commits,
      freshness: freshness([read]),
    };
  }

  /**
   * What `branch` changed against the project's default branch, file by file with patches as text, cut to the
   * contract's size budgets. Reads the same compare as `branch()`, so the two share one cached GitHub answer. A
   * compare over the client's size cap comes back `tooLarge` with no files, so the panel can point to GitHub.
   */
  async diff(who: Who, project: ProjectView, branch: string): Promise<BranchDiffView> {
    if (!isBranchName(branch) || !isBranchName(project.defaultBranch)) throw notFound("Branch not found.");
    const repo = repoPath(project.repoFullName);
    const empty = {
      branch,
      base: project.defaultBranch,
      tooLarge: false,
      headSha: null,
      aheadBy: 0,
      behindBy: 0,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      files: [],
      filesTruncated: false,
    };
    let read: CachedRead;
    try {
      read = await this.#d.cache.read(who.userId, await this.#d.token(who.userId), comparePath(repo, project.defaultBranch, branch));
    } catch (error) {
      if (isTooLarge(error)) {
        const freshnessNow = { fetchedAt: this.#d.now(), stale: false, rateLimitedUntil: this.#d.cache.rateLimitedUntil(who.userId) };
        return { ...empty, exists: true, tooLarge: true, freshness: freshnessNow };
      }
      if (!(error instanceof GithubError) || error.kind !== "not_found") throw this.#failure(who.userId, error, "branch");
      // GitHub says 404 both for a branch that is not pushed yet and for a repo the member cannot see.
      const repoRead = await this.#read(who.userId, `/repos/${repo}`, "repository");
      return { ...empty, exists: false, freshness: freshness([repoRead]) };
    }
    const compare = WireCompare.safeParse(read.body);
    if (!compare.success) throw dependencyUnavailable("GitHub sent a comparison we could not read. Try again shortly.");
    return {
      ...empty,
      exists: true,
      headSha: toBranchCommits(compare.data.commits, 1)[0]?.sha ?? null,
      aheadBy: compare.data.ahead_by,
      behindBy: compare.data.behind_by,
      ...toDiffFiles(compare.data.files),
      freshness: freshness([read]),
    };
  }

  // ---------- writes ----------

  async comment(who: Who, project: ProjectView, number: number, body: string, inReplyTo?: number): Promise<void> {
    const repo = repoPath(project.repoFullName);
    const path = inReplyTo ? `/repos/${repo}/pulls/${number}/comments/${inReplyTo}/replies` : `/repos/${repo}/issues/${number}/comments`;
    await this.#write(who, project, number, "comment", (token) => this.#d.client.write("POST", token, path, { body }));
  }

  async merge(who: Who, project: ProjectView, number: number, method: MergeMethod, headSha: string): Promise<void> {
    const repo = repoPath(project.repoFullName);
    const repoRead = await this.#optional(who.userId, `/repos/${repo}`);
    const info = WireRepo.safeParse(repoRead?.body);
    const allowed = info.success ? mergeMethods(info.data) : [];
    if (allowed.length > 0 && !allowed.includes(method)) throw conflict(`This repository does not allow ${METHOD_LABEL[method]}. Pick another merge method.`);
    await this.#write(who, project, number, "merge", (token) =>
      this.#d.client.write("PUT", token, `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha: headSha }),
    );
  }

  async markReady(who: Who, project: ProjectView, number: number): Promise<void> {
    const repo = repoPath(project.repoFullName);
    const pullRead = await this.#read(who.userId, `/repos/${repo}/pulls/${number}`, "pull request");
    const pr = WirePull.safeParse(pullRead.body);
    if (!pr.success || !pr.data.node_id) throw dependencyUnavailable("GitHub sent a pull request we could not read. Try again shortly.");
    if (pullState(pr.data) !== "draft") throw conflict("This pull request is not a draft.");
    const id = pr.data.node_id;
    await this.#write(who, project, number, "ready", (token) => this.#d.client.graphql(token, READY_FOR_REVIEW, { id }));
  }

  async setState(who: Who, project: ProjectView, number: number, state: "open" | "closed"): Promise<void> {
    const repo = repoPath(project.repoFullName);
    await this.#write(who, project, number, state === "closed" ? "close" : "reopen", (token) =>
      this.#d.client.write("PATCH", token, `/repos/${repo}/pulls/${number}`, { state }),
    );
  }

  // ---------- internals ----------

  async #write(who: Who, project: ProjectView, number: number, action: WriteAction, run: (token: string) => Promise<unknown>): Promise<void> {
    const token = await this.#d.token(who.userId);
    try {
      await run(token);
    } catch (error) {
      throw this.#failure(who.userId, error, action);
    }
    const repo = repoPath(project.repoFullName);
    this.#d.cache.invalidate(`/repos/${repo}/pulls/${number}`);
    this.#d.cache.invalidate(`/repos/${repo}/issues/${number}/`);
    this.#d.cache.invalidate(`/repos/${repo}/pulls?`);
    this.#d.onWrite?.(who.teamId, project.id, number);
  }

  async #read(userId: string, path: string, what: string): Promise<CachedRead> {
    try {
      return await this.#d.cache.read(userId, await this.#d.token(userId), path);
    } catch (error) {
      throw this.#failure(userId, error, what);
    }
  }

  /** A part of the panel that may be missing (no access to checks, merge settings hidden): null, not an error. */
  async #optional(userId: string, path: string): Promise<CachedRead | null> {
    try {
      return await this.#d.cache.read(userId, await this.#d.token(userId), path);
    } catch (error) {
      if (error instanceof GithubError && (error.kind === "not_found" || error.kind === "forbidden" || error.kind === "bad_response")) return null;
      throw this.#failure(userId, error, "pull request");
    }
  }

  /** Branch name -> task id, for this project's tasks (their integration branches). */
  async #taskBranches(teamId: string, projectId: string): Promise<Map<string, string>> {
    const view = await this.#d.workforce.getView(teamId);
    const out = new Map<string, string>();
    for (const task of Object.values(view.tasks)) {
      if (task.projectId !== projectId) continue;
      const branch = integrationBranch(task.id);
      if (!out.has(branch)) out.set(branch, task.id);
    }
    return out;
  }

  #failure(userId: string, error: unknown, action: WriteAction | string): AppError {
    const scopes = this.#d.cache.scopesOf(userId);
    return githubFailure(error, action, scopes !== null && !scopes.includes("repo"));
  }
}

type WriteAction = "comment" | "merge" | "ready" | "close" | "reopen";

const RECONNECT = `Your GitHub access has expired or is missing a permission ${APP_NAME} needs. Reconnect GitHub to continue.`;

/**
 * A GitHub failure in words a member can act on. GitHub's own reason for refusing a write (branch protection,
 * failing checks, a merge conflict) is passed along as text. `missingRepoScope`: the token was granted before
 * Morrow asked for `repo`, so a 404 or 403 is the token, not the member.
 */
export function githubFailure(error: unknown, action: WriteAction | string, missingRepoScope = false): AppError {
  if (error instanceof AppError) return error;
  if (!(error instanceof GithubError)) return dependencyUnavailable("GitHub is unavailable. Try again shortly.", error);
  const reason = error.detail ? ` GitHub says: ${error.detail}` : "";
  switch (error.kind) {
    case "unauthorized":
      return new AppError("unauthenticated", RECONNECT);
    case "rate_limited": {
      const seconds = Math.max(1, error.retryAfterSeconds ?? 60);
      const wait = seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
      return new AppError("rate_limited", `Your GitHub rate limit is used up. It resets in about ${wait}.`, { headers: { "retry-after": String(seconds) } });
    }
    case "forbidden":
      if (missingRepoScope) return new AppError("unauthenticated", RECONNECT);
      return forbidden(`${FORBIDDEN_TEXT[action as WriteAction] ?? "Your GitHub account cannot see this in the repository."}${reason}`);
    case "not_found":
      if (missingRepoScope) return new AppError("unauthenticated", RECONNECT);
      return notFound("GitHub can't find that, or your GitHub account can't see it.");
    case "unavailable":
      return dependencyUnavailable("GitHub is unavailable. Try again shortly.", error);
    default:
      break;
  }
  if (error.status === 409 && action === "merge") return conflict("New commits were pushed to this pull request since you loaded it. Review them, then merge again.");
  if (error.status === 405 && action === "merge") return conflict(`GitHub would not merge this pull request.${reason || " It is not mergeable right now."}`);
  if (error.status === 422 || error.status === 405 || error.status === 409) return conflict(`GitHub refused to ${VERB[action as WriteAction] ?? "do that"}.${reason}`);
  return dependencyUnavailable("GitHub sent an answer we could not read. Try again shortly.", error);
}

const FORBIDDEN_TEXT: Record<WriteAction, string> = {
  comment: "Your GitHub account cannot comment on this pull request.",
  merge: "Your GitHub account cannot merge this pull request. Merging needs write access to the repository.",
  ready: "Your GitHub account cannot change this pull request. That needs write access, or being its author.",
  close: "Your GitHub account cannot close this pull request. That needs write access, or being its author.",
  reopen: "Your GitHub account cannot reopen this pull request. That needs write access, or being its author.",
};

const VERB: Record<WriteAction, string> = {
  comment: "post the comment",
  merge: "merge the pull request",
  ready: "mark the pull request ready for review",
  close: "close the pull request",
  reopen: "reopen the pull request",
};

function freshness(reads: ReadonlyArray<CachedRead | null>): GithubFreshness {
  const present = reads.filter((r): r is CachedRead => r !== null);
  const limits = present.map((r) => r.rateLimitedUntil).filter((v): v is number => v !== null);
  return {
    fetchedAt: present.length ? Math.min(...present.map((r) => r.fetchedAt)) : 0,
    stale: present.some((r) => r.stale),
    rateLimitedUntil: limits.length ? Math.max(...limits) : null,
  };
}

/** `owner/name` as two encoded path segments; anything else never reaches a URL. */
export function repoPath(fullName: string): string {
  if (!RepoFullName.safeParse(fullName).success) throw notFound("Repository not found.");
  const [owner, name] = fullName.split("/") as [string, string];
  if (name === "." || name === "..") throw notFound("Repository not found.");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** Branch names as git and our VM scripts accept them (a strict subset of `git check-ref-format --branch`). */
export function isBranchName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  );
}

/** A ref inside a compare range: each segment encoded, so `...` can only be our separator. */
function refPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/** The `base...head` compare path. `branch()` and `diff()` both build it here, so they share one cache entry. */
function comparePath(repo: string, base: string, head: string): string {
  return `/repos/${repo}/compare/${refPath(base)}...${refPath(head)}`;
}

/** The client refused to read GitHub's answer because it was over its JSON size cap. */
function isTooLarge(error: unknown): boolean {
  return error instanceof GithubError && error.kind === "bad_response" && error.message === "response too large";
}
