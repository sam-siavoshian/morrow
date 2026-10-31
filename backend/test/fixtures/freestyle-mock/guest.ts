// Simulated guest OS behind the mock API: a file tree, Linux users, systemd
// units, and one simulator per backend/vm script that reproduces that script's
// contract (inputs it validates, effects, JSON it prints). The scripts' own
// logic is exercised for real in Docker; this only stands in for the VM.
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GuestFile {
  data: Uint8Array;
  mode: number;
  owner: string;
  mtime: number;
  symlink?: boolean;
}

export interface ScriptResult {
  statusCode: number | null;
  stdout: string;
  stderr: string;
  /** Simulated wall time; above the exec timeout the API reports statusCode null. */
  durationMs?: number;
}

export interface ScriptCall {
  script: string;
  user: string;
  env: Record<string, string>;
}

export type CliAuth = { installed: boolean; auth: "ok" | "auth_required" | "unknown"; source?: "status_command" | "credential_file" | "none" };

const VM_DIR = join(import.meta.dir, "../../../vm");

/** sha256(script body) -> script name, so the mock knows which script an exec carries. */
export const SCRIPT_BY_HASH = new Map<string, string>(
  readdirSync(VM_DIR)
    .filter((f) => f.endsWith(".sh"))
    .map((f) => [createHash("sha256").update(readFileSync(join(VM_DIR, f), "utf8")).digest("hex"), f.slice(0, -3)]),
);

const enc = new TextEncoder();
const dec = new TextDecoder();

const MOCK_CLIS = ["claude", "codex", "opencode", "cursor", "gemini", "grok"] as const;
type MockCli = (typeof MOCK_CLIS)[number];

export class FakeGuest {
  users = new Set<string>(["root", "ubuntu"]);
  files = new Map<string, GuestFile>();
  dirs = new Set<string>(["/", "/home", "/home/ubuntu", "/etc", "/var", "/var/lib", "/tmp"]);
  units = new Map<string, { enabled: boolean; active: boolean; restarts: number }>();
  useraddCount = 0;
  clones = new Map<string, number>();
  goldenSteps: string[] = [];
  cliAuth = new Map<string, Partial<Record<MockCli, CliAuth>>>();
  /** One-shot behaviors for the next matching script call. */
  faults = { killedLeavingCredential: false, pushRejected: false, githubDenied: false };
  /** Every token a root git op read from its credential file. */
  tokensUsed: string[] = [];
  /** `<user>:<owner__name>:<branch>` -> branch tip in the engineer's repo. */
  tips = new Map<string, string>();
  /** `<owner/name>:<branch>` -> SHA pushed to GitHub. */
  pushed = new Map<string, string>();
  test = { exitCode: 0, output: "ok\n", durationMs: 10 };
  /** What configure-node reports for /proc hidepid (false: the VM refused the remount). */
  procHidden = true;
  /** What a CHECK_CONFLICTS commit reports as unresolved (a resolver's unfinished merge); nothing is committed then. */
  unresolved: string[] = [];
  /** Uncommitted changes `OP=status` reports for every worktree (a commit clears them). Binary: null counts. */
  changes: Array<{ letter: "A" | "M" | "D"; path: string; added: number | null; deleted: number | null }> = [];
  /** Unmerged paths `OP=status` reports. */
  conflicted: string[] = [];

