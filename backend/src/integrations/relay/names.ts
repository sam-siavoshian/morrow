import { RelayIntegrationError } from "./errors.ts";

/** The one system identity per workspace that spawns workers and posts system messages. */
export const DISPATCHER_NAME = "dispatcher";
export const OBSERVER_TOKEN_PREFIX = "morrow-observer-";
/** PTY harnesses reject task bodies above this many UTF-8 bytes before launch. */
export const MAX_TASK_BRIEF_BYTES = 14_336;
/** Our cap on text we send; long context goes through files on the branch. */
export const MAX_MESSAGE_TEXT_BYTES = 32_768;

const TEAM_ID = /^[A-Za-z0-9._-]{1,128}$/;
const AGENT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const WORKER_NAME = /^w-[a-z0-9]+(?:-[a-z0-9]+)*-e[1-9][0-9]{0,15}$/;
const NODE_NAME = /^n-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const SHORT = /^[a-z0-9]{1,24}$/;
const ROLE = /^[a-z0-9]{1,16}$/;
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CLI = /^[a-z][a-z0-9-]{0,31}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(field: string, message: string): never {
  throw new RelayIntegrationError("invalid_input", `${field}: ${message}`, { field });
}

function check(re: RegExp, value: unknown, field: string, hint: string): string {
  if (typeof value !== "string" || !re.test(value)) invalid(field, hint);
  return value;
}

export function workspaceNameFor(teamId: string): string {
  return `morrow-${check(TEAM_ID, teamId, "teamId", "must match [A-Za-z0-9._-]{1,128}")}`;
}

export function assertAgentName(name: unknown, field = "name"): string {
  return check(AGENT_NAME, name, field, "must be 1-64 chars of [a-z0-9-], not starting or ending with '-'");
}

export function assertNodeName(name: unknown, field = "node"): string {
  assertAgentName(name, field);
  return check(NODE_NAME, name, field, "must look like n-<envShort>");
}

/**
 * Worker names are workspace-wide and stay taken after release unless deleted, so every lease gets a fresh
 * one: `w-<taskShort>-<role>-e<epoch>`. The `w-` prefix keeps them disjoint from node (`n-`) and human (`h-`)
 * names, since a broker registers an agent under its own node name.
 */
export function workerAgentName(taskShort: string, role: string, epoch: number): string {
  check(SHORT, taskShort, "taskShort", "must be 1-24 chars of [a-z0-9]");
  check(ROLE, role, "role", "must be 1-16 chars of [a-z0-9]");
  if (!Number.isSafeInteger(epoch) || epoch < 1) invalid("epoch", "must be a positive integer");
  return assertWorkerName(`w-${taskShort}-${role}-e${epoch}`);
}

export function assertWorkerName(name: unknown, field = "name"): string {
  assertAgentName(name, field);
  return check(WORKER_NAME, name, field, "must look like w-<taskShort>-<role>-e<epoch>");
}

/** GitHub logins are case-insensitive, so lowercasing keeps one identity per user. */
export function humanAgentName(githubLogin: string): string {
  check(GITHUB_LOGIN, githubLogin, "githubLogin", "is not a valid GitHub login");
  return `h-${githubLogin.toLowerCase()}`;
}

export function projectChannelName(projectShort: string): string {
  return `proj-${check(SHORT, projectShort, "projectShort", "must be 1-24 chars of [a-z0-9]")}`;
}

export function assertChannelName(name: unknown, field = "channel"): string {
  const value = typeof name === "string" && name.startsWith("#") ? name.slice(1) : name;
  return check(CHANNEL, value, field, "must be 1-63 chars of [a-z0-9-]");
}

export function assertCli(cli: unknown): string {
  return check(CLI, cli, "cli", "must be a harness name like claude or codex");
}

export function assertIdempotencyKey(key: unknown): string {
  return check(IDEMPOTENCY_KEY, key, "idempotencyKey", "must be 1-128 chars of [A-Za-z0-9._:-]");
}

export function assertMessageId(id: unknown, field = "messageId"): string {
  return check(MESSAGE_ID, id, field, "is not a Relay message id");
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertMessageText(text: unknown): string {
  if (typeof text !== "string" || text.trim() === "") invalid("text", "must be a non-empty string");
  if (utf8Bytes(text) > MAX_MESSAGE_TEXT_BYTES) invalid("text", `must be at most ${MAX_MESSAGE_TEXT_BYTES} UTF-8 bytes`);
  return text;
}

/** An absolute POSIX path with no traversal segments or control characters. */
export function assertWorkerCwd(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 1024) invalid("workerCwd", "must be an absolute path");
  if (/[\u0000-\u001f\u007f]/.test(path)) invalid("workerCwd", "must not contain control characters");
  if (path.split("/").some((segment) => segment === "." || segment === "..")) invalid("workerCwd", "must not contain . or .. segments");
  return path;
}
