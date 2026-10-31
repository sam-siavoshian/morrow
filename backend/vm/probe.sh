#!/usr/bin/env bash
# Health probe, run as the engineer user. Prints one JSON line.
#
# Auth state comes from each CLI's own status command and, failing that, from
# whether the credential file exists (stat only). Credential contents are never
# read, and CLI output is never echoed back: only exit codes and versions.
#
# Status commands (verified against vendor docs):
#   claude: `claude auth status` exits 0 if logged in, 1 if not
#           https://code.claude.com/docs/en/cli-reference
#   codex:  `codex login status` exits 0 when credentials are present
#           https://developers.openai.com/codex/cli/reference
#   opencode: no status command; `opencode auth login` stores keys in
#           ~/.local/share/opencode/auth.json  https://opencode.ai/docs/cli/
#   cursor: `cursor-agent status --format json` prints "isAuthenticated"; only
#           that flag is matched, the rest of the output is dropped. Its login
#           lives in ~/.config/cursor/auth.json
#   gemini: no status command; a Google login leaves ~/.gemini/oauth_creds.json
#           and selects "oauth-personal" in ~/.gemini/settings.json (not a
#           credential file, so it is matched, never echoed)
#   grok:   no status command; `grok login` writes ~/.grok/auth.json
#
# Each subcommand is only run when the CLI's --help lists it: an old `claude`
# without `auth` would treat "auth status" as a prompt.
set -uo pipefail

readonly T_VERSION=5
readonly T_STATUS=10

clean_version() {
  # First line, safe characters only, bounded.
  head -n1 | tr -cd 'A-Za-z0-9._()+ -' | cut -c1-64
}

file_stat() {
  # "<mtime>,<size>" or empty. Never opens the file.
  if [ -f "$1" ]; then stat -c '%Y,%s' -- "$1" 2>/dev/null || true; fi
}

has_subcommand() {
  # $1 = help output, $2 = subcommand. Aliases may sit on either side of a `|`
  # (Cursor Agent lists `status|whoami [options]`).
  printf '%s\n' "$1" | grep -qE "^[[:space:]]+([A-Za-z0-9-]+\\|)*$2([[:space:]]|\\[|\\||$)"
}

json_str_or_null() {
  if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi
}

emit_cli() {
  # name installed version auth source mtime
  local mtime=null
  [ -n "$6" ] && mtime="$6"
  printf '"%s":{"installed":%s,"version":%s,"auth":"%s","authSource":"%s","credentialModifiedAt":%s}' \
    "$1" "$2" "$(json_str_or_null "$3")" "$4" "$5" "$mtime"
}

probe_claude() {
  if ! command -v claude >/dev/null 2>&1; then emit_cli claude false "" unknown none ""; return; fi
  local version help rc st mtime=""
  version="$(timeout "$T_VERSION" claude --version </dev/null 2>/dev/null | clean_version)"
  st="$(file_stat "$HOME/.claude/.credentials.json")"
  [ -n "$st" ] && mtime="${st%%,*}"
  help="$(timeout "$T_VERSION" claude auth --help </dev/null 2>/dev/null || true)"
  if has_subcommand "$help" status; then
    timeout "$T_STATUS" claude auth status </dev/null >/dev/null 2>&1
    rc=$?
    case "$rc" in
      0) emit_cli claude true "$version" ok status_command "$mtime"; return ;;
      1) emit_cli claude true "$version" auth_required status_command "$mtime"; return ;;
    esac
  fi
  if [ -n "$st" ]; then
    emit_cli claude true "$version" unknown credential_file "$mtime"
  else
    emit_cli claude true "$version" auth_required credential_file ""
  fi
}

probe_codex() {
  if ! command -v codex >/dev/null 2>&1; then emit_cli codex false "" unknown none ""; return; fi
  local version help rc st mtime=""
  version="$(timeout "$T_VERSION" codex --version </dev/null 2>/dev/null | clean_version)"
  st="$(file_stat "${CODEX_HOME:-$HOME/.codex}/auth.json")"
  [ -n "$st" ] && mtime="${st%%,*}"
  help="$(timeout "$T_VERSION" codex login --help </dev/null 2>/dev/null || true)"
  if has_subcommand "$help" status; then
    timeout "$T_STATUS" codex login status </dev/null >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then emit_cli codex true "$version" ok status_command "$mtime"; return; fi
    if [ "$rc" -lt 124 ]; then emit_cli codex true "$version" auth_required status_command "$mtime"; return; fi
  fi
  if [ -n "$st" ]; then
    emit_cli codex true "$version" unknown credential_file "$mtime"
  else
    emit_cli codex true "$version" auth_required credential_file ""
  fi
}

