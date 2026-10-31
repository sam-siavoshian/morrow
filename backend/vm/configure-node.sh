#!/usr/bin/env bash
# Writes the Agent Relay node config and systemd unit for one engineer, and
# brings the unit to the desired state. Runs as root. Idempotent: the unit is
# only restarted when its config changed or it is not running, because a
# restart kills every worker the broker spawned.
#
# Env:
#   ACTION              apply | remove | restart
#   MORROW_USER        engineer Linux user (u<id>)
#   NODE_NAME           Relay node name (--broker-name)
#   HARNESSES           CSV of ready CLIs; empty = keep the node stopped
#                       (unset, the broker advertises every harness it knows)
#   MAX_AGENTS          node capacity (integer)
#   RELAY_WORKSPACE_KEY workspace key, only written to the root-only env file
#   RELAY_BASE_URL      optional engine origin (empty = hosted)
#   RELAY_WORKER_SCRIPT base64 of vm/relay-worker.sh
#
# Who holds the workspace key. The broker hands it to every CLI it spawns
# (environment and, for Claude Code and Codex, the command line). So the broker
# runs as its own user r<id>, with its state in /var/lib/morrow/relay/r<id>,
# and the CLIs run as the engineer u<id> through /opt/morrow/bin/relay-worker,
# which drops the key on the way (see that script). r<id> may start exactly that
# script as u<id> through sudo and nothing else. /proc hides other users'
# processes, so u<id> cannot read the broker's environment or command lines.
set -Eeuo pipefail
umask 077

readonly UNIT_NAME="morrow-relay-node.service"
readonly UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
readonly ENV_DIR="/etc/agent-relay"
readonly ENV_PATH="$ENV_DIR/node.env"
readonly NODE_ID_PATH="$ENV_DIR/node-id"
readonly IDENTITY_KEY_PATH="$ENV_DIR/identity-key"
readonly WORKER_PATH_FILE="$ENV_DIR/worker.path"
readonly RELAY_INSTALL_DIR="/opt/agent-relay"
readonly RELAY_ROOT="/var/lib/morrow/relay"
readonly HELPER_ROOT="/opt/morrow"
readonly HELPER="$HELPER_ROOT/bin/relay-worker"
readonly SHIM_DIR="$HELPER_ROOT/relay-shims"
readonly GEMINI_DIR="$HELPER_ROOT/etc/gemini"
readonly SYSTEM_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# Root runs useradd, visudo and mount: never depend on, or trust, the caller's PATH.
export PATH="$SYSTEM_PATH"

