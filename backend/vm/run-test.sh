#!/usr/bin/env bash
# Runs a project's test command in a worktree as the engineer user.
# stdout: the last MAX_OUTPUT_BYTES of combined output. stderr: one JSON line.
#
# Env: WT_PATH, TEST_CMD, TEST_TIMEOUT_SECS, MAX_OUTPUT_BYTES
#
# The inner `timeout` fires before the exec timeout, so a slow suite reports
# exit 124 instead of a lost result.
set -Eeuo pipefail
umask 077

die() { printf '{"error":"%s"}\n' "$1" >&2; exit 2; }

[ "$(id -u)" -ne 0 ] || die "root"
wt="${WT_PATH:-}"
cmd="${TEST_CMD:-}"
secs="${TEST_TIMEOUT_SECS:-}"
max="${MAX_OUTPUT_BYTES:-65536}"
case "$wt" in "$HOME/work/"*) ;; *) die "path" ;; esac
[ -d "$wt" ] || die "missing"
[ -n "$cmd" ] && [ "${#cmd}" -le 2000 ] || die "command"
[[ "$secs" =~ ^[0-9]{1,3}$ ]] && [ "$secs" -ge 1 ] || die "timeout"
[[ "$max" =~ ^[0-9]{1,7}$ ]] && [ "$max" -ge 1 ] || die "max"

out="$(mktemp)"
trap 'rm -f -- "$out"' EXIT
cd -- "$wt"
set +e
timeout --kill-after=5 "$secs" bash -lc "$cmd" </dev/null >"$out" 2>&1
rc=$?
set -e
size="$(stat -c %s "$out")"
tail -c "$max" "$out"
timed_out=false
[ "$rc" -eq 124 ] || [ "$rc" -eq 137 ] && timed_out=true
printf '{"exitCode":%d,"timedOut":%s,"bytes":%d}\n' "$rc" "$timed_out" "$size" >&2
