// Runs backend/vm/relay-worker.sh (the bridge between the Relay broker and the coding CLIs) for real in a
// throwaway ubuntu:24.04 container with no network. A stand-in sudo records exactly what the broker side hands
// over; fake CLIs and a fake agent-relay record what the engineer side starts them with. Proves the workspace key
// never crosses, in any form the broker 14.0.0 uses, and that the bridge fails closed.
// Needs Docker: `VM_DOCKER=1 bun test test/vm`. Skipped otherwise.
import { beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const RUN = process.env.VM_DOCKER === "1";
if (!RUN) console.warn("SKIP relay-worker docker suite: set VM_DOCKER=1 (needs Docker and the ubuntu:24.04 image)");

const BACKEND = resolve(import.meta.dir, "../..");
const KEY = "rk_live_e2eFakeWorkspaceKey0123456789";
const TOKEN = "at_live_e2eFakeAgentToken0123";
const U = "u0123456789ab";

interface Case {
  rc: number;
  raw: string;
}
let cases: Map<string, Case>;

async function scenario(): Promise<Map<string, Case>> {
  const name = `morrow-relay-worker-${randomBytes(4).toString("hex")}`;
  const proc = Bun.spawn(
    [
      "docker", "run", "--rm", "--name", name, "--network", "none",
      "-v", `${BACKEND}/vm:/vm:ro`, "-v", `${BACKEND}/test/fixtures/vm-docker:/t:ro`,
      "ubuntu:24.04", "bash", "/t/relay-worker-scenario.sh",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 || !stdout.includes("\nDONE")) throw new Error(`scenario failed (${code}): ${stderr.slice(-2000)}`);
    const out = new Map<string, Case>();
    for (const line of stdout.split("\n")) {
      const [label, rc, b64] = line.split("\t");
      if (!label || rc === undefined) continue;
      out.set(label, { rc: Number(rc), raw: Buffer.from(b64 ?? "", "base64").toString("utf8") });
    }
    return out;
  } finally {
    await Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" }).exited;
  }
}

const get = (label: string): Case => {
  const c = cases.get(label);
  if (!c) throw new Error(`no case ${label}`);
  return c;
};
/** sudo's recorded argv: `-n -u <user> -- /opt/morrow/bin/relay-worker exec <cli> args...`. */
const sudoArgv = (label: string) => get(label).raw.split("\0").slice(0, -1);
/** A fake program's record: its argv, then its environment. */
function record(label: string): { argv: string[]; env: Record<string, string> } {
  const raw = get(label).raw;
  const nl = raw.indexOf("\n");
  const argv = raw.slice(0, nl).split("\0").slice(1);
  const env: Record<string, string> = {};
  for (const entry of raw.slice(nl + 1).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return { argv, env };
}

beforeAll(async () => {
  if (RUN) cases = await scenario();
}, 120_000);

describe.skipIf(!RUN)("relay-worker.sh launch (broker side)", () => {
  test("hands over through sudo as the engineer, to the bridge's exec, with the key gone from every argument", () => {
    for (const label of ["claude_mid", "claude_first", "claude_last", "codex_forms"]) {
      const c = get(label);
      expect(c.rc).toBe(0);
      expect(c.raw).not.toContain(KEY);
      expect(c.raw).not.toContain("rk_live_");
      const argv = sudoArgv(label);
      expect(argv.slice(0, 6)).toEqual(["-n", "-u", U, "--", "/opt/morrow/bin/relay-worker", "exec"]);
    }
  });

  test("Claude's MCP config stays valid JSON and keeps everything but the key", () => {
    const configOf = (label: string) => {
      const argv = sudoArgv(label);
      const i = argv.indexOf("--mcp-config");
      const text = i >= 0 ? argv[i + 1]! : argv.find((a) => a.startsWith("--mcp-config="))!.slice("--mcp-config=".length);
      return JSON.parse(text).mcpServers["agent-relay"];
    };
    expect(configOf("claude_mid")).toEqual({
      command: "/opt/morrow/bin/relay-worker",
      args: ["mcp"],
      env: { RELAY_AGENT_NAME: "w-1", RELAY_AGENT_TOKEN: TOKEN },
    });
    expect(configOf("claude_first").env).toEqual({ RELAY_AGENT_NAME: "w-1" });
    expect(configOf("claude_last").env).toEqual({ RELAY_AGENT_NAME: "w-1" });
    // Other arguments pass through untouched and in order.
    expect(sudoArgv("claude_mid").slice(6)).toEqual(["claude", "--dangerously-skip-permissions", "--mcp-config", expect.any(String), "--model", "x"]);
  });

  test("Codex key overrides go in every form; other overrides stay", () => {
    expect(sudoArgv("codex_forms").slice(6)).toEqual([
      "codex",
      "--config", "check_for_update_on_startup=false",
      "--config", 'mcp_servers.agent-relay.command="/opt/morrow/bin/relay-worker"',
      "--config", `mcp_servers.agent-relay.env.RELAY_AGENT_TOKEN="${TOKEN}"`,
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  test("Cursor Agent, Gemini CLI and Grok cross over from their morrow-<cli> names, arguments untouched", () => {
    expect(sudoArgv("cursor_launch").slice(4)).toEqual(["/opt/morrow/bin/relay-worker", "exec", "cursor", "--force", "--approve-mcps", "--trust", "--disable-auto-update", "--model", "m"]);
    expect(sudoArgv("gemini_launch").slice(4)).toEqual(["/opt/morrow/bin/relay-worker", "exec", "gemini", "--approval-mode", "yolo"]);
    expect(sudoArgv("grok_launch").slice(4)).toEqual(["/opt/morrow/bin/relay-worker", "exec", "grok", "--always-approve", "--trust"]);
    for (const label of ["cursor_launch", "gemini_launch", "grok_launch"]) {
      expect(get(label).rc).toBe(0);
      expect(get(label).raw).not.toContain("rk_live_");
    }
  });

  test("the CLIs' own names on the broker's PATH refuse, for the broker and the engineer alike", () => {
    for (const label of ["deny_gemini", "deny_grok", "deny_cursor-agent", "deny_agent", "deny_as_engineer"]) {
      expect([label, get(label).rc]).toEqual([label, 78]);
      expect([label, get(label).raw]).toEqual([label, ""]);
    }
  });

  test("fails closed: a key left anywhere else, the wrong user, an unknown CLI", () => {
    for (const label of ["key_in_other_arg", "self_hosted_key_in_arg", "launch_as_engineer", "launch_unknown_cli"]) {
      expect([label, get(label).rc]).toEqual([label, 78]);
      expect(get(label).raw).toBe("");
    }
  });
});

describe.skipIf(!RUN)("relay-worker.sh exec (engineer side)", () => {
  test("starts the real CLI from the engineer's PATH, never the shim, with sudo's traces cleaned up", () => {
    const c = get("exec_claude");
    expect(c.rc).toBe(0);
    const { argv, env } = record("exec_claude");
    expect(argv).toEqual(["--mcp-config", '{"mcpServers":{}}']);
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(env.HOME).toBe(`/home/${U}`);
    expect(env.USER).toBe(U);
    expect(env.RELAY_AGENT_TOKEN).toBe(TOKEN);
    for (const v of ["SUDO_USER", "SUDO_UID", "SUDO_COMMAND", "MAIL"]) expect(env[v]).toBeUndefined();
  });

  test("Codex drops the broker's bypass flag only for a read-only sandbox", () => {
    expect(record("exec_codex_normal").argv).toEqual(["--dangerously-bypass-approvals-and-sandbox", "--model", "m"]);
    expect(record("exec_codex_ro").argv).toEqual(["--sandbox", "read-only", "--ask-for-approval", "never"]);
    expect(record("exec_codex_ro_short").argv).toEqual(["-s", "read-only"]);
    expect(record("exec_codex_ro_eq").argv).toEqual(["--sandbox=read-only"]);
  });

  test("opencode gets its Relay MCP server and agents inline, with the agent token and no key", () => {
    const { argv, env } = record("exec_opencode");
    expect(argv).toEqual(["--agent", "agent-relay"]);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(config.mcp["agent-relay"]).toEqual({
      type: "local",
      command: ["/opt/morrow/bin/relay-worker", "mcp"],
      environment: {
        RELAY_AGENT_NAME: "w-1",
        RELAY_AGENT_TYPE: "agent",
        RELAY_STRICT_AGENT_NAME: "1",
        RELAY_AGENT_TOKEN: TOKEN,
        RELAY_SKIP_BOOTSTRAP: "1",
        RELAY_BASE_URL: "https://relay.example",
      },
    });
    expect(config.agent["agent-relay"].tools).toEqual({ "agent-relay_*": true });
    expect(config.agent["agent-relay-readonly"]).toEqual({
      description: "Morrow read-only subagent",
      tools: { "agent-relay_*": true, "morrow-agent_*": true },
      permission: { edit: "deny", bash: "deny" },
    });
  });

  test("fails closed: any key variable or value, a key argument, the wrong user, a value that would break the config", () => {
    for (const label of [
      "exec_refuses_key_var",
      "exec_refuses_key_value",
      "exec_refuses_secret_name",
      "exec_refuses_key_arg",
      "exec_refuses_broker_user",
      "exec_refuses_root",
      "exec_opencode_bad_name",
      "exec_opencode_bad_token",
    ]) {
      expect([label, get(label).rc]).toEqual([label, 78]);
      expect([label, get(label).raw]).toEqual([label, ""]);
    }
  });
});

describe.skipIf(!RUN)("relay-worker.sh exec for Gemini CLI, Cursor Agent and Grok", () => {
  test("Gemini CLI reads the workers' settings, trusts the worktree and gets the token under its GEMINI_CLI_ name", () => {
    expect(get("exec_gemini").rc).toBe(0);
    const { argv, env } = record("exec_gemini");
    expect(argv).toEqual(["--approval-mode", "yolo"]);
    expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("/opt/morrow/etc/gemini/settings.json");
    expect(env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH).toBe("/opt/morrow/etc/gemini/system-defaults.json");
    expect(env.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
    expect(env.NO_BROWSER).toBe("true");
    expect(env.GEMINI_CLI_MORROW_AGENT_TOKEN).toBe(TOKEN);
    expect(Object.values(env).join("\n")).not.toContain("rk_live_");
  });

  test("Gemini CLI refuses settings it cannot trust and a malformed token", () => {
    for (const label of ["exec_gemini_bad_token", "exec_gemini_settings_not_root", "exec_gemini_settings_symlink", "exec_gemini_settings_missing"]) {
      expect([label, get(label).rc]).toEqual([label, 78]);
      expect([label, get(label).raw]).toEqual([label, ""]);
    }
  });

  test("Cursor Agent runs as cursor-agent once its user config names the bridge; register restores it once", () => {
    expect(get("exec_cursor").rc).toBe(0);
    const { argv, env } = record("exec_cursor");
    expect(argv).toEqual(["--force", "--approve-mcps", "--trust", "--disable-auto-update", "--model", "m"]);
    expect(env.RELAY_AGENT_TOKEN).toBe(TOKEN);
    expect(get("cursor_register_calls").raw).toBe("register\n");
    expect(JSON.parse(get("cursor_config").raw).mcpServers["agent-relay"].command).toBe("/opt/morrow/bin/relay-worker");
    // A config that already names the bridge is used as it is.
    expect(get("exec_cursor_again").rc).toBe(0);
    expect(get("cursor_register_calls_again").raw).toBe("register\n");
  });

  test("Grok runs with its updater and telemetry off", () => {
    expect(get("exec_grok").rc).toBe(0);
    const { argv, env } = record("exec_grok");
    expect(argv).toEqual(["--always-approve", "--trust"]);
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
  });

  test("Cursor Agent and Grok refuse to start without the bridge in their config, or with a symlinked one", () => {
    for (const label of ["exec_cursor_no_config", "exec_grok_no_config", "exec_cursor_symlinked_config"]) {
      expect([label, get(label).rc]).toEqual([label, 78]);
      expect([label, get(label).raw]).toEqual([label, ""]);
    }
  });
});

describe.skipIf(!RUN)("relay-worker.sh exec: Codex folder trust", () => {
  const H = `/home/${U}`;
  const trusted = (path: string) => `[projects."${path}"]\ntrust_level = "trusted"\n`;

  test("a worktree's repository is trusted once, in the engineer's own config, keeping everything else", () => {
    expect(get("exec_codex_trust_worktree").rc).toBe(0);
    expect(record("exec_codex_trust_worktree").argv).toEqual(["--model", "m"]);
    const config = get("codex_trust_config_1").raw;
    expect(config).toBe(
      'model = "gpt-5"\n\n# morrow-agent begin (managed by Morrow, replaced on update)\n[mcp_servers.morrow-agent]\ncommand = "/usr/local/bin/bun"\n# morrow-agent end\n\n' +
        trusted(`${H}/work/acme__web`),
    );
    const parsed = Bun.TOML.parse(config) as { projects: Record<string, { trust_level: string }> };
    expect(parsed.projects).toEqual({ [`${H}/work/acme__web`]: { trust_level: "trusted" } });
    // Another worktree of the same repository is already covered.
    expect(get("exec_codex_trust_again").rc).toBe(0);
    expect(get("codex_trust_config_2").raw).toBe(config);
  });

  test("outside the work tree nothing is written, and an entry the engineer chose is left alone", () => {
    expect(get("codex_trust_outside").raw).toBe("");
    expect(get("exec_codex_trust_known").rc).toBe(0);
    expect(get("codex_trust_known_unchanged").rc).toBe(0);
  });

  test("a .git file pointing outside the work tree trusts the folder itself, nothing above it", () => {
    expect(get("exec_codex_trust_odd").rc).toBe(0);
    expect(get("codex_trust_config_odd").raw).toBe(trusted(`${H}/work/.worktrees/acme__web/odd`));
  });

  test("parallel starts keep every entry, and the file stays valid TOML", () => {
    for (const n of [1, 2, 3, 4]) expect(get(`exec_codex_trust_par_${n}`).rc).toBe(0);
    const parsed = Bun.TOML.parse(get("codex_trust_config_parallel").raw) as { projects: Record<string, unknown> };
    expect(Object.keys(parsed.projects).sort()).toEqual([1, 2, 3, 4].map((n) => `${H}/work/acme__r${n}`));
  });

  test("a symlinked config is never written through, and Codex still starts", () => {
    expect(get("exec_codex_trust_symlink").rc).toBe(0);
    expect(get("codex_trust_symlink_victim").raw).toBe("x = 1\n");
  });
});

describe.skipIf(!RUN)("relay-worker.sh mcp", () => {
  test("runs agent-relay mcp on the agent token alone, with the key fallback disabled", () => {
    expect(get("mcp").rc).toBe(0);
    const { argv, env } = record("mcp");
    expect(argv).toEqual(["mcp"]);
    expect(env.RELAY_API_KEY).toBe("${RELAY_API_KEY}");
    for (const v of ["RELAY_WORKSPACE_KEY", "AGENT_RELAY_WORKSPACE_KEY", "RELAY_WORKSPACES_JSON"]) expect(env[v]).toBeUndefined();
    expect(env.RELAY_AGENT_TOKEN).toBe(TOKEN);
  });
});
