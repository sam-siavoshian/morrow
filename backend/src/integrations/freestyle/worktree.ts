import { APP_NAME } from "@morrow/contracts";
import type { Freestyle } from "freestyle";
import { z } from "zod";
import { freestyle } from "./client.ts";
import { FreestyleIntegrationError, invalidInput } from "./errors.ts";
import { lastJsonLine, MAX_EXEC_TIMEOUT_MS, requireSuccess, runScript, tail } from "./exec.ts";
import { assertBranch, assertGithubToken, assertLinuxUser, assertRepoFullName, worktreePath } from "./names.ts";
import { publishBranch, syncMirror } from "./repos.ts";

const WorktreeWire = z.object({
  path: z.string(),
  head: z.string().regex(/^[0-9a-f]{40,64}$/),
  created: z.boolean(),
  state: z.enum(["ok", "dirty", "diverged"]),
});

const CommitWire = z.object({
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  committed: z.boolean(),
  // Paths come from the agent's tree: git quotes odd ones; anything unprintable is dropped below.
  unresolved: z.array(z.string().max(2_000)).max(20).optional(),
});

export interface WorktreeTarget {
  vmId: string;
  linuxUser: string;
  repoFullName: string;
  branch: string;
  client?: Freestyle;
}

export interface WorktreeResult {
  /** Absolute path: pass as Relay `worker_cwd`. */
  path: string;
  head: string;
  created: boolean;
  /** `dirty`/`diverged`: an existing worktree that could not be fast-forwarded; left untouched. */
  state: "ok" | "dirty" | "diverged";
}

/**
 * Refresh the root-owned mirror from GitHub with `githubToken` (the environment owner's), then, as the
 * engineer's user and with no token, fetch the mirror and create the worktree for `branch` (from the local
 * branch, the remote branch, or a new branch off `baseBranch`), or refresh an existing one by
 * fast-forward only.
 */
export async function ensureWorktree(opts: WorktreeTarget & { baseBranch: string; githubToken: string | null }): Promise<WorktreeResult> {
  validateTarget(opts);
  assertBranch(opts.baseBranch);
  if (opts.githubToken !== null) assertGithubToken(opts.githubToken);
  const path = worktreePath(opts.linuxUser, opts.repoFullName, opts.branch);
  const vm = (opts.client ?? freestyle()).vms.ref(opts.vmId);
  await syncMirror(vm, { linuxUser: opts.linuxUser, repoFullName: opts.repoFullName, githubToken: opts.githubToken });
  const outcome = requireSuccess(
    await runScript(vm, {
      user: opts.linuxUser,
      script: "git",
      timeoutMs: 180_000,
      step: "prepare worktree",
      env: {
        OP: "worktree",
        REPO_FULL_NAME: opts.repoFullName,
        BRANCH: opts.branch,
        BASE_BRANCH: opts.baseBranch,
        WT_PATH: path,
      },
    }),
    "prepare worktree",
  );
  const parsed = WorktreeWire.safeParse(lastJsonLine(outcome.stdout, "prepare worktree"));
  if (!parsed.success || parsed.data.path !== path) {
    throw new FreestyleIntegrationError("unexpected_output", "Prepare worktree returned unexpected output.", { retryable: true });
  }
  return parsed.data;
}

export interface CheckpointResult {
  sha: string;
  committed: boolean;
  /**
   * With `checkConflicts`: files with unmerged paths or leftover conflict markers. When non-empty nothing was
   * pushed and `sha` is the local tip.
   */
  unresolved: string[];
}

/**
 * Commit everything in the worktree (if anything changed) as the engineer's user, then publish `branch`
 * to GitHub as root through the mirror with `githubToken` (the environment owner's). Never force-pushes.
 * Retrying is safe: with nothing new to commit it re-pushes the same SHA. The returned SHA is the one
 * pushed (the branch tip when root read it). `checkConflicts` (a conflict resolver's tree): unmerged paths
 * are not committed, and nothing is pushed while a path is unmerged or carries conflict markers.
 */
export async function checkpointWorktree(
  opts: WorktreeTarget & { message: string; githubToken: string; author?: { name: string; email: string }; checkConflicts?: boolean },
): Promise<CheckpointResult> {
  validateTarget(opts);
  assertGithubToken(opts.githubToken);
  const vm = (opts.client ?? freestyle()).vms.ref(opts.vmId);
  const commit = await runCommit(vm, opts, "checkpoint commit", "Checkpoint");
  if (opts.checkConflicts && (commit.unresolved?.length ?? 0) > 0) {
    // Never empty here: an empty list reads as "clean" to callers, and nothing was pushed.
    const shown = commit.unresolved!.filter((path) => /^[\x20-\x7e]{1,300}$/.test(path));
    return { sha: commit.sha, committed: commit.committed, unresolved: shown.length > 0 ? shown : ["(a path git could not print)"] };
  }
  const pushed = await pushOrThrow(vm, opts, "Checkpoint");
  return { sha: pushed, committed: commit.committed, unresolved: [] };
}

