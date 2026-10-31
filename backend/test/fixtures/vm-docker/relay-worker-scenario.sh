#!/usr/bin/env bash
# Runs inside a throwaway ubuntu:24.04 container as root (see test/vm/relay-worker-docker.test.ts). No network.
# Drives backend/vm/relay-worker.sh (mounted at /vm) through both sides of the bridge:
#   launch  as the broker user, with a stand-in /usr/bin/sudo that records the argv and environment it was
#           handed instead of switching users (so the test sees exactly what would cross over);
#   exec    as the engineer, with the environment sudo's env_keep would pass, against a fake CLI that
#           records what it was started with;
#   mcp     against a fake agent-relay that records its environment;
#   deny    the broker-side names of Cursor Agent, Gemini CLI and Grok, which must refuse.
# Prints one line per case: <case>\t<exit code>\t<base64 of the recorded output, or empty>
set -uo pipefail

U=u0123456789ab
R=r0123456789ab
KEY="rk_live_e2eFakeWorkspaceKey0123456789"
SELF_HOSTED_KEY="selfhostedkey_0123456789abcdef"
TOKEN="at_live_e2eFakeAgentToken0123"
OUT=/tmp/rw
mkdir -p "$OUT" && chmod 1777 "$OUT"

useradd --create-home --user-group --shell /bin/bash "$U"
useradd --system --user-group --no-create-home --home-dir "/var/lib/morrow/relay/$R" --shell /bin/bash "$R"
install -d -m 0755 /opt/morrow/bin /opt/morrow/relay-shims /etc/agent-relay /opt/morrow/etc/gemini
install -m 0755 /vm/relay-worker.sh /opt/morrow/bin/relay-worker
for cli in claude codex opencode; do
  printf '#!/bin/sh\nexec /opt/morrow/bin/relay-worker launch %s "$@"\n' "$cli" >"/opt/morrow/relay-shims/$cli"
  chmod 0755 "/opt/morrow/relay-shims/$cli"
done
# As configure-node.sh writes them: morrow-<cli> launches, the CLIs' own names refuse.
for cli in cursor gemini grok; do
  printf '#!/bin/sh\nexec /opt/morrow/bin/relay-worker launch %s "$@"\n' "$cli" >"/opt/morrow/relay-shims/morrow-$cli"
  chmod 0755 "/opt/morrow/relay-shims/morrow-$cli"
done
for name in gemini grok cursor-agent agent; do
  printf '#!/bin/sh\nexec /opt/morrow/bin/relay-worker deny\n' >"/opt/morrow/relay-shims/$name"
  chmod 0755 "/opt/morrow/relay-shims/$name"
done
printf '{"mcpServers":{}}\n' >/opt/morrow/etc/gemini/settings.json
chmod 0644 /opt/morrow/etc/gemini/settings.json
# Stand-in bun for `morrow-agent.js register`: writes both user configs, unless told to do nothing.
printf '// stand-in\n' >/opt/morrow/morrow-agent.js
cat >/usr/local/bin/bun <<'EOF'
#!/bin/bash
[ "${2:-}" = register ] || exit 1
[ -e /tmp/rw/bun.noop ] && exit 0
mkdir -p "$HOME/.cursor" "$HOME/.grok"
printf '{"mcpServers":{"agent-relay":{"command":"/opt/morrow/bin/relay-worker","args":["mcp"]}}}\n' >"$HOME/.cursor/mcp.json"
printf '[mcp_servers.agent-relay]\ncommand = "/opt/morrow/bin/relay-worker"\n' >"$HOME/.grok/config.toml"
echo register >>/tmp/rw/bun.calls
EOF
chmod 0755 /usr/local/bin/bun
# The engineer's PATH as configure-node.sh records it; the shim dir in it must be dropped.
printf '/opt/morrow/relay-shims:/usr/local/bin:/usr/bin:/bin' >/etc/agent-relay/worker.path

# Stand-in sudo: records its argv (NUL separated) and environment, then stops.
cat >/usr/bin/sudo <<'EOF'
#!/bin/bash
printf '%s\0' "$@" >/tmp/rw/sudo.argv
env -0 >/tmp/rw/sudo.env
exit 0
EOF
chmod 0755 /usr/bin/sudo

# Fake CLIs and agent-relay: record argv and environment.
cat >/usr/local/lib/record <<'EOF'
#!/bin/bash
{ printf 'ARGV'; printf '\0%s' "$@"; printf '\n'; env -0; } >"/tmp/rw/$(basename "$0").rec"
EOF
chmod 0755 /usr/local/lib/record
for cli in claude codex opencode gemini cursor-agent grok agent-relay; do ln -sf /usr/local/lib/record "/usr/local/bin/$cli"; done

