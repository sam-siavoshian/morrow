#!/usr/bin/env bash
# Bridge between the Agent Relay broker and the coding CLIs it starts.
# configure-node.sh installs it at /opt/morrow/bin/relay-worker (root:root 0755).
#
# Why: the broker (agent-relay 14.0.0) hands every CLI it spawns the team's
# workspace key (rk_live_...): in the environment (RELAY_API_KEY,
# RELAY_WORKSPACE_KEY, AGENT_RELAY_WORKSPACE_KEY, RELAY_WORKSPACES_JSON) and,
# for Claude Code and Codex, inside the MCP config it puts on the command line.
# With that key a worker could register or take over any Relay name
# (`dispatcher`, a person's `h-<login>`, another worker) and read every channel.
# So the broker runs as its own Linux user (r<id>) and the CLIs run as the
# engineer (u<id>), who cannot read the broker's processes or files. This
# script is the only way across:
#
#   launch <cli> [args...]  As r<id>, from the shims in /opt/morrow/relay-shims
#                           that sit first on the broker's PATH. Drops the key
#                           from the arguments, then hands over through sudo,
#                           which keeps only the environment variables listed in
#                           /etc/sudoers.d/morrow-relay-<r-user>.
#   exec <cli> [args...]    As u<id>, through sudo. Refuses to start if anything
#                           key-shaped is still in its environment or arguments,
#                           then runs the real CLI from the engineer's PATH.
#   mcp                     The MCP server command the broker writes into each
#                           CLI's config (AGENT_RELAY_MCP_COMMAND). Runs
#                           `agent-relay mcp` with only the worker's own agent
#                           token.
#   deny                    The shim for a CLI name the broker must never start
#                           directly (gemini, grok, cursor-agent, agent). Fails.
#
# Cursor Agent, Gemini CLI and Grok are started through the shims morrow-cursor,
# morrow-gemini and morrow-grok (the backend's harnessConfig names them). The
# broker only sets these CLIs up for Relay when the command is the CLI's own
# name: then it puts the key in a `gemini mcp add` / `grok mcp add` command line
# and writes it into the worker's .cursor/mcp.json from inside its own process,
# where no shim can stop it. Under another name it adds no MCP config, no
# permission bypass and writes nothing, and `exec` below gives each CLI its
# Relay MCP server with the agent token alone:
#   gemini  a root-owned settings file only workers read
#           (GEMINI_CLI_SYSTEM_SETTINGS_PATH, written by configure-node.sh);
#   cursor  ~/.cursor/mcp.json and grok ~/.grok/config.toml, the only MCP
#           sources these CLIs have. morrow-agent's `register` puts the Relay
#           server there with ${...} placeholders, never a value.
set -Eeuo pipefail

readonly SELF="/opt/morrow/bin/relay-worker"
readonly SHIM_DIR="/opt/morrow/relay-shims"
readonly WORKER_PATH_FILE="/etc/agent-relay/worker.path"
readonly AGENT_RELAY="/usr/local/bin/agent-relay"
readonly BUN="/usr/local/bin/bun"
readonly MORROW_AGENT="/opt/morrow/morrow-agent.js"
readonly GEMINI_SETTINGS="/opt/morrow/etc/gemini/settings.json"
readonly GEMINI_DEFAULTS="/opt/morrow/etc/gemini/system-defaults.json"
readonly DEFAULT_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
readonly SECRET_VARS=(RELAY_API_KEY RELAY_WORKSPACE_KEY AGENT_RELAY_WORKSPACE_KEY RELAY_WORKSPACES_JSON)
readonly SECRET_NAMES='RELAY_API_KEY|RELAY_WORKSPACE_KEY|AGENT_RELAY_WORKSPACE_KEY|RELAY_WORKSPACES_JSON'
# Relay workspace keys. Agent tokens (at_live_) are the worker's own and may pass.
readonly KEY_MARKER="rk_live_"

die() {
  printf '[relay-worker] error: %s\n' "$*" >&2
  exit 78
}

valid_cli() { [[ "$1" =~ ^(claude|codex|opencode|cursor|gemini|grok)$ ]]; }