  mkdirp(path: string): void {
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += `/${part}`;
      this.dirs.add(cur);
    }
  }

  writeFile(path: string, content: string | Uint8Array, opts: { mode?: number; owner?: string } = {}): void {
    this.mkdirp(path.slice(0, path.lastIndexOf("/")) || "/");
    const prev = this.files.get(path);
    this.files.set(path, {
      data: typeof content === "string" ? enc.encode(content) : content,
      mode: opts.mode ?? prev?.mode ?? 0o600,
      owner: opts.owner ?? prev?.owner ?? "root",
      mtime: Date.now(),
    });
  }

  readText(path: string): string | undefined {
    const file = this.files.get(path);
    return file ? dec.decode(file.data) : undefined;
  }

  remove(path: string): void {
    for (const key of [...this.files.keys()]) if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    for (const key of [...this.dirs]) if (key === path || key.startsWith(`${path}/`)) this.dirs.delete(key);
  }

  list(dir: string): { name: string; kind: string }[] {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    const names = new Map<string, string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) names.set(key.slice(prefix.length), "file");
    }
    for (const key of this.dirs) {
      if (key !== dir && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) names.set(key.slice(prefix.length), "directory");
    }
    return [...names].map(([name, kind]) => ({ name, kind }));
  }

  credentialFiles(): string[] {
    return this.list("/var/lib/morrow/cred").map((e) => e.name).filter((n) => n.startsWith("cred."));
  }

  run(call: ScriptCall): ScriptResult {
    const sim = SIMULATORS[call.script];
    if (!sim) return { statusCode: 127, stdout: "", stderr: "unknown script" };
    return sim(this, call);
  }
}

const ok = (stdout: string, durationMs = 5): ScriptResult => ({ statusCode: 0, stdout: `${stdout}\n`, stderr: "", durationMs });
const fail = (message: string, code = 1): ScriptResult => ({ statusCode: code, stdout: "", stderr: `error: ${message}\n`, durationMs: 5 });

const USER_RE = /^u[a-f0-9]{12}$/;
/** The Relay broker's own account, paired with an engineer: u<hex> runs the CLIs, r<hex> runs the broker. */
const RELAY_USER_RE = /^r[a-f0-9]{12}$/;
const relayUserOf = (u: string): string => `r${u.slice(1)}`;
const UNIT = "morrow-relay-node.service";

