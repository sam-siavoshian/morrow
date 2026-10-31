import { z } from "zod";
import type { RepoSummary } from "@morrow/contracts";

export const GITHUB_SCOPES = ["read:user", "user:email", "repo"] as const;

export type GithubErrorKind = "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "unavailable" | "bad_response";

/**
 * A GitHub failure classified for the HTTP layer. `message` is internal and never sent to the browser. `detail` is
 * GitHub's own one-line reason for refusing a write ("Required status check ... is failing"), kept for the member
 * who asked; it is never a token or a request body.
 */
export class GithubError extends Error {
  readonly kind: GithubErrorKind;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly detail: string | null;
  constructor(kind: GithubErrorKind, message: string, status: number | null = null, retryAfterSeconds: number | null = null, detail: string | null = null) {
    super(message);
    this.name = "GithubError";
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.detail = detail;
  }
}

/** What a response said about the caller's rate limit and token. Null where GitHub sent no header. */
export interface GithubRate {
  remaining: number | null;
  /** Epoch ms when the limit resets. */
  resetAt: number | null;
  /** The token's OAuth scopes (`x-oauth-scopes`). */
  scopes: string[] | null;
}

/** A conditional GET: 304 means the copy the caller holds for that ETag is still current (and cost no rate limit). */
export type ConditionalResponse =
  | { status: 304; rate: GithubRate }
  | { status: 200; etag: string | null; body: unknown; bytes: number; link: string | null; rate: GithubRate };

export interface GithubClientOptions {
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  webUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const GithubUser = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
  name: z.string().max(256).nullable().optional(),
  avatar_url: z.string().url().nullable().optional(),
});
export type GithubUser = { id: number; login: string; name: string | null; avatarUrl: string | null; email: string | null };

const GithubEmails = z.array(z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }));

const GithubRepo = z.object({
  id: z.number().int(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  description: z.string().nullable().optional(),
  pushed_at: z.string().nullable().optional(),
  permissions: z
    .object({ admin: z.boolean().optional(), maintain: z.boolean().optional(), push: z.boolean().optional(), pull: z.boolean().optional() })
    .optional(),
});
export type GithubRepo = z.infer<typeof GithubRepo>;

const TokenResponse = z.union([
  z.object({ access_token: z.string().min(1), scope: z.string().optional().default(""), token_type: z.string().optional() }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);

const ContentEntry = z.object({ name: z.string(), type: z.string() });
const FileContent = z.object({ type: z.literal("file"), encoding: z.string(), content: z.string(), size: z.number() });

const GitTree = z.object({
  tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })),
  truncated: z.boolean(),
});
export type TreeEntry = { path: string; type: "blob" | "tree"; size: number | null };

const Compare = z.object({
  status: z.enum(["ahead", "behind", "identical", "diverged"]),
  ahead_by: z.number().int(),
  behind_by: z.number().int(),
  files: z.array(z.object({ filename: z.string() })).optional(),
});
export type CompareResult = { status: "ahead" | "behind" | "identical" | "diverged"; aheadBy: number; behindBy: number; files: string[] };

const GitRef = z.object({ object: z.object({ sha: z.string() }) });

const PullRequest = z.object({
  number: z.number().int(),
  html_url: z.string().url(),
  state: z.string(),
  merged_at: z.string().nullable().optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().nullable().optional(),
});
export type PullRequestInfo = { number: number; url: string; state: string; mergeable: boolean | null; mergeableState: string | null };

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;

export function toRepoSummary(repo: GithubRepo): RepoSummary {
  return {
    id: repo.id,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
    description: repo.description ?? null,
    pushedAt: repo.pushed_at ?? null,
  };
}

export function canPush(repo: GithubRepo): boolean {
  const p = repo.permissions;
  return Boolean(p && (p.push || p.maintain || p.admin));
}

/** Typed GitHub calls. Every request has a timeout; every response is validated. Tokens only travel in headers. */
type ResolvedOptions = Required<Omit<GithubClientOptions, "fetch">> & { fetch: typeof globalThis.fetch };

export class GithubClient {
  readonly #o: ResolvedOptions;