export type WorktreeFileStatus = "added" | "modified" | "deleted" | "conflicted";

export interface WorktreeStatusFile {
  path: string;
  status: WorktreeFileStatus;
  /** Null for binary files. */
  additions: number | null;
  deletions: number | null;
}

export type WorktreeStatus =
  | { exists: false }
  | { exists: true; head: string; unpushed: number; files: WorktreeStatusFile[]; truncated: boolean };

/** Most changed files a status lists (the VM also cuts each stream at 32 KiB). */
export const MAX_STATUS_FILES = 500;
const STATUS_STREAM_LIMIT = 32_768;

const StatusWire = z.union([
  z.object({ exists: z.literal(false) }),
  z.object({
    exists: z.literal(true),
    head: z.string().regex(/^[0-9a-f]{40,64}$/),
    unpushed: z.number().int().nonnegative(),
    names: z.string().max(64 * 1024),
    stats: z.string().max(64 * 1024),
    conflicts: z.string().max(64 * 1024),
  }),
]);

/**
 * Read-only, as the engineer's user: what the worktree would commit (vs HEAD, untracked files included) and how
 * many local commits the mirror has not seen yet. Paths come from the agent's tree and are sanitized here.
 */
export async function worktreeStatus(opts: WorktreeTarget): Promise<WorktreeStatus> {
  validateTarget(opts);
  const vm = (opts.client ?? freestyle()).vms.ref(opts.vmId);
  const outcome = requireSuccess(
    await runScript(vm, {
      user: opts.linuxUser,
      script: "git",
      timeoutMs: 30_000,
      step: "worktree status",
      env: { OP: "status", REPO_FULL_NAME: opts.repoFullName, BRANCH: opts.branch, WT_PATH: worktreePath(opts.linuxUser, opts.repoFullName, opts.branch) },
    }),
    "worktree status",
  );
  const parsed = StatusWire.safeParse(lastJsonLine(outcome.stdout, "worktree status"));
  if (!parsed.success) throw new FreestyleIntegrationError("unexpected_output", "Worktree status returned unexpected output.", { retryable: true });
  if (!parsed.data.exists) return { exists: false };
  return { exists: true, head: parsed.data.head, unpushed: parsed.data.unpushed, ...parseStatusStreams(parsed.data) };
}

/** Exported for tests. Turns the VM's base64 NUL-separated `--name-status`, `--numstat` and conflict lists into files. */
export function parseStatusStreams(wire: { names: string; stats: string; conflicts: string }): { files: WorktreeStatusFile[]; truncated: boolean } {
  const names = nulFields(wire.names);
  const stats = nulFields(wire.stats);
  const conflicts = nulFields(wire.conflicts);
  let truncated = names.cut || stats.cut || conflicts.cut;
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  // numstat -z (no renames): "<added>\t<deleted>\t<path>" per record.
  for (const record of stats.fields) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!m) continue;
    counts.set(m[3]!, { additions: m[1] === "-" ? null : Number(m[1]), deletions: m[2] === "-" ? null : Number(m[2]) });
  }
  const conflicted = new Set(conflicts.fields);
  const files: WorktreeStatusFile[] = [];
  const seen = new Set<string>();
  // name-status -z: "<letter>\0<path>\0" pairs.
  for (let i = 0; i + 1 < names.fields.length; i += 2) {
    const letter = names.fields[i]!;
    const raw = names.fields[i + 1]!;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const status: WorktreeFileStatus = conflicted.has(raw) ? "conflicted" : letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
    const count = counts.get(raw) ?? { additions: null, deletions: null };
    files.push({ path: displayPath(raw), status, ...count });
  }
  for (const raw of conflicted) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    files.push({ path: displayPath(raw), status: "conflicted", additions: null, deletions: null });
  }
  if (files.length > MAX_STATUS_FILES) truncated = true;
  return { files: files.slice(0, MAX_STATUS_FILES), truncated };
}

/** NUL-separated fields of a base64 stream; a stream the VM cut drops its last (partial) field. */
function nulFields(b64: string): { fields: string[]; cut: boolean } {
  const bytes = Buffer.from(b64, "base64");
  const cut = bytes.length > STATUS_STREAM_LIMIT;
  const text = bytes.subarray(0, Math.min(bytes.length, STATUS_STREAM_LIMIT)).toString("utf8");
  const fields = text.split("\0");
  // A complete stream ends with NUL, leaving one empty trailing field; a cut one leaves a partial field.
  fields.pop();
  return { fields, cut };
}

/** A path from the agent's tree, safe to show: no control or bidi characters, bounded. */
function displayPath(raw: string): string {
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "\ufffd");
  return clean.length > 500 ? `${clean.slice(0, 499)}\u2026` : clean;
}

