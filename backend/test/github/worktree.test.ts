// The worktree status the web app's commit view reads: backend/vm/git.sh `OP=status` run for real with bash and
// git (as Freestyle exec runs it: script on stdin, values in env), the parser for its output, and the Freestyle
// wrapper against the Freestyle mock.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseStatusStreams, worktreeStatus, worktreePath, checkpointWorktree, ensureWorktree } from "../../src/integrations/freestyle/index.ts";
import { GITHUB_TOKEN, useMock } from "../freestyle/helpers.ts";

const VM_DIR = resolve(import.meta.dir, "../../vm");
const GNUBIN = "/opt/homebrew/opt/coreutils/libexec/gnubin";
const linux = process.platform === "linux";
const ready = linux || existsSync(GNUBIN);
if (!ready) console.warn("SKIP git.sh status: GNU coreutils not found (brew install coreutils)");

const b64 = (parts: string[]) => Buffer.from(parts.map((p) => `${p}\0`).join("")).toString("base64");

describe("parseStatusStreams", () => {
  test("joins names, counts and conflicts; binary files have null counts", () => {
    const out = parseStatusStreams({
      names: b64(["M", "src/a.ts", "A", "new file.txt", "D", "gone.txt", "M", "img.png", "M", "both.ts"]),
      stats: b64(["3\t1\tsrc/a.ts", "2\t0\tnew file.txt", "0\t4\tgone.txt", "-\t-\timg.png", "7\t0\tboth.ts"]),
      conflicts: b64(["both.ts", "only-unmerged.ts"]),
    });
    expect(out.truncated).toBe(false);
    expect(out.files).toEqual([
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
      { path: "new file.txt", status: "added", additions: 2, deletions: 0 },
      { path: "gone.txt", status: "deleted", additions: 0, deletions: 4 },
      { path: "img.png", status: "modified", additions: null, deletions: null },
      { path: "both.ts", status: "conflicted", additions: 7, deletions: 0 },
      { path: "only-unmerged.ts", status: "conflicted", additions: null, deletions: null },
    ]);
  });

  test("hostile paths are made safe to show; a cut stream is reported, its partial record dropped", () => {
    const out = parseStatusStreams({
      names: b64(["A", "evil‮gnp.exe", "A", "line\nbreak\u0007", "A", "x".repeat(800)]),
      stats: b64([]),
      conflicts: b64([]),
    });
    expect(out.files.map((f) => f.path)).toEqual(["evil�gnp.exe", "line�break�", `${"x".repeat(499)}…`]);
    const cut = Buffer.from(Array.from({ length: 3000 }, (_, i) => `M\0file-${i}.ts\0`).join("")).subarray(0, 32_769);
    const truncated = parseStatusStreams({ names: cut.toString("base64"), stats: "", conflicts: "" });
    expect(truncated.truncated).toBe(true);
    expect(truncated.files.length).toBe(500);
    expect(truncated.files.every((f) => /^file-\d+\.ts$/.test(f.path))).toBe(true);
  });

  test("garbage is ignored, not fatal", () => {
    expect(parseStatusStreams({ names: "!!!", stats: "@@", conflicts: "" })).toEqual({ files: [], truncated: false });
  });
});

