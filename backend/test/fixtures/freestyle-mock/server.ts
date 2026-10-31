// Local mock of the Freestyle public API, shaped after freestyle@0.2.20's own
// client (node_modules/freestyle/src): the same /v5 routes, JSON bodies, error
// bodies ({code,message}), the 202 + /v5/background-requests polling protocol,
// exec statusCode/null, identity-token scoping, and the PTY WebSocket framing
// (sessionInfo / replayStart / replayEnd text frames, binary output, binary
// input, resize/signal JSON). Point the real SDK at it with `baseUrl`.
import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { FakeGuest, SCRIPT_BY_HASH, type ScriptResult } from "./guest.ts";

const RUN_SCRIPT_COMMAND = 'morrow_script="$(cat)" && exec /bin/bash -c "$morrow_script" morrow-vm';
const BACKGROUND_HEADER = "x-freestyle-background-after-secs";
const REQUEST_ID_HEADER = "x-freestyle-background-request-id";
const IDENTITY_HEADER = "x-freestyle-identity-access-token";

type Json = Record<string, unknown> | unknown[];

interface MockResponse {
  status: number;
  body?: Json | null;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export interface MockVm {
  data: Record<string, unknown> & { id: string; state: string; slug: string | null; metadata: Record<string, string> };
  guest: FakeGuest;
  pty: Map<number, MockPty>;
  nextPty: number;
  /** data() reads left before a transitional state settles. */
  settleIn: number;
  settleTo?: string;
}

export interface MockPty {
  id: number;
  slug: string | null;
  linuxUser: string;
  exec: string | null;
  scrollback: Uint8Array[];
  sockets: Set<ServerWebSocket<PtySocketData>>;
  inputs: Uint8Array[];
  resizes: { cols: number; rows: number }[];
  signals: string[];
  createdUnix: number;
}

interface PtySocketData {
  vmId: string;
  sessionId: number;
  created: boolean;
}

export interface ExecRecord {
  vmId: string;
  auth: "key" | "identity";
  body: { command?: string; linuxUser?: string; timeoutMs?: number; env?: Record<string, string>; stdin?: string };
  script: string | null;
  result: { statusCode: number | null };
}

export interface Fault {
  method?: string;
  path?: RegExp;
  script?: string;
  /** before: fail without effect. after: apply the effect, then fail (a lost response). */
  mode: "before" | "after";
  status?: number;
}

interface Identity {
  id: string;
  managed: boolean;
  tokens: Map<string, { token: string; expiresAt: string | null }>;
  grants: Map<string, { id: string; identityId: string; vmId: string; allowedLinuxUsers: string[] | null; grantedAt: string; grantedBy: string }>;
}

type Auth = { kind: "key" } | { kind: "identity"; identity: Identity };

export interface FreestyleMock {
  url: string;
  apiKey: string;
  vms: Map<string, MockVm>;
  snapshots: Map<string, Record<string, unknown> & { id: string; slug: string | null }>;
  identities: Map<string, Identity>;
  execLog: ExecRecord[];
  requestLog: { method: string; path: string; status: number }[];
  faults: Fault[];
  /** Routes answered with 202 + background polling, resolved after `delayMs`. */
  background: { method: string; path: RegExp; delayMs: number }[];
  plan: { vmAutoDeleteSeconds: number | null; snapshotAutoDeleteSeconds: number | null };
  options: { startTransitionReads: number; pauseTransitionReads: number };
  vmBySlug(slug: string): MockVm | undefined;
  createPtySession(vmId: string, opts: { slug: string; linuxUser: string; output?: string }): MockPty;
  ptyOutput(vmId: string, sessionId: number, text: string): void;
  stop(): Promise<void>;
}

const now = () => new Date().toISOString();
const rid = (prefix: string, n = 8) => `${prefix}${randomBytes(n).toString("hex")}`;
const err = (status: number, code: string, message: string): MockResponse => ({ status, body: { code, message } });
const json = (body: Json | null, status = 200): MockResponse => ({ status, body });

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function startFreestyleMock(): FreestyleMock {
  const apiKey = `fs_test_${randomBytes(12).toString("hex")}`;
  const vms = new Map<string, MockVm>();
  const snapshots: FreestyleMock["snapshots"] = new Map();
  const identities = new Map<string, Identity>();
  const backgroundRequests = new Map<string, { done: boolean; response?: MockResponse }>();
  const execLog: ExecRecord[] = [];
  const requestLog: FreestyleMock["requestLog"] = [];
  const faults: Fault[] = [];
  const background: FreestyleMock["background"] = [];
  const plan = { vmAutoDeleteSeconds: null as number | null, snapshotAutoDeleteSeconds: null as number | null };
  const options = { startTransitionReads: 0, pauseTransitionReads: 0 };

  const vmBySlug = (slug: string) => [...vms.values()].find((vm) => vm.data.slug === slug);
  const findVm = (idOrSlug: string) => vms.get(idOrSlug) ?? vmBySlug(idOrSlug);
  const findSnapshot = (idOrSlug: string) => snapshots.get(idOrSlug) ?? [...snapshots.values()].find((s) => s.slug === idOrSlug);

  function authenticate(req: Request, url: URL): Auth | null {
    const authz = req.headers.get("authorization");
    if (authz === `Bearer ${apiKey}`) return { kind: "key" };
    let token = req.headers.get(IDENTITY_HEADER);
    if (!token) {
      const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
      const encoded = protocols.find((p) => p.startsWith("freestyle-identity."))?.slice("freestyle-identity.".length);
      if (encoded) token = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    }
    if (!token) return null;
    for (const identity of identities.values()) {
      for (const t of identity.tokens.values()) {
        if (t.token !== token) continue;
        if (t.expiresAt && Date.parse(t.expiresAt) <= Date.now()) return null;
        return { kind: "identity", identity };
      }
    }
    void url;
    return null;
  }

  /** Identity tokens reach only exec/PTY on granted VMs, as allowed users. */
  function identityAllowed(identity: Identity, method: string, path: string, linuxUser: string | undefined): boolean {
    const m = path.match(/^\/v5\/vms\/([^/]+)\/(exec-await|pty(?:\/sessions(?:\/[^/]+)?)?)$/);
    if (!m) return false;
    const vm = findVm(decodeURIComponent(m[1]!));
    if (!vm) return false;
    const grant = identity.grants.get(vm.data.id);
    if (!grant) return false;
    if (grant.allowedLinuxUsers === null) return true;
    if (!linuxUser || !grant.allowedLinuxUsers.includes(linuxUser)) return false;
    return method === "POST" || method === "GET" || method === "DELETE";
  }

  function takeFault(method: string, path: string, script: string | null): Fault | undefined {
    const i = faults.findIndex(
      (f) => (!f.method || f.method === method) && (!f.path || f.path.test(path)) && (!f.script || f.script === script),
    );
    return i >= 0 ? faults.splice(i, 1)[0] : undefined;
  }

  function vmView(vm: MockVm): Record<string, unknown> {
    if (vm.settleTo) {
      if (vm.settleIn <= 0) {
        vm.data.state = vm.settleTo;
        vm.settleTo = undefined;
      } else vm.settleIn--;
    }
    return { ...vm.data, metadata: { ...vm.data.metadata } };
  }

  function transition(vm: MockVm, through: string, to: string, reads: number) {
    if (reads > 0) {
      vm.data.state = through;
      vm.settleIn = reads;
      vm.settleTo = to;
    } else {
      vm.data.state = to;
      vm.settleTo = undefined;
    }
    vm.data.updatedAt = now();
  }

  function checkPath(path: string | null): string | null {
    if (!path || !path.startsWith("/") || path.length > 4096 || path.split("/").includes("..")) return null;
    return path;
  }

  async function route(req: Request, url: URL, auth: Auth): Promise<MockResponse> {
    const method = req.method;
    const path = url.pathname;
    const q = url.searchParams;
    const body = async () => {
      const text = await req.text();
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    };
    let m: RegExpMatchArray | null;

    if (auth.kind === "identity") {
      let linuxUser = q.get("linuxUser") ?? undefined;
      let parsed: Record<string, unknown> | undefined;
      if (path.endsWith("/exec-await")) {
        parsed = await body();
        linuxUser = typeof parsed.linuxUser === "string" ? parsed.linuxUser : undefined;
      }
      if (!identityAllowed(auth.identity, method, path, linuxUser)) return err(403, "FORBIDDEN", "identity not permitted");
      if (parsed) return execRoute(path, parsed, auth);
    }

    // ---- background requests
    if ((m = path.match(/^\/v5\/background-requests\/([^/]+)$/)) && method === "GET") {
      const entry = backgroundRequests.get(m[1]!);
      if (!entry) return err(404, "NOT_FOUND", "no such background request");
      if (!entry.done) return { status: 202, body: { requestId: m[1] } };
      return { ...entry.response!, headers: { ...entry.response!.headers, [REQUEST_ID_HEADER]: m[1]! } };
    }

    // ---- VMs
    if (path === "/v5/vms" && method === "POST") return createVm(await body());
    if (path === "/v5/vms" && method === "GET") {
      let list = [...vms.values()];
      if (q.get("state")) list = list.filter((v) => v.data.state === q.get("state"));
      if (q.get("slug")) list = list.filter((v) => v.data.slug === q.get("slug"));
      for (const pair of (q.get("metadata") ?? "").split(",").filter(Boolean)) {
        const [k, v] = pair.split(":");
        list = list.filter((vm) => vm.data.metadata[k!] === v);
      }
      const offset = Number(q.get("offset") ?? 0);
      const limit = Number(q.get("limit") ?? 50);
      const page = list.slice(offset, offset + limit).map(vmView);
      const count = (s: string) => list.filter((v) => v.data.state === s).length;
      return json({
        vms: page,
        totalCount: list.length,
        runningCount: count("running"),
        startingCount: count("starting"),
        pausingCount: count("pausing"),
        pausedCount: count("paused"),
        stoppedCount: count("stopped"),
      });
    }
    if ((m = path.match(/^\/v5\/vms\/([^/]+)(\/.*)?$/))) {
      const vm = findVm(decodeURIComponent(m[1]!));
      if (!vm) return err(404, "VM_NOT_FOUND", "VM not found");
      const rest = m[2] ?? "";
      if (rest === "" && method === "GET") return json(vmView(vm));
      if (rest === "" && method === "PATCH") {
        const b = await body();
        if (b.metadata) vm.data.metadata = { ...vm.data.metadata, ...(b.metadata as Record<string, string>) };
        return json(vmView(vm));
      }
      if (rest === "" && method === "DELETE") {
        vms.delete(vm.data.id);
        for (const s of vm.pty.values()) for (const ws of s.sockets) ws.close(1000, "vm deleted");
        for (const identity of identities.values()) identity.grants.delete(vm.data.id);
        return { status: 204 };
      }
      if (rest === "/start" && method === "POST") {
        if (vm.data.state === "paused" || vm.data.state === "stopped") transition(vm, "starting", "running", options.startTransitionReads);
        return json(vmView(vm));
      }
      if (rest === "/pause" && method === "POST") {
        if (vm.data.state === "running") transition(vm, "pausing", "paused", options.pauseTransitionReads);
        return json(vmView(vm));
      }
      if (rest === "/exec-await" && method === "POST") return execRoute(path, await body(), auth);
      if (rest === "/snapshot" && method === "POST") {
        const b = await body();
        const slug = typeof b.slug === "string" ? b.slug : null;
        if (slug && findSnapshot(slug)) return err(409, "CONFLICT", "snapshot slug taken");
        const snap = makeSnapshot(vm.data.id, slug, typeof b.displayName === "string" ? b.displayName : null);
        return json({ snapshotId: snap.id, sourceVmId: vm.data.id, snapshot: snap });
      }
      if (rest.startsWith("/fs/")) return fsRoute(vm, rest, method, q, req);
      if (rest === "/pty/sessions" && method === "GET") {
        const user = q.get("linuxUser");
        const sessions = [...vm.pty.values()]
          .filter((s) => !user || s.linuxUser === user)
          .map((s) => ({ sessionId: s.id, state: "running", createdUnix: s.createdUnix, cols: 80, rows: 24, linuxUser: s.linuxUser, slug: s.slug }));
        return json({ sessions });
      }
      if ((m = rest.match(/^\/pty\/sessions\/([^/]+)$/)) && method === "DELETE") {
        const s = findPty(vm, decodeURIComponent(m[1]!), q.get("linuxUser"));
        if (!s) return err(404, "PTY_SESSION_NOT_FOUND", "no such session");
        vm.pty.delete(s.id);
        for (const ws of s.sockets) ws.close(1000, "closed");
        return json({ sessionId: s.id });
      }
      return err(404, "NOT_FOUND", "no route");
    }

    // ---- snapshots
    if (path === "/v5/snapshots" && method === "GET") {
      const list = [...snapshots.values()];
      return json({ snapshots: list, totalCount: list.length });
    }
    if ((m = path.match(/^\/v5\/snapshots\/([^/]+)$/))) {
      const snap = findSnapshot(decodeURIComponent(m[1]!));
      if (!snap) return err(404, "SNAPSHOT_NOT_FOUND", "snapshot not found");
      if (method === "GET") return json(snap);
      if (method === "DELETE") {
        snapshots.delete(snap.id);
        return { status: 204 };
      }
      if (method === "PATCH") {
        const b = await body();
        if (typeof b.slug === "string") {
          if (b.slug && findSnapshot(b.slug) && findSnapshot(b.slug) !== snap) return err(409, "CONFLICT", "slug taken");
          snap.slug = b.slug || null;
        }
        return json(snap);
      }
    }

    // ---- identities
    if (path === "/v5/identities" && method === "POST") {
      const b = await body();
      const identity: Identity = { id: rid("id-"), managed: b.managed === true, tokens: new Map(), grants: new Map() };
      identities.set(identity.id, identity);
      return json({ id: identity.id, managed: identity.managed });
    }
    if (path === "/v5/identities" && method === "GET") {
      const list = [...identities.values()].map((i) => ({ id: i.id, managed: i.managed }));
      return json({ identities: list, total: list.length });
    }
    if ((m = path.match(/^\/v5\/identities\/([^/]+)(\/.*)?$/))) {
      const identity = identities.get(decodeURIComponent(m[1]!));
      if (!identity) return err(404, "IDENTITY_NOT_FOUND", "identity not found");
      const rest = m[2] ?? "";
      if (rest === "" && method === "GET") return json({ id: identity.id, accountId: "acct-mock", managed: identity.managed });
      if (rest === "" && method === "DELETE") {
        identities.delete(identity.id);
        return { status: 204 };
      }
      if (rest === "/tokens" && method === "POST") {
        const b = await body();
        const t = { id: rid("tok-"), token: `fit_${randomBytes(24).toString("hex")}`, expiresAt: (b.expiresAt as string | null | undefined) ?? null };
        identity.tokens.set(t.id, { token: t.token, expiresAt: t.expiresAt });
        return json(t);
      }
      if (rest === "/tokens" && method === "GET") return json([...identity.tokens].map(([id, t]) => ({ id, expiresAt: t.expiresAt })));
      if ((m = rest.match(/^\/tokens\/([^/]+)$/)) && method === "DELETE") {
        identity.tokens.delete(decodeURIComponent(m[1]!));
        return { status: 204 };
      }
      if (rest === "/permissions/vm" && method === "GET") return json([...identity.grants.values()]);
      if (rest === "/permissions/vm" && method === "POST") {
        const b = await body();
        const vm = findVm(String(b.vmId));
        if (!vm) return err(404, "VM_NOT_FOUND", "VM not found");
        if (identity.grants.has(vm.data.id)) return err(409, "CONFLICT", "grant exists");
        const grant = {
          id: rid("perm-"),
          identityId: identity.id,
          vmId: vm.data.id,
          allowedLinuxUsers: (b.allowedLinuxUsers as string[] | null | undefined) ?? null,
          grantedAt: now(),
          grantedBy: "api-key",
        };
        identity.grants.set(vm.data.id, grant);
        return json(grant);
      }
      if ((m = rest.match(/^\/permissions\/vm\/([^/]+)$/))) {
        const grant = identity.grants.get(decodeURIComponent(m[1]!));
        if (!grant) return err(404, "PERMISSION_NOT_FOUND", "no grant");
        if (method === "GET") return json(grant);
        if (method === "PATCH") {
          grant.allowedLinuxUsers = ((await body()).allowedLinuxUsers as string[] | null) ?? null;
          return json(grant);
        }
        if (method === "DELETE") {
          identity.grants.delete(grant.vmId);
          return { status: 204 };
        }
      }
    }
    return err(404, "NOT_FOUND", `no route ${method} ${path}`);
  }

  function createVm(b: Record<string, unknown>): MockResponse {
    if (!b.firewall || !Array.isArray((b.firewall as { rules?: unknown }).rules)) return err(400, "INVALID_REQUEST", "firewall required");
    const slug = (b.slug as string | null | undefined) ?? null;
    if (slug !== null && (slug.length > 63 || !SLUG_RE.test(slug))) return err(400, "INVALID_REQUEST", "bad slug");
    if (slug && vmBySlug(slug)) return err(409, "CONFLICT", "slug already in use");
    const metadata = (b.metadata as Record<string, string> | undefined) ?? {};
    if (Object.keys(metadata).length > 64 || Object.entries(metadata).some(([k, v]) => k.length > 63 || v.length > 63)) {
      return err(400, "INVALID_REQUEST", "metadata too large");
    }
    const snapshotId = (b.snapshotId as string | null | undefined) ?? "freestyle/ubuntu";
    if (!snapshotId.startsWith("freestyle/") && !findSnapshot(snapshotId)) return err(404, "SNAPSHOT_NOT_FOUND", "snapshot not found");
    const id = rid("vm-");
    const vm: MockVm = {
      data: {
        id,
        state: "running",
        slug,
        displayName: (b.displayName as string | undefined) ?? null,
        resources: { cpu: 4, memory: 8192, storage: 32768 },
        snapshotId: findSnapshot(snapshotId)?.id ?? snapshotId,
        idleTimeoutSeconds: (b.idleTimeoutSeconds as number | null | undefined) ?? null,
        autoDeleteSeconds: plan.vmAutoDeleteSeconds,
        autoDeleteFromPlan: plan.vmAutoDeleteSeconds !== null,
        ttlSeconds: (b.ttlSeconds as number | undefined) ?? null,
        metadata,
        vpcs: [],
        networks: [],
        createdAt: now(),
        updatedAt: now(),
      },
      guest: new FakeGuest(),
      pty: new Map(),
      nextPty: 1,
      settleIn: 0,
    };
    vms.set(id, vm);
    return json({ ...vmView(vm), firewallRules: [], tlsRules: [] });
  }

  function makeSnapshot(sourceVmId: string, slug: string | null, displayName: string | null) {
    const snap = {
      id: rid("sh-"),
      sourceVmId,
      slug,
      displayName,
      accountId: "acct-mock",
      public: false,
      autoDeleteSeconds: plan.snapshotAutoDeleteSeconds,
      autoDeleteFromPlan: plan.snapshotAutoDeleteSeconds !== null,
      createdAt: now(),
      updatedAt: now(),
    };
    snapshots.set(snap.id, snap);
    return snap;
  }

  function execRoute(path: string, b: Record<string, unknown>, auth: Auth): MockResponse {
    const vm = findVm(decodeURIComponent(path.split("/")[3]!));
    if (!vm) return err(404, "VM_NOT_FOUND", "VM not found");
    const record: ExecRecord = { vmId: vm.data.id, auth: auth.kind, body: b as ExecRecord["body"], script: null, result: { statusCode: null } };
    if (vm.data.state !== "running") return err(409, "VM_NOT_RUNNING", "VM is not running");
    const env = (b.env as Record<string, string> | undefined) ?? {};
    if (Object.keys(env).some((k) => !ENV_KEY_RE.test(k))) return err(400, "INVALID_REQUEST", "env keys must be POSIX names");
    const user = (b.linuxUser as string | undefined) ?? "ubuntu";
    if (!vm.guest.users.has(user)) return err(400, "LINUX_USER_NOT_FOUND", "no such linux user");
    const timeoutMs = (b.timeoutMs as number | undefined) ?? 30_000;
    let result: ScriptResult = { statusCode: 127, stdout: "", stderr: "command not found\n" };
    if (b.command === RUN_SCRIPT_COMMAND && typeof b.stdin === "string") {
      const script = Buffer.from(b.stdin, "base64").toString("utf8");
      const name = SCRIPT_BY_HASH.get(new Bun.CryptoHasher("sha256").update(script).digest("hex")) ?? null;
      record.script = name;
      if (name) result = vm.guest.run({ script: name, user, env });
    }
    if ((result.durationMs ?? 0) > timeoutMs) result = { statusCode: null, stdout: result.stdout, stderr: result.stderr };
    record.result = { statusCode: result.statusCode };
    execLog.push(record);
    return json({ stdout: result.stdout, stderr: result.stderr, statusCode: result.statusCode });
  }

  async function fsRoute(vm: MockVm, rest: string, method: string, q: URLSearchParams, req: Request): Promise<MockResponse> {
    const g = vm.guest;
    const op = rest.slice(4);
    const path = checkPath(q.get("path") ?? (method === "POST" ? ((await req.clone().json()) as { path?: string }).path ?? null : null));
    if (!path) return err(400, "INVALID_PATH", "path must be absolute");
    const wake = () => {
      if (vm.data.state !== "running") transition(vm, "starting", "running", 0);
    };
    if (op === "read" && method === "GET") {
      const file = g.files.get(path);
      if (!file) return err(404, "FILE_NOT_FOUND", "no such file");
      const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
      if (!range) return { status: 200, bytes: file.data };
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : file.data.length - 1;
      if (start >= file.data.length && file.data.length > 0) return err(416, "RANGE_NOT_SATISFIABLE", "range");
      return { status: 206, bytes: file.data.subarray(start, end + 1) };
    }
    if (op === "write" && method === "PUT") {
      wake();
      g.writeFile(path, new Uint8Array(await req.arrayBuffer()), { mode: q.get("mode") ? Number(q.get("mode")) : undefined, owner: "root" });
      return { status: 204 };
    }
    if (op === "dir" && method === "GET") {
      if (!g.dirs.has(path)) return err(404, "FILE_NOT_FOUND", "no such directory");
      return json({ entries: g.list(path) });
    }
    if (op === "exists" && method === "GET") return json({ exists: g.files.has(path) || g.dirs.has(path) });
    if (op === "stat" && method === "GET") {
      const file = g.files.get(path);
      if (file) {
        return json({
          size: file.data.length,
          isFile: !file.symlink,
          isDirectory: false,
          isSymlink: file.symlink === true,
          permissions: `0${file.mode.toString(8)}`,
          owner: file.owner,
          group: file.owner,
          modified: new Date(file.mtime).toISOString(),
        });
      }
      if (g.dirs.has(path)) {
        return json({ size: 4096, isFile: false, isDirectory: true, isSymlink: false, permissions: "0755", owner: "root", group: "root", modified: now() });
      }
      return err(404, "FILE_NOT_FOUND", "no such file");
    }
    if (op === "mkdir" && method === "POST") {
      wake();
      g.mkdirp(path);
      return { status: 204 };
    }
    if (op === "remove" && method === "DELETE") {
      wake();
      g.remove(path);
      return { status: 204 };
    }
    return err(404, "NOT_FOUND", "no fs route");
  }

  function findPty(vm: MockVm, selector: string, linuxUser: string | null): MockPty | undefined {
    const s = /^\d+$/.test(selector) ? vm.pty.get(Number(selector)) : [...vm.pty.values()].find((p) => p.slug === selector);
    if (s && linuxUser && s.linuxUser !== linuxUser) return undefined;
    return s;
  }

  function createPty(vm: MockVm, slug: string | null, linuxUser: string, exec: string | null): MockPty {
    const s: MockPty = {
      id: vm.nextPty++,
      slug,
      linuxUser,
      exec,
      scrollback: [],
      sockets: new Set(),
      inputs: [],
      resizes: [],
      signals: [],
      createdUnix: Math.floor(Date.now() / 1000),
    };
    vm.pty.set(s.id, s);
    return s;
  }

  function appendOutput(s: MockPty, bytes: Uint8Array) {
    s.scrollback.push(bytes);
    while (s.scrollback.reduce((n, b) => n + b.length, 0) > 64 * 1024) s.scrollback.shift();
    for (const ws of s.sockets) ws.send(bytes);
  }

  function toResponse(r: MockResponse): Response {
    const headers = new Headers(r.headers);
    if (r.bytes) {
      headers.set("content-type", "application/octet-stream");
      return new Response(r.bytes, { status: r.status, headers });
    }
    if (r.body === undefined || r.status === 204) return new Response(null, { status: r.status, headers });
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(r.body), { status: r.status, headers });
  }

