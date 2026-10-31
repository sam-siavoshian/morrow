#!/usr/bin/env bash
# Follows one Relay worker log as the broker's user (r<id>, see configure-node.sh)
# for live inspect (backend/src/integrations/freestyle/logstream.ts). It runs in
# a Freestyle PTY session, which streams its output as it is written: no exec
# per read. A PTY session takes no env or stdin, so the values come as
# arguments, each checked here (the backend checks them too):
#   $1 agent name  $2 first byte wanted (-1: the last $3 bytes)  $3 backlog bytes
#   $4 lifetime in seconds
# Prints one JSON object per line:
#   {"v":1,"start":N,"size":N}   the log is open; bytes from N follow. Printed
#                                again when the file shrank (start over).
#   {"o":N,"d":"<base64>"}       the bytes of the log from offset N
#   {"hb":N}                     still here (N: the size) while nothing is new
#   {"end":"<why>"}              lifetime | rotated | missing: done, open another
#   {"unsafe":"<reason>"}        the path is not the plain log we expect
#
# The same checks as logtail.sh, for the same reason: the path is derived from
# the account, it never runs as root, and what it opened is checked through the
# descriptor (exact path, regular file, owned by this user, one link). It then
# reads only through that descriptor (/proc/self/fd/3), so swapping the path
# later cannot redirect it; a swap shows as a new inode and ends the stream. A
# watchdog ends it shortly after its lifetime even if the open hangs (a FIFO
# swapped in after the check), so a stream the backend lost cannot run forever.
set -Eeuo pipefail
umask 077
# No echo, no output processing: the PTY passes the lines through unchanged.
stty -echo -opost 2>/dev/null || true

out() { printf '%s\n' "$1"; }
die() { printf '[logfollow] error: %s\n' "$*" >&2; exit 1; }
unsafe() { out "{\"unsafe\":\"$1\"}"; exit 0; }
finish() { out "{\"end\":\"$1\"}"; exit 0; }

[ "$(id -u)" -ne 0 ] || die "must not run as root"
me="$(id -un)"
[[ "$me" =~ ^r[a-f0-9]{12}$ ]] || die "must run as the Relay broker user"
name="${1:-}"
start="${2:-}"
backlog="${3:-}"
life="${4:-}"
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]] || die "invalid agent name"
[[ "$start" =~ ^(-1|0|[1-9][0-9]{0,14})$ ]] || die "invalid start"
[[ "$backlog" =~ ^[0-9]{1,6}$ ]] && [ "$backlog" -le 262144 ] || die "invalid backlog"
[[ "$life" =~ ^[0-9]{1,4}$ ]] && [ "$life" -ge 5 ] && [ "$life" -le 3600 ] || die "invalid lifetime"

log="/var/lib/morrow/relay/$me/relay-node/.agentworkforce/relay/team/worker-logs/$name.log"
deadline=$((SECONDS + life))
me_uid="$(id -u)"

(
  exec </dev/null >/dev/null 2>&1
  trap 'kill "$nap_pid" 2>/dev/null; exit 0' TERM
  sleep "$((life + 15))" &
  nap_pid=$!
  wait "$nap_pid"
  kill -KILL "$$"
) &
watchdog=$!
trap 'kill "$watchdog" 2>/dev/null || true' EXIT

# A sleep without a fork: nothing is ever typed into this PTY, so the read
# times out. Falls back to sleep when stdin is closed.
nap() {
  local rc=0
  read -r -t "$1" _ || rc=$?
  [ "$rc" -gt 128 ] || sleep "$1"
}

while [ ! -e "$log" ] && [ ! -L "$log" ]; do
  [ "$SECONDS" -lt "$deadline" ] || finish lifetime
  nap 0.25
done
[ ! -L "$log" ] || unsafe symlink
[ -f "$log" ] || unsafe not_a_file
[ -r "$log" ] || unsafe unreadable
exec 3<"$log" || finish missing
opened="$(readlink /proc/self/fd/3)"
case "$opened" in *" (deleted)") finish missing ;; esac
[ "$opened" = "$log" ] || unsafe path_changed
[ -f /proc/self/fd/3 ] || unsafe not_a_file
read -r uid links size ino < <(stat -L -c "%u %h %s %i" /proc/self/fd/3)
[ "$uid" = "$me_uid" ] || unsafe wrong_owner
[ "$links" = 1 ] || unsafe hardlink

if [ "$start" -lt 0 ] || [ "$start" -gt "$size" ]; then
  off=$((size > backlog ? size - backlog : 0))
else
  off=$start
fi
out "{\"v\":1,\"start\":$off,\"size\":$size}"

chunk=32768
active=$SECONDS
beat=$SECONDS
checked=$SECONDS
while :; do
  [ "$SECONDS" -lt "$deadline" ] || finish lifetime
  read -r links size < <(stat -L -c "%h %s" /proc/self/fd/3)
  [ "$links" = 1 ] || unsafe hardlink
  if [ "$size" -lt "$off" ]; then
    off=$((size > backlog ? size - backlog : 0))
    out "{\"v\":1,\"start\":$off,\"size\":$size}"
  fi
  if [ "$size" -gt "$off" ]; then
    want=$((size - off > chunk ? chunk : size - off))
    # tail gets SIGPIPE when more was written since the stat: not an error.
    data="$({ tail -c "+$((off + 1))" /proc/self/fd/3 || true; } | head -c "$want" | base64 -w0)"
    got=$((${#data} * 3 / 4))
    case "$data" in *==) got=$((got - 2)) ;; *=) got=$((got - 1)) ;; esac
    if [ "$got" -gt 0 ]; then
      out "{\"o\":$off,\"d\":\"$data\"}"
      off=$((off + got))
      active=$SECONDS
      beat=$SECONDS
      continue
    fi
  fi
  # Nothing new. A path that now names another file (or none) means the
  # broker started a new log: this one is done once it is drained.
  if [ $((SECONDS - checked)) -ge 2 ]; then
    checked=$SECONDS
    now_ino="$(stat -c %i -- "$log" 2>/dev/null || printf gone)"
    [ "$now_ino" = "$ino" ] || finish rotated
  fi
  if [ $((SECONDS - beat)) -ge 5 ]; then
    out "{\"hb\":$size}"
    beat=$SECONDS
  fi
  if [ $((SECONDS - active)) -lt 3 ]; then nap 0.1; else nap 0.25; fi
done
