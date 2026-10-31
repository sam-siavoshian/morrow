#!/usr/bin/env bash
# Runs inside a throwaway ubuntu:24.04 container as root (see test/vm/usage-docker.test.ts).
# Drives backend/vm/usage.sh (mounted at /vm) as the engineer user against fake `curl` and `codex` binaries
# and prints one line per case:
#   <case>\t<exit code>\t<milliseconds>\t<last stdout line>
# then `LEAK\t<what>` for any place the token showed up, and DONE.
set -uo pipefail

# jq ships on freestyle/ubuntu. Here: a mounted static jq (/jq/jq) if the test has one, else apt.
export DEBIAN_FRONTEND=noninteractive
if [ -x /jq/jq ]; then
  install -m 0755 /jq/jq /usr/bin/jq
elif ! { apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends jq >/dev/null 2>&1; }; then
  echo "jq install failed" >&2
  exit 1
fi

U=u0123456789ab
H="/home/$U"
TOKEN="sk-ant-oat01-SECRETTOKENVALUE0123456789"
useradd --create-home --user-group --shell /bin/bash "$U"
as_user() { runuser -u "$U" -- "$@"; }

FAKE=/usr/local/fakebin
mkdir -p "$FAKE"
# Fake curl: accepts the token only on its stdin config, and records anywhere else it shows up.
cat >"$FAKE/curl" <<EOF
#!/usr/bin/env bash
touch /tmp/curl-called
cfg="\$(cat)"
case " \$* " in *"$TOKEN"*) echo argv >>/tmp/leak ;; esac
env | grep -qF "$TOKEN" && echo env >>/tmp/leak
[ "\$1" = "-q" ] || { printf 'noq\n000'; exit 0; }
[ "\$cfg" = 'header = "Authorization: Bearer $TOKEN"' ] || { printf 'badcfg\n000'; exit 0; }
case " \$* " in *" https://api.anthropic.com/api/oauth/usage "*) ;; *) printf 'badurl\n000'; exit 0 ;; esac
case " \$* " in *"anthropic-beta: oauth-2025-04-20"*) ;; *) printf 'nobeta\n000'; exit 0 ;; esac
case "\${FAKE_CLAUDE:-ok}" in
  ok) printf '%s\n200' '{"five_hour":{"utilization":37.5,"resets_at":"2037-06-15T14:00:00.000Z"},"seven_day":{"utilization":62,"resets_at":"2037-06-19T09:00:00+00:00"},"seven_day_opus":null,"seven_day_sonnet":{"utilization":12,"resets_at":"not a time"},"seven_day_oauth_apps":null,"extra_usage":{"is_enabled":false},"limits":[]}' ;;
  unauth) printf '%s\n401' '{"error":{"type":"authentication_error","message":"token $TOKEN"}}' ;;
  throttled) printf '\n429' ;;
  garbage) printf 'oops <html>\n200' ;;
esac
EOF
# Fake codex app-server: newline-delimited JSON on stdio, mode from /tmp/codex-mode.
cat >"$FAKE/codex" <<'EOF'
#!/usr/bin/env bash
[ "$1" = app-server ] || exit 2
mode="$(cat /tmp/codex-mode 2>/dev/null)"
case "$mode" in fail) exit 1 ;; hang) sleep 60; exit 0 ;; esac
IFS= read -r l1 || exit 3
case "$l1" in *'"method":"initialize"'*) ;; *) exit 3 ;; esac
printf '%s\n' '{"id":1,"result":{"userAgent":"codex/0.165.0"}}'
IFS= read -r l2
IFS= read -r l3
case "$l3" in *'"method":"account/rateLimits/read"'*) ;; *) exit 4 ;; esac
printf '%s\n' '{"method":"account/rateLimits/updated","params":{"id":2}}'
if [ "$mode" = error ]; then
  printf '%s\n' '{"id":2,"error":{"code":-32600,"message":"chatgpt authentication required"}}'
