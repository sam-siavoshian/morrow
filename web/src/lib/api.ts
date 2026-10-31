import {
  ApiError as ApiErrorBody,
  ArtifactsView,
  BranchDiffView,
  BranchView,
  CancelTaskResponse,
  CommitWorkResponse,
  CSRF_HEADER,
  CreateInviteResponse,
  DeleteTaskResponse,
  EnvironmentView,
  Id,
  InviteListResponse,
  PickAttemptResponse,
  PlanAcceptedResponse,
  ProfileCheckResponse,
  ProfileView,
  ProjectView,
  PullDetail,
  PullListResponse,
  RealtimeTicketResponse,
  ReposResponse,
  RetryTaskResponse,
  StartTaskResponse,
  TaskDetail,
  TaskMessageResponse,
  TaskPullResponse,
  TeamView,
  TerminalTokenResponse,
  WorkerLogResponse,
  WorkforceEnvironmentView,
  WorkforceResponse,
  WorktreeChanges,
  type AssignableRole,
  type CreateEnvironmentBody,
  type CreateTaskBody,
  type ErrorCode,
  type LinkProjectBody,
  type PullCommentBody,
  type PullMergeBody,
  type PullStateBody,
  type PullStateFilter,
  type RegisterProfileBody,
  type ReplanBody,
  type StartTaskBody,
  type TaskMessageBody,
  type UpdatePolicyBody,
  type UpdateProfileBody,
  type UpdateProjectBody,
} from "@morrow/contracts";
import type { z } from "zod";

/** Server codes plus the failures that never reach the server's error mapper. */
export type ApiErrorCode = ErrorCode | "network_error" | "bad_response";

const MAX_MESSAGE_LENGTH = 300;

