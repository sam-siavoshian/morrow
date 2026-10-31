#!/usr/bin/env bash
# Headless planning call on an engineer's own CLI login, run as that engineer.
# stdout: the last MAX_OUTPUT_BYTES of the CLI's stdout. stderr: one JSON line
# {"exitCode":N,"timedOut":bool,"bytes":N,"stderr":"<base64 tail>"}.
#
# Env: PLAN_CLI (claude|codex), PLAN_PROMPT_B64, PLAN_TIMEOUT_SECS, MAX_OUTPUT_BYTES
#
# The prompt reaches the CLI as one argument through an environment variable;
# it is never part of a command string. TZ=UTC keeps reset times in limit
# messages unambiguous. Tools are off: the prompt already carries the context,
# and it holds untrusted text (task, feedback, README), so a tool could be
# steered into reading the engineer's files (~/.codex/auth.json,
# ~/.claude/.credentials.json) and echoing them into the plan every member sees.
# Flags follow docs/research/cli-signals.md section 4 (no --bare: it ignores
# subscription logins).
#
# Codex has no tool allowlist, and `--sandbox read-only` only blocks writes, so
# its tools are switched off one by one with `-c features.<name>=false` (an
# unknown name is only a warning on older builds) and `--ignore-user-config`
# drops MCP servers and plugins from ~/.codex/config.toml. CODEX_HOME stays the
# real one: auth.json refresh tokens rotate, so a copy would break the login.
set -Eeuo pipefail
umask 077

die() { printf '{"error":"%s"}\n' "$1" >&2; exit 2; }

[ "$(id -u)" -ne 0 ] || die "root"
cli="${PLAN_CLI:-}"
secs="${PLAN_TIMEOUT_SECS:-}"
max="${MAX_OUTPUT_BYTES:-262144}"
case "$cli" in claude | codex) ;; *) die "cli" ;; esac
[[ "$secs" =~ ^[0-9]{1,3}$ ]] && [ "$secs" -ge 1 ] || die "timeout"
[[ "$max" =~ ^[0-9]{1,7}$ ]] && [ "$max" -ge 1 ] || die "max"
MORROW_PLAN_PROMPT="$(printf '%s' "${PLAN_PROMPT_B64:-}" | base64 -d 2>/dev/null)" || die "prompt"
unset PLAN_PROMPT_B64
[ -n "$MORROW_PLAN_PROMPT" ] || die "prompt"
export MORROW_PLAN_PROMPT

work="$(mktemp -d)"
out="$(mktemp)"
err="$(mktemp)"
trap 'rm -rf -- "$work" "$out" "$err"' EXIT
cd -- "$work"

# Every built-in codex tool that can read files, run code or reach out (codex-rs/features, 0.165).
readonly CODEX_TOOL_FEATURES="shell_tool unified_exec view_image code_mode_host multi_agent apps plugins browser_use computer_use in_app_browser image_generation"

# shellcheck disable=SC2016  # expanded by the login shell below, never here
if [ "$cli" = claude ]; then
  run='export TZ=UTC; unset ANTHROPIC_API_KEY CLAUDE_CODE_RETRY_WATCHDOG; exec claude -p "$MORROW_PLAN_PROMPT" --output-format json --max-turns 2 --tools "" --disallowedTools "mcp__*" --permission-mode dontAsk --no-session-persistence'
else
  run='export TZ=UTC; exec codex exec --json --skip-git-repo-check --sandbox read-only --ephemeral --ignore-user-config --ignore-rules'
  for feature in $CODEX_TOOL_FEATURES; do run+=" -c features.$feature=false"; done
  run+=' -C "$PWD" "$MORROW_PLAN_PROMPT"'
fi

set +e
timeout --kill-after=5 "$secs" bash -lc "$run" </dev/null >"$out" 2>"$err"
rc=$?
set -e
size="$(stat -c %s "$out")"
tail -c "$max" "$out"
timed_out=false
[ "$rc" -eq 124 ] || [ "$rc" -eq 137 ] && timed_out=true
printf '{"exitCode":%d,"timedOut":%s,"bytes":%d,"stderr":"%s"}\n' "$rc" "$timed_out" "$size" "$(tail -c 4096 "$err" | base64 -w0)" >&2