# The program each CLI runs as, on the engineer's PATH.
cli_program() {
  case "$1" in
    cursor) printf 'cursor-agent' ;;
    *) printf '%s' "$1" ;;
  esac
}

# A JSON string body: anything but a quote or backslash, or a backslash escape.
readonly JSON_STRING='"([^"\\]|\\.)*"'
readonly JSON_SECRET_KEY="\"($SECRET_NAMES)\"[[:space:]]*:[[:space:]]*$JSON_STRING"

# Removes every `"<secret name>": "<string>"` member from a JSON text, keeping
# it valid: a member after a comma goes with that comma, a first member with
# the comma after it. Anything this misses is caught by `leaks` below.
strip_json_secrets() {
  local text="$1" with_comma=",[[:space:]]*$JSON_SECRET_KEY" first="${JSON_SECRET_KEY}[[:space:]]*,?"
  while [[ "$text" =~ $with_comma ]]; do text="${text/"${BASH_REMATCH[0]}"/}"; done
  while [[ "$text" =~ $first ]]; do text="${text/"${BASH_REMATCH[0]}"/}"; done
  printf '%s' "$text"
}

# Codex gets MCP env as `--config mcp_servers.<server>.env.<NAME>="..."` pairs.
codex_secret_override() { [[ "$1" =~ ^mcp_servers\.[^=]+\.env\.($SECRET_NAMES)[[:space:]]*= ]]; }

# True when the text carries a workspace key: the marker, or the literal value
# the broker gave us (a self-hosted key need not start with the marker).
leaks() {
  local text="$1" secret
  [[ "$text" == *"$KEY_MARKER"* ]] && return 0
  for secret in "${SECRETS[@]}"; do
    if [ "${#secret}" -ge 16 ] && [[ "$text" == *"$secret"* ]]; then return 0; fi
  done
  return 1
}

