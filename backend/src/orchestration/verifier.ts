// Verification once every workstream is done. A task passes only when:
//  1. every workstream's SHA exists on GitHub,
//  2. all of them merge cleanly into `morrow/<taskShort>/integration` (created from the default branch, never
//     force-reset) and the pull request to the default branch is mergeable,
//  3. the project's test command exits 0 on that branch in a separate worktree on a ready VM (5 min budget).
// When GitHub or Freestyle is unavailable the check fails as "unverified: <reason>". Nothing passes silently.
// Transient errors retry a few times before they count as unverified.
// A merge conflict (a workstream branch into the integration branch, or the pull request into the default branch)
// does not fail the task at once: the actor opens a bounded resolution step (`resolveConflict`) and a resolver
// worker merges and pushes the integration branch, then this runs again.
import { APP_NAME, type ProfileView } from "@morrow/contracts";
import { FreestyleIntegrationError } from "../integrations/freestyle/index.ts";
import { GithubError } from "../integrations/github/client.ts";
import { redactSecrets } from "../runtime/inspect.ts";
import { conflictBrief, conflictFileList } from "./brief.ts";
import { isCompare, shippedWorkstreams } from "./compare.ts";
import { describeFailure, findProject, isRetryable, memberGithubToken, NO_OWNER_GITHUB_ACCESS, ownerGithubToken, repoWebUrl, safeReason, teamEnvironments, vmTarget, type Ctx } from "./context.ts";
import { digest, integrationBranch, isResolver } from "./names.ts";
import type { ConflictInput, TaskRecord, VerificationInput } from "./workforce.ts";

type Check = VerificationInput["checks"][number];
type Project = { repoFullName: string; defaultBranch: string; testCommand: string | null };
type Workstream = TaskRecord["workstreams"][number];

/** What the merge check saw when something did not merge: the input for a resolution attempt. */
interface MergeConflict {
  /** The workstream whose branch did not merge; null when the pull request conflicts with the default branch. */
  ws: Workstream | null;
  branch: string;
  sha: string | null;
  merged: Workstream[];
  remaining: Workstream[];
  files: string[];
}

const MAX_TRANSIENT_ATTEMPTS = 3;
const MERGEABLE_POLLS = 4;
const MERGEABLE_POLL_MS = 2_000;
const OUTPUT_TAIL = 1_500;

/** A failure worth retrying (GitHub or a VM briefly unavailable). */
class RetryLater extends Error {}
/** A check failure whose message is our own fixed text, safe for every member to read. */
class CheckFailed extends Error {}

/** GitHub errors in words safe to show the team (GithubError messages are internal). */
function githubFailure(error: unknown): never {
  if (!(error instanceof GithubError)) throw error;
  switch (error.kind) {
    case "unauthorized":
      throw new CheckFailed("GitHub access expired for the task's creator");
    case "forbidden":
      throw new CheckFailed("GitHub denied access to the repository");
    case "not_found":
      throw new CheckFailed("the repository or a branch was not found on GitHub");
    default:
      throw new RetryLater("GitHub is unavailable");
  }
}

const check = (name: string, status: Check["status"], detail: string, url: string | null = null): Check => ({
  name,
  status,
  detail: detail.length <= 2_000 ? detail : `${detail.slice(0, 1_999)}…`,
  url: url && url.length <= 500 ? url : null,
});

export class Verifier {
  readonly #ctx: Ctx;
  readonly #sleep: (ms: number) => Promise<void>;
  /** A task just went to `resolving`: schedule its resolver now instead of on the next pass. */
  onResolving: (teamId: string) => void = () => {};

  constructor(ctx: Ctx, sleep: (ms: number) => Promise<void> = Bun.sleep) {
    this.#ctx = ctx;
    this.#sleep = sleep;
  }

