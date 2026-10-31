// The morrow-agent install path for real, in a throwaway Ubuntu 24.04 container (the Freestyle base image's
// release): golden-setup.sh's morrow step, bootstrap-user.sh registering the server with Claude Code, Codex and
// opencode while fake Relay credentials sit in the environment, the server answering as the engineer, and git.sh
// keeping the broker's opencode.json and credential-bearing files out of a checkpoint. The bun binary is the
// official Linux release, checked against the sha256 pinned in golden-setup.sh. Needs Docker and network for the
// one-time bun download: `VM_DOCKER=1 bun test test/vm/morrow-agent-docker.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENABLED = process.env.VM_DOCKER === "1";
if (!ENABLED) console.warn("SKIP morrow-agent Docker proof: set VM_DOCKER=1 (needs Docker)");

const BACKEND = resolve(import.meta.dir, "../..");
const FIXTURES = resolve(BACKEND, "test/fixtures/vm-docker");
const IMAGE = "morrow-vmtest-agent:24.04";

async function run(cmd: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: out + err };
}

/** The official bun for the container's architecture, verified against golden-setup.sh's pins. Returns its dir. */
async function linuxBun(): Promise<string> {
  const golden = readFileSync(resolve(BACKEND, "vm/golden-setup.sh"), "utf8");
  const version = /BUN_VERSION="([0-9.]+)"/.exec(golden)![1]!;
  const machine = (await run(["docker", "run", "--rm", "ubuntu:24.04", "uname", "-m"], 60_000)).out.trim();
  const arch = machine === "aarch64" || machine === "arm64" ? "aarch64" : "x64";
  const sha = new RegExp(`BUN_SHA256_${arch.toUpperCase()}="([a-f0-9]{64})"`).exec(golden)![1]!;
  const dir = join(tmpdir(), `morrow-bun-${version}-${arch}`);
  const binary = join(dir, `bun-linux-${arch}`, "bun");
  if (existsSync(binary)) return join(dir, `bun-linux-${arch}`);
  mkdirSync(dir, { recursive: true });
  const res = await fetch(`https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-${arch}.zip`);
  if (!res.ok) throw new Error(`bun download failed: HTTP ${res.status}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const got = createHash("sha256").update(zip).digest("hex");
  if (got !== sha) throw new Error(`bun zip sha256 ${got} does not match the pin ${sha}`);
  writeFileSync(join(dir, "bun.zip"), zip);
  const unzip = await run(["unzip", "-q", "-o", join(dir, "bun.zip"), "-d", dir], 120_000);
  if (unzip.code !== 0) throw new Error(`unzip failed: ${unzip.out}`);
  return join(dir, `bun-linux-${arch}`);
}

describe.skipIf(!ENABLED)("morrow-agent install in Docker", () => {
  const results = new Map<string, { status: string; detail: string }>();
  let output = "";

  beforeAll(async () => {
    const bunDir = await linuxBun();
    const build = await run(["docker", "build", "-q", "-t", IMAGE, "-f", resolve(FIXTURES, "git.Dockerfile"), FIXTURES], 600_000);
    if (build.code !== 0) throw new Error(`docker build failed: ${build.out.slice(-500)}`);
    const name = `morrow-agent-proof-${process.pid}`;
    try {
      const scenario = await run(
        [
          "docker", "run", "--rm", "--name", name,
          "-v", `${resolve(BACKEND, "vm")}:/vm:ro`,
          "-v", `${FIXTURES}:/fixtures:ro`,
          "-v", `${bunDir}:/bun:ro`,
          IMAGE, "bash", "/fixtures/morrow-agent-scenario.sh",
        ],
        300_000,
      );
      output = scenario.out;
    } finally {
      await run(["docker", "rm", "-f", name], 60_000);
    }
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

  for (const name of [
    "bun_runs",
    "golden_rejects_bad_checksum",
    "golden_morrow_step",
    "golden_script_root_owned",
    "golden_script_matches",
    "golden_verify_ping",
    "bootstrap_registered",
    "owned_by_user_.claude.json",
    "owned_by_user_config.toml",
    "owned_by_user_opencode.json",
    "claude_registers_morrow",
    "codex_registers_morrow",
    "opencode_registers_morrow",
    "bootstrap_idempotent",
    "no_credential_in_any_file",
    "worker_tools",
    "child_tools",
    "workspace_key_alone_fails_closed",
    "commit_ran",
    "commit_has_only_clean_files",
    "commit_has_no_credential",
    "opencode_json_excluded",
    "credential_files_left_unstaged",
    "commit_warned_without_secret",
  ]) {
    test(name, () => {
      const r = results.get(name);
      expect(r ? `${r.status} ${r.detail}`.trim() : `missing (${output.slice(-1500)})`).toBe("pass");
    });
  }
});