launch() {
  local cli="${1:-}"
  valid_cli "$cli" || die "unknown CLI"
  shift
  local me
  me="$(id -un)"
  [[ "$me" =~ ^r([a-f0-9]{12})$ ]] || die "launch must run as the Relay broker user"
  local target="u${BASH_REMATCH[1]}"

  SECRETS=()
  local name
  for name in RELAY_API_KEY RELAY_WORKSPACE_KEY AGENT_RELAY_WORKSPACE_KEY; do
    if [ -n "${!name:-}" ]; then SECRETS+=("${!name}"); fi
  done

  local -a out=()
  local arg
  while (($# > 0)); do
    arg="$1"
    shift
    case "$cli:$arg" in
      claude:--mcp-config)
        (($# > 0)) || die "--mcp-config without a value"
        out+=("$arg" "$(strip_json_secrets "$1")")
        shift
        continue
        ;;
      claude:--mcp-config=*)
        out+=("--mcp-config=$(strip_json_secrets "${arg#--mcp-config=}")")
        continue
        ;;
      codex:--config | codex:-c)
        (($# > 0)) || die "$arg without a value"
        if ! codex_secret_override "$1"; then out+=("$arg" "$1"); fi
        shift
        continue
        ;;
      codex:--config=*)
        codex_secret_override "${arg#--config=}" && continue
        ;;
    esac
    out+=("$arg")
  done
  for arg in ${out[@]+"${out[@]}"}; do
    if leaks "$arg"; then die "refusing to start $cli: a Relay workspace key is still in its arguments"; fi
  done
  # sudo starts from an empty environment plus its env_keep list, so the key
  # variables never reach the engineer's side. Direct exec: sudo replaces
  # itself with the command (no use_pty, no PAM session), so the broker's
  # signals and PTY reach the CLI unchanged.
  exec /usr/bin/sudo -n -u "$target" -- "$SELF" exec "$cli" ${out[@]+"${out[@]}"}
}

# The engineer's login PATH, recorded by configure-node.sh. Never the shim dir.
worker_path() {
  local value=""
  if [ -f "$WORKER_PATH_FILE" ]; then value="$(head -c 4096 -- "$WORKER_PATH_FILE")"; fi
  [[ "$value" =~ ^[A-Za-z0-9/._:-]{1,2000}$ ]] || value="$DEFAULT_PATH"
  local dir joined=""
  local IFS=:
  for dir in $value; do
    [ "$dir" = "$SHIM_DIR" ] && continue
    joined="${joined:+$joined:}$dir"
  done
  printf "%s" "${joined:-$DEFAULT_PATH}"
}

# opencode reads its MCP server and the `agent-relay` agent from this inline
# config (it overrides the project's opencode.json), so the broker never writes
# an opencode.json into the worktree. Mirrors what agent-relay 14.0.0 writes,
# with the agent token in place of the workspace key.
# Every value is checked against a charset that needs no JSON escaping. Runs
# in a command substitution, where `set -e` does not apply: each check exits
# on its own, and the caller checks the status.
opencode_config() {
  local name="${RELAY_AGENT_NAME:-}" token="${RELAY_AGENT_TOKEN:-}" url="${RELAY_BASE_URL:-}" env_json
  if ! [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]]; then die "invalid agent name"; fi
  if [ -n "$token" ] && ! [[ "$token" =~ ^at_live_[A-Za-z0-9_-]{8,256}$ ]]; then die "invalid agent token"; fi
  if [ -n "$url" ] && ! [[ "$url" =~ ^https?://[A-Za-z0-9._~:/?#@!\&()*+,\;=%-]{1,500}$ ]]; then die "invalid base url"; fi
  env_json="\"RELAY_AGENT_NAME\":\"$name\",\"RELAY_AGENT_TYPE\":\"agent\",\"RELAY_STRICT_AGENT_NAME\":\"1\""
  if [ -n "$token" ]; then env_json="$env_json,\"RELAY_AGENT_TOKEN\":\"$token\",\"RELAY_SKIP_BOOTSTRAP\":\"1\""; fi
  if [ -n "$url" ]; then env_json="$env_json,\"RELAY_BASE_URL\":\"$url\""; fi
  # agent-relay-readonly is the agent Morrow starts read-only subagents with:
  # no edits, no shell, Relay and morrow-agent tools (report_result) on.
  printf '{"mcp":{"agent-relay":{"type":"local","command":["%s","mcp"],"environment":{%s}}},"agent":{"agent-relay":{"description":"Agent with Agent Relay MCP enabled","tools":{"agent-relay_*":true}},"agent-relay-readonly":{"description":"Morrow read-only subagent","tools":{"agent-relay_*":true,"morrow-agent_*":true},"permission":{"edit":"deny","bash":"deny"}}},"permission":{"*":{"*":"allow"}}}' "$SELF" "$env_json"
}

# Gemini CLI reads its MCP servers from the workers' settings file. It hides
# every variable whose name holds TOKEN or KEY from its MCP servers and from
# the file's $VAR expansion, except names that start with GEMINI_CLI_, so the
# agent token reaches the Relay server under that prefix. The file is
# root-owned: the engineer cannot change what a worker's servers run.
gemini_env() {
  local token="${RELAY_AGENT_TOKEN:-}"
  if [ -n "$token" ] && ! [[ "$token" =~ ^at_live_[A-Za-z0-9_-]{8,256}$ ]]; then die "invalid agent token"; fi
  if [ ! -f "$GEMINI_SETTINGS" ] || [ -L "$GEMINI_SETTINGS" ] || [ "$(stat -c %u -- "$GEMINI_SETTINGS")" != 0 ]; then
    die "the Gemini CLI worker settings are missing (configure the node again)"
  fi
  export GEMINI_CLI_SYSTEM_SETTINGS_PATH="$GEMINI_SETTINGS" GEMINI_CLI_SYSTEM_DEFAULTS_PATH="$GEMINI_DEFAULTS"
  # Workers start in the task's worktree, which Gemini would otherwise ask to trust.
  export GEMINI_CLI_TRUST_WORKSPACE=true NO_BROWSER=true
  export GEMINI_CLI_MORROW_AGENT_TOKEN="$token"
}

# Cursor Agent and Grok read MCP servers only from the engineer's own config.
# `register` adds the Relay and morrow-agent servers there when the engineer's
# account is created; this adds them again when the file lost them.
user_mcp_config() {
  case "$1" in
    cursor) printf '%s/.cursor/mcp.json' "$2" ;;
    grok) printf '%s/.grok/config.toml' "$2" ;;
  esac
}

user_mcp_ready() {
  local file
  file="$(user_mcp_config "$1" "$2")"
  [ -f "$file" ] && [ ! -L "$file" ] && grep -qF -- "\"$SELF\"" "$file"
}

ensure_user_mcp() {
  local cli="$1" home="$2"
  user_mcp_ready "$cli" "$home" && return 0
  if [ -x "$BUN" ] && [ -f "$MORROW_AGENT" ]; then
    env -i HOME="$home" PATH="$DEFAULT_PATH" "$BUN" "$MORROW_AGENT" register </dev/null >/dev/null 2>&1 || true
  fi
  user_mcp_ready "$cli" "$home" || die "$cli has no Relay MCP server in its config"
}

# Codex asks "Trust this folder?" in a project it has no trust entry for, and
# a worker cannot answer it: Codex quits. It looks the entry up by the folder,
# then by the repository's main checkout (where a linked worktree's .git file
# points), so this records the main checkout, once per repository, in the
# engineer's ~/.codex/config.toml: the entry Codex writes itself when someone
# picks "Trust and continue". Only Morrow's work tree is ever trusted. Any
# entry the engineer already has for that folder, trusted or not, stays as it
# is. A failure is reported, not fatal: Codex then asks, as it did before.
codex_trust_root() {
  local home="$1" cwd root line gitdir
  cwd="$(pwd -P 2>/dev/null)" || return 1
  case "$cwd" in "$home/work/"*) ;; *) return 1 ;; esac
  root="$cwd"
  if [ -f "$cwd/.git" ] && [ ! -L "$cwd/.git" ]; then
    line="$(head -c 4096 -- "$cwd/.git" 2>/dev/null | head -n1)"
    gitdir="${line#gitdir: }"
    if [ "$gitdir" != "$line" ] && [[ "$gitdir" =~ ^(/.+)/\.git/worktrees/[A-Za-z0-9._-]+$ ]]; then
      root="${BASH_REMATCH[1]}"
    fi
  fi
  case "$root" in "$home/work/"*) ;; *) root="$cwd" ;; esac
  # Plain path characters only: the path goes into TOML and a grep pattern.
  [[ "$root" =~ ^/[A-Za-z0-9._/-]{1,1000}$ ]] && [[ ! "$root" =~ (^|/)\.\.?(/|$) ]] || return 1
  printf '%s' "$root"
}

