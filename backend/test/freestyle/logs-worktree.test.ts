import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkpointWorktree,
  ensureWorktree,
  readWorkerLogTail,
  relayUserFor,
  runTestCommand,
  workerLogPath,
  worktreePath,
} from "../../src/integrations/freestyle/index.ts";
import { GITHUB_TOKEN, useMock } from "./helpers.ts";

const USER = "u0123456789ab";
/** The broker's account: it writes the worker logs and the log reader runs as it. */
const RELAY_USER = relayUserFor(USER);
let ctx: ReturnType<typeof useMock>;
beforeEach(() => {
  ctx = useMock();
});
afterEach(() => ctx.restore());

async function vm() {
  const { vmId } = await ctx.client.vms.create({ firewall: { rules: [] } });
  const guest = ctx.mock.vms.get(vmId)!.guest;
  guest.users.add(USER);
  guest.users.add(RELAY_USER);
  return { vmId, guest };
}

describe("readWorkerLogTail", () => {
  test("returns at most 64 KiB, starting at a line boundary, read by the broker's own user", async () => {
    const { vmId, guest } = await vm();
    const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n") + "\n";
    guest.writeFile(workerLogPath(USER, "w-ab12-backend-e3"), lines, { owner: RELAY_USER });

    const tail = await readWorkerLogTail({ vmId, linuxUser: USER, agentName: "w-ab12-backend-e3" });
    expect(tail).not.toBeNull();
    expect(Buffer.byteLength(tail!.text)).toBeLessThanOrEqual(64 * 1024);
    expect(tail!.truncated).toBe(true);
    expect(tail!.text.startsWith("line ")).toBe(true);
    expect(tail!.text.endsWith("line 4999 " + "x".repeat(20) + "\n")).toBe(true);
    expect(tail!.size).toBe(Buffer.byteLength(lines));
    expect(Number.isNaN(Date.parse(tail!.modifiedAt))).toBe(false);
    const exec = ctx.mock.execLog.at(-1)!;
    expect(exec).toMatchObject({ script: "logtail", body: { linuxUser: RELAY_USER, env: { AGENT_NAME: "w-ab12-backend-e3", MAX_BYTES: "65536" } } });
  });

  test("small logs come back whole; missing logs are null", async () => {
    const { vmId, guest } = await vm();
    guest.writeFile(workerLogPath(USER, "w-1"), "hello\nworld\n", { owner: RELAY_USER });
    expect(await readWorkerLogTail({ vmId, linuxUser: USER, agentName: "w-1" })).toMatchObject({ text: "hello\nworld\n", truncated: false });
    expect(await readWorkerLogTail({ vmId, linuxUser: USER, agentName: "w-2" })).toBeNull();
  });

  test("custom bound is honored", async () => {
    const { vmId, guest } = await vm();
    guest.writeFile(workerLogPath(USER, "w-1"), "a\n".repeat(1000), { owner: RELAY_USER });
    const tail = await readWorkerLogTail({ vmId, linuxUser: USER, agentName: "w-1", maxBytes: 100 });
    expect(Buffer.byteLength(tail!.text)).toBeLessThanOrEqual(100);
    await expect(readWorkerLogTail({ vmId, linuxUser: USER, agentName: "w-1", maxBytes: 65 * 1024 })).rejects.toThrow("tail size");
  });

  test("refuses what the script reports as unsafe (a root or engineer file, a symlink)", async () => {
    const { vmId, guest } = await vm();
    guest.writeFile(workerLogPath(USER, "w-root"), "root:x:0:0", { owner: "root" });
    await expect(readWorkerLogTail({ vmId, linuxUser: USER, agentName: "w-root" })).rejects.toMatchObject({ kind: "unsafe_path" });
    // Workers run as the engineer; a file they could have written is not a broker log.
    guest.writeFile(workerLogPath(USER, "w-eng"), "planted", { owner: USER });
    await expect(readWorkerLogTail({ vmId, linuxUser: USER, agentName: "w-eng" })).rejects.toMatchObject({ kind: "unsafe_path" });
    guest.writeFile(workerLogPath(USER, "w-link"), "secret", { owner: RELAY_USER });
    guest.files.get(workerLogPath(USER, "w-link"))!.symlink = true;
    await expect(readWorkerLogTail({ vmId, linuxUser: USER, agentName: "w-link" })).rejects.toMatchObject({ kind: "unsafe_path" });
  });

  test("agent names cannot traverse paths", async () => {
    const { vmId } = await vm();
    for (const name of ["../../.claude/.credentials", "a/b", ".hidden", ""]) {
      await expect(readWorkerLogTail({ vmId, linuxUser: USER, agentName: name })).rejects.toThrow("Invalid agent name");
    }
  });
});

