#!/usr/bin/env bash
# Runs inside a throwaway ubuntu:24.04 container as root (see test/vm/logtail-docker.test.ts).
# Plays a hostile worker against backend/vm/logtail.sh (mounted at /vm) and prints one line per case:
#   <case>\t<exit code>\t<milliseconds>\t<last stdout line>
set -uo pipefail

# The engineer (workers run as them) and the broker's own account, laid out as configure-node.sh does.
E=u0123456789ab
U=r0123456789ab
RH="/var/lib/morrow/relay/$U"
useradd --create-home --user-group --shell /bin/bash "$E"
install -d -m 0711 -o root -g root /var/lib/morrow /var/lib/morrow/relay
useradd --system --user-group --no-create-home --home-dir "$RH" --shell /bin/bash "$U"
install -d -m 0700 -o "$U" -g "$U" "$RH"
LOGS="$RH/relay-node/.agentworkforce/relay/team/worker-logs"
as_user() { runuser -u "$U" -- "$@"; }
as_user mkdir -p "$LOGS" "$RH/elsewhere"
as_user bash -c "printf 'claude-oauth-secret\n' > ~/secret"

# The way Freestyle exec runs a script: body on stdin, values in env, nothing else inherited.
run() {
  local label="$1" user="$2" name="$3" max="${4:-65536}" start end out rc
  start=$(date +%s%3N)
  if [ "$user" = root ]; then
    out="$(env -i PATH=/usr/bin:/bin AGENT_NAME="$name" MAX_BYTES="$max" bash -c "$(cat /vm/logtail.sh)" 2>/dev/null)"
  else
    out="$(runuser -u "$user" -- env -i PATH=/usr/bin:/bin AGENT_NAME="$name" MAX_BYTES="$max" bash -c "$(cat /vm/logtail.sh)" 2>/dev/null)"
  fi
  rc=$?
  end=$(date +%s%3N)
  printf '%s\t%d\t%d\t%s\n' "$label" "$rc" "$((end - start))" "$(printf '%s' "$out" | tail -n1)"
}

as_user bash -c "printf 'hello\nworld\n' > '$LOGS/w-normal.log'"
run normal "$U" w-normal

run missing "$U" w-missing

as_user ln -s /etc/shadow "$LOGS/w-shadow.log"
run symlink_root_file "$U" w-shadow

as_user ln -s "$RH/secret" "$LOGS/w-secret.log"
run symlink_user_file "$U" w-secret

as_user ln "$RH/secret" "$LOGS/w-hard.log"
run hardlink_user_file "$U" w-hard

install -m 0644 -o root -g root /dev/null "$LOGS/w-rootfile.log"
echo "root data" >"$LOGS/w-rootfile.log"
run root_owned_readable "$U" w-rootfile

install -m 0600 -o root -g root /dev/null "$LOGS/w-rootonly.log"
echo "root only" >"$LOGS/w-rootonly.log"
run root_owned_unreadable "$U" w-rootonly

# Symlinked parent: worker-logs -> elsewhere, holding a plain user file under the expected name.
as_user bash -c "printf 'redirected\n' > ~/elsewhere/w-parent.log"
as_user mv "$LOGS" "$LOGS.real"
as_user ln -s "$RH/elsewhere" "$LOGS"
run symlinked_parent "$U" w-parent
as_user rm "$LOGS"
as_user mv "$LOGS.real" "$LOGS"

as_user mkfifo "$LOGS/w-fifo.log"
run fifo "$U" w-fifo

# 200 MB (sparse) plus a last line: only the last 64 KiB may be read, quickly.
as_user bash -c "truncate -s 200M '$LOGS/w-huge.log' && printf 'the end\n' >> '$LOGS/w-huge.log'"
run huge "$U" w-huge

as_user bash -c "printf 'abcdefghij\n' > '$LOGS/w-small.log'"
run bounded "$U" w-small 4

run as_root root w-normal
# The engineer, whose user every worker runs as, can neither run the reader nor reach the logs.
run as_engineer "$E" w-normal
if runuser -u "$E" -- cat "$LOGS/w-normal.log" >/dev/null 2>&1; then echo "engineer_read	0	0	{\"read\":true}"; else echo "engineer_read	1	0	{\"read\":false}"; fi
if runuser -u "$E" -- touch "$LOGS/w-planted.log" >/dev/null 2>&1; then echo "engineer_write	0	0	{\"wrote\":true}"; else echo "engineer_write	1	0	{\"wrote\":false}"; fi
run bad_name "$U" "../secret"
run bad_max "$U" w-normal 70000

# Race: flip the log between a regular file and a FIFO as fast as possible while reading it.
as_user bash -c "printf 'plain\n' > '$LOGS/w-race.log'; printf 'plain\n' > '$LOGS/.plain'; mkfifo '$LOGS/.fifo'"
as_user bash -c "while true; do ln -f '$LOGS/.fifo' '$LOGS/.f2' 2>/dev/null; mv -f '$LOGS/.f2' '$LOGS/w-race.log'; cp '$LOGS/.plain' '$LOGS/.p2'; mv -f '$LOGS/.p2' '$LOGS/w-race.log'; done" &
flipper=$!
for i in $(seq 1 12); do run "race_$i" "$U" w-race; done
kill "$flipper" 2>/dev/null
wait 2>/dev/null
echo "DONE"