# Whether config.toml already says anything about projects.<root>, in any
# TOML spelling, or holds an inline `projects` table a new table cannot extend.
codex_project_known() {
  local file="$1" root="$2" key
  key="[\"']${root//./\\.}[\"']"
  grep -Eq -- "^[[:space:]]*(\\[[[:space:]]*projects[[:space:]]*\\.[[:space:]]*${key}|projects[[:space:]]*\\.[[:space:]]*${key}|${key}[[:space:]]*[=.]|projects[[:space:]]*=)" "$file"
}

codex_trust_write() {
  local home="$1" root="$2" file tmp
  file="$home/.codex/config.toml"
  if [ -e "$file" ] || [ -L "$file" ]; then
    { [ -f "$file" ] && [ ! -L "$file" ]; } || return 1
    codex_project_known "$file" "$root" && return 0
  fi
  tmp="$(mktemp "$home/.codex/.config.toml.morrow-XXXXXX")" || return 1
  {
    if [ -s "$file" ]; then
      cat -- "$file"
      [ -z "$(tail -c 1 -- "$file")" ] || printf '\n'
      printf '\n'
    fi
    printf '[projects."%s"]\ntrust_level = "trusted"\n' "$root"
  } >"$tmp" || { rm -f -- "$tmp"; return 1; }
  if ! chmod 0600 -- "$tmp" || ! mv -f -- "$tmp" "$file"; then
    rm -f -- "$tmp"
    return 1
  fi
}

codex_trust() {
  local home="$1" root
  root="$(codex_trust_root "$home")" || return 0
  [ -d "$home/.codex" ] || mkdir -m 0700 -- "$home/.codex" 2>/dev/null || true
  # Workers starting at once must not drop each other's entry.
  if ! (flock -w 15 9 && codex_trust_write "$home" "$root") 9>>"$home/.codex/.morrow-trust.lock" 2>/dev/null; then
    printf '[relay-worker] warning: could not record Codex folder trust for %s\n' "$root" >&2
  fi
}

