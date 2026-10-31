#!/usr/bin/env bash
# Steps for test/vm/relay-node-docker.test.ts, run as root inside the systemd container (backend/vm at /vm,
# this directory at /t). One subcommand per call; anything the test parses is printed as one JSON line.
set -Eeuo pipefail

U=u0123456789ab
R=r0123456789ab
UNIT=morrow-relay-node.service
WORKTREE="/home/$U/work/.worktrees/acme__web/main"

die() { printf '[scenario] error: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  setup)
    # Fake coding CLIs where a real install puts them, on the engineer's login PATH.
    install -m 0755 /t/fake-cli.py /usr/local/lib/fake-cli.py
    for cli in claude codex opencode; do ln -sf /usr/local/lib/fake-cli.py "/usr/local/bin/$cli"; done
    env -i PATH=/usr/bin:/bin MORROW_USER="$U" bash -c "$(cat /vm/bootstrap-user.sh)" >/dev/null
    runuser -u "$U" -- mkdir -p "$WORKTREE" "/home/$U/e2e"
    runuser -u "$U" -- chmod 0700 "/home/$U/e2e"
    runuser -u "$U" -- sh -c "printf 'hello\n' > '$WORKTREE/README.md'"
    # The engine runs on the test host. A later EnvironmentFile wins, so this points the broker there
    # without changing what configure-node.sh writes.
    install -d -m 0755 "/etc/systemd/system/$UNIT.d"
    printf 'RELAY_BASE_URL=%s\n' "$E2E_BASE_URL" >/etc/e2e-relay.env
    chmod 0600 /etc/e2e-relay.env
    printf '[Service]\nEnvironmentFile=/etc/e2e-relay.env\n' >"/etc/systemd/system/$UNIT.d/e2e.conf"
    systemctl daemon-reload
    printf '{"ok":true}\n'
    ;;

  old-layout)
    # What configure-node.sh did before the broker had its own account: the broker runs as the engineer,
    # with its state in their home.
    runuser -u "$U" -- mkdir -p "/home/$U/relay-node"
    install -d -m 0755 /etc/agent-relay
    printf 'RELAY_WORKSPACE_KEY=%s\n' "$E2E_KEY" >/etc/agent-relay/node.env
    chmod 0600 /etc/agent-relay/node.env
    cat >"/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=Morrow Agent Relay node ($E2E_NODE)
After=network-online.target

[Service]
Type=simple
User=$U
Group=$U
WorkingDirectory=/home/$U/relay-node
EnvironmentFile=/etc/agent-relay/node.env
Environment=AGENT_RELAY_NODE_HARNESSES=claude
Environment=AGENT_RELAY_NODE_MAX_AGENTS=1
Environment=AGENT_RELAY_TELEMETRY_DISABLED=1
Environment=DO_NOT_TRACK=1
Environment=AGENT_RELAY_INSTALL_DIR=/opt/agent-relay
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/local/bin/agent-relay node up --broker-name $E2E_NODE --no-spawn
Restart=always
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now "$UNIT" >/dev/null 2>&1
    printf '{"ok":true}\n'
    ;;

  old-identity)
    # The node token the old broker cached in the engineer's home.
    runuser -u "$U" -- find "/home/$U/.local/share/agent-relay/node-tokens" -maxdepth 1 -name 'node_*.json' -printf '%f\n' 2>/dev/null |
      python3 -c 'import json,sys; print(json.dumps({"tokens":[l.strip() for l in sys.stdin if l.strip()]}))'
    ;;

  apply)
    # The real script, the way Freestyle exec runs it: body on stdin, values in env, nothing else inherited.
    env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      ACTION=apply MORROW_USER="$U" NODE_NAME="$E2E_NODE" HARNESSES="$E2E_HARNESSES" MAX_AGENTS="$E2E_MAX" \
      RELAY_WORKSPACE_KEY="$E2E_KEY" RELAY_BASE_URL="https://relay.invalid" \
      RELAY_WORKER_SCRIPT="$(base64 -w0 /vm/relay-worker.sh)" \
      bash -c "$(cat /vm/configure-node.sh)" | tail -n1
    ;;

  main-pid)
    printf '{"pid":%s}\n' "$(systemctl show -p MainPID --value "$UNIT")"
    ;;

  layout)
    # Facts about the node layout, read as root.
    python3 - "$U" "$R" <<'PY'
import grp, json, os, pwd, stat, subprocess, sys
u, r = sys.argv[1], sys.argv[2]
def run(*cmd, user=None, env=None):
    full = (["runuser", "-u", user, "--"] if user else []) + list(cmd)
    p = subprocess.run(full, capture_output=True, text=True, env=env)
    return {"rc": p.returncode, "out": p.stdout[-4000:], "err": p.stderr[-2000:]}