  const server: Server<PtySocketData> = Bun.serve<PtySocketData>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const auth = authenticate(req, url);
      const log = (status: number) => requestLog.push({ method: req.method, path: url.pathname, status });
      if (!auth) {
        log(401);
        return toResponse(err(401, "UNAUTHORIZED", "missing or invalid credentials"));
      }

      // PTY WebSocket upgrades.
      const ptyMatch = url.pathname.match(/^\/v5\/vms\/([^/]+)\/pty(?:\/sessions\/([^/]+))?$/);
      if (ptyMatch && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const vm = findVm(decodeURIComponent(ptyMatch[1]!));
        if (!vm) return toResponse(err(404, "VM_NOT_FOUND", "VM not found"));
        const linuxUser = url.searchParams.get("linuxUser") ?? "ubuntu";
        if (auth.kind === "identity" && !identityAllowed(auth.identity, "GET", url.pathname, url.searchParams.get("linuxUser") ?? undefined)) {
          log(403);
          return toResponse(err(403, "FORBIDDEN", "identity not permitted"));
        }
        if (vm.data.state !== "running") return toResponse(err(409, "VM_NOT_RUNNING", "VM is not running"));
        let session: MockPty | undefined;
        let created = false;
        if (ptyMatch[2]) {
          session = findPty(vm, decodeURIComponent(ptyMatch[2]), url.searchParams.get("linuxUser"));
          if (!session) return toResponse(err(404, "PTY_SESSION_NOT_FOUND", "no such session"));
        } else {
          const slug = url.searchParams.get("slug");
          session = slug ? findPty(vm, slug, null) : undefined;
          if (session && session.linuxUser !== linuxUser) return toResponse(err(409, "CONFLICT", "slug owned by another user"));
          if (!session) {
            session = createPty(vm, slug, linuxUser, url.searchParams.get("exec"));
            created = true;
          }
        }
        // Browsers offer ["freestyle-pty", "freestyle-identity.<b64>"]; Node clients authenticate by header and offer none.
        const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
        const protocol = offered.includes("freestyle-pty") ? "freestyle-pty" : undefined;
        if (srv.upgrade(req, { data: { vmId: vm.data.id, sessionId: session.id, created }, headers: protocol ? { "sec-websocket-protocol": protocol } : undefined })) {
          log(101);
          return undefined;
        }
        return toResponse(err(400, "UPGRADE_FAILED", "upgrade failed"));
      }