emit() {
  local label="$1" rc="$2" file="${3:-}"
  local b64=""
  if [ -n "$file" ] && [ -f "$file" ]; then b64="$(base64 -w0 "$file")"; fi
  printf '%s\t%d\t%s\n' "$label" "$rc" "$b64"
}

# As the broker: the environment the broker gives a CLI (key in four variables plus the agent's own).
launch() {
  local label="$1"
  shift
  rm -f "$OUT/sudo.argv" "$OUT/sudo.env"
  runuser -u "$R" -- env -i PATH=/opt/morrow/relay-shims:/usr/bin:/bin HOME=/tmp \
    RELAY_API_KEY="${LAUNCH_KEY:-$KEY}" RELAY_WORKSPACE_KEY="${LAUNCH_KEY:-$KEY}" AGENT_RELAY_WORKSPACE_KEY="${LAUNCH_KEY:-$KEY}" \
    RELAY_WORKSPACES_JSON="{\"workspaces\":[{\"key\":\"${LAUNCH_KEY:-$KEY}\"}]}" \
    RELAY_AGENT_NAME=w-1 RELAY_AGENT_TOKEN="$TOKEN" RELAY_BASE_URL=https://relay.example \
    "$@" >/dev/null 2>"$OUT/err"
  emit "$label" $? "$OUT/sudo.argv"
}

MCP_JSON_MID="{\"mcpServers\":{\"agent-relay\":{\"command\":\"/opt/morrow/bin/relay-worker\",\"args\":[\"mcp\"],\"env\":{\"RELAY_AGENT_NAME\":\"w-1\",\"RELAY_API_KEY\":\"$KEY\",\"RELAY_AGENT_TOKEN\":\"$TOKEN\"}}}}"
MCP_JSON_FIRST="{\"mcpServers\":{\"agent-relay\":{\"command\":\"/opt/morrow/bin/relay-worker\",\"args\":[\"mcp\"],\"env\":{\"RELAY_API_KEY\":\"$KEY\",\"RELAY_WORKSPACES_JSON\":\"{\\\"k\\\":\\\"$KEY\\\"}\",\"RELAY_AGENT_NAME\":\"w-1\"}}}}"
MCP_JSON_LAST="{\"mcpServers\":{\"agent-relay\":{\"command\":\"/opt/morrow/bin/relay-worker\",\"args\":[\"mcp\"],\"env\":{\"RELAY_AGENT_NAME\":\"w-1\",\"RELAY_API_KEY\" : \"$KEY\"}}}}"

launch claude_mid /opt/morrow/relay-shims/claude --dangerously-skip-permissions --mcp-config "$MCP_JSON_MID" --model x
launch claude_first /opt/morrow/relay-shims/claude --mcp-config "$MCP_JSON_FIRST"
launch claude_last /opt/morrow/relay-shims/claude "--mcp-config=$MCP_JSON_LAST"
launch codex_forms /opt/morrow/relay-shims/codex \
  --config check_for_update_on_startup=false \
  --config 'mcp_servers.agent-relay.command="/opt/morrow/bin/relay-worker"' \
  --config "mcp_servers.agent-relay.env.RELAY_API_KEY=\"$KEY\"" \
  -c "mcp_servers.agent-relay.env.RELAY_WORKSPACES_JSON=\"{\\\"k\\\":\\\"$KEY\\\"}\"" \
  "--config=mcp_servers.agent-relay.env.RELAY_WORKSPACE_KEY=\"$KEY\"" \
  --config "mcp_servers.agent-relay.env.RELAY_AGENT_TOKEN=\"$TOKEN\"" \
  --dangerously-bypass-approvals-and-sandbox
launch key_in_other_arg /opt/morrow/relay-shims/claude "--append-system-prompt=use $KEY"
LAUNCH_KEY="$SELF_HOSTED_KEY" launch self_hosted_key_in_arg /opt/morrow/relay-shims/codex "--note=$SELF_HOSTED_KEY"
launch cursor_launch /opt/morrow/relay-shims/morrow-cursor --force --approve-mcps --trust --disable-auto-update --model m
launch gemini_launch /opt/morrow/relay-shims/morrow-gemini --approval-mode yolo
launch grok_launch /opt/morrow/relay-shims/morrow-grok --always-approve --trust
# The broker's default flows for these CLIs would write the key into their MCP config: their own names refuse.
for name in gemini grok cursor-agent agent; do launch "deny_$name" "/opt/morrow/relay-shims/$name" --yolo; done
runuser -u "$U" -- /opt/morrow/bin/relay-worker deny >/dev/null 2>&1
emit deny_as_engineer $?
runuser -u "$U" -- /opt/morrow/bin/relay-worker launch claude >/dev/null 2>&1
emit launch_as_engineer $?
runuser -u "$R" -- /opt/morrow/bin/relay-worker launch bash >/dev/null 2>&1
emit launch_unknown_cli $?

