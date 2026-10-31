#!/bin/bash
# Hourly (launchd): keeps the backend log under 50 MB with five gzipped generations. launchd holds the log
# open in append mode, so the live file is copied and truncated in place rather than moved.
set -euo pipefail
log="$HOME/morrow/logs/backend.log"
[ -f "$log" ] || exit 0
[ "$(stat -f %z "$log")" -gt $((50 * 1024 * 1024)) ] || exit 0
for i in 4 3 2 1; do
  [ -f "$log.$i.gz" ] && mv -f "$log.$i.gz" "$log.$((i + 1)).gz"
done
cp "$log" "$log.1" && : >"$log"
gzip -f "$log.1"
