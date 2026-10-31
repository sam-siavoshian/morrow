// Commit and push from the web app. A workstream's worktree lives on the VM of the environment whose profile ran
// it, under that environment's Linux user. Reading it (what changed, what is not pushed) runs as that user with no
// token; committing runs as that user too, and pushing runs as root through the mirror with the environment
// OWNER's token, exactly like an agent checkpoint (a VM never sees another member's token). The person clicking is
// recorded as the commit author.
import type { ProjectView, Role, WorktreeChanges } from "@morrow/contracts";
import type { UserRecord } from "../actors/types.ts";
import {
  checkpointWorktree,
  FreestyleIntegrationError,
  isFreestyleConfigured,
  worktreeStatus,
  type CheckpointResult,
  type EnvironmentRecord,
  type WorktreeStatus,
} from "../integrations/freestyle/index.ts";
import { AppError, conflict, featureDisabled, forbidden, notFound } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { NO_OWNER_GITHUB_ACCESS } from "../orchestration/context.ts";
import type { WorkforceApi } from "../orchestration/workforce.ts";

export interface WorktreeTarget {
  vmId: string;
  linuxUser: string;
  repoFullName: string;
  branch: string;
}

/** The VM side, swappable in tests. Defaults to the Freestyle scripts. */
export interface GitWorkPort {
  enabled(): boolean;
  status(target: WorktreeTarget): Promise<WorktreeStatus>;
  commitAndPush(target: WorktreeTarget & { message: string; githubToken: string; author: { name: string; email: string } }): Promise<CheckpointResult>;
}

export const freestyleGitWork: GitWorkPort = {
  enabled: isFreestyleConfigured,
  status: (target) => worktreeStatus(target),
  // Conflict-checked: unmerged paths are never committed and conflict markers are never pushed.
  commitAndPush: (opts) => checkpointWorktree({ ...opts, checkConflicts: true }),
};

export interface WorktreeServiceDeps {
  workforce: Pick<WorkforceApi, "getView">;
  environment: (teamId: string, envId: string) => Promise<EnvironmentRecord | null>;
  getUser: (userId: string) => Promise<UserRecord | null>;
  /** A member's GitHub token; throws when they have none. */
  token: (userId: string) => Promise<string>;
  git?: GitWorkPort;
  now: () => number;
  log: Logger;
  /** A push landed: the branch and the project's pull requests changed on GitHub. */
  onPushed?: (teamId: string, project: ProjectView, branch: string) => void;
}

type Team = { id: string; projects: ProjectView[] };
interface Who {
  userId: string;
  role: Role;
}

const LIVE_LEASE = new Set(["reserved", "spawning", "running"]);

export class WorktreeService {
  readonly #d: WorktreeServiceDeps & { git: GitWorkPort };
  /** `<teamId>:<workstreamId>` with a commit running. One at a time per worktree. */
  readonly #busy = new Set<string>();

  constructor(deps: WorktreeServiceDeps) {
    // `git: undefined` (no test override) must not erase the default.
    this.#d = { ...deps, git: deps.git ?? freestyleGitWork };
  }

