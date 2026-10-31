import {
  CommitWorkBody,
  Id,
  PullCommentBody,
  PullListQuery,
  PullMergeBody,
  PullStateBody,
  type BranchDiffView,
  type BranchView,
  type CommitWorkResponse,
  type ProjectView,
  type PullDetail,
  type PullListResponse,
  type TaskPullResponse,
  type WorktreeChanges,
} from "@morrow/contracts";
import { Hono, type Context } from "hono";
import type { GithubService } from "../../github/service.ts";
import type { WorktreeService } from "../../github/worktrees.ts";
import { badRequest, notFound } from "../../lib/errors.ts";
import type { WorkforceApi } from "../../orchestration/workforce.ts";
import type { TeamRouteModule } from "../app.ts";
import type { AppEnv } from "../context.ts";
import { readJson } from "../errors.ts";
import { rateLimit, requireTeam } from "../middleware.ts";

type C = Context<AppEnv>;

const PULL_NUMBER = /^[1-9]\d{0,9}$/;

function id(c: C, name: "projectId" | "taskId" | "workstreamId", label: string): string {
  const value = c.req.param(name);
  if (!value || !Id.safeParse(value).success) throw notFound(`${label} not found.`);
  return value;
}

/** Only a project linked to this team; anything else is a plain 404. */
function project(c: C): ProjectView {
  const projectId = id(c, "projectId", "Project");
  const found = c.get("team").projects.find((p) => p.id === projectId);
  if (!found) throw notFound("Project not found.");
  return found;
}

function pullNumber(c: C): number {
  const raw = c.req.param("number") ?? "";
  const value = PULL_NUMBER.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value > 2 ** 31 - 1) throw notFound("Pull request not found.");
  return value;
}

const who = (c: C) => ({ teamId: c.get("team").id, userId: c.get("userId") });

export interface GithubRouteDeps {
  service: GithubService;
  worktrees: WorktreeService;
  workforce: Pick<WorkforceApi, "getView">;
}

/**
 * The GitHub layer under /api/teams. Every route: signed in, CSRF-checked for writes (app level), a member of the
 * team (404 otherwise), and on the `github` rate bucket on top of the read/mutation one. GitHub is always called as
 * the signed-in member, so GitHub's permissions apply; repo paths come from the team's linked projects only.
 */
export function githubRoutes(deps: GithubRouteDeps): TeamRouteModule {
  const { service, worktrees } = deps;
  return (teams: Hono<AppEnv>) => {
    const r = new Hono<AppEnv>();
    // Per route, not `r.use`: a sub-app's wildcard middleware would also run for every other module's team routes.
    const member = requireTeam();
    const github = rateLimit("github");

    r.get("/:teamId/projects/:projectId/pulls", member, github, async (c) => {
      const query = PullListQuery.safeParse({ state: c.req.query("state") || undefined });
      if (!query.success) throw badRequest("Unknown pull request filter.");
      const body: PullListResponse = await service.listPulls(who(c), project(c), query.data.state);
      return c.json(body);
    });

    r.get("/:teamId/projects/:projectId/pulls/:number", member, github, async (c) => {
      const body: PullDetail = await service.pullDetail(who(c), project(c), pullNumber(c));
      return c.json(body);
    });

    r.post("/:teamId/projects/:projectId/pulls/:number/comments", member, github, async (c) => {
      const p = project(c);
      const number = pullNumber(c);
      const body = await readJson(c, PullCommentBody);
      await service.comment(who(c), p, number, body.body, body.inReplyTo);
      // Never the body: comments are user content.
      c.get("log").info("pull request comment posted", { projectId: p.id, number, reply: body.inReplyTo !== undefined });
      return c.body(null, 204);
    });

    r.post("/:teamId/projects/:projectId/pulls/:number/merge", member, github, async (c) => {
      const p = project(c);
      const number = pullNumber(c);
      const body = await readJson(c, PullMergeBody);
      await service.merge(who(c), p, number, body.method, body.headSha);
      c.get("log").info("pull request merged", { projectId: p.id, number, method: body.method });
      return c.body(null, 204);
    });

    r.post("/:teamId/projects/:projectId/pulls/:number/ready", member, github, async (c) => {
      const p = project(c);
      const number = pullNumber(c);
      await service.markReady(who(c), p, number);
      c.get("log").info("pull request marked ready", { projectId: p.id, number });
      return c.body(null, 204);
    });

    r.patch("/:teamId/projects/:projectId/pulls/:number", member, github, async (c) => {
      const p = project(c);
      const number = pullNumber(c);
      const body = await readJson(c, PullStateBody);
      await service.setState(who(c), p, number, body.state);
      c.get("log").info("pull request state changed", { projectId: p.id, number, state: body.state });
      return c.body(null, 204);
    });

    r.get("/:teamId/tasks/:taskId/pull", member, github, async (c) => {
      const { task, project: p } = await taskOf(c);
      const body: TaskPullResponse = { projectId: p.id, pull: await service.taskPull(who(c), p, task) };
      return c.json(body);
    });

    r.get("/:teamId/tasks/:taskId/workstreams/:workstreamId/branch", member, github, async (c) => {
      const { task, project: p } = await taskOf(c);
      const workstreamId = id(c, "workstreamId", "Workstream");
      const ws = task.workstreams.find((w) => w.id === workstreamId);
      if (!ws) throw notFound("Workstream not found.");
      const body: BranchView = await service.branch(who(c), p, ws.branch);
      return c.json(body);
    });

    r.get("/:teamId/tasks/:taskId/workstreams/:workstreamId/diff", member, github, async (c) => {
      const { task, project: p } = await taskOf(c);
      const workstreamId = id(c, "workstreamId", "Workstream");
      const ws = task.workstreams.find((w) => w.id === workstreamId);
      if (!ws) throw notFound("Workstream not found.");
      const body: BranchDiffView = await service.diff(who(c), p, ws.branch);
      return c.json(body);
    });

    r.get("/:teamId/tasks/:taskId/workstreams/:workstreamId/changes", member, github, async (c) => {
      const body: WorktreeChanges = await worktrees.changes(c.get("team"), id(c, "taskId", "Task"), id(c, "workstreamId", "Workstream"));
      return c.json(body);
    });

    r.post("/:teamId/tasks/:taskId/workstreams/:workstreamId/commit", member, github, async (c) => {
      const taskId = id(c, "taskId", "Task");
      const workstreamId = id(c, "workstreamId", "Workstream");
      const body = await readJson(c, CommitWorkBody);
      const result: CommitWorkResponse = await worktrees.commit(c.get("team"), taskId, workstreamId, { userId: c.get("userId"), role: c.get("role") }, body.message);
      return c.json(result);
    });

    teams.route("/", r);
  };

  async function taskOf(c: C) {
    const taskId = id(c, "taskId", "Task");
    const view = await deps.workforce.getView(c.get("team").id);
    const task = view.tasks[taskId];
    if (!task) throw notFound("Task not found.");
    const found = c.get("team").projects.find((p) => p.id === task.projectId);
    if (!found) throw notFound("This task's project is no longer linked to the team.");
    return { task, project: found };
  }
}
