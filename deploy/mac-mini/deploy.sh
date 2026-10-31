#!/usr/bin/env bash
# Deploys the backend to the Mac mini and (re)starts it under launchd.
#
#   deploy/mac-mini/deploy.sh            ship code, install deps, restart, wait for /readyz
#   deploy/mac-mini/deploy.sh --status   show the service, the funnel and the last log lines
#
# Reaches the mini over Tailscale (MORROW_MINI, default root1@100.83.86.5). The backend listens on
# 127.0.0.1:8787 only; Tailscale Funnel is the one public way in (see deploy/README.md).
# Secrets live in deploy/mac-mini/backend.env on this machine (never in the repo) and are copied
# to ~/morrow/backend/.env on the mini with mode 0600.
#
# The mini runs headless with nobody logged in, so the backend is a system LaunchDaemon that runs as the
# deploy user: it starts at boot and needs no login. Installing or changing the daemon needs sudo on the
# mini, so the first deploy (and any deploy that changes the plists) asks for the mini's password and must
# run in a terminal. Every other deploy restarts the backend by signalling its own process, no sudo.
set -Eeuo pipefail

MINI="${MORROW_MINI:-root1@100.83.86.5}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/deploy/mac-mini"
ENV_FILE="$HERE/backend.env"
BUN_VERSION="1.4.4"
LABEL="dev.trymorrow.backend"
SSH_OPTS=(-o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
SSH=(ssh "${SSH_OPTS[@]}" "$MINI")
# Expanded on the mini, where a non-login shell lacks Homebrew on PATH.
# shellcheck disable=SC2016
TAILSCALE='PATH="/opt/homebrew/bin:/usr/local/bin:/Applications/Tailscale.app/Contents/MacOS:$PATH" tailscale'

log() { printf '[deploy] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

case "${1:-}" in
  --status)
    "${SSH[@]}" "launchctl print system/$LABEL 2>/dev/null | grep -E '^\s*(state|pid|last exit code|runs) =' \
      || echo 'service not installed'; $TAILSCALE funnel status; tail -n 30 ~/morrow/logs/backend.log 2>/dev/null"
    exit 0
    ;;
  "") ;;
  *) die "unknown option $1" ;;
esac

[ -f "$ENV_FILE" ] || die "missing $ENV_FILE (copy backend.env.example and fill it in)"
grep -q '^HOST=127.0.0.1$' "$ENV_FILE" || die "backend.env must set HOST=127.0.0.1 so only the funnel can reach the backend"
"${SSH[@]}" true || die "cannot reach $MINI (is Tailscale up on both machines?)"

log "shipping code to $MINI:~/morrow"
"${SSH[@]}" 'mkdir -p ~/morrow/logs ~/morrow/launchd && chmod 700 ~/morrow'
# The workspace root, the shared contracts and the backend. web/package.json rides along only so the
# lockfile's workspace list matches; nothing of the web app is installed or run on the mini.
# Relative paths from the repo root: macOS's openrsync ignores the /./ marker of --relative.
(cd "$ROOT" && rsync -az --delete --relative \
  --exclude node_modules --exclude '.env' --exclude 'test/' --exclude '*.tsbuildinfo' --exclude '.DS_Store' \
  -e "ssh ${SSH_OPTS[*]}" \
  package.json bun.lock packages backend web/package.json \
  "$MINI:morrow/")
# Streamed rather than rsynced: macOS's openrsync has no --chmod, and umask keeps the file private from creation.
"${SSH[@]}" 'umask 077 && cat >~/morrow/backend/.env.next && mv -f ~/morrow/backend/.env.next ~/morrow/backend/.env' <"$ENV_FILE"
rsync -az -e "ssh ${SSH_OPTS[*]}" "$HERE/$LABEL.plist" "$HERE/rotate-log.sh" "$MINI:morrow/launchd/"