die() { printf '[configure-node] error: %s\n' "$*" >&2; exit 1; }
note() { printf '[configure-node] %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
action="${ACTION:-}"
user="${MORROW_USER:-}"
[[ "$user" =~ ^u([a-f0-9]{12})$ ]] || die "invalid user"
relay_user="r${BASH_REMATCH[1]}"
relay_home="$RELAY_ROOT/$relay_user"
sudoers_path="/etc/sudoers.d/morrow-relay-$relay_user"

unit_active() { systemctl is-active --quiet "$UNIT_NAME"; }

if [ "$action" = "remove" ]; then
  systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  rm -f -- "$ENV_PATH" "$UNIT_PATH" "$sudoers_path"
  systemctl daemon-reload
  printf '{"changed":true,"active":false}\n'
  exit 0
fi
if [ "$action" = "restart" ]; then
  # Recovery for a broker whose engine link is wedged after a worker crash.
  # Only a unit that apply enabled (it has ready harnesses) is restarted.
  restarted=false
  if systemctl is-enabled --quiet "$UNIT_NAME" 2>/dev/null; then
    systemctl restart "$UNIT_NAME"
    restarted=true
  fi
  active=false
  unit_active && active=true
  printf '{"restarted":%s,"active":%s}\n' "$restarted" "$active"
  exit 0
fi
[ "$action" = "apply" ] || die "invalid action"

node="${NODE_NAME:-}"
harnesses="${HARNESSES:-}"
max_agents="${MAX_AGENTS:-0}"
key="${RELAY_WORKSPACE_KEY:-}"
base_url="${RELAY_BASE_URL:-}"
worker_b64="${RELAY_WORKER_SCRIPT:-}"
unset RELAY_WORKSPACE_KEY RELAY_WORKER_SCRIPT

[[ "$node" =~ ^n-[a-f0-9]{12}$ ]] || die "invalid node name"
readonly HARNESS='(claude|codex|opencode|cursor|gemini|grok)'
[[ -z "$harnesses" || "$harnesses" =~ ^$HARNESS(,$HARNESS)*$ ]] || die "invalid harness list"
[[ "$max_agents" =~ ^[0-9]{1,2}$ ]] || die "invalid max agents"
[[ "$key" =~ ^[A-Za-z0-9_-]{16,512}$ ]] || die "invalid workspace key"
# Characters an EnvironmentFile would interpret (quotes, backslash, whitespace, $) are refused.
[[ -z "$base_url" || "$base_url" =~ ^https://[A-Za-z0-9._~:/?#@!\&()*+,\;=%-]{1,500}$ ]] || die "invalid base url"
# Length checked apart from the pattern: glibc refuses repeat bounds above 32767, and large ones exhaust memory.
(( ${#worker_b64} >= 100 && ${#worker_b64} <= 65536 )) && [[ "$worker_b64" =~ ^[A-Za-z0-9+/=]+$ ]] || die "invalid relay worker script"
worker_script="$(printf '%s' "$worker_b64" | base64 -d 2>/dev/null)" || die "invalid relay worker script"
[[ "$worker_script" == "#!/usr/bin/env bash"* ]] || die "invalid relay worker script"
unset worker_b64
id -u "$user" >/dev/null 2>&1 || die "user does not exist"
command -v sudo >/dev/null 2>&1 || die "sudo is not installed (rebuild the golden image)"
command -v visudo >/dev/null 2>&1 || die "visudo is not installed"
# agent-relay checks a crashed broker's node claim with lsof. Without it the
# claim reads as held forever and the node never starts again.
command -v lsof >/dev/null 2>&1 || die "lsof is not installed (rebuild the golden image)"
[ -x "$RELAY_INSTALL_DIR/bin/agent-relay-broker" ] || die "agent-relay is not installed (rebuild the golden image)"
# Older golden images keep the installer's execute-only (0711) binaries. A
# process started from a binary its user cannot read is non-dumpable, so the
# broker user could not inspect its own broker and agent-relay refuses to start.
chmod -R a+rX,go-w -- "$RELAY_INSTALL_DIR"

home="/home/$user"
[ -d "$home" ] && [ ! -L "$home" ] && [ "$(stat -c %U "$home")" = "$user" ] || die "home directory missing or wrong owner"

changed=false
# Writes a root-owned file atomically when its content differs. Returns 0 when it wrote.
write_file() {
  local path="$1" mode="$2" content="$3" tmp
  if [ -f "$path" ] && [ ! -L "$path" ] && [ "$(cat -- "$path")" = "$content" ]; then
    chmod "$mode" "$path"
    chown root:root "$path"
    return 1
  fi
  tmp="$(mktemp -p "$(dirname -- "$path")" .morrow.XXXXXXXX)"
  printf '%s\n' "$content" >"$tmp"
  chmod "$mode" "$tmp"
  chown root:root "$tmp"
  if [ -n "${VALIDATE_SUDOERS:-}" ] && ! visudo -cqf "$tmp" >/dev/null 2>&1; then
    rm -f -- "$tmp"
    die "generated sudoers rule does not validate"
  fi
  mv -f -- "$tmp" "$path"
  return 0
}
# Same, for files the running broker reads at start: a change means a restart.
write_if_changed() {
  if write_file "$@"; then changed=true; fi
}

# ---------- the broker's own account ----------

install -d -m 0711 -o root -g root /var/lib/morrow "$RELAY_ROOT"
if ! id -u "$relay_user" >/dev/null 2>&1; then
  # Exit 9 = created concurrently by another run; that is success.
  useradd --system --user-group --no-create-home --home-dir "$relay_home" --shell /bin/bash "$relay_user" || [ $? -eq 9 ]
fi
id -u "$relay_user" >/dev/null 2>&1 || die "relay user was not created"
[ "$(getent passwd "$relay_user" | cut -d: -f6)" = "$relay_home" ] || die "relay user has an unexpected home"
# Its own group only: never the engineer's group (the unit adds that for the
# broker alone), never a privilege group.
for group in $(id -nG "$relay_user"); do
  [ "$group" = "$relay_user" ] || gpasswd -d "$relay_user" "$group" >/dev/null
done
if grep -rqsw -- "$relay_user" /etc/sudoers 2>/dev/null; then die "relay user appears in sudoers"; fi
# RELAY_ROOT is root-owned, so the broker cannot swap its home for a symlink.
if [ ! -e "$relay_home" ]; then
  install -d -m 0700 -o "$relay_user" -g "$relay_user" "$relay_home"
fi
[ -d "$relay_home" ] && [ ! -L "$relay_home" ] && [ "$(stat -c %U "$relay_home")" = "$relay_user" ] || die "relay home has the wrong owner"
chmod 0700 "$relay_home"
# Root never creates anything inside a home it does not own.
runuser -u "$relay_user" -- mkdir -p -m 0700 "$relay_home/relay-node" </dev/null

# The broker starts each CLI in its worktree, so it must traverse the
# engineer's home down to the worktrees (group x only; never write).
# shellcheck disable=SC2016  # expanded by the inner sh
runuser -u "$user" -- sh -c '
  for d in "$1/work" "$1/work/.worktrees"; do [ -d "$d" ] && chmod g+x -- "$d"; done
  [ -d "$1/work/.worktrees" ] && find "$1/work/.worktrees" -mindepth 1 -maxdepth 2 -type d -exec chmod g+x -- {} + 2>/dev/null
  exit 0
' sh "$home" </dev/null

# ---------- helper, shims, PATHs, sudo rule ----------

install -d -m 0755 -o root -g root "$HELPER_ROOT" "$HELPER_ROOT/bin" "$SHIM_DIR" "$ENV_DIR" "$HELPER_ROOT/etc" "$GEMINI_DIR"
write_file "$HELPER" 0755 "$worker_script" || true
for cli in claude codex opencode; do
  write_file "$SHIM_DIR/$cli" 0755 "#!/bin/sh
exec $HELPER launch $cli \"\$@\"" || true
done
# Cursor Agent, Gemini CLI and Grok start under another name (the backend's
# harnessConfig), so the broker sets up no MCP config for them, with the key in
# it (see relay-worker.sh). Their own names on the broker's PATH refuse.
for cli in cursor gemini grok; do
  write_file "$SHIM_DIR/morrow-$cli" 0755 "#!/bin/sh
exec $HELPER launch $cli \"\$@\"" || true
done
for name in gemini grok cursor-agent agent; do
  write_file "$SHIM_DIR/$name" 0755 "#!/bin/sh
exec $HELPER deny" || true
done

# Gemini CLI workers read their MCP servers from this file alone
# (GEMINI_CLI_SYSTEM_SETTINGS_PATH, set by relay-worker.sh exec). Root-owned and
# holds no value: Gemini fills in $GEMINI_CLI_MORROW_AGENT_TOKEN from the
# worker's environment. The servers inherit the worker's name and URL; Gemini
# passes on no variable whose name holds TOKEN or KEY, hence the prefixed copy
# of the agent token. trust lets their tools run in plan mode (read-only
# subagents); delegate_task waits up to 30 minutes.
# shellcheck disable=SC2016  # expanded by Gemini CLI, never here
gemini_settings='{
  "general": { "enableAutoUpdate": false, "enableAutoUpdateNotification": false },
  "privacy": { "usageStatisticsEnabled": false },
  "telemetry": { "enabled": false },
  "advanced": { "ignoreLocalEnv": true },
  "mcpServers": {
    "agent-relay": {
      "command": "/opt/morrow/bin/relay-worker",
      "args": ["mcp"],
      "trust": true,
      "env": {
        "RELAY_AGENT_TOKEN": "$GEMINI_CLI_MORROW_AGENT_TOKEN",
        "RELAY_AGENT_TYPE": "agent",
        "RELAY_STRICT_AGENT_NAME": "1",
        "RELAY_SKIP_BOOTSTRAP": "1"
      }
    },
    "morrow-agent": {
      "command": "/usr/local/bin/bun",
      "args": ["/opt/morrow/morrow-agent.js"],
      "trust": true,
      "timeout": 1900000,
      "env": { "RELAY_AGENT_TOKEN": "$GEMINI_CLI_MORROW_AGENT_TOKEN" }
    }
  }
}'
write_file "$GEMINI_DIR/settings.json" 0644 "$gemini_settings" || true

# The engineer's login PATH, the one their terminal (and their claude/codex
# login) used. Only plain path characters survive.
# shellcheck disable=SC2016  # expanded by the user's login shell
user_path="$(runuser -l "$user" -c 'printf %s "$PATH"' </dev/null 2>/dev/null || true)"
[[ "$user_path" =~ ^[A-Za-z0-9/._:-]{1,2000}$ ]] || user_path="$SYSTEM_PATH"
write_file "$WORKER_PATH_FILE" 0644 "$user_path" || true

keep_env="TERM COLORTERM LANG LC_ALL LC_CTYPE TZ NO_COLOR FORCE_COLOR"
keep_env="$keep_env RELAY_AGENT_NAME RELAY_AGENT_TOKEN RELAY_AGENT_TYPE RELAY_STRICT_AGENT_NAME RELAY_BASE_URL"
keep_env="$keep_env RELAY_SKIP_PROMPT RELAY_SKIP_BOOTSTRAP AGENT_RELAY_ORIGIN_ACTOR AGENT_RELAY_TELEMETRY_DISABLED DO_NOT_TRACK"
keep_env="$keep_env CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION DISABLE_AUTOUPDATER"
# !use_pty keeps the CLI on the broker's own PTY (no second terminal in
# between), !pam_session skips a login session. sudo stays as the CLI's parent
# on purpose: it runs with the broker's real uid, so the broker may signal it,
# and it passes the signal on. A CLI exec'd in place would run purely as the
# engineer, and the broker could no longer stop it on release. env_keep is the
# whole environment the CLI gets from the broker side: never a workspace key
# variable.
sudoers_content="# Managed by configure-node.sh. The Relay broker user may start the coding CLIs as the engineer, nothing else.
Defaults:$relay_user !use_pty, !pam_session, !lecture, env_reset, !log_allowed
Defaults:$relay_user env_keep = \"$keep_env\"
$relay_user ALL=($user) NOPASSWD: $HELPER exec *"
VALIDATE_SUDOERS=1 write_file "$sudoers_path" 0440 "$sudoers_content" || true

# ---------- hide other users' processes ----------

# The broker's PTY children carry the key in their command line, which any
# user can read from /proc unless hidepid is on. The unit also gets its own
# hidden /proc (ProtectProc=invisible) that its workers inherit; this covers
# processes started outside it (the engineer's terminal, cron).
proc_hidden() { grep -qE '^proc /proc proc [^ ]*hidepid=(2|invisible)' /proc/mounts; }
if ! proc_hidden; then
  mount -o remount,hidepid=invisible /proc 2>/dev/null || note "could not remount /proc with hidepid"
fi
if [ -f /etc/fstab ] && ! grep -qE '^[^#]*[[:space:]]/proc[[:space:]]' /etc/fstab; then
  printf 'proc /proc proc defaults,hidepid=invisible 0 0\n' >>/etc/fstab
fi
proc_hidden_now=false
proc_hidden && proc_hidden_now=true

# ---------- move a node that ran as the engineer ----------

# Before this layout the broker ran as the engineer, with its identity in their
# home. The node keeps its name only if it keeps its id: copy the node token
# into the broker's home and pin the id (the id also depends on the broker's
# working directory, which moves). The same goes for the proof the broker gives
# the engine that its name is its own: agent-relay derives it from the broker's
# state file path (sha256 of <project root>/.agentworkforce/relay/state-<name>.json),
# that path moves too, and without the old proof the engine refuses the name
# (409 agent_identity_mismatch). Then remove every Relay file from the
# engineer's home: the node token, the broker's local API key and logs. Reads
# and writes run as each account, never as root inside either home.
old_layout=false
if [ -f "$UNIT_PATH" ] && grep -qx "User=$user" "$UNIT_PATH"; then old_layout=true; fi
if [ "$old_layout" = true ] || runuser -u "$user" -- test -e "$home/relay-node" </dev/null; then
  systemctl stop "$UNIT_NAME" >/dev/null 2>&1 || true
  old_tokens="$home/.local/share/agent-relay/node-tokens"
  if [ ! -f "$NODE_ID_PATH" ]; then
    names="$(runuser -u "$user" -- find "$old_tokens" -maxdepth 1 -type f -name 'node_*.json' -printf '%f\n' </dev/null 2>/dev/null || true)"
    if [[ "$names" =~ ^(node_[a-f0-9]{32})\.json$ ]]; then
      node_id="${BASH_REMATCH[1]}"
      # shellcheck disable=SC2016  # expanded by the inner sh
      runuser -u "$user" -- head -c 65536 -- "$old_tokens/$names" </dev/null |
        runuser -u "$relay_user" -- sh -c 'umask 077 && mkdir -p "$1" && cat >"$1/$2"' sh "$relay_home/.local/share/agent-relay/node-tokens" "$names"
      write_file "$NODE_ID_PATH" 0600 "$node_id" || true
      note "moved node identity $node_id to $relay_user"
    elif [ -n "$names" ]; then
      note "more than one old node identity; the node starts fresh"
    fi
  fi
  if [ ! -f "$IDENTITY_KEY_PATH" ]; then
    # The old project root is the one whose broker lock was written last
    # (agent-relay picks the nearest dir with Relay state, so either can be it).
    # shellcheck disable=SC2016  # expanded by the inner sh
    old_root="$(runuser -u "$user" -- sh -c '
      best="" best_t=0
      for d in "$1/relay-node" "$1"; do
        lock="$d/.agentworkforce/relay/broker-$2.lock"
        [ -f "$lock" ] || continue
        t="$(stat -c %Y -- "$lock")" || continue
        if [ -z "$best" ] || [ "$t" -gt "$best_t" ]; then best="$(cd -P -- "$d" && pwd -P)" && best_t="$t"; fi
      done
      printf %s "$best"' sh "$home" "$node" </dev/null 2>/dev/null || true)"
    if [[ "$old_root" =~ ^/[A-Za-z0-9/._-]{1,500}$ ]]; then
      identity="node-$(printf '%s' "$old_root/.agentworkforce/relay/state-$node.json" | sha256sum | cut -d' ' -f1)"
      write_file "$IDENTITY_KEY_PATH" 0600 "$identity" || true
      note "kept the node's registration proof"
    else
      note "no old broker state found; the engine may refuse the node's name"
    fi
  fi
  runuser -u "$user" -- rm -rf -- "$home/relay-node" "$home/.local/share/agent-relay" \
    "$home/.agentworkforce/relay/workspace-key.json" "$home/.agentworkforce/relay/workspaces.json" \
    "$home/.agentworkforce/relay/relaycast-credentials.json" "$home/.agentworkforce/relay/connection.json" </dev/null
  changed=true
fi

# ---------- env file and unit ----------

env_content="RELAY_WORKSPACE_KEY=$key"
[ -z "$base_url" ] || env_content="$env_content
RELAY_BASE_URL=$base_url"
if [ -f "$NODE_ID_PATH" ]; then
  node_id="$(head -c 64 -- "$NODE_ID_PATH")"
  [[ "$node_id" =~ ^node_[a-f0-9]{32}$ ]] || die "invalid pinned node id"
  env_content="$env_content
RELAY_NODE_ID=$node_id"
fi
if [ -f "$IDENTITY_KEY_PATH" ]; then
  identity="$(head -c 80 -- "$IDENTITY_KEY_PATH")"
  [[ "$identity" =~ ^node-[a-f0-9]{64}$ ]] || die "invalid pinned registration proof"
  # Never reaches a CLI: the broker strips it from worker environments and
  # sudo's env_reset drops it again.
  env_content="$env_content
RELAY_AGENT_IDENTITY_KEY=$identity"
fi
write_if_changed "$ENV_PATH" 0600 "$env_content"
unset key env_content

# The PTY every worker runs in. The service has no terminal, so agent-relay
# sizes each worker's PTY from `tput cols` / `tput lines`, which read COLUMNS
# and LINES once TERM is set (without TERM it falls back to 80x24). Live
# inspect renders at exactly this size: WORKER_TERMINAL in packages/contracts.
# The CLIs never see COLUMNS/LINES (sudo resets the environment); they read
# the PTY itself. TERM is what the broker gives their PTYs anyway.
readonly PTY_COLS=80 PTY_ROWS=40

# NoNewPrivileges is off: sudo (setuid) is how a CLI starts as the engineer.
# The sudo rule allows exactly one command as exactly one user.
unit_content="[Unit]
Description=Morrow Agent Relay node ($node)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$relay_user
Group=$relay_user
SupplementaryGroups=$user
WorkingDirectory=$relay_home/relay-node
EnvironmentFile=$ENV_PATH
Environment=AGENT_RELAY_PROJECT=$relay_home/relay-node
Environment=AGENT_RELAY_NODE_HARNESSES=$harnesses
Environment=AGENT_RELAY_NODE_MAX_AGENTS=$max_agents
Environment=AGENT_RELAY_TELEMETRY_DISABLED=1
Environment=DO_NOT_TRACK=1
Environment=TERM=xterm-256color
Environment=COLUMNS=$PTY_COLS
Environment=LINES=$PTY_ROWS
Environment=AGENT_RELAY_INSTALL_DIR=$RELAY_INSTALL_DIR
Environment=\"AGENT_RELAY_MCP_COMMAND=$HELPER mcp\"
Environment=PATH=$SHIM_DIR:$RELAY_INSTALL_DIR/bin:$SYSTEM_PATH
ExecStart=/usr/local/bin/agent-relay node up --broker-name $node --no-spawn
UMask=0077
ProtectProc=invisible
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target"
write_if_changed "$UNIT_PATH" 0644 "$unit_content"
if [ "$changed" = true ]; then
  systemctl daemon-reload
fi

if [ -z "$harnesses" ]; then
  systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
else
  systemctl enable "$UNIT_NAME" >/dev/null 2>&1
  if [ "$changed" = true ] || ! unit_active; then
    systemctl restart "$UNIT_NAME"
  fi
fi

active=false
unit_active && active=true
printf '{"changed":%s,"active":%s,"procHidden":%s}\n' "$changed" "$active" "$proc_hidden_now"