  /** What is in the workstream's worktree and not on GitHub yet. Any member may look. */
  async changes(team: Team, taskId: string, workstreamId: string): Promise<WorktreeChanges> {
    const located = await this.#locate(team, taskId, workstreamId);
    const status = await this.#run(() => this.#d.git.status(located.target));
    if (!status.exists) return { state: "missing", headSha: null, unpushed: 0, files: [], truncated: false, agentLive: located.agentLive, checkedAt: this.#d.now() };
    return {
      state: "ready",
      headSha: status.head,
      unpushed: status.unpushed,
      files: status.files,
      truncated: status.truncated,
      agentLive: located.agentLive,
      checkedAt: this.#d.now(),
    };
  }

  /**
   * Commit everything in the worktree (when anything changed) with `message`, authored by the person asking, then
   * push the branch. Same rule as cancel and retry: the task's creator, or an owner or admin.
   */
  async commit(team: Team, taskId: string, workstreamId: string, who: Who, message: string): Promise<{ sha: string; committed: boolean }> {
    const located = await this.#locate(team, taskId, workstreamId);
    if (located.createdBy !== who.userId && who.role !== "owner" && who.role !== "admin") {
      throw forbidden("Only the task's creator or a team admin can commit and push its work.");
    }
    const key = `${team.id}:${workstreamId}`;
    if (this.#busy.has(key)) throw conflict("A commit is already running for this workstream. Wait for it to finish.");
    this.#busy.add(key);
    try {
      const githubToken = await this.#d.token(located.env.ownerUserId).catch(() => null);
      if (!githubToken) throw conflict(NO_OWNER_GITHUB_ACCESS);
      const author = await this.#author(who.userId);
      const result = await this.#run(() => this.#d.git.commitAndPush({ ...located.target, message, githubToken, author }));
      if (result.unresolved.length > 0) {
        const shown = result.unresolved.slice(0, 5).join(", ");
        const more = result.unresolved.length > 5 ? ` and ${result.unresolved.length - 5} more` : "";
        throw conflict(`Nothing was pushed: ${shown}${more} still ${result.unresolved.length === 1 ? "has" : "have"} merge conflicts. Resolve them first.`);
      }
      this.#d.log.info("worktree committed from the web", { teamId: team.id, taskId, workstreamId, committed: result.committed, sha: result.sha });
      this.#d.onPushed?.(team.id, located.project, located.target.branch);
      return { sha: result.sha, committed: result.committed };
    } finally {
      this.#busy.delete(key);
    }
  }

  async #locate(team: Team, taskId: string, workstreamId: string) {
    const view = await this.#d.workforce.getView(team.id);
    const task = view.tasks[taskId];
    const ws = task?.workstreams.find((w) => w.id === workstreamId);
    if (!task || !ws) throw notFound("Workstream not found.");
    const project = team.projects.find((p) => p.id === task.projectId);
    if (!project) throw conflict("This task's project is no longer linked to the team.");
    if (!this.#d.git.enabled()) throw featureDisabled("Agent environments are not configured on this server, so there is no worktree to commit from.");
    // The workstream's current lease, else its newest one.
    const lease =
      (ws.leaseId ? view.leases[ws.leaseId] : undefined) ??
      Object.values(view.leases)
        .filter((l) => l.taskId === taskId && l.workstreamId === workstreamId)
        .sort((a, b) => b.epoch - a.epoch)[0];
    if (!lease) throw conflict("No agent has worked on this workstream yet, so it has no worktree.");
    const profile = view.profiles[lease.profileId];
    const env = profile ? await this.#d.environment(team.id, profile.envId) : null;
    if (!env) throw conflict("The environment that ran this workstream is no longer connected.");
    if (!env.freestyleVmId) throw conflict("The environment that ran this workstream has no VM.");
    if (env.vmState !== "running") throw conflict("The environment that ran this workstream is paused. Resume it on the Workforce page first.");
    return {
      env,
      project,
      createdBy: task.createdBy,
      agentLive: LIVE_LEASE.has(lease.state),
      target: { vmId: env.freestyleVmId, linuxUser: env.linuxUser, repoFullName: project.repoFullName, branch: ws.branch },
    };
  }

  /** The person clicking, as GitHub shows them: their name and their private noreply address. */
  async #author(userId: string): Promise<{ name: string; email: string }> {
    const user = await this.#d.getUser(userId);
    if (!user) throw notFound("User not found.");
    const login = /^[A-Za-z0-9-]{1,39}$/.test(user.login) ? user.login : "unknown";
    const name = (user.name ?? "").replace(/[\0\n\r<>]/g, "").trim().slice(0, 100) || login;
    return { name, email: `${user.githubId}+${login}@users.noreply.github.com` };
  }

  async #run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof FreestyleIntegrationError) throw new AppError(error.apiCode, error.message, { cause: error });
      throw error;
    }
  }
}
