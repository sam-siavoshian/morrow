import { createHash } from "node:crypto";
import { invalidInput } from "./errors.ts";

// Every value that reaches a VM is checked here first, then again by the
// script that receives it. Nothing below is ever spliced into a command string:
// values travel as exec env.

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const LINUX_USER_RE = /^u[a-f0-9]{12}$/;
const NODE_NAME_RE = /^n-[a-f0-9]{12}$/;
const VM_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REPO_FULL_NAME_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const HOME_ROOT = "/home";
export const WORK_DIR_NAME = "work";
export const WORKTREES_DIR_NAME = ".worktrees";
export const NODE_DIR_NAME = "relay-node";
/** Homes of the Relay broker users (`vm/configure-node.sh`). Root-owned, so a broker cannot swap its home. */
export const RELAY_HOME_ROOT = "/var/lib/morrow/relay";

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw invalidInput(`${label} is not a valid id.`);
}

export function assertLinuxUser(value: unknown): asserts value is string {
  if (typeof value !== "string" || !LINUX_USER_RE.test(value)) throw invalidInput("Invalid Linux user name.");
}

export function assertNodeName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !NODE_NAME_RE.test(value)) throw invalidInput("Invalid Relay node name.");
}

export function assertVmSlug(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 63 || !VM_SLUG_RE.test(value)) {
    throw invalidInput("Invalid VM slug.");
  }
}

export function assertAgentName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !AGENT_NAME_RE.test(value)) throw invalidInput("Invalid agent name.");
}

export function assertSha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA_RE.test(value)) throw invalidInput("Invalid commit SHA.");
}

/** `owner/name` as GitHub allows it. `.` and `..` match the charset, so they are refused explicitly. */
export function assertRepoFullName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REPO_FULL_NAME_RE.test(value)) throw invalidInput("Invalid repository name.");
  const name = value.split("/")[1] ?? "";
  if (name === "." || name === ".." || name.endsWith(".git")) throw invalidInput("Invalid repository name.");
}

/**
 * Branch names we accept: a strict subset of `git check-ref-format --branch`
 * (the VM script runs that too). No leading `-` (option injection), no `..`,
 * no `@{`, no control characters, no `.lock` components.
 */
export function assertBranch(value: unknown): asserts value is string {
  const ok =
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
  if (!ok) throw invalidInput("Invalid branch name.");
}

/** Deterministic, so a crash between create and persist finds the same VM again. */
export function vmSlugFor(teamId: string, envId: string): string {
  assertId(teamId, "teamId");
  assertId(envId, "envId");
  return `morrow-${digest(`${teamId}/${envId}`, 24)}`;
}

/** One Linux account per engineer. Hex digest keeps it clear of every system account name. */
export function linuxUserFor(ownerUserId: string): string {
  assertId(ownerUserId, "ownerUserId");
  return `u${digest(`user/${ownerUserId}`, 12)}`;
}

/** Relay node names are workspace-wide and can never be reused by an agent; derive, never accept. */
export function nodeNameFor(teamId: string, envId: string): string {
  assertId(teamId, "teamId");
  assertId(envId, "envId");
  return `n-${digest(`node/${teamId}/${envId}`, 12)}`;
}

/** Freestyle caps metadata values at 63 chars; long ids are replaced by a stable digest. */
export function metadataValue(id: string): string {
  return id.length <= 63 ? id : `h-${digest(id, 40)}`;
}

export function homeDir(linuxUser: string): string {
  assertLinuxUser(linuxUser);
  return `${HOME_ROOT}/${linuxUser}`;
}

/** `owner__name`: unique across owners, and never a dotfile. */
export function repoDirName(repoFullName: string): string {
  assertRepoFullName(repoFullName);
  return repoFullName.replace("/", "__");
}

export function repoPath(linuxUser: string, repoFullName: string): string {
  return `${homeDir(linuxUser)}/${WORK_DIR_NAME}/${repoDirName(repoFullName)}`;
}

/**
 * Worktrees live beside, not inside, the main checkout so they never show up as
 * untracked files in it. The digest suffix keeps `a/b` and `a-b` apart.
 */
export function worktreePath(linuxUser: string, repoFullName: string, branch: string): string {
  assertBranch(branch);
  const slug = branch.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  return `${homeDir(linuxUser)}/${WORK_DIR_NAME}/${WORKTREES_DIR_NAME}/${repoDirName(repoFullName)}/${slug}-${digest(branch, 8)}`;
}

/**
 * The Linux user the engineer's Relay broker runs as (`r` + the engineer's id). The broker holds the team's
 * workspace key and hands it to every CLI it spawns, so it is not the engineer's user: the CLIs run as the
 * engineer, who cannot read the broker's processes or files (`vm/configure-node.sh`, `vm/relay-worker.sh`).
 */
export function relayUserFor(linuxUser: string): string {
  assertLinuxUser(linuxUser);
  return `r${linuxUser.slice(1)}`;
}

/** The broker's working directory, in its own home. */
export function nodeDir(linuxUser: string): string {
  return `${RELAY_HOME_ROOT}/${relayUserFor(linuxUser)}/${NODE_DIR_NAME}`;
}

/** Where the Relay broker writes a worker's PTY log (cwd-relative to `node up`). Owned by the broker's user. */
export function workerLogPath(linuxUser: string, agentName: string): string {
  assertAgentName(agentName);
  return `${nodeDir(linuxUser)}/.agentworkforce/relay/team/worker-logs/${agentName}.log`;
}

const SECRET_RE = /^[A-Za-z0-9_-]{16,512}$/;
const URL_CHARS_RE = /^[A-Za-z0-9._~:/?#@!&()*+,;=%-]+$/;

/** Relay workspace keys are opaque tokens; anything else must not reach an env file. */
export function assertRelayKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SECRET_RE.test(value)) throw invalidInput("Invalid Relay workspace key.");
}

/** GitHub OAuth/App tokens: opaque, no whitespace. */
export function assertGithubToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{20,512}$/.test(value)) throw invalidInput("Invalid GitHub token.");
}

/** An https origin with no characters a systemd EnvironmentFile would interpret. */
export function assertRelayBaseUrl(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 512 || !URL_CHARS_RE.test(value)) {
    throw invalidInput("Invalid Relay base URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput("Invalid Relay base URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw invalidInput("Relay base URL must be https.");
}
