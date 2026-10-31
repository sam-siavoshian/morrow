import { randomBytes } from "node:crypto";
import type { Vm } from "freestyle";
import { FreestyleIntegrationError, isFreestyleStatus, toIntegrationError } from "./errors.ts";
import { lastJsonLine, requireSuccess, runScript, type ScriptOutcome } from "./exec.ts";
import { assertBranch, assertGithubToken, assertLinuxUser, assertRepoFullName } from "./names.ts";

export const CRED_DIR = "/var/lib/morrow/cred";
export const CLONE_TIMEOUT_MS = 300_000;
export const SYNC_TIMEOUT_MS = 240_000;

/**
 * Runs `fn` with the GitHub token in a fresh root-only file (`CRED_DIR` is 0700 root), written over the
 * Freestyle file API, so the token is in no process environment and no argv on the VM. `fn` gets the
 * file name for git.sh's `CRED_NAME`. The script deletes the file on exit; this deletes it again in case
 * the exec was killed first. Null token: no file, public repos only.
 */
export async function withGithubCredential<T>(vm: Vm, token: string | null, fn: (credName: string) => Promise<T>): Promise<T> {
  if (token === null) return fn("");
  assertGithubToken(token);
  const name = `cred.${randomBytes(16).toString("hex")}`;
  const path = `${CRED_DIR}/${name}`;
  try {
    await vm.fs.writeFile(path, token, { mode: 0o600 });
  } catch (error) {
    throw toIntegrationError(error, "Prepare GitHub access");
  }
  try {
    return await fn(name);
  } finally {
    await removeCredential(vm, path);
  }
}

async function removeCredential(vm: Vm, path: string): Promise<void> {
  try {
    await vm.fs.remove(path);
  } catch (error) {
    if (isFreestyleStatus(error, 404)) return;
    // git.sh also sweeps files older than 15 min on every root run; still, say it loudly.
    throw new FreestyleIntegrationError("exec_failed", "Could not remove a credential file on the VM.", { retryable: true, cause: error });
  }
}

/** The owner's GitHub account cannot read or push the repo (or has no token for a private one). */
export function githubAccessDenied(repoFullName: string): FreestyleIntegrationError {
  return new FreestyleIntegrationError(
    "dependency_rejected",
    `GitHub denied access to ${repoFullName} for this environment's owner. They need to sign in again or be given access to the repository.`,
  );
}

function gitReason(outcome: ScriptOutcome, step: string): string | null {
  const reason = (lastJsonLine(outcome.stdout, step) as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

function throwForReason(reason: string | null, repoFullName: string, step: string): void {
  if (reason === null) return;
  if (reason === "auth") throw githubAccessDenied(repoFullName);
  throw new FreestyleIntegrationError("exec_failed", `${step} could not reach GitHub.`, { retryable: true });
}

/**
 * GitHub -> the root-owned mirror of `owner/name` for this engineer, with the given owner's token.
 * Engineer repos and worktrees fetch from the mirror; they never see the token.
 */
export async function syncMirror(vm: Vm, opts: { linuxUser: string; repoFullName: string; githubToken: string | null }): Promise<void> {
  assertLinuxUser(opts.linuxUser);
  assertRepoFullName(opts.repoFullName);
  const step = `Sync ${opts.repoFullName}`;
  const outcome = await withGithubCredential(vm, opts.githubToken, async (credName) =>
    requireSuccess(
      await runScript(vm, {
        user: "root",
        script: "git",
        timeoutMs: SYNC_TIMEOUT_MS,
        step,
        env: { OP: "sync", MORROW_USER: opts.linuxUser, REPO_FULL_NAME: opts.repoFullName, CRED_NAME: credName },
      }),
      step,
    ),
  );
  throwForReason(gitReason(outcome, step), opts.repoFullName, step);
}

/**
 * Sync the mirror, then clone it into /home/<user>/work/owner__name as the engineer (root never writes in
 * the home). Idempotent: an existing checkout is left alone.
 */
export async function cloneRepo(vm: Vm, opts: { linuxUser: string; repoFullName: string; githubToken: string | null }): Promise<{ cloned: boolean }> {
  assertLinuxUser(opts.linuxUser);
  assertRepoFullName(opts.repoFullName);
  const step = `Clone ${opts.repoFullName}`;
  const outcome = await withGithubCredential(vm, opts.githubToken, async (credName) =>
    requireSuccess(
      await runScript(vm, {
        user: "root",
        script: "git",
        timeoutMs: CLONE_TIMEOUT_MS,
        step: `clone ${opts.repoFullName}`,
        env: { OP: "clone", MORROW_USER: opts.linuxUser, REPO_FULL_NAME: opts.repoFullName, CRED_NAME: credName },
      }),
      `clone ${opts.repoFullName}`,
    ),
  );
  throwForReason(gitReason(outcome, step), opts.repoFullName, step);
  const result = lastJsonLine(outcome.stdout, "clone") as { cloned?: unknown };
  return { cloned: result.cloned === true };
}

/**
 * The engineer's `branch` -> mirror -> GitHub, as root with the owner's token. Root reads the branch over
 * a pipe from `git upload-pack` run as the engineer, never by opening their repo. Never force-pushes.
 */
export async function publishBranch(
  vm: Vm,
  opts: { linuxUser: string; repoFullName: string; branch: string; githubToken: string },
): Promise<{ sha: string; pushed: true } | { sha: string; pushed: false; reason: "rejected" | "failed" }> {
  assertLinuxUser(opts.linuxUser);
  assertRepoFullName(opts.repoFullName);
  assertBranch(opts.branch);
  const step = "checkpoint";
  const outcome = await withGithubCredential(vm, opts.githubToken, async (credName) =>
    requireSuccess(
      await runScript(vm, {
        user: "root",
        script: "git",
        timeoutMs: SYNC_TIMEOUT_MS,
        step,
        env: { OP: "publish", MORROW_USER: opts.linuxUser, REPO_FULL_NAME: opts.repoFullName, BRANCH: opts.branch, CRED_NAME: credName },
      }),
      step,
    ),
  );
  const wire = lastJsonLine(outcome.stdout, step) as { sha?: unknown; pushed?: unknown; reason?: unknown };
  if (wire.reason === "auth") throw githubAccessDenied(opts.repoFullName);
  if (typeof wire.sha !== "string" || !/^[0-9a-f]{40,64}$/.test(wire.sha) || typeof wire.pushed !== "boolean") {
    throw new FreestyleIntegrationError("unexpected_output", "Checkpoint returned unexpected output.", { retryable: true });
  }
  if (wire.pushed) return { sha: wire.sha, pushed: true };
  return { sha: wire.sha, pushed: false, reason: wire.reason === "rejected" ? "rejected" : "failed" };
}