describe("worktrees", () => {
  const target = (vmId: string) => ({ vmId, linuxUser: USER, repoFullName: "acme/web", branch: "morrow/ab12/backend" });

  test("create, refresh, checkpoint and test as the engineer user", async () => {
    const { vmId, guest } = await vm();
    guest.mkdirp(`/home/${USER}/work/acme__web/.git`);
    const created = await ensureWorktree({ ...target(vmId), baseBranch: "main", githubToken: GITHUB_TOKEN });
    expect(created).toMatchObject({ path: worktreePath(USER, "acme/web", "morrow/ab12/backend"), created: true, state: "ok" });
    expect(created.path.startsWith(`/home/${USER}/work/.worktrees/acme__web/`)).toBe(true);
    const refreshed = await ensureWorktree({ ...target(vmId), baseBranch: "main", githubToken: GITHUB_TOKEN });
    expect(refreshed.created).toBe(false);

    const cp = await checkpointWorktree({ ...target(vmId), message: "morrow: checkpoint backend e3\n$(rm -rf ~)", githubToken: GITHUB_TOKEN });
    expect(cp.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(guest.pushed.get("acme/web:morrow/ab12/backend")).toBe(cp.sha);
    const ops = ctx.mock.execLog.filter((e) => e.script === "git").map((e) => [e.body.env!.OP, e.body.linuxUser]);
    // Network git (sync, publish) as root with the token file; worktree and commit as the engineer with no token.
    expect(ops).toEqual([
      ["sync", "root"],
      ["worktree", USER],
      ["sync", "root"],
      ["worktree", USER],
      ["commit", USER],
      ["publish", "root"],
    ]);
    const commit = ctx.mock.execLog.find((e) => e.body.env?.OP === "commit")!;
    expect(commit.body.command).not.toContain("rm -rf");
    expect(commit.body.env!.MESSAGE).toContain("$(rm -rf ~)");
    for (const e of ctx.mock.execLog) expect(JSON.stringify(e.body)).not.toContain(GITHUB_TOKEN);
    expect(guest.tokensUsed).toEqual([GITHUB_TOKEN, GITHUB_TOKEN, GITHUB_TOKEN]);
    expect(guest.credentialFiles()).toEqual([]);

    guest.test = { exitCode: 1, output: "FAIL src/a.test.ts\n", durationMs: 50 };
    const failing = await runTestCommand({ ...target(vmId), command: "bun test; echo $SECRET", timeoutMs: 60_000 });
    expect(failing).toMatchObject({ exitCode: 1, passed: false, timedOut: false, output: "FAIL src/a.test.ts\n", truncated: false });
    expect(ctx.mock.execLog.at(-1)!.body.timeoutMs).toBe(75_000);
    expect(ctx.mock.execLog.at(-1)!.body.command).not.toContain("bun test");
  });

  test("GitHub refusing the owner's token is a clear, final error", async () => {
    const { vmId, guest } = await vm();
    guest.mkdirp(`/home/${USER}/work/acme__web/.git`);
    guest.faults.githubDenied = true;
    await expect(ensureWorktree({ ...target(vmId), baseBranch: "main", githubToken: GITHUB_TOKEN })).rejects.toMatchObject({
      kind: "dependency_rejected",
      retryable: false,
      message: expect.stringContaining("GitHub denied access to acme/web"),
    });
    await ensureWorktree({ ...target(vmId), baseBranch: "main", githubToken: GITHUB_TOKEN });
    guest.faults.githubDenied = true;
    await expect(checkpointWorktree({ ...target(vmId), message: "x", githubToken: GITHUB_TOKEN })).rejects.toMatchObject({ kind: "dependency_rejected" });
    expect(guest.credentialFiles()).toEqual([]);
  });

  test("a resolver's checkpoint with unresolved conflicts is never published", async () => {
    const { vmId, guest } = await vm();
    guest.mkdirp(`/home/${USER}/work/acme__web/.git`);
    await ensureWorktree({ ...target(vmId), baseBranch: "main", githubToken: null });
    const published = () => ctx.mock.execLog.filter((e) => e.body.env?.OP === "publish").length;
    const before = published();

    guest.unresolved = ["src/shared.ts", "web/app\\nname.tsx"];
    const blocked = await checkpointWorktree({ ...target(vmId), message: "x", githubToken: GITHUB_TOKEN, checkConflicts: true });
    expect(blocked).toMatchObject({ committed: false, unresolved: ["src/shared.ts", "web/app\\nname.tsx"] });
    expect(ctx.mock.execLog.at(-1)!.body.env).toMatchObject({ OP: "commit", CHECK_CONFLICTS: "1" });
    expect(published()).toBe(before);
    expect(guest.pushed.has("acme/web:morrow/ab12/backend")).toBe(false);

    // A path the backend will not echo (control characters, too long) still blocks the push.
    guest.unresolved = ["bad\u0007path", "x".repeat(301)];
    const unprintable = await checkpointWorktree({ ...target(vmId), message: "x", githubToken: GITHUB_TOKEN, checkConflicts: true });
    expect(unprintable.unresolved).toEqual(["(a path git could not print)"]);
    expect(published()).toBe(before);

    guest.unresolved = [];
    const clean = await checkpointWorktree({ ...target(vmId), message: "x", githubToken: GITHUB_TOKEN, checkConflicts: true });
    expect(clean.unresolved).toEqual([]);
    expect(guest.pushed.get("acme/web:morrow/ab12/backend")).toBe(clean.sha);
    // Plain workers never send the flag.
    await checkpointWorktree({ ...target(vmId), message: "x", githubToken: GITHUB_TOKEN });
    expect(ctx.mock.execLog.filter((e) => e.body.env?.OP === "commit").at(-1)!.body.env!.CHECK_CONFLICTS).toBeUndefined();
  });

  test("push rejection is a typed conflict", async () => {
    const { vmId, guest } = await vm();
    guest.mkdirp(`/home/${USER}/work/acme__web/.git`);
    await ensureWorktree({ ...target(vmId), baseBranch: "main", githubToken: null });
    guest.faults.pushRejected = true;
    await expect(checkpointWorktree({ ...target(vmId), message: "x", githubToken: GITHUB_TOKEN })).rejects.toMatchObject({ kind: "conflict" });
  });

  test("test output is bounded and slow suites report a timeout", async () => {
    const { vmId, guest } = await vm();
    guest.mkdirp(`/home/${USER}/work/acme__web/.git`);
    await ensureWorktree({ ...target(vmId), baseBranch: "main", githubToken: null });
    guest.test = { exitCode: 0, output: "y".repeat(200_000), durationMs: 10 };
    const big = await runTestCommand({ ...target(vmId), command: "bun test", timeoutMs: 30_000, maxOutputBytes: 1_000 });
    expect(big.output.length).toBe(1_000);
    expect(big.truncated).toBe(true);
    guest.test = { exitCode: 0, output: "...", durationMs: 120_000 };
    const slow = await runTestCommand({ ...target(vmId), command: "bun test", timeoutMs: 5_000 });
    expect(slow).toMatchObject({ timedOut: true, passed: false, exitCode: 124 });
  });

  test("hostile branch and repo names are refused before exec", async () => {
    const { vmId } = await vm();
    for (const branch of ["-delete", "a..b", "a b", "main;id", "x/.lock", "a//b", "@{-1}", "/abs"]) {
      await expect(ensureWorktree({ ...target(vmId), branch, baseBranch: "main", githubToken: null })).rejects.toThrow("Invalid branch");
    }
    await expect(ensureWorktree({ ...target(vmId), repoFullName: "acme/..", baseBranch: "main", githubToken: null })).rejects.toThrow("Invalid repository");
    expect(ctx.mock.execLog.length).toBe(0);
  });
});
