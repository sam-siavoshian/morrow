#!/usr/bin/env bash
# Usage probe, run as the engineer user. Prints one JSON line: how much of each CLI's subscription windows
# (5-hour, weekly) is used, as the vendor reports it.
#
# The CLI's own login is used on this VM only. The access token never reaches argv, the environment, a file
# or stdout: jq writes it straight into curl's config on stdin. Output is numbers, ISO times and fixed words.
#
#   claude:   GET https://api.anthropic.com/api/oauth/usage, the endpoint Claude Code's /usage reads, with the
#             access token from ~/.claude/.credentials.json. Never refreshes the token: a refresh here could race
#             the CLI's own and sign it out. An expired token reports "expired"; the CLI renews it on its next run.
#   codex:    `codex app-server`, method account/rateLimits/read (one backend read, spends no model quota; the
#             CLI handles its own token). Falls back to the newest rate_limits snapshot in ~/.codex/sessions.
#   opencode: no subscription windows (it bills the user's own provider keys); not probed.
set -uo pipefail

readonly T_HTTP=8
readonly T_CODEX=15
readonly MAX_BODY=65536
readonly MAX_LINES=200
readonly CLAUDE_URL="https://api.anthropic.com/api/oauth/usage"
readonly ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:?[0-9]{2})$'

status_only() { printf '{"status":"%s"}' "$1"; }

have_tools() { command -v jq >/dev/null 2>&1; }

# ---------- claude

claude_usage() {
  local cred now_ms state out code body
  cred="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
  command -v curl >/dev/null 2>&1 || { status_only unavailable; return; }
  [ -f "$cred" ] || { status_only no_login; return; }
  now_ms=$(($(date +%s) * 1000))
  # A token we can use, or why not. Only the verdict leaves jq here.
  state="$(jq -r --argjson now "$now_ms" '
    (.claudeAiOauth // {}) as $o
    | ($o.accessToken // "") as $t
    | if ($t | type) != "string" or ($t | test("^[A-Za-z0-9._~+/=-]{20,4096}$") | not) then "no_login"
      elif ($o.expiresAt | type) != "number" or $o.expiresAt <= $now + 60000 then "expired"
      elif ($o.scopes | type) == "array" and ($o.scopes | index("user:profile")) == null then "no_scope"
      else "ok" end' "$cred" 2>/dev/null)"
  case "$state" in
    ok) ;;
    no_login | expired | no_scope) status_only "$state"; return ;;
    *) status_only no_login; return ;;
  esac
  # -q must come first: no ~/.curlrc. The token travels only on curl's stdin config.
  out="$(jq -r '"header = \"Authorization: Bearer " + .claudeAiOauth.accessToken + "\""' "$cred" 2>/dev/null \
    | curl -q -sS --proto '=https' --tlsv1.2 --max-redirs 0 --max-time "$T_HTTP" -K - \
      -H 'anthropic-beta: oauth-2025-04-20' -H 'Content-Type: application/json' -H 'User-Agent: morrow-usage-probe' \
      -w '\n%{http_code}' "$CLAUDE_URL" 2>/dev/null | head -c "$MAX_BODY")"
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  case "$code" in
    200) ;;
    401 | 403) status_only rejected; return ;;
    429) status_only throttled; return ;;
    *) status_only unavailable; return ;;
  esac
  printf '%s' "$body" | jq -c --arg iso "$ISO_RE" '
    def win($k): .[$k] as $w
      | if ($w | type) == "object" and ($w.utilization | type) == "number" then
          { key: $k, used: $w.utilization,
            resetsAt: (if ($w.resets_at | type) == "string" and ($w.resets_at | test($iso)) then $w.resets_at else null end) }
        else empty end;
    if type == "object" then
      { status: "ok", windows: [win("five_hour"), win("seven_day"), win("seven_day_opus"), win("seven_day_sonnet")] }
    else { status: "unavailable" } end' 2>/dev/null || status_only unavailable
}

# ---------- codex

# Newline-delimited JSON over stdio. The reply to request `id` is printed as one compact line, or nothing.
codex_app_server() {
  command -v codex >/dev/null 2>&1 || return 1
  local in out line n=0 reply=""
  coproc CX { exec timeout "$T_CODEX" codex app-server 2>/dev/null; }
  in="${CX[1]}"
  out="${CX[0]}"
  await_reply() {
    local id="$1" got
    while [ "$n" -lt "$MAX_LINES" ] && IFS= read -r -t "$T_CODEX" line <&"$out"; do
      n=$((n + 1))
      got="$(printf '%s' "$line" | jq -c --argjson id "$id" 'select(type == "object" and .id == $id)' 2>/dev/null)"
      if [ -n "$got" ]; then
        reply="$got"
        return 0
      fi
    done
    return 1
  }
  printf '%s\n' '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"morrow-usage-probe","title":null,"version":"1"}}}' 1>&"$in" 2>/dev/null
  if await_reply 1; then
    reply=""
    printf '%s\n' '{"method":"initialized"}' '{"id":2,"method":"account/rateLimits/read","params":{"excludeResetCreditDetails":true}}' 1>&"$in" 2>/dev/null
    await_reply 2 || reply=""
  fi
  eval "exec ${in}>&-" 2>/dev/null
  kill "$CX_PID" 2>/dev/null
  wait "$CX_PID" 2>/dev/null
  [ -n "$reply" ] || return 1
  printf '%s' "$reply" | jq -ce '
    .result.rateLimits as $r
    | select(($r | type) == "object")
    | { status: "ok", source: "app_server",
        windows: [ ($r.primary, $r.secondary)
          | select(type == "object" and (.usedPercent | type) == "number")
          | { used: .usedPercent,
              minutes: (if (.windowDurationMins | type) == "number" then .windowDurationMins else null end),
              resetsAt: (if (.resetsAt | type) == "number" then .resetsAt else null end) } ] }' 2>/dev/null
}

# The newest token_count snapshot a Codex session wrote (workers write these as they run). No network.
codex_rollout() {
  local dir file
  dir="${CODEX_HOME:-$HOME/.codex}/sessions"
  [ -d "$dir" ] || return 1
  file="$(find "$dir" -type f -name 'rollout-*.jsonl' -mtime -8 -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)"
  [ -n "$file" ] && [ -f "$file" ] || return 1
  tail -c 1048576 -- "$file" 2>/dev/null | grep -F '"token_count"' | grep -F '"rate_limits"' | tail -n1 \
    | jq -ce --arg iso "$ISO_RE" '
      .payload.rate_limits as $r
      | select(($r | type) == "object" and (.timestamp | type) == "string" and (.timestamp | test($iso)))
      | { status: "ok", source: "rollout", observedAt: .timestamp,
          windows: [ ($r.primary, $r.secondary)
            | select(type == "object" and (.used_percent | type) == "number")
            | { used: .used_percent,
                minutes: (if (.window_minutes | type) == "number" then .window_minutes else null end),
                resetsAt: (if (.resets_at | type) == "number" then .resets_at else null end) } ] }' 2>/dev/null
}

codex_usage() {
  local got
  got="$(codex_app_server)" && [ -n "$got" ] && { printf '%s' "$got"; return; }
  got="$(codex_rollout)" && [ -n "$got" ] && { printf '%s' "$got"; return; }
  status_only no_data
}

if ! have_tools; then
  printf '{"v":1,"claude":{"status":"unavailable"},"codex":{"status":"unavailable"}}\n'
  exit 0
fi
printf '{"v":1,"claude":%s,"codex":%s}\n' "$(claude_usage)" "$(codex_usage)"