/** The only error the client throws. `message` is safe to show; nothing else from the server is. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Seconds to wait, from `retry-after` on a 429. */
  readonly retryAfter: number | null;

  constructor(code: ApiErrorCode, message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

/** What to show for a failed call: the ApiError's safe message, else `fallback`. Never a raw error. */
export const errorMessage = (error: unknown, fallback: string): string => (isApiError(error) ? error.message : fallback);

const FALLBACK: Record<number, [ErrorCode, string]> = {
  400: ["bad_request", "That request was not valid."],
  401: ["unauthenticated", "Your session ended. Sign in again."],
  403: ["forbidden", "You do not have access to that."],
  404: ["not_found", "Not found."],
  409: ["conflict", "That changed while you were working. Try again."],
  429: ["rate_limited", "Too many requests. Wait a moment and try again."],
  503: ["dependency_unavailable", "A service we depend on is unavailable. Try again shortly."],
};

/** The stock message for a status we have no words for: what failed and what to do, never the raw body. */
const serverFailure = (status: number) => `The server could not finish that request (error ${status}). Try again in a moment.`;

function retryAfterOf(res: Response): number | null {
  const value = Number(res.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Maps a failed response to an ApiError. Unrecognised bodies never leak: they get a stock message. */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const parsed = ApiErrorBody.safeParse(body);
  if (parsed.success) {
    const { code, message } = parsed.data.error;
    return new ApiError(code, message.slice(0, MAX_MESSAGE_LENGTH), res.status, retryAfterOf(res));
  }
  const [code, message] = FALLBACK[res.status] ?? ["internal", serverFailure(res.status)];
  return new ApiError(code, message, res.status, retryAfterOf(res));
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

type RequestOptions<S extends z.ZodType | null> = {
  schema: S;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
};

/**
 * Same-origin JSON request to the backend (proxied by the `/api` rewrite). Mutations carry the CSRF
 * header; the browser adds Origin. Responses are parsed with the contracts schema, so a backend
 * drift fails loudly here instead of deep inside a screen.
 */
async function request<S extends z.ZodType | null>(
  method: Method,
  path: string,
  { schema, body, query, signal }: RequestOptions<S>,
): Promise<S extends z.ZodType ? z.infer<S> : void> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") search.set(k, String(v));
  const url = search.size > 0 ? `${path}?${search}` : path;

  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers[CSRF_HEADER] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError("network_error", "Can't reach the server. Check your connection.", 0);
  }

  if (!res.ok) throw await toApiError(res);
  if (schema === null) return undefined as never;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("bad_response", "The server sent a response we could not read.", res.status);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("bad_response", "The server sent a response we could not read.", res.status);
  return parsed.data as never;
}

/**
 * One path segment from an id. Rejects anything that is not a plain id, including `.` and `..`.
 * Every endpoint function is async, so this surfaces as a rejected promise like any other ApiError.
 */
function seg(value: string): string {
  if (!Id.safeParse(value).success || /^\.+$/.test(value)) throw new ApiError("bad_request", "That link is not valid.", 0);
  return encodeURIComponent(value);
}

const team = (teamId: string) => `/api/teams/${seg(teamId)}`;
type Opts = { signal?: AbortSignal };

// ---------- auth ----------

/** Same-site paths only (no `//host`, no backslashes, no control characters); anything else is null. */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || value.length > 512 || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/** The sign-in page, coming back to `returnTo` afterwards. */
export function loginPath(returnTo?: string | null): string {
  const safe = safeReturnTo(returnTo);
  return safe ? `/login?returnTo=${encodeURIComponent(safe)}` : "/login";
}

/** Full-page navigation target for "Sign in with GitHub". */
export function signInUrl(returnTo?: string | null): string {
  const safe = safeReturnTo(returnTo);
  return safe ? `/api/auth/github?returnTo=${encodeURIComponent(safe)}` : "/api/auth/github";
}

export const logout = async (options: { everywhere?: boolean } = {}) =>
  request("POST", "/api/auth/logout", { schema: null, query: { everywhere: options.everywhere ? 1 : undefined } });

// ---------- teams, invites, members ----------

export const createTeam = async (name: string) => request("POST", "/api/teams", { schema: TeamView, body: { name } });

export const getTeam = async (teamId: string, o: Opts = {}) => request("GET", team(teamId), { schema: TeamView, ...o });

/** Owner or admin. The slug never changes. */
export const renameTeam = async (teamId: string, name: string) => request("PATCH", team(teamId), { schema: TeamView, body: { name } });

/** Owner or admin. Send only what changed; the server merges it. */
export const updatePolicy = async (teamId: string, patch: UpdatePolicyBody) =>
  request("PATCH", `${team(teamId)}/policy`, { schema: TeamView, body: patch });

export const createInvite = async (teamId: string, body: { maxUses?: number; expiresInHours?: number } = {}) =>
  request("POST", `${team(teamId)}/invites`, { schema: CreateInviteResponse, body });

/** Owner or admin: invites that still work. Never the link itself. */
export const listInvites = async (teamId: string, o: Opts = {}) =>
  request("GET", `${team(teamId)}/invites`, { schema: InviteListResponse, ...o });

export const revokeInvite = async (teamId: string, inviteId: string) =>
  request("DELETE", `${team(teamId)}/invites/${seg(inviteId)}`, { schema: null });

/** `token` is the `/join/<token>` path segment. */
export const acceptInvite = async (token: string) => request("POST", "/api/invites/accept", { schema: TeamView, body: { token } });

/** Owner only. The owner's own role never changes. */
export const setMemberRole = async (teamId: string, userId: string, role: AssignableRole) =>
  request("PATCH", `${team(teamId)}/members/${seg(userId)}`, { schema: TeamView, body: { role } });

export const removeMember = async (teamId: string, userId: string) =>
  request("DELETE", `${team(teamId)}/members/${seg(userId)}`, { schema: null });

// ---------- repos and projects ----------

export const listRepos = async (params: { page?: number; perPage?: number; q?: string } = {}, o: Opts = {}) =>
  request("GET", "/api/github/repos", { schema: ReposResponse, query: params, ...o });

export const linkProject = async (teamId: string, body: { repoFullName: string; testCommand?: LinkProjectBody["testCommand"] }) =>
  request("POST", `${team(teamId)}/projects`, { schema: ProjectView, body });

export const unlinkProject = async (teamId: string, projectId: string) =>
  request("DELETE", `${team(teamId)}/projects/${seg(projectId)}`, { schema: null });

/** Owner or admin. Null clears the test command. Answers with the updated team. */
export const updateProject = async (teamId: string, projectId: string, body: UpdateProjectBody) =>
  request("PATCH", `${team(teamId)}/projects/${seg(projectId)}`, { schema: TeamView, body });

// ---------- environments ----------

export const createEnvironment = async (teamId: string, body: CreateEnvironmentBody = {}) =>
  request("POST", `${team(teamId)}/environments`, { schema: EnvironmentView, body });

export const getEnvironment = async (teamId: string, envId: string, o: Opts = {}) =>
  request("GET", `${team(teamId)}/environments/${seg(envId)}`, { schema: WorkforceEnvironmentView, ...o });

const envAction = (action: "pause" | "resume" | "disconnect") => async (teamId: string, envId: string) =>
  request("POST", `${team(teamId)}/environments/${seg(envId)}/${action}`, { schema: EnvironmentView });

export const pauseEnvironment = envAction("pause");
export const resumeEnvironment = envAction("resume");
export const disconnectEnvironment = envAction("disconnect");

/** Owner only. The token is for this tab's terminal: never store or log it. */
export const mintTerminalToken = async (teamId: string, envId: string) =>
  request("POST", `${team(teamId)}/environments/${seg(envId)}/terminal`, { schema: TerminalTokenResponse });

// ---------- CLI profiles and workforce ----------

export const registerProfile = async (
  teamId: string,
  envId: string,
  body: Pick<RegisterProfileBody, "cli" | "label"> & Partial<Pick<RegisterProfileBody, "scopes" | "maxConcurrent">>,
) => request("POST", `${team(teamId)}/environments/${seg(envId)}/profiles`, { schema: ProfileView, body });

/** Owner only. How many workers the login runs at once; the next placement uses it. */
export const updateProfile = async (teamId: string, profileId: string, body: UpdateProfileBody) =>
  request("PATCH", `${team(teamId)}/profiles/${seg(profileId)}`, { schema: ProfileView, body });

export const checkProfile = async (teamId: string, profileId: string) =>
  request("POST", `${team(teamId)}/profiles/${seg(profileId)}/check`, { schema: ProfileCheckResponse });

export const removeProfile = async (teamId: string, profileId: string) =>
  request("DELETE", `${team(teamId)}/profiles/${seg(profileId)}`, { schema: null });

export const getWorkforce = async (teamId: string, o: Opts = {}) =>
  request("GET", `${team(teamId)}/workforce`, { schema: WorkforceResponse, ...o });

/** Ticket for the read-only worker log socket at `/realtime/inspect/:leaseId`. */
export const inspectTicket = async (teamId: string, leaseId: string) =>
  request("POST", `${team(teamId)}/inspect/ticket`, { schema: RealtimeTicketResponse, body: { leaseId } });

/** An ended worker's last output, why it ended and what it left. 409 while it is live (use `inspectTicket`). */
export const getWorkerLog = async (teamId: string, leaseId: string, o: Opts = {}) =>
  request("GET", `${team(teamId)}/leases/${seg(leaseId)}/log`, { schema: WorkerLogResponse, ...o });

// ---------- tasks ----------

type CreateTaskInput = Pick<CreateTaskBody, "projectId" | "prompt"> & Partial<Omit<CreateTaskBody, "projectId" | "prompt">>;

/** Creates the task and starts planning in the background; the plan arrives on `workforce.view`. */
export const createTask = async (teamId: string, body: CreateTaskInput) =>
  request("POST", `${team(teamId)}/tasks`, { schema: PlanAcceptedResponse, body });

const task = (teamId: string, taskId: string) => `${team(teamId)}/tasks/${seg(taskId)}`;

export const replanTask = async (teamId: string, taskId: string, body: Partial<ReplanBody> = {}) =>
  request("POST", `${task(teamId, taskId)}/plan`, { schema: PlanAcceptedResponse, body });

export const startTask = async (teamId: string, taskId: string, body: StartTaskBody = {}) =>
  request("POST", `${task(teamId, taskId)}/start`, { schema: StartTaskResponse, body });

export const messageTask = async (teamId: string, taskId: string, body: TaskMessageBody) =>
  request("POST", `${task(teamId, taskId)}/message`, { schema: TaskMessageResponse, body });

export const cancelTask = async (teamId: string, taskId: string) =>
  request("POST", `${task(teamId, taskId)}/cancel`, { schema: CancelTaskResponse });

/** Creator, owner or admin. Stops a task that has not ended, then removes it for the whole team. GitHub is left alone. */
export const deleteTask = async (teamId: string, taskId: string) =>
  request("DELETE", task(teamId, taskId), { schema: DeleteTaskResponse });

export const retryTask = async (teamId: string, taskId: string) =>
  request("POST", `${task(teamId, taskId)}/retry`, { schema: RetryTaskResponse });

/** Ships one finished compare attempt (the others stop), or with null finishes the task without shipping. */
export const pickAttempt = async (teamId: string, taskId: string, workstreamId: string | null) =>
  request("POST", `${task(teamId, taskId)}/pick`, { schema: PickAttemptResponse, body: { workstreamId } });

export const getArtifacts = async (teamId: string, taskId: string, o: Opts = {}) =>
  request("GET", `${task(teamId, taskId)}/artifacts`, { schema: ArtifactsView, ...o });

/** The task with its full text and whole stored trace; the live view carries only a summary. */
export const getTaskDetail = async (teamId: string, taskId: string, o: Opts = {}) =>
  request("GET", task(teamId, taskId), { schema: TaskDetail, ...o });

// ---------- GitHub (as the signed-in member, with their own GitHub access) ----------

const project = (teamId: string, projectId: string) => `${team(teamId)}/projects/${seg(projectId)}`;

/** A pull request number as a path segment. */
function pullSeg(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1 || number > 2 ** 31 - 1) throw new ApiError("bad_request", "That link is not valid.", 0);
  return String(number);
}

