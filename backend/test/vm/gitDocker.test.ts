// backend/vm/git.sh for real, in a throwaway Ubuntu 24.04 container (the Freestyle base image's release):
// fake https://github.com with a system-trusted CA, a hostile repo-local and global git config written by
// the agent, and an agent-uid process scanning every /proc/<pid>/{cmdline,environ} and the credential dir
// while root pushes. Needs Docker; runs only with VM_DOCKER=1 and skips loudly otherwise.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ENABLED = process.env.VM_DOCKER === "1";
if (!ENABLED) console.warn("SKIP git.sh Docker proof: set VM_DOCKER=1 (needs Docker)");

const BACKEND = resolve(import.meta.dir, "../..");
const FIXTURES = resolve(BACKEND, "test/fixtures/vm-docker");
const IMAGE = "morrow-vmtest-git:24.04";

async function run(cmd: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: out + err };
}

describe.skipIf(!ENABLED)("git.sh in Docker", () => {
  const results = new Map<string, { status: string; detail: string }>();
  let output = "";

  beforeAll(async () => {
    const build = await run(["docker", "build", "-q", "-t", IMAGE, "-f", resolve(FIXTURES, "git.Dockerfile"), FIXTURES], 600_000);
    if (build.code !== 0) throw new Error(`docker build failed: ${build.out.slice(-500)}`);
    const name = `morrow-git-proof-${process.pid}`;
    const scenario = await run(
      ["docker", "run", "--rm", "--name", name, "-v", `${resolve(BACKEND, "vm")}:/vm:ro`, "-v", `${FIXTURES}:/fixtures:ro`, IMAGE, "bash", "/fixtures/git-scenario.sh"],
      300_000,
    );
    output = scenario.out;
    for (const line of output.split("\n")) {
      const m = /^RESULT (\S+) (pass|fail|info) ?(.*)$/.exec(line);
      if (m) results.set(m[1]!, { status: m[2]!, detail: m[3] ?? "" });
    }
  }, 900_000);

  afterAll(async () => {
    await run(["docker", "image", "rm", "-f", IMAGE], 60_000);
  });

  test("the scenario ran to the end", () => {
    expect(output).toContain("\nDONE");
  });

  const expectations = [
    // clone and worktree through the mirror
    "clone",
    "clone_owned_by_engineer",
    "clone_origin_is_mirror",
    "mirror_dir_mode",
    "mirror_config_root_only_writable",
    "worktree",
    "commit",
    // publish under a hostile config, with a /proc scanner running as the agent
    "scan_control_detects_env_leak",
    "publish",
    "publish_pushed_the_commit",
    "github_has_the_branch",
    "mirror_tracks_the_branch",
    "scan_no_token_seen",
    "scan_saw_root_git_processes",
    "scan_saw_root_https_transport",
    "scan_root_environ_unreadable",
    "scan_cred_dir_unreadable",
    "github_push_was_authenticated",
    "hostile_proxy_never_used",
    "no_root_marker",
    "token_not_in_mirror_or_home",
    "agent_cannot_write_mirror",
    "agent_cannot_push_to_mirror",
    "agent_can_fetch_mirror",
    // later syncs, failures, rejection, symlink swap, validation
    "sync",
    "worktree_after_sync",
    "sync_without_token_is_auth",
    "sync_wrong_token_is_auth",
    "publish_rejected_when_branch_moved",
    "rejected_push_left_github_alone",
    "symlinked_repo_refused",
    "symlinked_repo_not_pushed",
    "no_cred_files_after_clone",
    "no_cred_files_after_publish",
    "no_cred_files_after_sync",
    "no_cred_files_after_failure",
    "no_cred_files_at_end",
    "bad_user_refused",
    "bad_repo_refused",
    "bad_cred_name_refused",
    "root_ops_refuse_engineer",
    "engineer_ops_refuse_root",
  ];
  for (const name of expectations) {
    test(name, () => {
      expect(results.get(name) ?? { status: "missing", detail: output.slice(-800) }).toMatchObject({ status: "pass" });
    });
  }

  test("no git hook, fsmonitor, helper or hook from the agent's config ran at all", () => {
    expect(results.get("markers")?.detail ?? "missing").toBe("");
  });
});
