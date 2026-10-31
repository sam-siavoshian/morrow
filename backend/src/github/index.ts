// The GitHub layer, assembled: one conditional-request cache, the per-member service behind the routes, the
// worktree commit/push service, and the background sync that keeps viewers current and feeds review comments to
// the agent loop.
import type { TeamRouteModule } from "../http/app.ts";
import type { AppDeps } from "../http/context.ts";
import { githubTokenFor } from "../http/githubAccess.ts";
import { githubRoutes } from "../http/routes/github.ts";
import type { GithubClient } from "../integrations/github/client.ts";
import type { WorkforceApi } from "../orchestration/workforce.ts";
import type { RealtimeHub } from "../realtime/hub.ts";
import type { TeamRuntimeApi } from "../runtime/types.ts";
import { GithubCache } from "./cache.ts";
import { toReviewComment, type PullCommentEvent } from "./events.ts";
import { GithubService, repoPath } from "./service.ts";
import { GithubSync } from "./sync.ts";
import { WorktreeService, type GitWorkPort } from "./worktrees.ts";
import type { ReviewCommentEvent } from "../orchestration/comms.ts";

export interface GithubLayer {
  routes: TeamRouteModule;
  service: GithubService;
  worktrees: WorktreeService;
  sync: GithubSync;
  cache: GithubCache;
  start(): void;
  stop(): Promise<void>;
}

export interface GithubLayerInput {
  deps: Pick<AppDeps, "actors" | "keys" | "log" | "now"> & {
    github: Pick<GithubClient, "conditionalGet" | "write" | "graphql">;
    hub: Pick<RealtimeHub, "viewerIds" | "publish">;
    runtime: Pick<TeamRuntimeApi, "environment" | "activeTeamIds">;
  };
  workforce: Pick<WorkforceApi, "getView">;
  /** Orchestration's `comms.reviewComment`: tells the task's workers about a new comment. */
  reviewComment: (event: ReviewCommentEvent) => Promise<unknown>;
  options?: { pollMs?: number; git?: GitWorkPort };
}

export function createGithubLayer(input: GithubLayerInput): GithubLayer {
  const { deps, workforce } = input;
  const log = deps.log.child({ mod: "github" });
  const token = (userId: string) => githubTokenFor(deps, userId);
  const cache = new GithubCache({ get: (t, path, etag) => deps.github.conditionalGet(t, path, etag), now: deps.now });

  // Declared first: the services tell viewers about their writes through it.
  let sync: GithubSync | null = null;
  const service = new GithubService({
    client: deps.github,
    cache,
    token,
    workforce,
    now: deps.now,
    onWrite: (teamId, projectId, number) => sync?.noteChanged(teamId, projectId, [number], true),
  });
  const worktrees = new WorktreeService({
    workforce,
    environment: (teamId, envId) => deps.runtime.environment(teamId, envId),
    getUser: (userId) => deps.actors.getUser(userId),
    token,
    git: input.options?.git,
    now: deps.now,
    log,
    onPushed: (teamId, project) => {
      // The branch moved: comparisons and pull requests (their head) are stale for everyone.
      const repo = repoPath(project.repoFullName);
      cache.invalidate(`/repos/${repo}/compare/`);
      cache.invalidate(`/repos/${repo}/pulls`);
      sync?.noteChanged(teamId, project.id, [], true);
    },
  });
  sync = new GithubSync({
    cache,
    actors: deps.actors,
    workforce,
    activeTeamIds: () => deps.runtime.activeTeamIds(),
    viewerIds: (teamId) => deps.hub.viewerIds(teamId),
    publish: (teamId, frame) => void deps.hub.publish(teamId, frame),
    onComment: (event: PullCommentEvent) => input.reviewComment(toReviewComment(event)).then(() => undefined),
    token,
    log,
    now: deps.now,
    pollMs: input.options?.pollMs,
  });

  return {
    routes: githubRoutes({ service, worktrees, workforce }),
    service,
    worktrees,
    sync,
    cache,
    start: () => sync!.start(),
    stop: () => sync!.stop(),
  };
}
