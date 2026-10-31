#!/usr/bin/env bash
# Reads the tail of one Relay worker log as the broker's user (r<id>, see
# configure-node.sh). Prints one JSON line:
#   {"found":false}                                   no log yet (or it vanished mid-read)
#   {"found":true,"size":N,"mtime":N,"b64":"..."}    the last <= MAX_BYTES bytes before `size`
#   {"unsafe":"<reason>"}                             the path is not the plain log we expect
#
# Env: AGENT_NAME, MAX_BYTES (1..65536)
#
# The log sits in the broker's private state directory, which workers (the
# engineer's user) cannot read or write. The checks below still assume the
# file may have been swapped for a symlink, a hardlink, a FIFO or a symlinked
# parent: running as the broker's user (never root) caps what any swap can
# reach at what that user can already read. The file is opened once, and what was opened is checked
# through the descriptor: its resolved path must equal the expected path, it
# must be a regular file owned by this user with one link. Size and bytes come
# from that same descriptor. The open runs under `timeout`, so a FIFO swapped
# in after the pre-check cannot hang the read.
set -Eeuo pipefail
umask 077

die() { printf '[logtail] error: %s\n' "$*" >&2; exit 1; }
unsafe() { printf '{"unsafe":"%s"}\n' "$1"; exit 0; }

[ "$(id -u)" -ne 0 ] || die "must not run as root"
me="$(id -un)"
[[ "$me" =~ ^r[a-f0-9]{12}$ ]] || die "must run as the Relay broker user"
name="${AGENT_NAME:-}"
max="${MAX_BYTES:-}"
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]] || die "invalid agent name"
[[ "$max" =~ ^[0-9]{1,5}$ ]] && [ "$max" -ge 1 ] && [ "$max" -le 65536 ] || die "invalid max bytes"

# Derived from the account, never from input or $HOME.
log="/var/lib/morrow/relay/$me/relay-node/.agentworkforce/relay/team/worker-logs/$name.log"

if [ -L "$log" ]; then unsafe symlink; fi
if [ ! -e "$log" ]; then printf '{"found":false}\n'; exit 0; fi
if [ ! -f "$log" ]; then unsafe not_a_file; fi
if [ ! -r "$log" ]; then unsafe unreadable; fi

# shellcheck disable=SC2016  # expanded by the inner shell
reader='
set -Eeuo pipefail
exec 3<"$1" || exit 2
opened="$(readlink /proc/self/fd/3)"
case "$opened" in *" (deleted)") exit 2 ;; esac
[ "$opened" = "$1" ] || { echo path_changed; exit 3; }
[ -f /proc/self/fd/3 ] || { echo not_a_file; exit 3; }
read -r uid links size mtime < <(stat -L -c "%u %h %s %Y" /proc/self/fd/3)
[ "$uid" = "$(id -u)" ] || { echo wrong_owner; exit 3; }
[ "$links" = 1 ] || { echo hardlink; exit 3; }
offset=$(( size > $2 ? size - $2 : 0 ))
b64="$(tail -c "+$((offset + 1))" <&3 | head -c "$((size - offset))" | base64 -w0)"
printf "{\"found\":true,\"size\":%d,\"mtime\":%d,\"b64\":\"%s\"}\n" "$size" "$mtime" "$b64"
'

set +e
out="$(timeout --kill-after=1 5 bash -c "$reader" logtail "$log" "$max")"
rc=$?
set -e
case "$rc" in
  0) printf '%s\n' "$out" ;;
  2) printf '{"found":false}\n' ;;
  3) unsafe "${out:-refused}" ;;
  124 | 137) unsafe blocked ;;
  *) die "read failed ($rc)" ;;
esac