  /** Starts verification for a verifying task unless it is running or waiting out a transient failure. */
  maybeRun(teamId: string, taskId: string): boolean {
    const memory = this.#ctx.memory.team(teamId);
    if ((memory.verifyAfter.get(taskId) ?? 0) > this.#ctx.now()) return false;
    return this.#ctx.lanes.run(teamId, `verify:${taskId}`, () => this.verify(teamId, taskId));
  }

  async verify(teamId: string, taskId: string): Promise<VerificationInput | null> {
    const ctx = this.#ctx;
    const memory = ctx.memory.team(teamId);
    const task = await ctx.wf.getTask(teamId, taskId);
    if (!task || task.status !== "verifying") return null;
    // The actor never lets a compare task verify without a pick; never merge every attempt if that ever changed.
    if (isCompare(task) && !task.pickedWorkstreamId) return null;
    const attempt = (memory.verifyAttempts.get(taskId) ?? 0) + 1;

    let checks: Check[];
    let conflict: MergeConflict | null;
    try {
      ({ checks, conflict } = await this.#checks(teamId, task, attempt >= MAX_TRANSIENT_ATTEMPTS));
    } catch (error) {
      if (!(error instanceof RetryLater)) throw error;
      memory.verifyAttempts.set(taskId, attempt);
      memory.verifyAfter.set(taskId, ctx.now() + ctx.timing.verifyRetryMs);
      ctx.log.warn("verification will retry", { teamId, taskId, attempt, reason: error.message });
      return null;
    }
    memory.verifyAttempts.delete(taskId);
    memory.verifyAfter.delete(taskId);

    const evidence: VerificationInput = { status: checks.some((c) => c.status === "failed") ? "failed" : "passed", checks };
    if (evidence.status === "failed" && conflict && (await this.#resolve(teamId, task, evidence, conflict))) return evidence;
    // `updatedAt` scopes the key to this verifying run: after a retry, identical evidence must still be applied.
    const key = `verify-${taskId}-${task.updatedAt}-${digest(JSON.stringify(evidence))}`;
    const result = await ctx.wf.submitVerification(teamId, taskId, evidence, key);
    ctx.log.info("verification submitted", { teamId, taskId, status: evidence.status, accepted: result.ok });
    return evidence;
  }

  /**
   * Hands a merge conflict to the actor: a resolution attempt (`resolving`) or, with none left, a failure that says
   * why. False when the actor refused it; the caller then submits the evidence as a plain failure.
   */
  async #resolve(teamId: string, task: TaskRecord, evidence: VerificationInput, conflict: MergeConflict): Promise<boolean> {
    const ctx = this.#ctx;
    const project = await findProject(ctx, teamId, task.projectId);
    const integration = integrationBranch(task.id);
    const brief = conflictBrief({
      integrationBranch: integration,
      branch: conflict.branch,
      sha: conflict.sha,
      incoming: conflict.ws,
      merged: conflict.merged,
      remaining: conflict.remaining.map((w) => w.branch),
      files: conflict.files,
      testCommand: project?.testCommand ?? null,
    });
    const input: ConflictInput = {
      branch: conflict.branch,
      workstreamId: conflict.ws?.id ?? null,
      integrationBranch: integration,
      involvedWorkstreamIds: [...(conflict.ws ? [conflict.ws.id] : []), ...conflict.merged.map((w) => w.id)],
      files: conflict.files,
      brief,
    };
    const key = `rc-${task.id}-${task.updatedAt}-${digest(JSON.stringify([evidence, input]))}`;
    const result = await ctx.wf.resolveConflict(teamId, task.id, evidence, input, key);
    if (!result.ok) {
      ctx.log.warn("merge conflict not handed to a resolver", { teamId, taskId: task.id, reason: result.reason });
      return false;
    }
    ctx.log.info("merge conflict", { teamId, taskId: task.id, status: result.status, attempt: result.attempt, files: conflict.files.length });
    if (result.status === "resolving") this.onResolving(teamId);
    return true;
  }

  /** `final`: this is the last try, so transient problems become "unverified" instead of a retry. */
  async #checks(teamId: string, task: TaskRecord, final: boolean): Promise<{ checks: Check[]; conflict: MergeConflict | null }> {
    const ctx = this.#ctx;
    const project = await findProject(ctx, teamId, task.projectId);
    if (!project) return { checks: [check("Project", "failed", "unverified: the project is no longer linked to this team")], conflict: null };
    const token = await memberGithubToken(ctx, task.createdBy);
    if (!token) {
      const detail = "unverified: GitHub access for the task's creator expired. Sign in again and re-run.";
      return {
        checks: [check("Commits on GitHub", "failed", detail), check("Merges cleanly", "failed", detail), await this.#tests(teamId, task, project, false)],
        conflict: null,
      };
    }

    const guarded = async (name: string, fn: () => Promise<Check>): Promise<Check> => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof RetryLater && !final) throw error;
        if (!(error instanceof CheckFailed || error instanceof RetryLater)) ctx.log.warn("verification check failed", { teamId, taskId: task.id, check: name, error });
        const reason = error instanceof CheckFailed || error instanceof RetryLater ? error.message : safeReason(error);
        return check(name, "failed", `unverified: ${reason}`);
      }
    };

    const commits = await guarded("Commits on GitHub", () => this.#commits(token, task, project));
    let conflict: MergeConflict | null = null;
    const found = (c: MergeConflict) => {
      conflict = c;
    };
    const merge =
      commits.status === "passed"
        ? await guarded("Merges cleanly", () => this.#merge(token, task, project, found))
        : check("Merges cleanly", "failed", "unverified: skipped because a workstream commit is missing");
    const tests =
      merge.status === "passed"
        ? await guarded("Tests pass", () => this.#tests(teamId, task, project, true))
        : project.testCommand
          ? check("Tests pass", "failed", "unverified: skipped because the branches do not merge")
          : check("Tests pass", "skipped", "No test command is set for this project.");
    return { checks: [commits, merge, tests], conflict: merge.status === "failed" ? conflict : null };
  }

  async #commits(token: string, task: TaskRecord, project: Project): Promise<Check> {
    const git = this.#ctx.ports.git;
    const missing: string[] = [];
    const shipped = shippedWorkstreams(task);
    for (const ws of shipped) {
      const sha = ws.lastCheckpoint?.sha;
      const exists = sha ? await git.commitExists(token, project.repoFullName, sha).catch(githubFailure) : false;
      if (!exists) missing.push(`${ws.branch}${sha ? ` (${sha.slice(0, 12)})` : " (no commit reported)"}`);
    }
    if (missing.length > 0) return check("Commits on GitHub", "failed", `Not found on GitHub: ${missing.join(", ")}`);
    const only = shipped.length === 1 ? shipped[0]!.lastCheckpoint!.sha : null;
    return check(
      "Commits on GitHub",
      "passed",
      isCompare(task) ? "The picked attempt's commit is on GitHub." : `${shipped.length} workstream commit(s) found on GitHub.`,
      only ? repoWebUrl(this.#ctx, project.repoFullName, `commit/${only}`) : null,
    );
  }

  /** Files changed on both sides since `a` and `b` split: where a merge of the two conflicts. Best effort. */
  async #bothSides(token: string, repo: string, a: string, b: string): Promise<string[]> {
    const git = this.#ctx.ports.git;
    try {
      const [sideB, sideA] = await Promise.all([git.compare(token, repo, a, b), git.compare(token, repo, b, a)]);
      const changedOnB = new Set(sideB.files);
      return conflictFileList(sideA.files.filter((f) => changedOnB.has(f)));
    } catch (error) {
      this.#ctx.log.warn("could not list conflicting files", { repo, error });
      return [];
    }
  }

  async #merge(token: string, task: TaskRecord, project: Project, found: (conflict: MergeConflict) => void): Promise<Check> {
    const git = this.#ctx.ports.git;
    const repo = project.repoFullName;
    const integration = integrationBranch(task.id);
    if ((await git.getBranchHead(token, repo, integration).catch(githubFailure)) === null) {
      const base = await git.getBranchHead(token, repo, project.defaultBranch).catch(githubFailure);
      if (!base) return check("Merges cleanly", "failed", `unverified: the default branch ${project.defaultBranch} was not found`);
      await git.createBranch(token, repo, integration, base).catch(githubFailure);
    }
    // A compare task ships only its picked attempt (and a resolver's merge): the others never touch the integration branch.
    const shipped = shippedWorkstreams(task);
    const planned = shipped.filter((w) => !isResolver(w));
    for (const ws of shipped) {
      const sha = ws.lastCheckpoint!.sha;
      const merged = await git.mergeInto(token, repo, integration, sha, `morrow: merge ${ws.branch}`).catch(githubFailure);
      if (merged === "conflict") {
        const at = planned.indexOf(ws);
        found({
          ws: at === -1 ? null : ws,
          branch: ws.branch,
          sha,
          merged: planned.slice(0, Math.max(0, at)),
          remaining: at === -1 ? [] : planned.slice(at + 1),
          files: await this.#bothSides(token, repo, integration, sha),
        });
        return check("Merges cleanly", "failed", `${ws.branch} conflicts with the other workstreams on ${integration}.`, repoWebUrl(this.#ctx, repo, `tree/${integration}`));
      }
    }
    const pr = await git
      .ensurePullRequest(token, repo, {
        head: integration,
        base: project.defaultBranch,
        title: `${APP_NAME}: ${task.title}`.slice(0, 200),
        body: isCompare(task)
          ? `The picked attempt for task ${task.id}.\n\n${planned.map((w) => `- ${w.title} (${w.branch})`).join("\n")}`
          : `Integration of ${shipped.length} workstream(s) for task ${task.id}.\n\n${shipped.map((w) => `- ${w.title} (${w.branch})`).join("\n")}`,
      })
      .catch(githubFailure);
    let mergeable = pr.mergeable;
    for (let poll = 0; mergeable === null && poll < MERGEABLE_POLLS; poll++) {
      await this.#sleep(MERGEABLE_POLL_MS);
      mergeable = (await git.getPullRequest(token, repo, pr.number).catch(githubFailure)).mergeable;
    }
    if (mergeable === false) {
      // The default branch moved on and conflicts with the task's work: the resolver merges it into the integration branch.
      found({ ws: null, branch: project.defaultBranch, sha: null, merged: planned, remaining: [], files: await this.#bothSides(token, repo, integration, project.defaultBranch) });
      return check("Merges cleanly", "failed", `Pull request #${pr.number} does not merge cleanly into ${project.defaultBranch}.`, pr.url);
    }
    if (mergeable === null) {
      // GitHub has not computed it yet. An integration branch that is not behind the base merges trivially.
      const compare = await git.compare(token, repo, project.defaultBranch, integration).catch(githubFailure);
      if (compare.behindBy > 0) throw new RetryLater("GitHub has not computed whether the pull request merges");
    }
    return check("Merges cleanly", "passed", `All workstreams merge into ${integration}; pull request #${pr.number} is mergeable.`, pr.url);
  }

  async #tests(teamId: string, task: TaskRecord, project: Project, canRun: boolean): Promise<Check> {
    const ctx = this.#ctx;
    if (!project.testCommand) return check("Tests pass", "skipped", "No test command is set for this project.");
    if (!canRun) return check("Tests pass", "failed", "unverified: tests could not run without GitHub access");
    if (!ctx.ports.vm.enabled()) return check("Tests pass", "failed", "unverified: Freestyle is not configured, so tests could not run");

    const view = await ctx.wf.getView(teamId);
    const envs = await teamEnvironments(ctx, teamId);
    // Only machines with a CLI this project is allowed on (the same scope rule as leasing work there).
    const allowed = (p: ProfileView) =>
      p.availability !== "offline" && (p.scopes === "all" || p.scopes.includes(task.projectId)) && envs.get(p.envId)?.phase === "ready";
    // Machines that already ran this task's workstreams first: their owners already hold its code.
    const ranTask = new Set(Object.values(view.leases).filter((l) => l.taskId === task.id).map((l) => view.profiles[l.profileId]?.envId));
    const envIds = [...new Set(Object.values(view.profiles).filter(allowed).map((p) => p.envId))].sort((a, b) => Number(ranTask.has(b)) - Number(ranTask.has(a)));
    if (envIds.length === 0) return check("Tests pass", "failed", "unverified: no ready environment has a CLI allowed on this project, so tests could not run");
    // Output can hold anything the tests print (a teammate's CLI login included): masked, and only with inspection on.
    const showOutput = (await ctx.teams.getTeam(teamId))?.policy.allowInspect === true;
    let noAccess = 0;
    for (const envId of envIds) {
      const vm = await vmTarget(ctx, teamId, envId);
      if (!vm.ok) continue;
      // Only the VM owner's token ever goes to their VM.
      const token = await ownerGithubToken(ctx, vm.env);
      if (!token) {
        noAccess++;
        continue;
      }
      const target = { ...vm.target, repoFullName: project.repoFullName, branch: integrationBranch(task.id) };
      try {
        await ctx.ports.vm.ensureWorktree({ ...target, baseBranch: project.defaultBranch, githubToken: token });
        const run = await ctx.ports.vm.runTests({ ...target, command: project.testCommand, timeoutMs: ctx.timing.testTimeoutMs });
        // Mask the whole output before cutting it, so a cut never splits a token past the redactor.
        const output = redactSecrets(run.output);
        const tail = showOutput ? `\n${output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output}` : "";
        const hidden = showOutput ? "" : " Output is hidden because the team turned off worker inspection.";
        if (run.passed) return check("Tests pass", "passed", `\`${project.testCommand}\` exited 0.${hidden}${tail}`);
        const why = run.timedOut ? `timed out after ${Math.round(ctx.timing.testTimeoutMs / 1000)} s` : `exited ${run.exitCode}`;
        return check("Tests pass", "failed", `\`${project.testCommand}\` ${why}.${hidden}${tail}`);
      } catch (error) {
        if (isRetryable(error)) throw new RetryLater(describeFailure("Test run", error));
        ctx.log.warn("test run failed on environment", { teamId, envId, error });
        if (error instanceof FreestyleIntegrationError && error.kind === "dependency_rejected") noAccess++;
      }
    }
    if (noAccess > 0) return check("Tests pass", "failed", `unverified: no ready environment could run the tests. ${NO_OWNER_GITHUB_ACCESS}`);
    return check("Tests pass", "failed", "unverified: no ready environment could run the tests");
  }
}