# True when the Codex arguments ask for the read-only sandbox, in any of the
# forms Codex accepts.
codex_read_only() {
  local prev="" arg
  for arg in "$@"; do
    if [ "$arg" = "--sandbox=read-only" ]; then return 0; fi
    if [[ "$prev" =~ ^(--sandbox|-s)$ ]] && [ "$arg" = "read-only" ]; then return 0; fi
    prev="$arg"
  done
  return 1
}

exec_cli() {
  local cli="${1:-}"
  valid_cli "$cli" || die "unknown CLI"
  shift
  [ "$(id -u)" -ne 0 ] || die "exec must not run as root"
  local me
  me="$(id -un)"
  [[ "$me" =~ ^u[a-f0-9]{12}$ ]] || die "exec must run as the engineer"

  # Fail closed: nothing key-shaped may reach the CLI.
  SECRETS=()
  local name entry arg
  for name in "${SECRET_VARS[@]}"; do
    [ -z "${!name+x}" ] || die "refusing to start $cli: $name is set"
  done
  while IFS= read -r -d '' entry; do
    if leaks "$entry"; then die "refusing to start $cli: a Relay workspace key is in its environment"; fi
  done < <(env -0)
  for arg in "$@"; do
    if leaks "$arg"; then die "refusing to start $cli: a Relay workspace key is in its arguments"; fi
  done

  local home
  home="$(getent passwd "$me" | cut -d: -f6)"
  [ "$home" = "/home/$me" ] && [ -d "$home" ] || die "unexpected home directory"
  unset SUDO_COMMAND SUDO_USER SUDO_UID SUDO_GID SUDO_HOME MAIL
  export HOME="$home" USER="$me" LOGNAME="$me" SHELL=/bin/bash
  PATH="$(worker_path)"
  export PATH
  umask 022

  case "$cli" in
    opencode)
      OPENCODE_CONFIG_CONTENT="$(opencode_config)" || exit 78
      export OPENCODE_CONFIG_CONTENT
      ;;
    codex) codex_trust "$home" ;;
    gemini) gemini_env ;;
    cursor) ensure_user_mcp cursor "$home" ;;
    grok)
      ensure_user_mcp grok "$home"
      export GROK_DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1
      ;;
  esac
  if [ "$cli" = codex ] && codex_read_only "$@"; then
    # The broker adds the bypass flag to every Codex start unless an argument
    # already names one. A read-only subagent asks for `--sandbox read-only`,
    # which Codex refuses alongside the bypass, so the bypass goes.
    local -a kept=()
    for arg in "$@"; do
      if [ "$arg" != "--dangerously-bypass-approvals-and-sandbox" ]; then kept+=("$arg"); fi
    done
    set -- ${kept[@]+"${kept[@]}"}
  fi

  local program real
  program="$(cli_program "$cli")"
  real="$(command -v -- "$program" || true)"
  [ -n "$real" ] && [ "${real#/}" != "$real" ] || die "$program is not installed for $me"
  case "$real" in "$SHIM_DIR"/* | "$SELF") die "$program resolves to the Relay shim" ;; esac
  exec "$real" "$@"
}

mcp() {
  # With no key in its environment, `agent-relay mcp` falls back to a key stored
  # on disk (a project pin in its cwd, then the machine-wide store) and then
  # ignores the agent token. An unresolved ${...} placeholder turns that
  # fallback off, so the server runs on RELAY_AGENT_TOKEN alone.
  unset RELAY_WORKSPACE_KEY AGENT_RELAY_WORKSPACE_KEY RELAY_WORKSPACES_JSON
  # shellcheck disable=SC2016  # a literal placeholder, never expanded
  export RELAY_API_KEY='${RELAY_API_KEY}'
  exec "$AGENT_RELAY" mcp "$@"
}

SECRETS=()
case "${1:-}" in
  launch) shift && launch "$@" ;;
  exec) shift && exec_cli "$@" ;;
  mcp) shift && mcp "$@" ;;
  deny) die "this CLI starts only through its Morrow harness command" ;;
  *) die "usage: relay-worker launch|exec <cli> [args...] | mcp | deny" ;;
esac