const SIMULATORS: Record<string, (g: FakeGuest, c: ScriptCall) => ScriptResult> = {
  "bootstrap-user"(g, { user, env }) {
    if (user !== "root") return fail("must run as root");
    const u = env.MORROW_USER ?? "";
    if (!USER_RE.test(u)) return fail("invalid user");
    const created = !g.users.has(u);
    if (created) {
      g.users.add(u);
      g.useraddCount++;
    }
    for (const d of [`/home/${u}/work/.worktrees`, "/var/lib/morrow/cred", "/var/lib/morrow/git-home"]) {
      g.mkdirp(d);
    }
    return ok(JSON.stringify({ created }));
  },

  "configure-node"(g, { user, env }) {
    if (user !== "root") return fail("must run as root");
    const u = env.MORROW_USER ?? "";
    if (!USER_RE.test(u)) return fail("invalid user");
    const unit = g.units.get(UNIT) ?? { enabled: false, active: false, restarts: 0 };
    if (env.ACTION === "remove") {
      g.remove("/etc/agent-relay/node.env");
      g.remove(`/etc/systemd/system/${UNIT}`);
      g.remove(`/etc/sudoers.d/morrow-relay-${relayUserOf(u)}`);
      g.units.set(UNIT, { ...unit, enabled: false, active: false });
      return ok(JSON.stringify({ changed: true, active: false }));
    }
    if (env.ACTION === "restart") {
      if (!unit.enabled) return ok(JSON.stringify({ restarted: false, active: unit.active }));
      g.units.set(UNIT, { ...unit, active: true, restarts: unit.restarts + 1 });
      return ok(JSON.stringify({ restarted: true, active: true }));
    }
    if (env.ACTION !== "apply") return fail("invalid action");
    const harnesses = env.HARNESSES ?? "";
    if (!/^n-[a-f0-9]{12}$/.test(env.NODE_NAME ?? "")) return fail("invalid node name");
    if (harnesses && !/^(claude|codex|opencode|cursor|gemini|grok)(,(claude|codex|opencode|cursor|gemini|grok))*$/.test(harnesses)) return fail("invalid harness list");
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(env.RELAY_WORKSPACE_KEY ?? "")) return fail("invalid workspace key");
    const worker = Buffer.from(env.RELAY_WORKER_SCRIPT ?? "", "base64").toString("utf8");
    if (!/^[A-Za-z0-9+/=]{100,65536}$/.test(env.RELAY_WORKER_SCRIPT ?? "") || !worker.startsWith("#!/usr/bin/env bash"))
      return fail("invalid relay worker script");
    if (!g.users.has(u)) return fail("user does not exist");
    const r = relayUserOf(u);
    g.users.add(r);
    g.mkdirp(`/var/lib/morrow/relay/${r}/relay-node`);
    g.writeFile("/opt/morrow/bin/relay-worker", worker, { mode: 0o755, owner: "root" });
    g.writeFile(`/etc/sudoers.d/morrow-relay-${r}`, `${r} ALL=(${u}) NOPASSWD: /opt/morrow/bin/relay-worker exec *\n`, { mode: 0o440, owner: "root" });
    const envFile = `RELAY_WORKSPACE_KEY=${env.RELAY_WORKSPACE_KEY}${env.RELAY_BASE_URL ? `\nRELAY_BASE_URL=${env.RELAY_BASE_URL}` : ""}\n`;
    const unitFile = `User=${r}\nSupplementaryGroups=${u}\nExecStart=/usr/local/bin/agent-relay node up --broker-name ${env.NODE_NAME} --no-spawn\nEnvironment=AGENT_RELAY_NODE_HARNESSES=${harnesses}\nEnvironment=AGENT_RELAY_NODE_MAX_AGENTS=${env.MAX_AGENTS}\n`;
    let changed = false;
    if (g.readText("/etc/agent-relay/node.env") !== envFile) {
      g.writeFile("/etc/agent-relay/node.env", envFile, { mode: 0o600, owner: "root" });
      changed = true;
    }
    if (g.readText(`/etc/systemd/system/${UNIT}`) !== unitFile) {
      g.writeFile(`/etc/systemd/system/${UNIT}`, unitFile, { mode: 0o644, owner: "root" });
      changed = true;
    }
    if (!harnesses) {
      g.units.set(UNIT, { ...unit, enabled: false, active: false });
    } else {
      const restart = changed || !unit.active;
      g.units.set(UNIT, { enabled: true, active: true, restarts: unit.restarts + (restart ? 1 : 0) });
    }
    return ok(JSON.stringify({ changed, active: g.units.get(UNIT)!.active, procHidden: g.procHidden }));
  },

  git(g, { user, env }) {
    const repo = env.REPO_FULL_NAME ?? "";
    const repoDir = repo.replace("/", "__");
    const repoOk = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo);
    // Root ops: the token comes only from the root-only file named by CRED_NAME, which the script removes.
    const rootOp = (): { u: string; mirror: string } | ScriptResult => {
      if (user !== "root") return fail(`${env.OP} must run as root`);
      const u = env.MORROW_USER ?? "";
      if (!USER_RE.test(u) || !repoOk) return fail("invalid input");
      const name = env.CRED_NAME ?? "";
      if (name) {
        if (!/^cred\.[a-f0-9]{32}$/.test(name)) return fail("invalid credential name");
        const file = `/var/lib/morrow/cred/${name}`;
        const token = g.readText(file);
        if (token === undefined) return fail("credential file missing");
        g.tokensUsed.push(token);
        if (g.faults.killedLeavingCredential) {
          // The exec was killed mid-op: the script's trap never ran.
          g.faults.killedLeavingCredential = false;
          return { statusCode: null, stdout: "", stderr: "", durationMs: 400_000 };
        }
        g.remove(file);
      }
      if (g.faults.githubDenied) {
        g.faults.githubDenied = false;
        return ok(JSON.stringify(env.OP === "publish" ? { pushed: false, reason: "auth" } : { [env.OP === "clone" ? "cloned" : "synced"]: false, reason: "auth" }));
      }
      const mirror = `/var/lib/morrow/mirrors/${u}/${repoDir}.git`;
      g.mkdirp(mirror);
      return { u, mirror };
    };
    switch (env.OP) {
      case "sync": {
        const r = rootOp();
        if ("statusCode" in r) return r;
        return ok(JSON.stringify({ synced: true }));
      }
      case "clone": {
        const r = rootOp();
        if ("statusCode" in r) return r;
        const dest = `/home/${r.u}/work/${repoDir}`;
        if (g.dirs.has(`${dest}/.git`)) return ok(JSON.stringify({ cloned: false }));
        g.mkdirp(`${dest}/.git`);
        g.clones.set(repo, (g.clones.get(repo) ?? 0) + 1);
        return ok(JSON.stringify({ cloned: true }), 2_000);
      }
      case "publish": {
        const r = rootOp();
        if ("statusCode" in r) return r;
        const sha = g.tips.get(`${r.u}:${repoDir}:${env.BRANCH}`);
        if (!sha) return fail("could not read the branch from the engineer's repository");
        if (g.faults.pushRejected) {
          g.faults.pushRejected = false;
          return ok(JSON.stringify({ sha, pushed: false, reason: "rejected" }));
        }
        g.pushed.set(`${repo}:${env.BRANCH}`, sha);
        return ok(JSON.stringify({ sha, pushed: true }));
      }
      case "worktree": {
        if (user === "root") return fail("worktree must not run as root");
        if (!repoOk) return fail("invalid repo");
        const main = `/home/${user}/work/${repoDir}`;
        if (!g.dirs.has(`${main}/.git`)) return fail("repository is not cloned");
        if (!g.dirs.has(`/var/lib/morrow/mirrors/${user}/${repoDir}.git`)) return fail("mirror missing");
        const wt = env.WT_PATH ?? "";
        if (!wt.startsWith(`/home/${user}/work/.worktrees/${repoDir}/`)) return fail("worktree path outside the worktree root");
        const created = !g.dirs.has(`${wt}/.git`);
        g.mkdirp(`${wt}/.git`);
        const head = createHash("sha1").update(env.BRANCH ?? "").digest("hex");
        if (!g.tips.has(`${user}:${repoDir}:${env.BRANCH}`)) g.tips.set(`${user}:${repoDir}:${env.BRANCH}`, head);
        return ok(JSON.stringify({ path: wt, head, created, state: "ok" }));
      }
      case "commit": {
        if (user === "root") return fail("commit must not run as root");
        const wt = env.WT_PATH ?? "";
        if (!g.dirs.has(`${wt}/.git`)) return fail("worktree missing");
        const dir = wt.slice(`/home/${user}/work/.worktrees/`.length).split("/")[0];
        const checked = env.CHECK_CONFLICTS === "1";
        if (checked && g.unresolved.length > 0) {
          return ok(JSON.stringify({ sha: g.tips.get(`${user}:${dir}:${env.BRANCH}`) ?? "0".repeat(40), committed: false, unresolved: g.unresolved }));
        }
        const sha = randomBytes(20).toString("hex");
        g.tips.set(`${user}:${dir}:${env.BRANCH}`, sha);
        g.changes = [];
        // Older VMs print no `unresolved`; the backend reads a missing one as none.
        return ok(JSON.stringify(checked ? { sha, committed: true, unresolved: [] } : { sha, committed: true }));
      }
      case "status": {
        if (user === "root") return fail("status must not run as root");
        if (!repoOk) return fail("invalid repo");
        const wt = env.WT_PATH ?? "";
        if (!wt.startsWith(`/home/${user}/work/.worktrees/${repoDir}/`)) return fail("worktree path outside the worktree root");
        if (!g.dirs.has(`${wt}/.git`)) return ok(JSON.stringify({ exists: false }));
        const head = g.tips.get(`${user}:${repoDir}:${env.BRANCH}`) ?? "0".repeat(40);
        const b64 = (parts: string[]) => Buffer.from(parts.map((p) => `${p}\0`).join("")).toString("base64");
        return ok(
          JSON.stringify({
            exists: true,
            head,
            unpushed: g.pushed.get(`${repo}:${env.BRANCH}`) === head ? 0 : 1,
            names: b64(g.changes.flatMap((c) => [c.letter, c.path])),
            stats: b64(g.changes.map((c) => `${c.added ?? "-"}\t${c.deleted ?? "-"}\t${c.path}`)),
            conflicts: b64(g.conflicted),
          }),
        );
      }
      default:
        return fail("unknown op");
    }
  },

  probe(g, { user }) {
    if (user === "root") return fail("probe must run as the engineer");
    const states = g.cliAuth.get(user) ?? {};
    const cli = (name: MockCli) => {
      const s = states[name] ?? { installed: true, auth: "auth_required" as const };
      return {
        installed: s.installed,
        version: s.installed ? "1.0.0 (mock)" : null,
        auth: s.installed ? s.auth : "unknown",
        authSource: s.installed ? s.source ?? "status_command" : "none",
        credentialModifiedAt: s.auth === "ok" ? 1_700_000_000 : null,
      };
    };
    const active = g.units.get(UNIT)?.active ? "active" : "inactive";
    return ok(JSON.stringify({ v: 1, clis: Object.fromEntries(MOCK_CLIS.map((name) => [name, cli(name)])), relay: { installed: true, version: "14.0.0", node: active } }));
  },

  "run-test"(g, { user, env }) {
    if (user === "root") return { statusCode: 2, stdout: "", stderr: '{"error":"root"}\n' };
    const secs = Number(env.TEST_TIMEOUT_SECS);
    const max = Number(env.MAX_OUTPUT_BYTES);
    const timedOut = g.test.durationMs > secs * 1000;
    const full = enc.encode(g.test.output);
    const out = dec.decode(full.subarray(Math.max(0, full.length - max)));
    return {
      statusCode: 0,
      stdout: out,
      stderr: `${JSON.stringify({ exitCode: timedOut ? 124 : g.test.exitCode, timedOut, bytes: full.length })}\n`,
      durationMs: Math.min(g.test.durationMs, secs * 1000 + 5_000),
    };
  },

  "golden-setup"(g, { user, env }) {
    if (user !== "root") return fail("must run as root");
    const step = env.MORROW_GOLDEN_STEP ?? "all";
    if (!["gh", "relay", "bun", "morrow", "gemini", "cursor", "grok", "verify", "scrub", "all"].includes(step)) return fail("unknown step");
    if (step === "morrow" || step === "all") {
      const script = new Uint8Array(Buffer.from(env.MORROW_AGENT_B64 ?? "", "base64"));
      if (script.length === 0) return fail("MORROW_AGENT_B64 is not set");
      if (new Bun.CryptoHasher("sha256").update(script).digest("hex") !== env.MORROW_AGENT_SHA256) return fail("morrow-agent checksum mismatch");
    }
    g.goldenSteps.push(step);
    return ok(JSON.stringify({ ok: true, step }), 60_000);
  },

  logtail(g, { user, env }) {
    if (!RELAY_USER_RE.test(user)) return fail("must run as the Relay broker user");
    const name = env.AGENT_NAME ?? "";
    const max = Number(env.MAX_BYTES);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) return fail("invalid agent name");
    if (!/^[0-9]{1,5}$/.test(env.MAX_BYTES ?? "") || max < 1 || max > 65_536) return fail("invalid max bytes");
    const file = g.files.get(`/var/lib/morrow/relay/${user}/relay-node/.agentworkforce/relay/team/worker-logs/${name}.log`);
    if (!file) return ok(JSON.stringify({ found: false }));
    if (file.symlink) return ok(JSON.stringify({ unsafe: "symlink" }));
    if (file.owner !== user) return ok(JSON.stringify({ unsafe: "wrong_owner" }));
    const tail = file.data.subarray(Math.max(0, file.data.length - max));
    return ok(JSON.stringify({ found: true, size: file.data.length, mtime: Math.floor(file.mtime / 1000), b64: Buffer.from(tail).toString("base64") }));
  },
};
