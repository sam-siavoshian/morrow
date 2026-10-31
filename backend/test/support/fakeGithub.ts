// A local HTTP server that speaks the slice of GitHub's OAuth + REST API the backend uses. Tests point
// GITHUB_WEB_URL / GITHUB_API_URL at it, so the real GithubClient (fetch, headers, parsing) is exercised.
//
//   bun test/support/fakeGithub.ts   -> runs standalone on a free port and prints its URL (for curl runs)

export interface FakeRepo {
  id: number;
  fullName: string;
  private?: boolean;
  defaultBranch?: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean };
  rootFiles?: string[];
  packageJson?: string;
}

/** Repo-wide state every user with access sees (pull requests, merge settings, branches). */
export interface FakeRepoState {
  pulls: Map<number, FakePull>;
  /** Which merge methods the repo allows (shown only to users with write access, as on GitHub). */
  mergeSettings: { merge: boolean; squash: boolean; rebase: boolean };
  /** head branch -> comparison against the default branch. Missing: the branch is not on GitHub. */
  branches: Map<
    string,
    {
      aheadBy: number;
      behindBy: number;
      commits: Array<{ sha: string; message: string; author: string; date: string }>;
      /** The compare's changed files. Left out of the answer when unset. */
      files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string; previous_filename?: string }>;
    }
  >;
}

export interface FakePull {
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  mergedBy?: string;
  author: string;
  head: string;
  headSha: string;
  base: string;
  createdAt?: string;
  updatedAt: string;
  mergeable?: boolean | null;
  mergeableState?: string;
  files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  reviews?: Array<{ id: number; user: string; state: string; body?: string; submittedAt: string }>;
  reviewComments?: Array<{ id: number; user: string; body: string; path: string; line: number | null; diffHunk?: string; inReplyTo?: number; createdAt: string }>;
  issueComments?: Array<{ id: number; user: string; body: string; createdAt: string }>;
  requestedReviewers?: string[];
  checkRuns?: Array<{ name: string; status: string; conclusion: string | null }>;
  statuses?: Array<{ context: string; state: string }>;
  /** The next merge attempt answers with this (then it is cleared). */
  mergeRefusal?: { status: number; message: string };
}

export interface FakeUser {
  id: number;
  login: string;
  name?: string | null;
  /** GitHub's `avatar_url`. Null by default, so nothing (the dev stack's browser included) loads a made-up host. */
  avatarUrl?: string | null;
  token: string;
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>;
  repos?: FakeRepo[];
}

export interface FakeGithub {
  url: string;
  clientId: string;
  clientSecret: string;
  /** Registers an OAuth code that exchanges for `user`'s token. */
  issueCode(user: FakeUser): string;
  addUser(user: FakeUser): void;
  /** The user `/login/oauth/authorize` auto-approves as (for end-to-end curl runs). */
  setAuthorizingUser(user: FakeUser | null): void;
  /** Makes every API call answer with this status until cleared. */
  failWith(status: number | null): void;
  /** A repo's shared state (created on first use). */
  repo(fullName: string): FakeRepoState;
  /** Requests left for a token before GitHub says the rate limit is spent (304s are free). Null: unlimited. */
  setRateLimit(token: string, remaining: number | null): void;
  /** `x-oauth-scopes` sent for a token (default "read:user, user:email, repo"). */
  setScopes(token: string, scopes: string): void;
  requests: Array<{ method: string; path: string; search: string; auth: string | null; status: number }>;
  stop(): Promise<void>;
}