  constructor(options: GithubClientOptions) {
    this.#o = { ...options, timeoutMs: options.timeoutMs ?? 10_000, fetch: options.fetch ?? globalThis.fetch };
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const url = new URL("/login/oauth/authorize", this.#o.webUrl);
    url.searchParams.set("client_id", this.#o.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", GITHUB_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "true");
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; scopes: string[] }> {
    const res = await this.#request(new URL("/login/oauth/access_token", this.#o.webUrl).toString(), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.#o.clientId,
        client_secret: this.#o.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw await this.#failure(res, "token exchange");
    const parsed = TokenResponse.safeParse(await this.#json(res));
    if (!parsed.success) throw new GithubError("bad_response", "token exchange: unexpected response shape", res.status);
    if ("error" in parsed.data) throw new GithubError("unauthorized", `token exchange rejected: ${parsed.data.error}`, res.status);
    return {
      accessToken: parsed.data.access_token,
      scopes: parsed.data.scope.split(/[,\s]+/).filter(Boolean),
    };
  }

  async getUser(token: string): Promise<GithubUser> {
    const user = GithubUser.safeParse(await this.#api(token, "/user"));
    if (!user.success) throw new GithubError("bad_response", "GET /user: unexpected response shape");
    let email: string | null = null;
    try {
      const emails = GithubEmails.safeParse(await this.#api(token, "/user/emails"));
      if (emails.success) email = emails.data.find((e) => e.primary && e.verified)?.email ?? null;
    } catch (error) {
      // A user who hid their email still gets in; anything else is a real failure.
      if (!(error instanceof GithubError) || (error.kind !== "not_found" && error.kind !== "forbidden")) throw error;
    }
    return {
      id: user.data.id,
      login: user.data.login,
      name: user.data.name ?? null,
      avatarUrl: user.data.avatar_url ?? null,
      email,
    };
  }

  /** One page of the user's repos, most recently pushed first. `hasMore` comes from the Link header. */
  async listRepos(token: string, page: number, perPage: number): Promise<{ repos: GithubRepo[]; hasMore: boolean }> {
    const params = new URLSearchParams({
      sort: "pushed",
      direction: "desc",
      affiliation: "owner,collaborator,organization_member",
      per_page: String(perPage),
      page: String(page),
    });
    const res = await this.#apiResponse(token, `/user/repos?${params}`);
    const parsed = z.array(GithubRepo).safeParse(await this.#json(res));
    if (!parsed.success) throw new GithubError("bad_response", "GET /user/repos: unexpected response shape");
    return { repos: parsed.data, hasMore: /\brel="next"/.test(res.headers.get("link") ?? "") };
  }

  async getRepo(token: string, fullName: string): Promise<GithubRepo> {
    const parsed = GithubRepo.safeParse(await this.#api(token, `/repos/${repoPath(fullName)}`));
    if (!parsed.success) throw new GithubError("bad_response", "GET /repos: unexpected response shape");
    return parsed.data;
  }

  /** Names of files in the repo root at `ref`. */
  async listRootFiles(token: string, fullName: string, ref: string): Promise<string[]> {
    const data = await this.#api(token, `/repos/${repoPath(fullName)}/contents/?ref=${encodeURIComponent(ref)}`);
    const parsed = z.array(ContentEntry).safeParse(data);
    if (!parsed.success) return [];
    return parsed.data.filter((e) => e.type === "file").map((e) => e.name);
  }

  /** Text of a small file, or null when it does not exist or is too large to be worth reading. */
  async readSmallFile(token: string, fullName: string, path: string, ref: string): Promise<string | null> {
    let data: unknown;
    try {
      data = await this.#api(
        token,
        `/repos/${repoPath(fullName)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      );
    } catch (error) {
      if (error instanceof GithubError && error.kind === "not_found") return null;
      throw error;
    }
    const parsed = FileContent.safeParse(data);
    if (!parsed.success || parsed.data.encoding !== "base64" || parsed.data.size > MAX_PACKAGE_JSON_BYTES) return null;
    return Buffer.from(parsed.data.content, "base64").toString("utf8");
  }

  /** Blobs and trees of `ref`, recursively. GitHub truncates very large trees; `truncated` says so. */
  async getTree(token: string, fullName: string, ref: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const parsed = GitTree.safeParse(await this.#api(token, `/repos/${repoPath(fullName)}/git/trees/${encodeURIComponent(ref)}?recursive=1`));
    if (!parsed.success) throw new GithubError("bad_response", "GET git/trees: unexpected response shape");
    return {
      entries: parsed.data.tree.map((e) => ({ path: e.path, type: e.type === "tree" ? "tree" : "blob", size: e.size ?? null })),
      truncated: parsed.data.truncated,
    };
  }

  /** Whether `sha` exists in the repository on GitHub. */
  async commitExists(token: string, fullName: string, sha: string): Promise<boolean> {
    assertSha(sha);
    try {
      await this.#api(token, `/repos/${repoPath(fullName)}/commits/${sha}`);
      return true;
    } catch (error) {
      // 422: "No commit found for SHA".
      if (error instanceof GithubError && (error.kind === "not_found" || error.status === 422)) return false;
      throw error;
    }
  }

  /** `base...head`. `ahead`/`identical` means head contains base. Files are capped by GitHub at 300. */
  async compare(token: string, fullName: string, base: string, head: string): Promise<CompareResult> {
    const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const parsed = Compare.safeParse(await this.#api(token, `/repos/${repoPath(fullName)}/compare/${range}`));
    if (!parsed.success) throw new GithubError("bad_response", "GET compare: unexpected response shape");
    return {
      status: parsed.data.status,
      aheadBy: parsed.data.ahead_by,
      behindBy: parsed.data.behind_by,
      files: (parsed.data.files ?? []).map((f) => f.filename),
    };
  }

  /** Head SHA of a branch, or null when it does not exist. */
  async getBranchHead(token: string, fullName: string, branch: string): Promise<string | null> {
    try {
      const parsed = GitRef.safeParse(await this.#api(token, `/repos/${repoPath(fullName)}/git/ref/heads/${branchPath(branch)}`));
      if (!parsed.success) throw new GithubError("bad_response", "GET git/ref: unexpected response shape");
      return parsed.data.object.sha;
    } catch (error) {
      if (error instanceof GithubError && error.kind === "not_found") return null;
      throw error;
    }
  }

  /** Creates `branch` at `sha`. An existing branch is left untouched. */
  async createBranch(token: string, fullName: string, branch: string, sha: string): Promise<"created" | "exists"> {
    assertSha(sha);
    try {
      await this.#send("POST", token, `/repos/${repoPath(fullName)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
      return "created";
    } catch (error) {
      if (error instanceof GithubError && error.status === 422) return "exists";
      throw error;
    }
  }

  /** Server-side merge of `head` (branch or SHA) into branch `base`. Never force-updates anything. */
  async mergeInto(token: string, fullName: string, base: string, head: string, message: string): Promise<"merged" | "noop" | "conflict"> {
    try {
      const res = await this.#send("POST", token, `/repos/${repoPath(fullName)}/merges`, { base, head, commit_message: message.slice(0, 500) });
      return res.status === 204 ? "noop" : "merged";
    } catch (error) {
      if (error instanceof GithubError && error.status === 409) return "conflict";
      throw error;
    }
  }

  /** The newest pull request from `head` (a branch of this repo) into `base`, open or closed. */
  async findPullRequest(token: string, fullName: string, head: string, base: string): Promise<PullRequestInfo | null> {
    const owner = fullName.split("/")[0] ?? "";
    const params = new URLSearchParams({ head: `${owner}:${head}`, base, state: "all", per_page: "5" });
    const parsed = z.array(PullRequest).safeParse(await this.#api(token, `/repos/${repoPath(fullName)}/pulls?${params}`));
    if (!parsed.success) throw new GithubError("bad_response", "GET pulls: unexpected response shape");
    const pr = parsed.data[0];
    return pr ? toPullRequest(pr) : null;
  }

  /** Opens a pull request, or returns the one that already exists for the same head and base. */
  async ensurePullRequest(token: string, fullName: string, input: { head: string; base: string; title: string; body: string }): Promise<PullRequestInfo> {
    try {
      const res = await this.#send("POST", token, `/repos/${repoPath(fullName)}/pulls`, {
        head: input.head,
        base: input.base,
        title: input.title.slice(0, 250),
        body: input.body.slice(0, 60_000),
      });
      const parsed = PullRequest.safeParse(await this.#json(res));
      if (!parsed.success) throw new GithubError("bad_response", "POST pulls: unexpected response shape");
      return toPullRequest(parsed.data);
    } catch (error) {
      if (!(error instanceof GithubError) || error.status !== 422) throw error;
      const existing = await this.findPullRequest(token, fullName, input.head, input.base);
      if (!existing) throw error;
      return existing;
    }
  }

  /** `mergeable` is null while GitHub is still computing it. */
  async getPullRequest(token: string, fullName: string, number: number): Promise<PullRequestInfo> {
    const parsed = PullRequest.safeParse(await this.#api(token, `/repos/${repoPath(fullName)}/pulls/${Math.trunc(number)}`));
    if (!parsed.success) throw new GithubError("bad_response", "GET pull: unexpected response shape");
    return toPullRequest(parsed.data);
  }

  /** GET with `If-None-Match`. Bodies are parsed but not validated: callers validate what they read. */
  async conditionalGet(token: string, path: string, etag: string | null): Promise<ConditionalResponse> {
    const headers = apiHeaders(token);
    if (etag) headers["if-none-match"] = etag;
    const res = await this.#request(`${this.#o.apiUrl}${path}`, { headers });
    const rate = rateOf(res);
    if (res.status === 304) {
      await res.body?.cancel().catch(() => {});
      return { status: 304, rate };
    }
    if (!res.ok) throw await this.#failure(res, `GET ${path.split("?")[0]}`);
    const text = await this.#text(res);
    return { status: 200, etag: res.headers.get("etag"), body: parseJson(text, res.status), bytes: text.length, link: res.headers.get("link"), rate };
  }

  /** A REST write. A refusal carries GitHub's reason in `detail`. 204 answers null. */
  async write(method: "POST" | "PUT" | "PATCH", token: string, path: string, body: unknown): Promise<unknown> {
    const res = await this.#request(`${this.#o.apiUrl}${path}`, {
      method,
      headers: { ...apiHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.#refusal(res, `${method} ${path.split("?")[0]}`);
    if (res.status === 204) return null;
    return this.#json(res);
  }

  /** One GraphQL call (for what REST cannot do, like marking a draft ready). GraphQL errors become GithubErrors. */
  async graphql(token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
    const res = await this.#request(graphqlUrl(this.#o.apiUrl), {
      method: "POST",
      headers: { ...apiHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw await this.#refusal(res, "POST graphql");
    const parsed = GraphqlResponse.safeParse(await this.#json(res));
    if (!parsed.success) throw new GithubError("bad_response", "POST graphql: unexpected response shape", res.status);
    const error = parsed.data.errors?.[0];
    if (error) {
      const detail = oneLine(error.message ?? "");
      if (error.type === "FORBIDDEN") throw new GithubError("forbidden", "POST graphql: forbidden", 403, null, detail);
      if (error.type === "NOT_FOUND") throw new GithubError("not_found", "POST graphql: not found", 404, null, detail);
      if (error.type === "RATE_LIMITED") throw new GithubError("rate_limited", "POST graphql: rate limited", 403, 60);
      throw new GithubError("bad_response", "POST graphql: refused", 422, null, detail);
    }
    return parsed.data.data ?? null;
  }

  async #api(token: string, path: string): Promise<unknown> {
    return this.#json(await this.#apiResponse(token, path));
  }

  async #apiResponse(token: string, path: string): Promise<Response> {
    const res = await this.#request(`${this.#o.apiUrl}${path}`, { headers: apiHeaders(token) });
    if (!res.ok) throw await this.#failure(res, `GET ${path.split("?")[0]}`);
    return res;
  }

  async #send(method: "POST", token: string, path: string, body: unknown): Promise<Response> {
    const res = await this.#request(`${this.#o.apiUrl}${path}`, {
      method,
      headers: { ...apiHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.#failure(res, `${method} ${path.split("?")[0]}`);
    return res;
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#o.fetch(url, {
        ...init,
        redirect: "error",
        headers: { "user-agent": "morrow-backend", ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch (error) {
      throw new GithubError("unavailable", `request failed: ${(error as Error).name}`);
    }
  }

  async #json(res: Response): Promise<unknown> {
    return parseJson(await this.#text(res), res.status);
  }

  async #text(res: Response): Promise<string> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_JSON_BYTES) throw new GithubError("bad_response", "response too large", res.status);
    const text = await res.text();
    if (text.length > MAX_JSON_BYTES) throw new GithubError("bad_response", "response too large", res.status);
    return text;
  }

  /** `#failure` plus GitHub's own reason from the error body (`message`, then the first `errors[].message`). */
  async #refusal(res: Response, what: string): Promise<GithubError> {
    let detail: string | null = null;
    if (res.status >= 400 && res.status < 500 && Number(res.headers.get("content-length") ?? "0") <= MAX_REFUSAL_BYTES) {
      const text = await res.text().catch(() => "");
      const parsed = RefusalBody.safeParse(text.length <= MAX_REFUSAL_BYTES ? safeParse(text) : null);
      if (parsed.success) {
        const extra = parsed.data.errors?.map((e) => (typeof e === "string" ? e : e.message ?? "")).find(Boolean);
        detail = oneLine([parsed.data.message, extra].filter(Boolean).join(": ")) || null;
      }
    }
    return this.#failure(res, what, detail);
  }

  async #failure(res: Response, what: string, detail: string | null = null): Promise<GithubError> {
    await res.body?.cancel().catch(() => {});
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    // Primary limit (remaining 0), or a secondary limit (403/429 with retry-after).
    if (res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")))) {
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Number.isFinite(reset) && reset > 0 ? reset - Date.now() / 1000 : 60;
      return new GithubError("rate_limited", `${what}: rate limited`, res.status, Math.max(1, Math.ceil(wait)));
    }
    if (res.status === 401) return new GithubError("unauthorized", `${what}: 401`, 401);
    if (res.status === 403) return new GithubError("forbidden", `${what}: 403`, 403, null, detail);
    if (res.status === 404) return new GithubError("not_found", `${what}: 404`, 404);
    if (res.status >= 500) return new GithubError("unavailable", `${what}: ${res.status}`, res.status);
    return new GithubError("bad_response", `${what}: ${res.status}`, res.status, null, detail);
  }
}

const MAX_REFUSAL_BYTES = 64 * 1024;
const RefusalBody = z.object({
  message: z.string().max(2_000).optional(),
  errors: z.array(z.union([z.string().max(2_000), z.object({ message: z.string().max(2_000).optional() })])).max(20).optional(),
});
const GraphqlResponse = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ type: z.string().optional(), message: z.string().max(2_000).optional() })).max(20).optional(),
});

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GithubError("bad_response", "response was not JSON", status);
  }
}

/** GitHub's prose on one printable line, capped: it is shown to the member who asked, as text. */
function oneLine(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= 300 ? flat : `${flat.slice(0, 299)}…`;
}

function rateOf(res: Response): GithubRate {
  const num = (name: string) => {
    const raw = res.headers.get(name);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const reset = num("x-ratelimit-reset");
  const scopes = res.headers.get("x-oauth-scopes");
  return {
    remaining: num("x-ratelimit-remaining"),
    resetAt: reset === null ? null : reset * 1000,
    scopes: scopes === null ? null : scopes.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/** github.com serves GraphQL at `api.github.com/graphql`; GitHub Enterprise at `<host>/api/graphql` beside `/api/v3`. */
function graphqlUrl(apiUrl: string): string {
  return apiUrl.endsWith("/api/v3") ? `${apiUrl.slice(0, -"/v3".length)}/graphql` : `${apiUrl}/graphql`;
}

function apiHeaders(token: string): Record<string, string> {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
}

function assertSha(sha: string): void {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new GithubError("not_found", "malformed sha");
}

/** Branch names go into the URL path segment by segment. */
function branchPath(branch: string): string {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.split("/").some((p) => !p || p === "." || p === "..")) {
    throw new GithubError("not_found", "malformed branch");
  }
  return branch.split("/").map(encodeURIComponent).join("/");
}

function toPullRequest(pr: z.infer<typeof PullRequest>): PullRequestInfo {
  return {
    number: pr.number,
    url: pr.html_url,
    state: pr.merged_at ? "merged" : pr.state,
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? null,
  };
}

function repoPath(fullName: string): string {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) throw new GithubError("not_found", "malformed repo name");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