async function runCommit(
  vm: ReturnType<Freestyle["vms"]["ref"]>,
  opts: WorktreeTarget & { message: string; author?: { name: string; email: string }; checkConflicts?: boolean },
  step: string,
  label: string,
): Promise<z.infer<typeof CommitWire>> {
  const message = opts.message.replace(/\0/g, "").trim();
  if (!message || message.length > 2_000) throw invalidInput("Invalid commit message.");
  const author = opts.author ?? { name: APP_NAME, email: "agent@morrow.invalid" };
  if (!/^[^\0\n<>]{1,100}$/.test(author.name) || !/^[^\0\n<>\s]{3,200}$/.test(author.email)) throw invalidInput("Invalid commit author.");
  const outcome = requireSuccess(
    await runScript(vm, {
      user: opts.linuxUser,
      script: "git",
      timeoutMs: 120_000,
      step,
      env: {
        OP: "commit",
        BRANCH: opts.branch,
        WT_PATH: worktreePath(opts.linuxUser, opts.repoFullName, opts.branch),
        MESSAGE: message,
        AUTHOR_NAME: author.name,
        AUTHOR_EMAIL: author.email,
        ...(opts.checkConflicts ? { CHECK_CONFLICTS: "1" } : {}),
      },
    }),
    step,
  );
  const commit = CommitWire.safeParse(lastJsonLine(outcome.stdout, step));
  if (!commit.success) throw new FreestyleIntegrationError("unexpected_output", `${label} returned unexpected output.`, { retryable: true });
  return commit.data;
}

async function pushOrThrow(vm: ReturnType<Freestyle["vms"]["ref"]>, opts: WorktreeTarget & { githubToken: string }, label: string): Promise<string> {
  const pushed = await publishBranch(vm, { linuxUser: opts.linuxUser, repoFullName: opts.repoFullName, branch: opts.branch, githubToken: opts.githubToken });
  if (!pushed.pushed) {
    const rejected = pushed.reason === "rejected";
    throw new FreestyleIntegrationError(
      rejected ? "conflict" : "exec_failed",
      rejected ? `${label} push was rejected: the branch moved on GitHub.` : `${label} push failed.`,
      { retryable: !rejected, detail: { sha: pushed.sha } },
    );
  }
  return pushed.sha;
}

export interface TestRunResult {
  exitCode: number;
  passed: boolean;
  timedOut: boolean;
  /** Last `maxOutputBytes` of combined stdout/stderr. */
  output: string;
  truncated: boolean;
}

const TestMetaWire = z.object({ exitCode: z.number().int(), timedOut: z.boolean(), bytes: z.number().int().nonnegative() });

/**
 * Run the project's test command (an untrusted, user-configured string) in the
 * worktree as the engineer's user. It is passed as env and run by `bash -lc`;
 * it never becomes part of the exec command. Output is bounded on the VM.
 */
export async function runTestCommand(
  opts: WorktreeTarget & { command: string; timeoutMs: number; maxOutputBytes?: number },
): Promise<TestRunResult> {
  validateTarget(opts);
  const command = opts.command.trim();
  if (!command || command.length > 2_000 || command.includes("\0")) throw invalidInput("Invalid test command.");
  const slackMs = 15_000;
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1_000 || opts.timeoutMs > MAX_EXEC_TIMEOUT_MS - slackMs) {
    throw invalidInput("Invalid test timeout.");
  }
  const maxOutputBytes = opts.maxOutputBytes ?? 64 * 1024;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 256 * 1024) throw invalidInput("Invalid output limit.");
  const vm = (opts.client ?? freestyle()).vms.ref(opts.vmId);
  const outcome = await runScript(vm, {
    user: opts.linuxUser,
    script: "run-test",
    timeoutMs: opts.timeoutMs + slackMs,
    step: "test run",
    env: {
      WT_PATH: worktreePath(opts.linuxUser, opts.repoFullName, opts.branch),
      TEST_CMD: command,
      TEST_TIMEOUT_SECS: String(Math.ceil(opts.timeoutMs / 1000)),
      MAX_OUTPUT_BYTES: String(maxOutputBytes),
    },
  });
  if (outcome.statusCode === null) {
    return { exitCode: 124, passed: false, timedOut: true, output: tail(outcome.stdout, maxOutputBytes), truncated: true };
  }
  const meta = TestMetaWire.safeParse(safeJson(outcome.stderr.trimEnd().split("\n").at(-1) ?? ""));
  if (outcome.statusCode !== 0 || !meta.success) {
    throw new FreestyleIntegrationError("exec_failed", "Could not run the test command on the VM.", {
      retryable: true,
      detail: { statusCode: outcome.statusCode, stderr: tail(outcome.stderr, 512) },
    });
  }
  const output = tail(outcome.stdout, maxOutputBytes);
  return {
    exitCode: meta.data.exitCode,
    passed: meta.data.exitCode === 0,
    timedOut: meta.data.timedOut,
    output,
    truncated: meta.data.bytes > Buffer.byteLength(output, "utf8"),
  };
}

function validateTarget(opts: WorktreeTarget): void {
  assertLinuxUser(opts.linuxUser);
  assertRepoFullName(opts.repoFullName);
  assertBranch(opts.branch);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(opts.vmId)) throw invalidInput("Invalid VM id.");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
