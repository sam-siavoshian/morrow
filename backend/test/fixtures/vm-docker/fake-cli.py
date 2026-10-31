#!/usr/bin/env python3
"""Fake coding CLI for test/vm/relay-node-docker.test.ts, installed as claude, codex and opencode.

Plays a curious worker: it records everything it can see (its own environment and arguments, every process
and file it can read) to ~/e2e/<agent>.json, so the test can prove no workspace key reached it. Then it
reports ready to the broker, and when the task names a channel it runs the Agent Relay MCP server exactly as
the broker configured it (claude: --mcp-config, codex: --config pairs, opencode: OPENCODE_CONFIG_CONTENT) and
uses it with only its own agent token: a channel post, a DM, an inbox check. Everything typed into the PTY
afterwards is appended to ~/e2e/<agent>.in.
"""
import json
import os
import pwd
import re
import select
import subprocess
import sys
import time
import tomllib

CLI = os.path.basename(sys.argv[0])
ARGS = sys.argv[1:]
NAME = os.environ.get("RELAY_AGENT_NAME", "unknown")
OUT = os.path.join(os.path.expanduser("~"), "e2e")
FILE_ROOTS = ["/var/lib/morrow", "/etc/agent-relay", "/etc/sudoers.d", "/etc/systemd/system", "/opt/morrow", "/tmp", "/var/tmp", "/dev/shm", os.path.expanduser("~"), os.getcwd()]
PROBES = [
    "/etc/agent-relay/node.env",
    "/etc/agent-relay/node-id",
    "/var/lib/morrow/relay",
    "/root",
]
MAX_FILE = 256 * 1024


def write_json(path, value):
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(value, f)
    os.replace(tmp, path)


def read(path, limit=MAX_FILE):
    try:
        with open(path, "rb") as f:
            return f.read(limit).decode("utf-8", "replace")
    except OSError:
        return None


def processes():
    seen = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            uid = os.stat(f"/proc/{entry}").st_uid
        except OSError:
            continue
        seen.append({
            "pid": int(entry),
            "uid": uid,
            "cmdline": read(f"/proc/{entry}/cmdline"),
            "environ": read(f"/proc/{entry}/environ"),
        })
    return seen


def files():
    found = {}
    for root in FILE_ROOTS:
        for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: None):
            dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
            for name in filenames:
                path = os.path.join(dirpath, name)
                if path.startswith(OUT) or os.path.islink(path) or not os.path.isfile(path):
                    continue
                text = read(path)
                if text is not None:
                    found[path] = text
    return found


def sudo_attempts():
    me = pwd.getpwuid(os.getuid()).pw_name
    broker = "r" + me[1:]
    results = {}
    for label, cmd in {
        "as_root": ["sudo", "-n", "true"],
        "as_broker": ["sudo", "-n", "-u", broker, "true"],
    }.items():
        try:
            results[label] = subprocess.run(cmd, capture_output=True, timeout=10).returncode
        except (OSError, subprocess.TimeoutExpired) as e:
            results[label] = str(e)
    return results


def mcp_server():
    """The Agent Relay MCP server spec as this CLI received it."""
    if CLI == "claude":
        for i, arg in enumerate(ARGS):
            if arg == "--mcp-config" and i + 1 < len(ARGS):
                cfg = json.loads(ARGS[i + 1])["mcpServers"]["agent-relay"]
                return {"command": cfg["command"], "args": cfg.get("args", []), "env": cfg.get("env", {})}
            if arg.startswith("--mcp-config="):
                cfg = json.loads(arg.split("=", 1)[1])["mcpServers"]["agent-relay"]
                return {"command": cfg["command"], "args": cfg.get("args", []), "env": cfg.get("env", {})}
    if CLI == "codex":
        spec = {"command": None, "args": [], "env": {}}
        for i, arg in enumerate(ARGS):
            if arg not in ("--config", "-c") or i + 1 >= len(ARGS):
                continue
            m = re.match(r"^mcp_servers\.agent-relay\.(command|args|env\.([A-Z0-9_]+))=(.*)$", ARGS[i + 1], re.S)
            if not m:
                continue
            value = tomllib.loads(f"v = {m.group(3)}")["v"]
            if m.group(1) == "command":
                spec["command"] = value
            elif m.group(1) == "args":
                spec["args"] = value
            else:
                spec["env"][m.group(2)] = value
        return spec if spec["command"] else None
    if CLI == "opencode":
        content = os.environ.get("OPENCODE_CONFIG_CONTENT")
        if content:
            cfg = json.loads(content)["mcp"]["agent-relay"]
            return {"command": cfg["command"][0], "args": cfg["command"][1:], "env": cfg.get("environment", {})}
    return None


