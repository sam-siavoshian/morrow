// Runs backend/vm/plan.sh and workfile.sh for real with bash, the way Freestyle exec does (script on stdin,
// values in env), against fake `claude`/`codex` binaries. The scripts target GNU coreutils (the VM is Linux);
// on macOS they need Homebrew's coreutils on PATH, and this suite skips loudly without them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VM_DIR = resolve(import.meta.dir, "../../vm");
const GNUBIN = "/opt/homebrew/opt/coreutils/libexec/gnubin";
const linux = process.platform === "linux";
const ready = linux || existsSync(GNUBIN);
if (!ready) console.warn("SKIP vm scripts: GNU coreutils not found (brew install coreutils)");

let home: string;
let bin: string;
let path: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "morrow-vm-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  path = [bin, ...(linux ? [] : [GNUBIN, "/opt/homebrew/bin"]), "/usr/bin", "/bin"].join(":");
  // Fake CLIs: print their argv and TZ as JSON so the test can see exactly what arrived.
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake(
    "claude",
    `if [ "\${FAKE_SLEEP:-0}" != 0 ]; then sleep "$FAKE_SLEEP"; fi
echo "to stderr" >&2
printf '%s' "$3" > "$HOME/claude-arg3"
printf '%s' "$2" > "$HOME/claude-prompt"
printf '{"type":"result","is_error":false,"result":"ok","tz":"%s","argc":%d}' "$TZ" "$#"`,
  );
  fake("codex", `printf '%s\\n' "$@" > "$HOME/codex-args"; printf '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\\n'`);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function runScript(name: string, env: Record<string, string>) {
  const proc = Bun.spawn(["bash", "-s"], {
    stdin: Bun.file(join(VM_DIR, `${name}.sh`)),
    env: { HOME: home, PATH: path, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const meta = (stderr: string) => JSON.parse(stderr.trimEnd().split("\n").at(-1)!) as { exitCode: number; timedOut: boolean; bytes: number; stderr: string };

describe.skipIf(!ready)("plan.sh", () => {
  test("the prompt arrives as one verbatim argument, never as shell; TZ is UTC", async () => {
    const prompt = `Plan this. $(touch "$HOME/pwned") \`touch $HOME/pwned2\` "quoted" 'single' ; rm -rf / \n second line`;
    const res = await runScript("plan", { PLAN_CLI: "claude", PLAN_PROMPT_B64: b64(prompt), PLAN_TIMEOUT_SECS: "20", MAX_OUTPUT_BYTES: "4096" });
    expect(res.code).toBe(0);
    expect(readFileSync(join(home, "claude-prompt"), "utf8")).toBe(prompt);
    expect(readFileSync(join(home, "claude-arg3"), "utf8")).toBe("--output-format");
    expect(existsSync(join(home, "pwned"))).toBe(false);
    expect(existsSync(join(home, "pwned2"))).toBe(false);
    const out = JSON.parse(res.stdout) as { tz: string; argc: number };
    expect(out.tz).toBe("UTC");
    expect(out.argc).toBe(13);
    const m = meta(res.stderr);
    expect(m).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Buffer.from(m.stderr, "base64").toString()).toContain("to stderr");
  });

  test("codex gets a read-only sandbox, no user config, every file/exec tool off, and the prompt last", async () => {
    const res = await runScript("plan", { PLAN_CLI: "codex", PLAN_PROMPT_B64: b64("p; ls"), PLAN_TIMEOUT_SECS: "20", MAX_OUTPUT_BYTES: "4096" });
    expect(res.code).toBe(0);
    const args = readFileSync(join(home, "codex-args"), "utf8").trimEnd().split("\n");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("read-only");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    const disabled = args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
    for (const feature of ["shell_tool", "unified_exec", "view_image", "code_mode_host", "multi_agent", "apps", "plugins", "browser_use", "computer_use"]) {
      expect(disabled).toContain(`features.${feature}=false`);
    }
    expect(args.at(-1)).toBe("p; ls");
  });

  test("a hung CLI is killed at the timeout and reported", async () => {
    const res = await runScript("plan", { PLAN_CLI: "claude", PLAN_PROMPT_B64: b64("x"), PLAN_TIMEOUT_SECS: "1", MAX_OUTPUT_BYTES: "4096", FAKE_SLEEP: "10" });
    expect(meta(res.stderr)).toMatchObject({ timedOut: true, exitCode: 124 });
  }, 20_000);

  test("bad input is refused before anything runs", async () => {
    for (const env of [
      { PLAN_CLI: "bash", PLAN_PROMPT_B64: b64("x"), PLAN_TIMEOUT_SECS: "5" },
      { PLAN_CLI: "claude", PLAN_PROMPT_B64: b64("x"), PLAN_TIMEOUT_SECS: "5; rm" },
      { PLAN_CLI: "claude", PLAN_PROMPT_B64: "", PLAN_TIMEOUT_SECS: "5" },
    ]) {
      const res = await runScript("plan", env);
      expect(res.code).toBe(2);
    }
  });
});

describe.skipIf(!ready)("workfile.sh", () => {
  const wt = () => join(home, "work/.worktrees/o__r/morrow-abc-api");
  beforeAll(() => {
    mkdirSync(wt(), { recursive: true });
    writeFileSync(join(wt(), ".git"), "gitdir: elsewhere\n");
  });

  test("writes the note atomically and reports its size", async () => {
    const content = "# Handoff\n\n$(not run) `nope`\n";
    const res = await runScript("workfile", { WT_PATH: wt(), REL_PATH: ".morrow/handoff/ws-api.md", CONTENT_B64: b64(content) });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ path: ".morrow/handoff/ws-api.md", bytes: Buffer.byteLength(content) });
    expect(readFileSync(join(wt(), ".morrow/handoff/ws-api.md"), "utf8")).toBe(content);
  });

  test("refuses paths outside the worktree root, traversal, bad note names and symlinked note dirs", async () => {
    const cases: Record<string, string>[] = [
      { WT_PATH: join(home, "elsewhere"), REL_PATH: ".morrow/briefs/ws.md" },
      { WT_PATH: `${join(home, "work/.worktrees")}/../../x`, REL_PATH: ".morrow/briefs/ws.md" },
      { WT_PATH: wt(), REL_PATH: "../escape.md" },
      { WT_PATH: wt(), REL_PATH: ".morrow/briefs/../../x.md" },
      { WT_PATH: wt(), REL_PATH: ".morrow/other/ws.md" },
    ];
    for (const env of cases) {
      const res = await runScript("workfile", { ...env, CONTENT_B64: b64("x") });
      expect(res.code).toBe(1);
    }
    const target = join(home, "target");
    mkdirSync(target);
    symlinkSync(target, join(wt(), ".morrow/briefs"));
    const res = await runScript("workfile", { WT_PATH: wt(), REL_PATH: ".morrow/briefs/ws.md", CONTENT_B64: b64("x") });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("symlink");
    expect(existsSync(join(target, "ws.md"))).toBe(false);
  });
});