else
  printf '%s\n' '{"id":2,"result":{"ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex","primary":{"usedPercent":23,"windowDurationMins":300,"resetsAt":2128705200},"secondary":{"usedPercent":141,"windowDurationMins":10080,"resetsAt":2129304800},"planType":"pro"},"accountId":"acct-secret"}}'
fi
# A real app server keeps running until stdin closes; the probe must not wait for that.
sleep 60
EOF
chmod 0755 "$FAKE/curl" "$FAKE/codex"

cred() {
  # $1 = expiresAt ms, $2 = scopes json, $3 = token
  as_user mkdir -p "$H/.claude"
  printf '{"claudeAiOauth":{"accessToken":%s,"refreshToken":"rt-secret","expiresAt":%s,"scopes":%s,"subscriptionType":"max"}}' \
    "$(jq -Rn --arg t "$3" '$t')" "$1" "$2" | as_user tee "$H/.claude/.credentials.json" >/dev/null
  chmod 0600 "$H/.claude/.credentials.json"
}

rollout() {
  as_user mkdir -p "$H/.codex/sessions/2037/06/15"
  as_user bash -c "cat > '$H/.codex/sessions/2037/06/15/rollout-2037-06-15T10-00-00-abc.jsonl'" <<'EOF'
{"timestamp":"2037-06-15T10:00:00.000Z","type":"session_meta","payload":{"id":"abc"}}
{"timestamp":"2037-06-15T10:11:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","primary":{"used_percent":10,"window_minutes":300,"resets_at":2128705200},"secondary":null}}}
{"timestamp":"2037-06-15T10:12:03.120Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":55.5,"window_minutes":300,"resets_at":2128705200},"secondary":{"used_percent":41,"window_minutes":10080,"resets_at":2129304800},"plan_type":"plus"}}}
{"timestamp":"2037-06-15T10:12:04.000Z","type":"response_item","payload":{"type":"message"}}
EOF
}

# The way Freestyle exec runs a script: body on stdin, values in env, nothing else inherited.
run() {
  local label="$1" start end out rc
  start=$(date +%s%3N)
  out="$(runuser -u "$U" -- env -i PATH="$FAKE:/usr/bin:/bin" HOME="$H" FAKE_CLAUDE="${FAKE_CLAUDE:-ok}" bash -c "$(cat /vm/usage.sh)" 2>/dev/null)"
  rc=$?
  end=$(date +%s%3N)
  printf '%s\t%d\t%d\t%s\n' "$label" "$rc" "$((end - start))" "$(printf '%s' "$out" | tail -n1)"
  printf '%s' "$out" | grep -qF "$TOKEN" && echo stdout >>/tmp/leak
  printf '%s' "$out" | grep -qF "rt-secret" && echo refresh_stdout >>/tmp/leak
}

FUTURE=$((($(date +%s) + 3600) * 1000))
PAST=$((($(date +%s) - 10) * 1000))

cred "$FUTURE" '["user:inference","user:profile"]' "$TOKEN"
echo ok >/tmp/codex-mode
run live

echo error >/tmp/codex-mode
rollout
cred "$PAST" '["user:profile"]' "$TOKEN"
run expired_and_rollout

cred "$FUTURE" '["user:inference"]' "$TOKEN"
echo fail >/tmp/codex-mode
run no_scope_and_rollout_after_crash

cred "$FUTURE" '["user:profile"]' "$TOKEN"
FAKE_CLAUDE=unauth run rejected
FAKE_CLAUDE=throttled run throttled
FAKE_CLAUDE=garbage run garbage

rm -f /tmp/curl-called
cred "$FUTURE" '["user:profile"]' 'abc" url = "http://evil.example/x'
run injection
[ -e /tmp/curl-called ] && echo curl_on_bad_token >>/tmp/leak

rm -rf "$H/.claude" "$H/.codex"
echo hang >/tmp/codex-mode
run nothing_and_hang

if [ -s /tmp/leak ]; then while read -r what; do printf 'LEAK\t%s\n' "$what"; done </tmp/leak; fi
echo DONE
