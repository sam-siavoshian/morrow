// Keeps the team's view of GitHub current without webhooks. Every `pollMs`, for each team with a connected viewer or
// live work (`activeTeamIds`), it reads each linked repo's pull request list and, for open pull requests Morrow
// opened, their checks and new comments, all through the conditional-request cache (a 304 costs no rate limit). It
// reads as one member of that team (a connected viewer first), skips anyone whose GitHub budget is low or spent,
// and pushes a small `github.changed` frame naming what changed; browsers refetch it with their own tokens.
//
// New comments on a task's pull request go to `onComment` (wired to the agent loop's `comms.reviewComment`).
//
// All state is in memory and bounded (teams, projects, 10 watched pull requests each). A restart loses it, which only
// means the next pass sets a new baseline. A webhook receiver could later call `noteChanged` with the same effect.
import type { ProjectView, ServerFrame, TaskView } from "@morrow/contracts";
import type { TeamRecord } from "../actors/types.ts";
import type { Logger } from "../lib/logger.ts";
import { integrationBranch } from "../orchestration/names.ts";
import type { WorkforceApi } from "../orchestration/workforce.ts";
import type { CachedRead, GithubCache } from "./cache.ts";
import type { PullCommentEvent } from "./events.ts";
import { isFullSha, parseList, pullState, rowSignature, toChecks, toConversation, WirePull, type WirePull as Pull } from "./pulls.ts";
import { repoPath } from "./service.ts";

const MAX_TEAMS_PER_PASS = 200;
const MAX_PROJECTS = 10;
const MAX_WATCHED_PULLS = 10;
const MAX_EVENTS_PER_PULL = 20;
const LIST_PAGE = 30;
/** Teams not polled for this long are forgotten. */
const FORGET_AFTER_MS = 60 * 60_000;
/** Issue comments are read `since` the baseline minus this, so clock skew with GitHub cannot hide one. */
const SINCE_SLACK_MS = 5 * 60_000;
const TERMINAL = new Set<TaskView["status"]>(["completed", "failed", "cancelled"]);

export interface GithubSyncOptions {
  cache: GithubCache;
  actors: { getTeam(teamId: string): Promise<TeamRecord | null> };
  workforce: Pick<WorkforceApi, "getView">;
  /** Teams with a connected viewer or live work. */
  activeTeamIds: () => string[];
  /** Members of the team with a connected socket right now. */
  viewerIds: (teamId: string) => string[];
  publish: (teamId: string, frame: ServerFrame) => void;
  /** A new comment on a task's pull request. Failures are logged; the comment is not retried. */
  onComment: (event: PullCommentEvent) => Promise<void>;
  token: (userId: string) => Promise<string>;
  log: Logger;
  now: () => number;
  pollMs?: number;
}

type CommentKind = "comment" | "review" | "review_comment";

interface Watch {
  updatedAt: string;
  checks: string | null;
  /** ISO time issue comments are listed from (fixed per watch so the URL, and its ETag, stay the same). */
  since: string;
  maxIds: Record<CommentKind, number>;
}

interface TeamState {
  polledAt: number;
  /** projectId -> pull number -> row signature. */
  lists: Map<string, Map<number, string>>;
  /** `<projectId>#<number>` -> watch, for the task pull requests being followed. */
  watches: Map<string, Watch>;
}

export interface SyncStats {
  passes: number;
  teamsPolled: number;
  frames: number;
  events: number;
  skippedNoReader: number;
  failures: number;
}

export class GithubSync {
  readonly #o: Required<GithubSyncOptions>;
  readonly #teams = new Map<string, TeamState>();
  readonly #stats: SyncStats = { passes: 0, teamsPolled: 0, frames: 0, events: 0, skippedNoReader: 0, failures: 0 };
  #timer: ReturnType<typeof setInterval> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;

  constructor(options: GithubSyncOptions) {
    this.#o = { ...options, pollMs: options.pollMs ?? 30_000 };
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.pollOnce(), this.#o.pollMs);
    this.#timer.unref?.();
    this.#heartbeat = setInterval(() => this.#o.log.info("github sync heartbeat", { ...this.#stats, teams: this.#teams.size, cache: this.#o.cache.stats() }), 60_000);
    this.#heartbeat.unref?.();
    this.#o.log.info("github sync started", { pollMs: this.#o.pollMs });
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#timer = this.#heartbeat = null;
    await this.#running;
  }