# As the engineer, with what sudo's env_reset + env_keep pass (plus sudo's own SUDO_* variables).
exec_as() {
  local label="$1" user="$2" cli="$3" rec="$3"
  shift 3
  # Cursor Agent's program is cursor-agent.
  [ "$cli" = cursor ] && rec=cursor-agent
  rm -f "$OUT/$rec.rec"
  (cd "${EXEC_CWD:-/tmp}" && runuser -u "$user" -- env -i TERM=xterm PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    HOME="/home/$U" SUDO_USER="$R" SUDO_UID=999 SUDO_COMMAND=x MAIL=/var/mail/x \
    RELAY_AGENT_NAME="${EXEC_NAME:-w-1}" RELAY_AGENT_TOKEN="${EXEC_TOKEN:-$TOKEN}" RELAY_BASE_URL=https://relay.example \
    ${EXEC_EXTRA:+"$EXEC_EXTRA"} \
    /opt/morrow/bin/relay-worker exec "$cli" "$@" >/dev/null 2>"$OUT/err")
  emit "$label" $? "$OUT/$rec.rec"
}

exec_as exec_claude "$U" claude --mcp-config '{"mcpServers":{}}'
exec_as exec_codex_normal "$U" codex --dangerously-bypass-approvals-and-sandbox --model m
exec_as exec_codex_ro "$U" codex --sandbox read-only --ask-for-approval never --dangerously-bypass-approvals-and-sandbox
exec_as exec_codex_ro_short "$U" codex -s read-only --dangerously-bypass-approvals-and-sandbox
exec_as exec_codex_ro_eq "$U" codex --sandbox=read-only --dangerously-bypass-approvals-and-sandbox
exec_as exec_opencode "$U" opencode --agent agent-relay
EXEC_EXTRA="RELAY_API_KEY=$KEY" exec_as exec_refuses_key_var "$U" claude
EXEC_EXTRA="SOMETHING=$KEY" exec_as exec_refuses_key_value "$U" claude
EXEC_EXTRA="RELAY_WORKSPACES_JSON=[]" exec_as exec_refuses_secret_name "$U" claude
exec_as exec_refuses_key_arg "$U" claude "--x=$KEY"
exec_as exec_refuses_broker_user "$R" claude
exec_as exec_refuses_root root claude
EXEC_NAME='w-1","x":"y' exec_as exec_opencode_bad_name "$U" opencode
EXEC_TOKEN='not-a-token' exec_as exec_opencode_bad_token "$U" opencode

# Gemini CLI: the workers' root-owned settings, the agent token under its GEMINI_CLI_ name.
exec_as exec_gemini "$U" gemini --approval-mode yolo
EXEC_TOKEN='not-a-token' exec_as exec_gemini_bad_token "$U" gemini
chown "$U" /opt/morrow/etc/gemini/settings.json
exec_as exec_gemini_settings_not_root "$U" gemini
chown root /opt/morrow/etc/gemini/settings.json
mv /opt/morrow/etc/gemini/settings.json /opt/morrow/etc/gemini/settings.real
ln -s /opt/morrow/etc/gemini/settings.real /opt/morrow/etc/gemini/settings.json
exec_as exec_gemini_settings_symlink "$U" gemini
rm /opt/morrow/etc/gemini/settings.json
exec_as exec_gemini_settings_missing "$U" gemini
mv /opt/morrow/etc/gemini/settings.real /opt/morrow/etc/gemini/settings.json

# Cursor Agent and Grok: the engineer's own config must name the bridge; register restores it once.
touch "$OUT/bun.noop"
exec_as exec_cursor_no_config "$U" cursor
exec_as exec_grok_no_config "$U" grok
install -d -o "$U" -g "$U" "/home/$U/.cursor"
ln -s /tmp/elsewhere.json "/home/$U/.cursor/mcp.json"
printf '{"mcpServers":{"agent-relay":{"command":"/opt/morrow/bin/relay-worker"}}}' >/tmp/elsewhere.json
exec_as exec_cursor_symlinked_config "$U" cursor
rm -f "/home/$U/.cursor/mcp.json" "$OUT/bun.noop" "$OUT/bun.calls"
exec_as exec_cursor "$U" cursor --force --approve-mcps --trust --disable-auto-update --model m
emit cursor_register_calls 0 "$OUT/bun.calls"
cp "/home/$U/.cursor/mcp.json" "$OUT/cursor-mcp.json"
emit cursor_config 0 "$OUT/cursor-mcp.json"
exec_as exec_cursor_again "$U" cursor
emit cursor_register_calls_again 0 "$OUT/bun.calls"
exec_as exec_grok "$U" grok --always-approve --trust

