// A real merge conflict through backend/vm/git.sh, in the same throwaway Ubuntu 24.04 image as gitDocker.test.ts:
// two branches edit one line, the merge reports the conflict, the resolver's CHECK_CONFLICTS commit refuses
// unmerged paths and leftover markers, the resolution is published, and the merge is clean afterwards.
// Needs Docker; runs only with VM_DOCKER=1 and skips loudly otherwise.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ENABLED = process.env.VM_DOCKER === "1";
if (!ENABLED) console.warn("SKIP merge conflict Docker proof: set VM_DOCKER=1 (needs Docker)");

const BACKEND = resolve(import.meta.dir, "../..");
const FIXTURES = resolve(BACKEND, "test/fixtures/vm-docker");
const IMAGE = "morrow-vmtest-conflict:24.04";

async function run(cmd: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: out + err };
}

describe.skipIf(!ENABLED)("merge conflict resolution in Docker", () => {
  const results = new Map<string, { status: string; detail: string }>();
  let output = "";

  beforeAll(async () => {
    const build = await run(["docker", "build", "-q", "-t", IMAGE, "-f", resolve(FIXTURES, "git.Dockerfile"), FIXTURES], 600_000);
    if (build.code !== 0) throw new Error(`docker build failed: ${build.out.slice(-500)}`);
    const name = `morrow-conflict-proof-${process.pid}`;
    const scenario = await run(
      ["docker", "run", "--rm", "--name", name, "-v", `${resolve(BACKEND, "vm")}:/vm:ro`, "-v", `${FIXTURES}:/fixtures:ro`, IMAGE, "bash", "/fixtures/conflict-scenario.sh"],
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
    // the verifier's merge check on two truly conflicting branches
    "first_branch_merges",
    "second_branch_conflicts",
    "conflict_left_integration_alone",
    "both_sides_file_list",
    // the resolver on the integration branch
    "clone",
    "resolver_worktree_on_integration",
    "worker_merge_conflicts",
    "worker_tree_has_markers",
    "unmerged_not_committed",
    "unmerged_head_unchanged",
    "unmerged_merge_still_in_progress",
    "leftover_markers_reported",
    "resolution_committed",
    "resolution_contains_web",
    "resolution_has_both_files",
    "resolution_published",
    "published_is_fast_forward",
    // verifying again
    "reverify_merges_clean",
    "reverify_pr_mergeable",
    // the default branch moved on
    "base_branch_conflicts",
    "base_worktree_refreshed",
    "ours_resolution_concludes_merge",
    "base_resolution_published",
    "base_reverify_clean",
    "no_cred_files_at_end",
  ];
  for (const name of expectations) {
    test(name, () => {
      expect(results.get(name) ?? { status: "missing", detail: output.slice(-800) }).toMatchObject({ status: "pass" });
    });
  }

  test("no step failed", () => {
    expect([...results].filter(([, r]) => r.status === "fail")).toEqual([]);
  });
});
