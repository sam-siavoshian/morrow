#!/usr/bin/env bash
# Runs inside a throwaway ubuntu:24.04 container as root (see test/vm/logfollow-docker.test.ts). Runs the exact PTY
# command the backend sends (followCommand, passed in as CMD_<case> env) under a real PTY (`script`), as Freestyle runs
# it, and prints every line it streams, stamped:
#   <case>\t<epoch ms>\t<line>
# plus `<case>\t<epoch ms>\t#wrote <n>` when the scenario appends to the log, and `<case>\t-\t#rc <code>` at the end.
set -uo pipefail

E=u0123456789ab
U=r0123456789ab
RH="/var/lib/morrow/relay/$U"
useradd --create-home --user-group --shell /bin/bash "$E"
install -d -m 0711 -o root -g root /var/lib/morrow /var/lib/morrow/relay
useradd --system --user-group --no-create-home --home-dir "$RH" --shell /bin/bash "$U"
install -d -m 0700 -o "$U" -g "$U" "$RH"
LOGS="$RH/relay-node/.agentworkforce/relay/team/worker-logs"
as_user() { runuser -u "$U" -- "$@"; }
as_user mkdir -p "$LOGS"
now() { date +%s%3N; }

# Streams one follower; the rest of the case runs alongside it.
follow() {
  local label="$1" user="$2" cmd="$3"
  {
    runuser -u "$user" -- env -i PATH=/usr/bin:/bin HOME=/tmp script -qfec "$cmd" /dev/null 2>/dev/null
    printf '%s\t-\t#rc %d\n' "$label" "$?"
  } | while IFS= read -r line; do
    case "$line" in *"#rc "*) printf '%s\n' "$line" ;; *) printf '%s\t%s\t%s\n' "$label" "$(now)" "${line%$'\r'}" ;; esac
  done
}
wrote() { printf '%s\t%s\t#wrote %s\n' "$1" "$(now)" "$2"; }

# normal: backlog, appends, a burst bigger than one frame, then the file shrinks.
as_user bash -c "printf 'hello\nworld\n' > '$LOGS/w-normal.log'"
follow normal "$U" "$CMD_NORMAL" &
sleep 1
as_user bash -c "printf 'more\n' >> '$LOGS/w-normal.log'"; wrote normal 5
sleep 1
as_user bash -c "head -c 100000 /dev/zero | tr '\\0' 'z' >> '$LOGS/w-normal.log'"; wrote normal 100000
sleep 1
as_user bash -c "printf 'x\n' > '$LOGS/w-normal.log'"; wrote normal truncate
sleep 1
as_user bash -c "printf 'é' | head -c 1 >> '$LOGS/w-normal.log'"; wrote normal half
sleep 0.5
as_user bash -c "printf 'é' | tail -c 1 >> '$LOGS/w-normal.log'"; wrote normal other-half
wait

# resume: start at byte 6 of "hello\nworld\n".
as_user bash -c "printf 'hello\nworld\n' > '$LOGS/w-resume.log'"
follow resume "$U" "$CMD_RESUME"

# late: no log yet; it appears after a while.
follow late "$U" "$CMD_LATE" &
sleep 1
as_user bash -c "printf 'first\n' > '$LOGS/w-late.log'"; wrote late 6
wait

# rotated: the broker starts a new file under the same name.
as_user bash -c "printf 'old\n' > '$LOGS/w-rotated.log'"
follow rotated "$U" "$CMD_ROTATED" &
sleep 1
as_user bash -c "mv '$LOGS/w-rotated.log' '$LOGS/w-rotated.old' && printf 'new\n' > '$LOGS/w-rotated.log'"; wrote rotated rotate
wait

# Hostile layouts, as in logtail-scenario.sh.
as_user ln -s /etc/shadow "$LOGS/w-symlink.log"
follow symlink "$U" "$CMD_SYMLINK"
as_user bash -c "printf 'x\n' > '$RH/elsewhere.log'"
as_user ln "$RH/elsewhere.log" "$LOGS/w-hardlink.log"
follow hardlink "$U" "$CMD_HARDLINK"
printf 'planted\n' > "$LOGS/w-rootowned.log"
chmod 0644 "$LOGS/w-rootowned.log"
follow rootowned "$U" "$CMD_ROOTOWNED"
as_user mkfifo "$LOGS/w-fifo.log"
follow fifo "$U" "$CMD_FIFO"
follow as_root root "$CMD_NORMAL"
follow as_engineer "$E" "$CMD_NORMAL"
follow bad_args "$U" "$CMD_BAD_ARGS"

sleep 1
# Nothing the followers started may outlive them (the watchdog's sleep included).
left=0
for status in /proc/[0-9]*/status; do
  uid="$(awk '/^Uid:/ { print $2 }' "$status" 2>/dev/null)"
  [ "$uid" = "$(id -u "$U")" ] && left=$((left + 1))
done
printf 'leftover\t-\t%d\n' "$left"
printf 'DONE\n'