      let script: string | null = null;
      if (url.pathname.endsWith("/exec-await")) {
        try {
          const b = (await req.clone().json()) as { stdin?: string };
          if (b.stdin) script = SCRIPT_BY_HASH.get(new Bun.CryptoHasher("sha256").update(Buffer.from(b.stdin, "base64").toString("utf8")).digest("hex")) ?? null;
        } catch {
          /* not json */
        }
      }
      const fault = takeFault(req.method, url.pathname, script);
      if (fault?.mode === "before") {
        log(fault.status ?? 503);
        return toResponse(err(fault.status ?? 503, "INJECTED_FAULT", "injected failure"));
      }

      const bg = req.headers.has(BACKGROUND_HEADER)
        ? background.find((b) => b.method === req.method && b.path.test(url.pathname))
        : undefined;
      if (bg) {
        const id = rid("bg-");
        const entry: { done: boolean; response?: MockResponse } = { done: false };
        backgroundRequests.set(id, entry);
        // Do the work now (the request body is gone once we answer); reveal the result later.
        const result = await route(req, url, auth).catch((e) => err(500, "INTERNAL", String(e)));
        setTimeout(() => Object.assign(entry, { done: true, response: result }), bg.delayMs);
        log(202);
        return toResponse({ status: 202, body: { requestId: id }, headers: { [REQUEST_ID_HEADER]: id } });
      }