const pull = (teamId: string, projectId: string, number: number) => `${project(teamId, projectId)}/pulls/${pullSeg(number)}`;

export const listPulls = async (teamId: string, projectId: string, state: PullStateFilter = "open", o: Opts = {}) =>
  request("GET", `${project(teamId, projectId)}/pulls`, { schema: PullListResponse, query: { state }, ...o });

export const getPull = async (teamId: string, projectId: string, number: number, o: Opts = {}) =>
  request("GET", pull(teamId, projectId, number), { schema: PullDetail, ...o });

/** The pull request Morrow opened for the task, or `pull: null` before there is one. */
export const getTaskPull = async (teamId: string, taskId: string, o: Opts = {}) =>
  request("GET", `${task(teamId, taskId)}/pull`, { schema: TaskPullResponse, ...o });

/** A conversation comment, or with `inReplyTo` a reply in a review comment's thread. */
export const commentOnPull = async (teamId: string, projectId: string, number: number, body: PullCommentBody) =>
  request("POST", `${pull(teamId, projectId, number)}/comments`, { schema: null, body });

/** `headSha` is the head the person saw: GitHub refuses if someone pushed since. */
export const mergePull = async (teamId: string, projectId: string, number: number, body: PullMergeBody) =>
  request("POST", `${pull(teamId, projectId, number)}/merge`, { schema: null, body });