# Codex folder trust. The earlier Codex runs started in /tmp, outside the work tree: nothing was written.
emit codex_trust_outside 0 "/home/$U/.codex/config.toml"
H="/home/$U"
mkrepo() { # <repo dir> [worktree name]: a main checkout, and a linked worktree of it, as git.sh lays them out
  install -d -o "$U" -g "$U" "$H/work" "$H/work/$1" "$H/work/$1/.git" "$H/work/.worktrees" "$H/work/.worktrees/$1"
  if [ -n "${2:-}" ]; then
    install -d -o "$U" -g "$U" "$H/work/$1/.git/worktrees/$2" "$H/work/.worktrees/$1/$2"
    printf 'gitdir: %s/work/%s/.git/worktrees/%s\n' "$H" "$1" "$2" >"$H/work/.worktrees/$1/$2/.git"
    chown "$U:$U" "$H/work/.worktrees/$1/$2/.git"
  fi
}
mkrepo acme__web main
mkrepo acme__web feature-2
install -d -o "$U" -g "$U" "$H/.codex"
printf 'model = "gpt-5"\n\n# morrow-agent begin (managed by Morrow, replaced on update)\n[mcp_servers.morrow-agent]\ncommand = "/usr/local/bin/bun"\n# morrow-agent end' >"$H/.codex/config.toml"
chown "$U:$U" "$H/.codex/config.toml"
EXEC_CWD="$H/work/.worktrees/acme__web/main" exec_as exec_codex_trust_worktree "$U" codex --model m
cp "$H/.codex/config.toml" "$OUT/codex-config-1"
emit codex_trust_config_1 0 "$OUT/codex-config-1"
# Another worktree of the same repository: covered by the same entry, nothing added.
EXEC_CWD="$H/work/.worktrees/acme__web/feature-2" exec_as exec_codex_trust_again "$U" codex
emit codex_trust_config_2 0 "$H/.codex/config.toml"
# An entry the engineer chose stays as it is, in any spelling.
mkrepo acme__api
printf "\n[projects]\n'%s/work/acme__api' = { trust_level = \"untrusted\" }\n" "$H" >>"$H/.codex/config.toml"
cp "$H/.codex/config.toml" "$OUT/codex-config-before-api"
EXEC_CWD="$H/work/acme__api" exec_as exec_codex_trust_known "$U" codex
cmp -s "$H/.codex/config.toml" "$OUT/codex-config-before-api"
emit codex_trust_known_unchanged $?
# A .git file pointing outside the work tree trusts only the folder itself.
install -d -o "$U" -g "$U" "$H/work/.worktrees/acme__web/odd"
printf 'gitdir: /tmp/elsewhere/.git/worktrees/odd\n' >"$H/work/.worktrees/acme__web/odd/.git"
rm -f "$H/.codex/config.toml"
EXEC_CWD="$H/work/.worktrees/acme__web/odd" exec_as exec_codex_trust_odd "$U" codex
emit codex_trust_config_odd 0 "$H/.codex/config.toml"
# Parallel starts in four repositories: every entry lands.
rm -f "$H/.codex/config.toml"
for n in 1 2 3 4; do mkrepo "acme__r$n" main; done
for n in 1 2 3 4; do EXEC_CWD="$H/work/.worktrees/acme__r$n/main" exec_as "exec_codex_trust_par_$n" "$U" codex & done
wait
emit codex_trust_config_parallel 0 "$H/.codex/config.toml"
# A symlinked config is never written through; Codex still starts.
rm -f "$H/.codex/config.toml"
printf 'x = 1\n' >/tmp/codex-victim.toml
ln -s /tmp/codex-victim.toml "$H/.codex/config.toml"
EXEC_CWD="$H/work/.worktrees/acme__web/main" exec_as exec_codex_trust_symlink "$U" codex
emit codex_trust_symlink_victim 0 /tmp/codex-victim.toml
rm -f "$H/.codex/config.toml"

# The MCP server command, as the CLI would start it (the CLI's environment plus the config's).
rm -f "$OUT/agent-relay.rec"
runuser -u "$U" -- env -i PATH=/usr/bin:/bin HOME="/home/$U" RELAY_AGENT_NAME=w-1 RELAY_AGENT_TOKEN="$TOKEN" \
  RELAY_WORKSPACE_KEY=leftover AGENT_RELAY_WORKSPACE_KEY=leftover RELAY_WORKSPACES_JSON=leftover \
  /opt/morrow/bin/relay-worker mcp >/dev/null 2>&1
emit mcp $? "$OUT/agent-relay.rec"
echo "DONE"