log "installing dependencies"
# Prints the daemons whose installed plist differs from the freshly rendered one.
changed="$("${SSH[@]}" BUN_VERSION="$BUN_VERSION" LABEL="$LABEL" bash -s <<'REMOTE'
set -Eeuo pipefail
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  echo "[mini] installing bun $BUN_VERSION" >&2
  curl -fsSL --proto '=https' --tlsv1.2 https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
fi
[ "$(bun --version)" = "$BUN_VERSION" ] || { echo "[mini] bun $BUN_VERSION not active" >&2; exit 1; }
cd ~/morrow
bun install --frozen-lockfile --production --filter backend >/dev/null
chmod 600 backend/.env

dir="$HOME/morrow/launchd"
chmod 755 "$dir/rotate-log.sh"
sed -e "s#__USER__#$(id -un)#g" -e "s#__HOME__#$HOME#g" -e "s#__BUN__#$HOME/.bun/bin/bun#g" \
  "$dir/$LABEL.plist" >"$dir/$LABEL.rendered.plist"
mv -f "$dir/$LABEL.rendered.plist" "$dir/$LABEL.plist"
cat >"$dir/$LABEL.rotate.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL.rotate</string>
  <key>UserName</key><string>$(id -un)</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>
  <key>ProgramArguments</key><array><string>$dir/rotate-log.sh</string></array>
  <key>StartInterval</key><integer>3600</integer>
</dict>
</plist>
PLIST
plutil -lint "$dir/$LABEL.plist" "$dir/$LABEL.rotate.plist" >/dev/null
for name in "$LABEL" "$LABEL.rotate"; do
  cmp -s "$dir/$name.plist" "/Library/LaunchDaemons/$name.plist" || echo "$name"
done
REMOTE
)"

if [ -n "$changed" ]; then
  [ -t 0 ] || die "the launchd daemons need installing (sudo on the mini); run deploy.sh in a terminal"
  log "installing launchd daemons: $(echo "$changed" | tr '\n' ' ')(sudo asks for the mini's password)"
  # The plists are copied root-owned so the deploy user cannot later edit what launchd runs, or as whom.
  # shellcheck disable=SC2029
  ssh -t "${SSH_OPTS[@]}" "$MINI" "set -e; for name in $(echo "$changed" | tr '\n' ' '); do
      sudo install -o root -g wheel -m 644 \"\$HOME/morrow/launchd/\$name.plist\" \"/Library/LaunchDaemons/\$name.plist\"
      sudo launchctl bootout \"system/\$name\" 2>/dev/null || true
      sudo launchctl bootstrap system \"/Library/LaunchDaemons/\$name.plist\"
    done"
fi

log "restarting"
"${SSH[@]}" LABEL="$LABEL" RESTART="$([ -n "$changed" ] && echo no || echo yes)" bash -s <<'REMOTE'
set -Eeuo pipefail
pid_of() { launchctl print "system/$LABEL" 2>/dev/null | awk '$1 == "pid" { print $3 }'; }
old="$(pid_of)"
# KeepAlive brings it back; the backend drains on SIGTERM before it exits.
if [ "$RESTART" = yes ] && [ -n "$old" ]; then kill -TERM "$old"; fi
port="$(sed -n 's/^PORT=//p' ~/morrow/backend/.env)"
port="${port:-8787}"
for _ in $(seq 1 90); do
  now="$(pid_of)"
  if [ -n "$now" ] && { [ "$RESTART" = no ] || [ "$now" != "$old" ]; } \
    && curl -fsS --max-time 3 "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then
    echo "[mini] backend ready on 127.0.0.1:$port (pid $now)"
    exit 0
  fi
  sleep 1
done
echo "[mini] backend did not become ready; last log lines:" >&2
tail -n 40 ~/morrow/logs/backend.log >&2
exit 1
REMOTE
log "done. Public check: curl -fsS https://sams-mac-mini.tail115f36.ts.net/readyz"