probe_opencode() {
  if ! command -v opencode >/dev/null 2>&1; then emit_cli opencode false "" unknown none ""; return; fi
  local version st mtime="" size
  version="$(timeout "$T_VERSION" opencode --version </dev/null 2>/dev/null | clean_version)"
  st="$(file_stat "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json")"
  if [ -n "$st" ]; then
    mtime="${st%%,*}"
    size="${st##*,}"
    # An empty store ("{}", maybe pretty-printed) is a few bytes; any stored key is far more.
    if [ "$size" -gt 16 ]; then
      emit_cli opencode true "$version" ok credential_file "$mtime"
      return
    fi
  fi
  emit_cli opencode true "$version" auth_required credential_file "$mtime"
}

probe_cursor() {
  if ! command -v cursor-agent >/dev/null 2>&1; then emit_cli cursor false "" unknown none ""; return; fi
  local version help status st mtime=""
  version="$(timeout "$T_VERSION" cursor-agent --version </dev/null 2>/dev/null | clean_version)"
  st="$(file_stat "${XDG_CONFIG_HOME:-$HOME/.config}/cursor/auth.json")"
  [ -n "$st" ] && mtime="${st%%,*}"
  help="$(timeout "$T_VERSION" cursor-agent --help </dev/null 2>/dev/null || true)"
  if has_subcommand "$help" status; then
    status="$(timeout "$T_STATUS" cursor-agent status --format json </dev/null 2>/dev/null || true)"
    if printf '%s' "$status" | grep -qE '"isAuthenticated"[[:space:]]*:[[:space:]]*true'; then
      emit_cli cursor true "$version" ok status_command "$mtime"; return
    fi
    if printf '%s' "$status" | grep -qE '"isAuthenticated"[[:space:]]*:[[:space:]]*false'; then
      emit_cli cursor true "$version" auth_required status_command "$mtime"; return
    fi
  fi
  if [ -n "$st" ]; then
    emit_cli cursor true "$version" unknown credential_file "$mtime"
  else
    emit_cli cursor true "$version" auth_required credential_file ""
  fi
}

probe_gemini() {
  if ! command -v gemini >/dev/null 2>&1; then emit_cli gemini false "" unknown none ""; return; fi
  local version st mtime="" size
  version="$(timeout "$T_VERSION" gemini --version </dev/null 2>/dev/null | clean_version)"
  st="$(file_stat "$HOME/.gemini/oauth_creds.json")"
  if [ -n "$st" ]; then
    mtime="${st%%,*}"
    size="${st##*,}"
    if [ "$size" -gt 64 ]; then
      if [ -f "$HOME/.gemini/settings.json" ] && grep -q '"oauth-personal"' "$HOME/.gemini/settings.json" 2>/dev/null; then
        emit_cli gemini true "$version" ok credential_file "$mtime"
      else
        # Signed in once, but no Google login is selected: the CLI would ask again.
        emit_cli gemini true "$version" unknown credential_file "$mtime"
      fi
      return
    fi
  fi
  emit_cli gemini true "$version" auth_required credential_file "$mtime"
}

probe_grok() {
  if ! command -v grok >/dev/null 2>&1; then emit_cli grok false "" unknown none ""; return; fi
  local version st mtime="" size
  version="$(timeout "$T_VERSION" grok --version </dev/null 2>/dev/null | clean_version)"
  st="$(file_stat "${GROK_HOME:-$HOME/.grok}/auth.json")"
  if [ -n "$st" ]; then
    mtime="${st%%,*}"
    size="${st##*,}"
    if [ "$size" -gt 16 ]; then
      emit_cli grok true "$version" ok credential_file "$mtime"
      return
    fi
  fi
  emit_cli grok true "$version" auth_required credential_file "$mtime"
}

probe_relay() {
  local installed=false version="" node=unknown
  if command -v agent-relay >/dev/null 2>&1; then
    installed=true
    version="$(timeout "$T_VERSION" agent-relay --version </dev/null 2>/dev/null | clean_version)"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    case "$(systemctl is-active morrow-relay-node.service 2>/dev/null)" in
      active) node=active ;;
      activating | reloading) node=starting ;;
      inactive | failed | deactivating) node=inactive ;;
    esac
  fi
  printf '"relay":{"installed":%s,"version":%s,"node":"%s"}' "$installed" "$(json_str_or_null "$version")" "$node"
}

printf '{"v":1,"clis":{%s,%s,%s,%s,%s,%s},%s}\n' \
  "$(probe_claude)" "$(probe_codex)" "$(probe_opencode)" "$(probe_cursor)" "$(probe_gemini)" "$(probe_grok)" "$(probe_relay)"