      let response: MockResponse;
      try {
        response = await route(req, url, auth);
      } catch (e) {
        response = err(500, "INTERNAL", String(e));
      }
      if (fault?.mode === "after") {
        log(fault.status ?? 502);
        return toResponse(err(fault.status ?? 502, "INJECTED_FAULT", "response lost after effect"));
      }
      log(response.status);
      return toResponse(response);
    },
    websocket: {
      open(ws) {
        const vm = vms.get(ws.data.vmId);
        const s = vm?.pty.get(ws.data.sessionId);
        if (!vm || !s) return ws.close(1011, "gone");
        s.sockets.add(ws);
        ws.send(JSON.stringify({ type: "sessionInfo", sessionId: s.id, slug: s.slug ?? undefined, created: ws.data.created }));
        if (s.scrollback.length > 0) {
          ws.send(JSON.stringify({ type: "replayStart", exact: true }));
          for (const chunk of s.scrollback) ws.send(chunk);
          ws.send(JSON.stringify({ type: "replayEnd" }));
        }
      },
      message(ws, message) {
        const s = vms.get(ws.data.vmId)?.pty.get(ws.data.sessionId);
        if (!s) return;
        if (typeof message === "string") {
          try {
            const msg = JSON.parse(message) as { type: string; cols?: number; rows?: number; signal?: string };
            if (msg.type === "resize") s.resizes.push({ cols: msg.cols!, rows: msg.rows! });
            if (msg.type === "signal") s.signals.push(msg.signal!);
          } catch {
            /* ignore */
          }
          return;
        }
        const bytes = new Uint8Array(message);
        s.inputs.push(bytes);
        appendOutput(s, bytes);
      },
      close(ws) {
        vms.get(ws.data.vmId)?.pty.get(ws.data.sessionId)?.sockets.delete(ws);
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    apiKey,
    vms,
    snapshots,
    identities,
    execLog,
    requestLog,
    faults,
    background,
    plan,
    options,
    vmBySlug,
    createPtySession(vmId, opts) {
      const vm = vms.get(vmId);
      if (!vm) throw new Error("no vm");
      const s = createPty(vm, opts.slug, opts.linuxUser, null);
      if (opts.output) s.scrollback.push(new TextEncoder().encode(opts.output));
      return s;
    },
    ptyOutput(vmId, sessionId, text) {
      const s = vms.get(vmId)?.pty.get(sessionId);
      if (s) appendOutput(s, new TextEncoder().encode(text));
    },
    async stop() {
      await server.stop(true);
    },
  };
}