  stats(): SyncStats {
    return { ...this.#stats };
  }

  /** One pass over every active team. A pass still running is joined, never overlapped. */
  pollOnce(): Promise<void> {
    this.#running ??= this.#pass().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** Something changed on GitHub (a write made here, or later a webhook): tell the team's viewers now. */
  noteChanged(teamId: string, projectId: string, pulls: number[], list: boolean): void {
    this.#stats.frames++;
    this.#o.publish(teamId, { kind: "github.changed", teamId, data: { projectId, pulls: pulls.slice(0, 100), list, at: this.#o.now() } });
  }

  async #pass(): Promise<void> {
    this.#stats.passes++;
    const teams = [...new Set(this.#o.activeTeamIds())].slice(0, MAX_TEAMS_PER_PASS);
    for (const teamId of teams) {
      try {
        await this.#pollTeam(teamId);
      } catch (error) {
        this.#stats.failures++;
        this.#o.log.warn("github sync: team poll failed", { teamId, error });
      }
    }
    const cutoff = this.#o.now() - FORGET_AFTER_MS;
    for (const [teamId, state] of this.#teams) if (state.polledAt < cutoff) this.#teams.delete(teamId);
  }

  async #pollTeam(teamId: string): Promise<void> {
    const team = await this.#o.actors.getTeam(teamId);
    if (!team || team.projects.length === 0) {
      this.#teams.delete(teamId);
      return;
    }
    const view = await this.#o.workforce.getView(teamId);
    const reader = await this.#reader(team, Object.values(view.tasks));
    if (!reader) {
      this.#stats.skippedNoReader++;
      return;
    }
    this.#stats.teamsPolled++;
    const prev = this.#teams.get(teamId);
    const state: TeamState = { polledAt: this.#o.now(), lists: new Map(), watches: new Map() };
    for (const project of team.projects.slice(0, MAX_PROJECTS)) {
      const tasks = new Map<string, string>();
      for (const task of Object.values(view.tasks)) if (task.projectId === project.id && !tasks.has(integrationBranch(task.id))) tasks.set(integrationBranch(task.id), task.id);
      const keep = await this.#pollProject(teamId, project, tasks, reader, prev, state);
      // A failed read keeps what we knew, so the next pass still compares against it.
      if (!keep) {
        const old = prev?.lists.get(project.id);
        if (old) state.lists.set(project.id, old);
        for (const [key, watch] of prev?.watches ?? []) if (key.startsWith(`${project.id}#`)) state.watches.set(key, watch);
      }
    }
    this.#teams.set(teamId, state);
  }

  /** Returns false when GitHub could not be read for this project this pass. */
  async #pollProject(
    teamId: string,
    project: ProjectView,
    tasks: Map<string, string>,
    reader: Reader,
    prev: TeamState | undefined,
    state: TeamState,
  ): Promise<boolean> {
    const repo = repoPath(project.repoFullName);
    const params = new URLSearchParams({ state: "all", sort: "updated", direction: "desc", per_page: String(LIST_PAGE) });
    const list = await this.#tryRead(reader, `/repos/${repo}/pulls?${params}`);
    if (!list || list.stale) return false;
    const pulls = parseList(WirePull, list.body);
    const before = prev?.lists.get(project.id);
    const now = new Map(pulls.map((pr) => [pr.number, rowSignature(pr)]));
    state.lists.set(project.id, now);
    const changed = new Set<number>();
    let listChanged = false;
    if (before) {
      for (const [number, sig] of now) {
        if (before.get(number) !== sig) {
          changed.add(number);
          listChanged = true;
        }
      }
      for (const number of before.keys()) if (!now.has(number)) listChanged = true;
    }

    const watched = pulls.filter((pr) => tasks.has(pr.head.ref) && (pullState(pr) === "open" || pullState(pr) === "draft")).slice(0, MAX_WATCHED_PULLS);
    for (const pr of watched) {
      const key = `${project.id}#${pr.number}`;
      const old = prev?.watches.get(key);
      const watch: Watch = old ? { ...old, maxIds: { ...old.maxIds } } : { updatedAt: "", checks: null, since: new Date(this.#o.now() - SINCE_SLACK_MS).toISOString(), maxIds: { comment: 0, review: 0, review_comment: 0 } };
      const checks = await this.#checksSignature(reader, repo, pr);
      if (checks !== null) {
        if (old && old.checks !== null && old.checks !== checks) changed.add(pr.number);
        watch.checks = checks;
      }
      if (watch.updatedAt !== pr.updated_at) {
        const ok = await this.#forwardComments(teamId, project, tasks.get(pr.head.ref)!, pr, reader, repo, watch, old === undefined);
        if (ok) watch.updatedAt = pr.updated_at;
      }
      state.watches.set(key, watch);
    }

    if (changed.size > 0 || listChanged) this.noteChanged(teamId, project.id, [...changed], listChanged);
    return true;
  }

  async #checksSignature(reader: Reader, repo: string, pr: Pull): Promise<string | null> {
    if (!isFullSha(pr.head.sha)) return null;
    const [runs, status] = await Promise.all([
      this.#tryRead(reader, `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`),
      this.#tryRead(reader, `/repos/${repo}/commits/${pr.head.sha}/status?per_page=100`),
    ]);
    if (!runs && !status) return null;
    const checks = toChecks(runs?.body, status?.body);
    return `${pr.head.sha}|${checks.items.map((c) => `${c.name}:${c.state}`).sort().join(",")}`;
  }

  /**
   * New issue comments, reviews and review comments on a task's pull request go on the bus, oldest first. The first
   * look at a pull request only records where it stands (`baseline`). Returns false when GitHub could not be read.
   */
  async #forwardComments(teamId: string, project: ProjectView, taskId: string, pr: Pull, reader: Reader, repo: string, watch: Watch, baseline: boolean): Promise<boolean> {
    const issueParams = new URLSearchParams({ since: watch.since, per_page: "100" });
    const [issue, reviews, reviewComments] = await Promise.all([
      this.#tryRead(reader, `/repos/${repo}/issues/${pr.number}/comments?${issueParams}`),
      this.#tryRead(reader, `/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`),
      this.#tryRead(reader, `/repos/${repo}/pulls/${pr.number}/comments?sort=created&direction=desc&per_page=50`),
    ]);
    if (!issue || !reviews || !reviewComments) return false;
    const { items } = toConversation(issue.body, reviews.body, reviewComments.body);
    const fresh = items.filter((item) => item.id > watch.maxIds[item.kind]);
    for (const item of items) watch.maxIds[item.kind] = Math.max(watch.maxIds[item.kind], item.id);
    if (baseline) return true;
    for (const comment of fresh.slice(-MAX_EVENTS_PER_PULL)) {
      const event: PullCommentEvent = {
        teamId,
        projectId: project.id,
        taskId,
        repoFullName: project.repoFullName,
        pullNumber: pr.number,
        pullUrl: pr.html_url,
        headRef: pr.head.ref,
        comment,
      };
      this.#stats.events++;
      await this.#o.onComment(event).catch((error) => this.#o.log.warn("github sync: comment hand-off failed", { teamId, taskId, pull: pr.number, commentId: comment.id, error }));
    }
    return true;
  }

  /** Whose token reads for this team: a connected viewer first, then creators of unfinished tasks. Null if none can. */
  async #reader(team: TeamRecord, tasks: TaskView[]): Promise<Reader | null> {
    const members = new Set(team.members.map((m) => m.userId));
    const candidates = [...this.#o.viewerIds(team.id), ...tasks.filter((t) => !TERMINAL.has(t.status)).map((t) => t.createdBy)];
    const tried = new Set<string>();
    for (const userId of candidates) {
      if (tried.has(userId) || !members.has(userId)) continue;
      tried.add(userId);
      if (this.#o.cache.budgetLow(userId)) continue;
      const token = await this.#o.token(userId).catch(() => null);
      if (token) return { userId, token };
    }
    return null;
  }

  async #tryRead(reader: Reader, path: string): Promise<CachedRead | null> {
    try {
      return await this.#o.cache.read(reader.userId, reader.token, path);
    } catch (error) {
      this.#o.log.debug("github sync: read failed", { path: path.split("?")[0], error });
      return null;
    }
  }
}

interface Reader {
  userId: string;
  token: string;
}