describe.skipIf(!ready)("git.sh OP=status", () => {
  let home: string;
  let path: string;
  const USER_REPO = "acme/web";
  const BRANCH = "morrow/ab12/backend";
  let wt: string;

  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { cwd, env: { HOME: home, PATH: path } });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
  };
  async function status(env: Record<string, string> = {}) {
    const proc = Bun.spawn(["bash", "-s"], {
      stdin: Bun.file(join(VM_DIR, "git.sh")),
      env: { HOME: home, PATH: path, OP: "status", REPO_FULL_NAME: USER_REPO, BRANCH, WT_PATH: wt, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "morrow-gitstatus-"));
    path = [...(linux ? [] : [GNUBIN, "/opt/homebrew/bin"]), "/usr/bin", "/bin"].join(":");
    const main = join(home, "work", "acme__web");
    mkdirSync(main, { recursive: true });
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "keep.txt"), "a\nb\n");
    writeFileSync(join(main, "del.txt"), "x\n");
    writeFileSync(join(main, "mod.txt"), "m\n");
    git(main, "add", ".");
    git(main, "commit", "-qm", "init");
    // What the mirror last saw of the branch: the base commit.
    git(main, "update-ref", `refs/remotes/origin/${BRANCH}`, "HEAD");
    wt = worktreePath("u0123456789ab", USER_REPO, BRANCH).replace("/home/u0123456789ab", home);
    mkdirSync(join(home, "work", ".worktrees", "acme__web"), { recursive: true });
    git(main, "worktree", "add", "-q", "-b", BRANCH, wt, "HEAD");
    writeFileSync(join(wt, "local.txt"), "committed locally\n");
    git(wt, "add", "local.txt");
    git(wt, "commit", "-qm", "local");
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test("lists every uncommitted change, counts unpushed commits, and leaves the index alone", async () => {
    rmSync(join(wt, "del.txt"));
    writeFileSync(join(wt, "mod.txt"), "m\nn\n");
    git(wt, "add", "mod.txt"); // staged
    writeFileSync(join(wt, "new file.txt"), "new\nfile\n"); // untracked, with a space
    mkdirSync(join(wt, "sub"));
    writeFileSync(join(wt, "sub", "q.txt"), "q\n");
    writeFileSync(join(wt, "bin.dat"), new Uint8Array([0, 1, 2, 0, 255]));
    const before = git(wt, "status", "--porcelain");

    const res = await status();
    expect(res.code).toBe(0);
    const wire = JSON.parse(res.stdout.trim().split("\n").at(-1)!);
    expect(wire).toMatchObject({ exists: true, unpushed: 1 });
    expect(wire.head).toMatch(/^[0-9a-f]{40}$/);
    const parsed = parseStatusStreams(wire);
    expect(parsed.truncated).toBe(false);
    expect(parsed.files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "bin.dat", status: "added", additions: null, deletions: null },
      { path: "del.txt", status: "deleted", additions: 0, deletions: 1 },
      { path: "mod.txt", status: "modified", additions: 1, deletions: 0 },
      { path: "new file.txt", status: "added", additions: 2, deletions: 0 },
      { path: "sub/q.txt", status: "added", additions: 1, deletions: 0 },
    ]);
    // Read-only: the real index and the untracked files are exactly as they were.
    expect(git(wt, "status", "--porcelain")).toBe(before);
  });

  test("a missing worktree says so; paths outside the worktree root and bad branches are refused", async () => {
    const gone = await status({ WT_PATH: `${wt}-nope` });
    expect(JSON.parse(gone.stdout.trim())).toEqual({ exists: false });
    expect((await status({ WT_PATH: join(home, "work", "acme__web") })).code).not.toBe(0);
    expect((await status({ WT_PATH: join(home, "work", ".worktrees", "acme__web", "..", "..", "acme__web") })).code).not.toBe(0);
    expect((await status({ BRANCH: "-x" })).code).not.toBe(0);
    expect((await status({ BRANCH: "other" })).stderr).toContain("different branch");
  });
});

describe("worktreeStatus (Freestyle)", () => {
  const USER = "u0123456789ab";
  let ctx: ReturnType<typeof useMock>;
  beforeEach(() => {
    ctx = useMock();
  });
  afterEach(() => ctx.restore());

  test("runs as the engineer with no token; a commit clears the changes and the push clears unpushed", async () => {
    const { vmId } = await ctx.client.vms.create({ firewall: { rules: [] } });
    const guest = ctx.mock.vms.get(vmId)!.guest;
    guest.users.add(USER);
    guest.mkdirp(`/home/${USER}/work/acme__web/.git`);
    const target = { vmId, linuxUser: USER, repoFullName: "acme/web", branch: "morrow/ab12/backend" };
    expect(await worktreeStatus(target)).toEqual({ exists: false });

    await ensureWorktree({ ...target, baseBranch: "main", githubToken: null });
    guest.changes = [{ letter: "M", path: "src/a.ts", added: 1, deleted: 2 }];
    guest.conflicted = [];
    const st = await worktreeStatus(target);
    expect(st).toMatchObject({ exists: true, unpushed: 1, truncated: false, files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 2 }] });
    const exec = ctx.mock.execLog.at(-1)!;
    expect(exec.body.linuxUser).toBe(USER);
    expect(exec.body.env).toMatchObject({ OP: "status", BRANCH: "morrow/ab12/backend" });
    expect(JSON.stringify(exec.body)).not.toContain(GITHUB_TOKEN);

    await checkpointWorktree({ ...target, message: "web commit", githubToken: GITHUB_TOKEN, checkConflicts: true, author: { name: "Ada", email: "1+ada@users.noreply.github.com" } });
    expect(await worktreeStatus(target)).toMatchObject({ exists: true, unpushed: 0, files: [] });
    expect(guest.credentialFiles()).toEqual([]);
  });
});