class Mcp:
    def __init__(self, spec):
        env = dict(os.environ)
        env.update(spec["env"])
        self.proc = subprocess.Popen([spec["command"], *spec["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        self.next_id = 0

    def send(self, message):
        self.proc.stdin.write((json.dumps(message) + "\n").encode())
        self.proc.stdin.flush()

    def call(self, method, params, timeout=60):
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        deadline = time.time() + timeout
        while time.time() < deadline:
            ready, _, _ = select.select([self.proc.stdout], [], [], max(0.1, deadline - time.time()))
            if not ready:
                continue
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("MCP server exited: " + self.proc.stderr.read().decode("utf-8", "replace")[-2000:])
            msg = json.loads(line)
            if msg.get("id") == self.next_id:
                return msg
        raise RuntimeError(f"MCP {method} timed out")

    def tool(self, name, arguments):
        msg = self.call("tools/call", {"name": name, "arguments": arguments})
        if "error" in msg:
            return {"ok": False, "error": msg["error"]}
        result = msg["result"]
        text = "".join(c.get("text", "") for c in result.get("content", []))
        return {"ok": not result.get("isError", False), "text": text[:4000]}

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def use_relay(channel):
    report = {"channel": channel}
    spec = mcp_server()
    report["server"] = spec
    if not spec:
        report["error"] = "no agent-relay MCP server configured"
        return report
    mcp = Mcp(spec)
    try:
        init = mcp.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fake-cli", "version": "1"}})
        report["initialized"] = "result" in init
        mcp.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools = mcp.call("tools/list", {})
        report["tools"] = sorted(t["name"] for t in tools.get("result", {}).get("tools", []))
        report["post_message"] = mcp.tool("post_message", {"channel": channel, "text": f"channel hello from {NAME}"})
        report["send_dm"] = mcp.tool("send_dm", {"to": "dispatcher", "text": f"dm hello from {NAME}"})
        report["check_inbox"] = mcp.tool("check_inbox", {})
        # Workspace-level tools need the key this worker no longer has.
        report["list_agents"] = mcp.tool("list_agents", {})
    except Exception as e:  # noqa: BLE001 - the test reads the failure from the report
        report["error"] = str(e)
    finally:
        mcp.close()
    return report


CODEX_COMPOSER = []


def render_codex(text):
    """Codex's composer: one prompt row ("› ") with the pending text after it, scrolled so the prompt
    stays on the first visible row; Enter submits and leaves a fresh, empty composer. The broker checks
    that each typed chunk shows up there before it sends the next one or Enter."""
    for ch in re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text):
        if ch == "\r":
            CODEX_COMPOSER.clear()
        elif ch == "\n":
            CODEX_COMPOSER.append(" ")
        elif ch.isprintable():
            CODEX_COMPOSER.append(ch)
    try:
        cols, rows = os.get_terminal_size(1)
    except OSError:
        cols, rows = 80, 24
    room = max(200, (rows - 2) * cols - 4)
    shown = "".join(CODEX_COMPOSER)[-room:]
    sys.stdout.buffer.write(("\x1b[2J\x1b[H\u203a " + shown).encode())
    sys.stdout.buffer.flush()


def main():
    os.makedirs(OUT, mode=0o700, exist_ok=True)
    me = pwd.getpwuid(os.getuid()).pw_name
    ppid = os.getppid()
    write_json(os.path.join(OUT, f"{NAME}.json"), {
        "cli": CLI,
        "argv": ARGS,
        "user": me,
        "uid": os.getuid(),
        "euid": os.geteuid(),
        "cwd": os.getcwd(),
        "pid": os.getpid(),
        "ppid": ppid,
        "parent_visible": os.path.exists(f"/proc/{ppid}"),
        "env": dict(os.environ),
        "processes": processes(),
        "files": files(),
        "probes": {p: os.access(p, os.R_OK) for p in PROBES},
        "sudo": sudo_attempts(),
    })
    # Raw, like the real TUIs: every typed byte arrives at once (canonical mode would hold a chunk's tail
    # until the next newline) and Enter (\r) stays apart from newlines inside a pasted body (\n).
    subprocess.run(["stty", "raw", "-echo"], check=False, stderr=subprocess.DEVNULL)
    # The broker types a task only once it sees the CLI's own composer with the cursor on it
    # (claude: a bare "❯" row, codex: "›"); input is consumed unechoed, so the prompt stays proven.
    composer = {"claude": "\u276f ", "codex": "\u203a "}.get(CLI, "")
    sys.stdout.buffer.write(("->pty:ready\r\n" + composer).encode())
    sys.stdout.buffer.flush()
    inbox = os.path.join(OUT, f"{NAME}.in")
    done = False
    buf = ""
    while True:
        chunk = os.read(0, 4096)
        if not chunk:
            break
        text = chunk.decode("utf-8", "replace")
        with open(inbox, "a") as f:
            f.write(text)
        if CLI == "codex":
            render_codex(text)
        buf = (buf + text)[-8192:]
        # Raw reads can split the name; only a name followed by something else is whole.
        m = re.search(r"E2E-CHANNEL:([a-z0-9-]+)[^a-z0-9-]", buf)
        if m and not done:
            done = True
            write_json(os.path.join(OUT, f"{NAME}.mcp.json"), use_relay(m.group(1)))


if __name__ == "__main__":
    main()