export const markPullReady = async (teamId: string, projectId: string, number: number) =>
  request("POST", `${pull(teamId, projectId, number)}/ready`, { schema: null });

export const setPullState = async (teamId: string, projectId: string, number: number, state: PullStateBody["state"]) =>
  request("PATCH", pull(teamId, projectId, number), { schema: null, body: { state } });

const workstream = (teamId: string, taskId: string, workstreamId: string) => `${task(teamId, taskId)}/workstreams/${seg(workstreamId)}`;

export const getWorkstreamBranch = async (teamId: string, taskId: string, workstreamId: string, o: Opts = {}) =>
  request("GET", `${workstream(teamId, taskId, workstreamId)}/branch`, { schema: BranchView, ...o });

/** What the workstream's pushed branch changed against the task base, with patches as text. */
export const getWorkstreamDiff = async (teamId: string, taskId: string, workstreamId: string, o: Opts = {}) =>
  request("GET", `${workstream(teamId, taskId, workstreamId)}/diff`, { schema: BranchDiffView, ...o });

/** What is in the agent's worktree on its VM and not on GitHub yet. */
export const getWorkstreamChanges = async (teamId: string, taskId: string, workstreamId: string, o: Opts = {}) =>
  request("GET", `${workstream(teamId, taskId, workstreamId)}/changes`, { schema: WorktreeChanges, ...o });

/** Task creator or admin: commit everything in the worktree with `message`, then push the branch. */
export const commitWorkstream = async (teamId: string, taskId: string, workstreamId: string, message: string) =>
  request("POST", `${workstream(teamId, taskId, workstreamId)}/commit`, { schema: CommitWorkResponse, body: { message } });

// ---------- realtime ----------

export const realtimeTicket = async (teamId: string, o: Opts = {}) =>
  request("POST", "/api/realtime/ticket", { schema: RealtimeTicketResponse, body: { teamId }, ...o });