home = f"/home/{u}"
unit = open("/etc/systemd/system/morrow-relay-node.service").read()
facts = {
    "unit": unit,
    "relay_user": pwd.getpwnam(r).pw_dir,
    "relay_groups": sorted(g.gr_name for g in grp.getgrall() if r in g.gr_mem),
    "relay_home_mode": oct(stat.S_IMODE(os.stat(f"/var/lib/morrow/relay/{r}").st_mode)),
    "relay_home_owner": pwd.getpwuid(os.stat(f"/var/lib/morrow/relay/{r}").st_uid).pw_name,
    "engineer_relay_files": [p for p in [f"{home}/relay-node", f"{home}/.local/share/agent-relay", f"{home}/.agentworkforce/relay/workspace-key.json"] if os.path.exists(p)],
    "node_id_pin": open("/etc/agent-relay/node-id").read().strip() if os.path.exists("/etc/agent-relay/node-id") else None,
    "identity_key_pin": open("/etc/agent-relay/identity-key").read().strip() if os.path.exists("/etc/agent-relay/identity-key") else None,
    "env_has_identity_key": "RELAY_AGENT_IDENTITY_KEY=" in open("/etc/agent-relay/node.env").read(),
    "engineer_reads_identity_key": run("cat", "/etc/agent-relay/identity-key", user=u),
    # The broker's state dir is pinned under relay-node (worker logs and logtail read there).
    "broker_state_files": sorted(os.listdir(f"/var/lib/morrow/relay/{r}/relay-node/.agentworkforce/relay")) if os.path.isdir(f"/var/lib/morrow/relay/{r}/relay-node/.agentworkforce/relay") else [],
    "relay_tokens": sorted(os.listdir(f"/var/lib/morrow/relay/{r}/.local/share/agent-relay/node-tokens")) if os.path.isdir(f"/var/lib/morrow/relay/{r}/.local/share/agent-relay/node-tokens") else [],
    "proc_mount": next((l for l in open("/proc/mounts") if l.split()[1] == "/proc"), ""),
    "fstab_proc": [l for l in open("/etc/fstab") if " /proc " in l or "\t/proc\t" in l] if os.path.exists("/etc/fstab") else [],
    "sudoers": open(f"/etc/sudoers.d/morrow-relay-{r}").read(),
    "visudo": run("visudo", "-c"),
    "sudo_list": run("sudo", "-n", "-l", user=r),
    "sudo_shell_as_engineer": run("sudo", "-n", "-u", u, "--", "/bin/bash", "-c", "id", user=r),
    "sudo_as_root": run("sudo", "-n", "true", user=r),
    "sudo_from_engineer": run("sudo", "-n", "-u", r, "true", user=u),
    "engineer_reads_env": run("cat", "/etc/agent-relay/node.env", user=u),
    "engineer_lists_relay_home": run("ls", f"/var/lib/morrow/relay/{r}", user=u),
    "engineer_ps": run("ps", "-eo", "user=", user=u),
    "exec_refuses_key_env": run("env", "RELAY_API_KEY=rk_live_e2e_not_a_real_key_000", "/opt/morrow/bin/relay-worker", "exec", "claude", user=u),
    "exec_refuses_key_arg": run("/opt/morrow/bin/relay-worker", "exec", "claude", "--x=rk_live_e2e_not_a_real_key_000", user=u),
    "exec_refuses_wrong_user": run("/opt/morrow/bin/relay-worker", "exec", "claude", user=r),
    "launch_refuses_engineer": run("/opt/morrow/bin/relay-worker", "launch", "claude", user=u),
}
print(json.dumps(facts))
PY
    ;;

  procs)
    # Every process on the box: user, pid, ppid, command. Root's view.
    ps -eo user:32=,pid=,ppid=,args= | python3 -c '
import json, sys
rows = []
for line in sys.stdin:
    parts = line.split(None, 3)
    if len(parts) >= 3:
        rows.append({"user": parts[0], "pid": int(parts[1]), "ppid": int(parts[2]), "args": parts[3].strip() if len(parts) > 3 else ""})
print(json.dumps(rows))'
    ;;

  environ)
    # One process's environment and command line, read as root (to prove the leak check can see a key).
    pid="${2:?pid}"
    python3 - "$pid" <<'PY'
import json, sys
pid = sys.argv[1]
def read(p):
    try:
        return open(p, "rb").read().decode("utf-8", "replace")
    except OSError:
        return None
print(json.dumps({"environ": read(f"/proc/{pid}/environ"), "cmdline": read(f"/proc/{pid}/cmdline")}))
PY
    ;;

  report)
    name="${2:?agent}"
    [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || die "bad agent name"
    file="/home/$U/e2e/$name.${3:-json}"
    if [ -f "$file" ]; then cat "$file"; else printf 'null'; fi
    printf '\n'
    ;;

  worktree)
    find "$WORKTREE" -mindepth 1 -maxdepth 1 -printf "%f\n" | python3 -c 'import json,sys; print(json.dumps(sorted(l.strip() for l in sys.stdin)))'
    ;;

  *)
    die "unknown step"
    ;;
esac