export function startFakeGithub(options: { clientId?: string; clientSecret?: string } = {}): FakeGithub {
  const clientId = options.clientId ?? "fake-client-id";
  const clientSecret = options.clientSecret ?? "fake-client-secret";
  const users = new Map<string, FakeUser>();
  const codes = new Map<string, FakeUser>();
  const requests: FakeGithub["requests"] = [];
  let authorizing: FakeUser | null = null;
  let failStatus: number | null = null;
  const repoStates = new Map<string, FakeRepoState>();
  const limits = new Map<string, number>();
  const scopes = new Map<string, string>();
  let nextId = 900_000;
  const stateOf = (fullName: string): FakeRepoState => {
    const key = fullName.toLowerCase();
    let state = repoStates.get(key);
    if (!state) repoStates.set(key, (state = { pulls: new Map(), mergeSettings: { merge: true, squash: true, rebase: true }, branches: new Map() }));
    return state;
  };
  const canPush = (r: FakeRepo) => {
    const p = r.permissions ?? { push: true };
    return Boolean(p.push || p.admin || p.maintain);
  };

  const repoJson = (r: FakeRepo) => ({
    id: r.id,
    full_name: r.fullName,
    private: r.private ?? false,
    default_branch: r.defaultBranch ?? "main",
    description: null,
    pushed_at: "2020-01-01T00:00:00Z",
    permissions: r.permissions ?? { admin: false, maintain: false, push: true, pull: true },
    // GitHub shows merge settings only to people who can write to the repo.
    ...(canPush(r)
      ? {
          allow_merge_commit: stateOf(r.fullName).mergeSettings.merge,
          allow_squash_merge: stateOf(r.fullName).mergeSettings.squash,
          allow_rebase_merge: stateOf(r.fullName).mergeSettings.rebase,
        }
      : {}),
  });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      const entry = { method: req.method, path: url.pathname, search: url.search, auth, status: 0 };
      requests.push(entry);
      const res = await handle(req, url, auth);
      entry.status = res.status;
      return res;
    },
  });

  async function handle(req: Request, url: URL, auth: string | null): Promise<Response> {
    {

      if (url.pathname === "/login/oauth/authorize" && req.method === "GET") {
        if (!authorizing || url.searchParams.get("client_id") !== clientId) return new Response("denied", { status: 403 });
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", issue(authorizing));
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        return Response.redirect(redirect.toString(), 302);
      }

      if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, string>;
        if (body.client_id !== clientId || body.client_secret !== clientSecret)
          return Response.json({ error: "incorrect_client_credentials" });
        const user = codes.get(body.code ?? "");
        codes.delete(body.code ?? "");
        if (!user) return Response.json({ error: "bad_verification_code" });
        return Response.json({ access_token: user.token, scope: "read:user,user:email,repo", token_type: "bearer" });
      }

      if (failStatus !== null) return Response.json({ message: "forced failure" }, { status: failStatus });
      const user = auth?.startsWith("Bearer ") ? users.get(auth.slice(7)) : undefined;
      if (!user) return Response.json({ message: "Bad credentials" }, { status: 401 });
      return api(req, url, user);
    }
  }

  /** Authenticated API: rate limit, scopes and ETag/304 around the routes. */
  async function api(req: Request, url: URL, user: FakeUser): Promise<Response> {
    const left = limits.get(user.token);
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    if (left !== undefined && left <= 0) {
      return Response.json(
        { message: "API rate limit exceeded for user." },
        { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } },
      );
    }
    const res = await route(req, url, user);
    const headers = new Headers(res.headers);
    headers.set("x-oauth-scopes", scopes.get(user.token) ?? "read:user, user:email, repo");
    if (req.method === "GET" && res.status === 200) {
      const text = await res.text();
      const etag = `W/"${new Bun.CryptoHasher("sha1").update(text).digest("hex")}"`;
      headers.set("etag", etag);
      if (req.headers.get("if-none-match") === etag) {
        headers.set("x-ratelimit-remaining", String(left ?? 5000));
        headers.set("x-ratelimit-reset", reset);
        return new Response(null, { status: 304, headers });
      }
      if (left !== undefined) limits.set(user.token, left - 1);
      headers.set("x-ratelimit-remaining", String(left === undefined ? 4999 : left - 1));
      headers.set("x-ratelimit-reset", reset);
      return new Response(text, { status: 200, headers });
    }
    if (left !== undefined) limits.set(user.token, left - 1);
    headers.set("x-ratelimit-remaining", String(left === undefined ? 4999 : left - 1));
    headers.set("x-ratelimit-reset", reset);
    return new Response(res.body, { status: res.status, headers });
  }

  async function route(req: Request, url: URL, user: FakeUser): Promise<Response> {
    {
      if (url.pathname === "/graphql" && req.method === "POST") return graphql(req, user);
      const pr = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(pulls|issues|commits|compare)(?:\/(.*))?$/);
      if (pr) {
        const fullName = `${decodeURIComponent(pr[1]!)}/${decodeURIComponent(pr[2]!)}`;
        const repo = (user.repos ?? []).find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
        if (!repo) return Response.json({ message: "Not Found" }, { status: 404 });
        return repoRoute(req, url, user, repo, pr[3]!, pr[4] ?? "");
      }

      if (url.pathname === "/user") {
        return Response.json({ id: user.id, login: user.login, name: user.name ?? null, avatar_url: user.avatarUrl ?? null });
      }
      if (url.pathname === "/user/emails") return Response.json(user.emails ?? []);
      if (url.pathname === "/user/repos") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        const all = user.repos ?? [];
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const headers: Record<string, string> = {};
        if (page * perPage < all.length) headers.link = `<${url.origin}/user/repos?page=${page + 1}>; rel="next"`;
        return Response.json(slice.map(repoJson), { headers });
      }
      const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.*))?$/);
      if (m) {
        const fullName = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`;
        const repo = (user.repos ?? []).find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
        if (!repo) return Response.json({ message: "Not Found" }, { status: 404 });
        if (m[3] === undefined) return Response.json(repoJson(repo));
        if (m[3] === "") return Response.json((repo.rootFiles ?? []).map((name) => ({ name, type: "file" })));
        if (m[3] === "package.json" && repo.packageJson !== undefined) {
          return Response.json({
            type: "file",
            encoding: "base64",
            size: repo.packageJson.length,
            content: Buffer.from(repo.packageJson).toString("base64"),
          });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
  }

  const userJson = (login: string) => ({ login, avatar_url: `https://avatars.githubusercontent.com/u/${login.length}?v=4` });
  const webBase = () => `http://127.0.0.1:${server.port}`;

  function pullJson(repo: FakeRepo, p: FakePull) {
    const files = p.files ?? [];
    return {
      number: p.number,
      node_id: `PR_node${p.number}`,
      title: p.title,
      body: p.body ?? null,
      state: p.state,
      draft: p.draft ?? false,
      merged: p.merged ?? false,
      merged_at: p.merged ? p.updatedAt : null,
      merged_by: p.mergedBy ? userJson(p.mergedBy) : null,
      user: userJson(p.author),
      head: { ref: p.head, sha: p.headSha },
      base: { ref: p.base },
      html_url: `${webBase()}/${repo.fullName}/pull/${p.number}`,
      created_at: p.createdAt ?? p.updatedAt,
      updated_at: p.updatedAt,
      mergeable: p.mergeable ?? true,
      mergeable_state: p.mergeableState ?? "clean",
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      changed_files: files.length,
      commits: 1,
      requested_reviewers: (p.requestedReviewers ?? []).map(userJson),
    };
  }

  const touch = (p: FakePull) => void (p.updatedAt = new Date(Math.max(Date.now(), Date.parse(p.updatedAt) + 1000)).toISOString());

  async function repoRoute(req: Request, url: URL, user: FakeUser, repo: FakeRepo, kind: string, rest: string): Promise<Response> {
    const state = stateOf(repo.fullName);
    const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });
    const q = url.searchParams;
    if (kind === "compare" && req.method === "GET") {
      const [, head] = decodeURIComponent(rest).split("...");
      const branch = head ? state.branches.get(head) : undefined;
      if (!branch) return notFound();
      return Response.json({
        status: branch.aheadBy && branch.behindBy ? "diverged" : branch.aheadBy ? "ahead" : branch.behindBy ? "behind" : "identical",
        ahead_by: branch.aheadBy,
        behind_by: branch.behindBy,
        // GitHub lists compare commits oldest first.
        commits: branch.commits.map((c) => ({
          sha: c.sha,
          html_url: `${webBase()}/${repo.fullName}/commit/${c.sha}`,
          author: userJson(c.author),
          commit: { message: c.message, author: { name: c.author, date: c.date }, committer: { date: c.date } },
        })),
        ...(branch.files ? { files: branch.files.map((f) => ({ ...f, changes: f.additions + f.deletions })) } : {}),
      });
    }
    if (kind === "commits" && req.method === "GET") {
      const m = rest.match(/^([0-9a-f]{40})\/(check-runs|status)$/);
      if (!m) return notFound();
      const pulls = [...state.pulls.values()].filter((p) => p.headSha === m[1]);
      if (m[2] === "check-runs") {
        const runs = pulls.flatMap((p) => p.checkRuns ?? []).map((r, i) => ({ id: i + 1, ...r, html_url: `${webBase()}/runs/${i + 1}` }));
        return Response.json({ total_count: runs.length, check_runs: runs });
      }
      const statuses = pulls.flatMap((p) => p.statuses ?? []).map((st, i) => ({ id: i + 1, ...st, description: null, target_url: null }));
      return Response.json({ state: "pending", statuses });
    }
    if (kind === "issues") {
      const m = rest.match(/^(\d+)\/comments$/);
      const p = m ? state.pulls.get(Number(m[1])) : undefined;
      if (!p) return notFound();
      if (req.method === "GET") {
        const since = q.get("since") ? Date.parse(q.get("since")!) : 0;
        const items = (p.issueComments ?? []).filter((c) => Date.parse(c.createdAt) >= since);
        return Response.json(items.map((c) => ({ id: c.id, user: userJson(c.user), body: c.body, created_at: c.createdAt, html_url: `${webBase()}/${repo.fullName}/pull/${p.number}#issuecomment-${c.id}` })));
      }
      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { body?: unknown };
        if (typeof body.body !== "string" || !body.body) return Response.json({ message: "Validation Failed", errors: [{ message: "body is missing" }] }, { status: 422 });
        const comment = { id: ++nextId, user: user.login, body: body.body, createdAt: new Date().toISOString() };
        (p.issueComments ??= []).push(comment);
        touch(p);
        return Response.json({ id: comment.id }, { status: 201 });
      }
      return notFound();
    }
    // pulls
    if (rest === "" && req.method === "GET") {
      const want = q.get("state") ?? "open";
      const head = q.get("head");
      const base = q.get("base");
      const perPage = Number(q.get("per_page") ?? "30");
      const list = [...state.pulls.values()]
        .filter((p) => want === "all" || p.state === want)
        .filter((p) => !head || `${repo.fullName.split("/")[0]}:${p.head}` === head)
        .filter((p) => !base || p.base === base)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return Response.json(list.slice(0, perPage).map((p) => pullJson(repo, p)));
    }
    const m = rest.match(/^(\d+)(?:\/(files|reviews|comments|merge)(?:\/(\d+)\/replies)?)?$/);
    const p = m ? state.pulls.get(Number(m[1])) : undefined;
    if (!m || !p) return notFound();
    const sub = m[2];
    if (!sub && req.method === "GET") return Response.json(pullJson(repo, p));
    if (!sub && req.method === "PATCH") {
      if (!canPush(repo) && user.login !== p.author) return Response.json({ message: "Must have admin rights to Repository." }, { status: 403 });
      const body = (await req.json().catch(() => ({}))) as { state?: unknown };
      if (body.state !== "open" && body.state !== "closed") return Response.json({ message: "Validation Failed" }, { status: 422 });
      if (p.merged) return Response.json({ message: "Validation Failed", errors: [{ message: "state cannot be changed. The pull request has been merged." }] }, { status: 422 });
      p.state = body.state;
      touch(p);
      return Response.json(pullJson(repo, p));
    }
    if (sub === "files" && req.method === "GET") return Response.json((p.files ?? []).map((f) => ({ ...f, changes: f.additions + f.deletions })));
    if (sub === "reviews" && req.method === "GET") {
      return Response.json(
        (p.reviews ?? []).map((r) => ({ id: r.id, user: userJson(r.user), state: r.state, body: r.body ?? "", submitted_at: r.submittedAt, html_url: `${webBase()}/${repo.fullName}/pull/${p.number}#pullrequestreview-${r.id}` })),
      );
    }
    if (sub === "comments" && req.method === "GET" && !m[3]) {
      const items = [...(p.reviewComments ?? [])];
      if (q.get("direction") === "desc") items.reverse();
      return Response.json(
        items.map((c) => ({
          id: c.id,
          user: userJson(c.user),
          body: c.body,
          path: c.path,
          line: c.line,
          diff_hunk: c.diffHunk ?? null,
          ...(c.inReplyTo ? { in_reply_to_id: c.inReplyTo } : {}),
          created_at: c.createdAt,
          html_url: `${webBase()}/${repo.fullName}/pull/${p.number}#discussion_r${c.id}`,
        })),
      );
    }
    if (sub === "comments" && m[3] && req.method === "POST") {
      const parent = (p.reviewComments ?? []).find((c) => c.id === Number(m[3]));
      if (!parent) return notFound();
      const body = (await req.json().catch(() => ({}))) as { body?: unknown };
      if (typeof body.body !== "string" || !body.body) return Response.json({ message: "Validation Failed" }, { status: 422 });
      const reply = { id: ++nextId, user: user.login, body: body.body, path: parent.path, line: parent.line, diffHunk: parent.diffHunk, inReplyTo: parent.id, createdAt: new Date().toISOString() };
      p.reviewComments!.push(reply);
      touch(p);
      return Response.json({ id: reply.id }, { status: 201 });
    }
    if (sub === "merge" && req.method === "PUT") {
      if (!canPush(repo)) return Response.json({ message: "Must have push access to merge this pull request." }, { status: 403 });
      const body = (await req.json().catch(() => ({}))) as { merge_method?: unknown; sha?: unknown };
      if (p.mergeRefusal) {
        const refusal = p.mergeRefusal;
        p.mergeRefusal = undefined;
        return Response.json({ message: refusal.message }, { status: refusal.status });
      }
      const method = body.merge_method;
      const allowed = method === "merge" ? state.mergeSettings.merge : method === "squash" ? state.mergeSettings.squash : method === "rebase" ? state.mergeSettings.rebase : false;
      if (!allowed) return Response.json({ message: "Merge method not allowed for this repository." }, { status: 405 });
      if (typeof body.sha === "string" && body.sha !== p.headSha) return Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 });
      if (p.state !== "open" || p.merged) return Response.json({ message: "Pull Request is not mergeable" }, { status: 405 });
      if (p.draft) return Response.json({ message: "Pull Request is still a draft" }, { status: 405 });
      p.state = "closed";
      p.merged = true;
      p.mergedBy = user.login;
      touch(p);
      return Response.json({ sha: "f".repeat(40), merged: true, message: "Pull Request successfully merged" });
    }
    return notFound();
  }

  async function graphql(req: Request, user: FakeUser): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { query?: string; variables?: { id?: string } };
    if (!body.query?.includes("markPullRequestReadyForReview")) return Response.json({ errors: [{ type: "INVALID", message: "unsupported" }] });
    for (const repo of user.repos ?? []) {
      for (const p of stateOf(repo.fullName).pulls.values()) {
        if (`PR_node${p.number}` !== body.variables?.id) continue;
        if (!canPush(repo) && user.login !== p.author) return Response.json({ data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
        p.draft = false;
        touch(p);
        return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      }
    }
    return Response.json({ data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node" }] });
  }

  function issue(user: FakeUser): string {
    users.set(user.token, user);
    const code = crypto.randomUUID().replace(/-/g, "");
    codes.set(code, user);
    return code;
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    clientId,
    clientSecret,
    issueCode: issue,
    addUser: (user) => void users.set(user.token, user),
    setAuthorizingUser: (user) => {
      authorizing = user;
      if (user) users.set(user.token, user);
    },
    failWith: (status) => void (failStatus = status),
    repo: stateOf,
    setRateLimit: (token, remaining) => void (remaining === null ? limits.delete(token) : limits.set(token, remaining)),
    setScopes: (token, value) => void scopes.set(token, value),
    requests,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const gh = startFakeGithub();
  const alice: FakeUser = {
    id: 1001,
    login: "alice",
    name: "Alice",
    token: "gho_alice_fake",
    emails: [{ email: "alice@example.com", primary: true, verified: true }],
    repos: [
      { id: 1, fullName: "alice/app", rootFiles: ["package.json", "bun.lock"], packageJson: JSON.stringify({ scripts: { test: "bun test" } }) },
      { id: 2, fullName: "alice/readonly", permissions: { pull: true } },
    ],
  };
  const bob: FakeUser = { id: 1002, login: "bob", token: "gho_bob_fake", repos: [] };
  gh.addUser(alice);
  gh.addUser(bob);
  gh.setAuthorizingUser(alice);
  console.log(JSON.stringify({ url: gh.url, clientId: gh.clientId, clientSecret: gh.clientSecret }));
  // Switch the authorizing user with: kill -USR1 <pid>  (alice <-> bob)
  let current = alice;
  process.on("SIGUSR1", () => {
    current = current === alice ? bob : alice;
    gh.setAuthorizingUser(current);
    console.log(`authorizing as ${current.login}`);
  });
  await new Promise<void>((done) => process.once("SIGTERM", done));
  await gh.stop();
}
