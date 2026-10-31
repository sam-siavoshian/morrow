#!/usr/bin/env bash
# Builds the morrow-base golden snapshot on a fresh freestyle/ubuntu VM. Runs as root.
#
# Installs tools only. A snapshot copies memory AND disk into every engineer VM,
# so this script never starts the Relay node, never logs anything in, and
# scrubs Relay machine identity before it exits.
#
# MORROW_GOLDEN_STEP selects one step (gh | relay | bun | morrow | gemini |
# cursor | grok | verify | scrub) so each fits in one exec timeout; default
# "all" runs them in order.
#
# The morrow step installs the morrow-agent MCP server (docs/subagents.md) from
# MORROW_AGENT_B64 (the script, base64) checked against MORROW_AGENT_SHA256.
#
# The gemini, cursor and grok steps install those coding CLIs root-owned, each
# from one pinned release checked by sha256 before anything is unpacked. None of
# them gets an `agent` link (Cursor's installer adds one, Grok's too, and the
# two collide). Auto-update stays off: the install is read-only to engineers.
set -Eeuo pipefail
umask 022
# visudo is in /usr/sbin. System directories first; the caller's entries stay after them, because the base
# image's coding CLIs (checked in verify_tools) may live elsewhere on its PATH.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"

# Not named AGENT_RELAY_VERSION: a readonly var of that name cannot be passed to the installer.
readonly RELAY_VERSION="14.0.0"
# install.sh pinned to the v14.0.0 tag commit and checked against its sha256:
# the default `main` URL changes under us.
readonly RELAY_INSTALLER_URL="https://raw.githubusercontent.com/AgentWorkforce/relay/77c6d1e87296f186c631bc7f3945668ac7b0c697/install.sh"
readonly RELAY_INSTALLER_SHA256="5823eb4b1c49dfd641bb82d2e6c9c6982f7e7783996305bbffe7aa74f590f73a"
readonly RELAY_INSTALL_DIR="/opt/agent-relay"
readonly RELAY_BIN_DIR="/usr/local/bin"
readonly GH_KEYRING_URL="https://cli.github.com/packages/githubcli-archive-keyring.gpg"
readonly GH_KEYRING="/etc/apt/keyrings/githubcli-archive-keyring.gpg"
readonly GH_KEY_FINGERPRINT="2C6106201985B60E6C7AC87323F3D4EA75716059"
# Bun runs morrow-agent. Official release zips, pinned by sha256 (SHASUMS256.txt of bun-v1.4.4).
readonly BUN_VERSION="1.4.4"
readonly BUN_SHA256_X64="bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c"
readonly BUN_SHA256_AARCH64="baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e"
readonly BUN_BIN="/usr/local/bin/bun"
readonly MORROW_DIR="/opt/morrow"
readonly MORROW_AGENT="$MORROW_DIR/morrow-agent.js"
# Gemini CLI: the npm tarball, one zero-dependency bundle that needs Node 20+.
readonly GEMINI_VERSION="0.66.0"
readonly GEMINI_URL="https://registry.npmjs.org/@google/gemini-cli/-/gemini-cli-$GEMINI_VERSION.tgz"
readonly GEMINI_SHA256="269734d35287fbd8ed2982534258ecf4a95f184b6e06e6732e0d6850c28701d9"
readonly GEMINI_DIR="/opt/gemini-cli/$GEMINI_VERSION"
# Cursor Agent: the release package its installer fetches (a launcher plus its own node).
readonly CURSOR_VERSION="2026.10.22-27dcf5f"
readonly CURSOR_SHA256_X64="85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294"
readonly CURSOR_SHA256_ARM64="22a36df9720830668ccd4d707e5190204ab9c8a0efb2f068cc914895f804d3ec"
readonly CURSOR_DIR="/opt/cursor-agent/$CURSOR_VERSION"
# Grok: one static binary, zstd-compressed on the wire. Only the x86_64 build is pinned.
readonly GROK_VERSION="1.0.70"
readonly GROK_URL="https://x.ai/cli/grok-$GROK_VERSION-linux-x86_64.zst"
readonly GROK_ZST_SHA256="e751b614949d8458702367b0e0f333904c58258ad3e431a7226b14a42b74f847"
readonly GROK_SHA256="22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9"
readonly GROK_DIR="/opt/grok/$GROK_VERSION"
readonly BROKER_PROC='^(/[^ ]*/)?agent-relay-broker( |$)'
readonly NODE_PROC='^(/[^ ]*/)?agent-relay node up( |$)'

export DEBIAN_FRONTEND=noninteractive
export AGENT_RELAY_TELEMETRY_DISABLED=1
export DO_NOT_TRACK=1

log() { printf '[golden] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"

# A stalled mirror or download must fail the step, never hang the build. Freestyle kills an exec at 300 s,
# so every limit here ends first and the step fails with our own message and log tail instead.
readonly APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
readonly CURL_LIMITS=(--connect-timeout 20 --max-time 80 --retry 2)
# The Cursor and Grok packages are 60 to 190 MB; each has a step of its own.
readonly BIG_CURL_LIMITS=(--connect-timeout 20 --max-time 200 --retry 1)

apt_update() {
  apt-get "${APT_OPTS[@]}" update -qq </dev/null >/dev/null
}

apt_install() {
  apt-get "${APT_OPTS[@]}" install -y -qq --no-install-recommends "$@" </dev/null >/dev/null
}

install_gh() {
  if command -v gh >/dev/null 2>&1; then
    log "gh already installed: $(gh --version | head -n1)"
    return
  fi
  log "installing gh"
  apt_update
  apt_install ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  local keyring fingerprint
  keyring="$(mktemp)"
  curl "${CURL_LIMITS[@]}" -fsSL --proto '=https' --tlsv1.2 -o "$keyring" "$GH_KEYRING_URL"
  fingerprint="$(gpg --batch --show-keys --with-colons "$keyring" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
  if [ "$fingerprint" != "$GH_KEY_FINGERPRINT" ]; then
    rm -f "$keyring"
    die "GitHub CLI keyring fingerprint mismatch"
  fi
  install -m 0644 "$keyring" "$GH_KEYRING"
  rm -f "$keyring"
  printf 'deb [arch=%s signed-by=%s] https://cli.github.com/packages stable main\n' \
    "$(dpkg --print-architecture)" "$GH_KEYRING" >/etc/apt/sources.list.d/github-cli.list
  apt_update
  apt_install gh
  log "installed $(gh --version | head -n1)"
}

relay_version_ok() {
  local out
  out="$("$RELAY_BIN_DIR/agent-relay" --version 2>/dev/null </dev/null || true)"
  case "$out" in
    *"$RELAY_VERSION"*) return 0 ;;
    *) return 1 ;;
  esac
}

# The installer leaves its binaries execute-only (0711). Linux marks a process
# started from a binary its user cannot read as non-dumpable, which hides its
# /proc/<pid>/fd even from that same user. agent-relay then cannot verify its
# own broker with lsof and refuses to start when it runs as a non-root user.
relay_permissions() {
  chmod -R a+rX,go-w "$RELAY_INSTALL_DIR"
}

install_relay() {
  # The node's broker runs as its own user and starts each coding CLI as the
  # engineer through one sudo rule (configure-node.sh). agent-relay uses lsof
  # to tell a crashed broker's node claim from a live one; without it the node
  # refuses to start again after any crash.
  if ! command -v sudo >/dev/null 2>&1 || ! command -v visudo >/dev/null 2>&1 || ! command -v lsof >/dev/null 2>&1; then
    log "installing sudo and lsof"
    apt_update
    apt_install sudo lsof
  fi
  if relay_version_ok; then
    log "agent-relay $RELAY_VERSION already installed"
    relay_permissions
    return
  fi
  log "installing agent-relay $RELAY_VERSION into $RELAY_INSTALL_DIR"
  command -v curl >/dev/null 2>&1 || { apt_update; apt_install ca-certificates curl; }
  local work
  work="$(mktemp -d)"
  # Installer side files land in a throwaway HOME, never in /root.
  mkdir -p "$work/home"
  curl "${CURL_LIMITS[@]}" -fsSL --proto '=https' --tlsv1.2 -o "$work/install.sh" "$RELAY_INSTALLER_URL"
  if ! printf '%s  %s\n' "$RELAY_INSTALLER_SHA256" "$work/install.sh" | sha256sum -c --quiet - >/dev/null 2>&1; then
    rm -rf "$work"
    die "Relay installer checksum mismatch"
  fi
  if ! HOME="$work/home" \
    AGENT_RELAY_VERSION="$RELAY_VERSION" \
    AGENT_RELAY_INSTALL_DIR="$RELAY_INSTALL_DIR" \
    AGENT_RELAY_BIN_DIR="$RELAY_BIN_DIR" \
    timeout 240 bash "$work/install.sh" </dev/null >"$work/install.log" 2>&1; then
    tail -n 30 "$work/install.log" >&2 || true
    rm -rf "$work"
    die "Relay installer failed"
  fi
  rm -rf "$work"
  relay_permissions
  relay_version_ok || die "agent-relay --version does not report $RELAY_VERSION"
  log "installed agent-relay $RELAY_VERSION"
}

bun_version_ok() {
  [ -x "$BUN_BIN" ] && [ "$("$BUN_BIN" --version 2>/dev/null </dev/null || true)" = "$BUN_VERSION" ]
}

install_bun() {
  if bun_version_ok; then
    log "bun $BUN_VERSION already installed"
    return
  fi
  local arch sha
  case "$(uname -m)" in
    x86_64 | amd64) arch="x64"; sha="$BUN_SHA256_X64" ;;
    aarch64 | arm64) arch="aarch64"; sha="$BUN_SHA256_AARCH64" ;;
    *) die "no bun build for $(uname -m)" ;;
  esac
  log "installing bun $BUN_VERSION ($arch)"
  if ! command -v curl >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then
    apt_update
    apt_install ca-certificates curl unzip
  fi
  local work
  work="$(mktemp -d)"
  curl "${CURL_LIMITS[@]}" -fsSL --proto "=https" --tlsv1.2 -o "$work/bun.zip" \
    "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$arch.zip"
  if ! printf "%s  %s\n" "$sha" "$work/bun.zip" | sha256sum -c --quiet - >/dev/null 2>&1; then
    rm -rf "$work"
    die "bun checksum mismatch"
  fi
  unzip -q -o "$work/bun.zip" -d "$work" </dev/null
  install -m 0755 -o root -g root "$work/bun-linux-$arch/bun" "$BUN_BIN"
  rm -rf "$work"
  bun_version_ok || die "bun --version does not report $BUN_VERSION"
  log "installed bun $BUN_VERSION"
}

install_morrow_agent() {
  local b64="${MORROW_AGENT_B64:-}" want="${MORROW_AGENT_SHA256:-}"
  [ -n "$b64" ] || die "MORROW_AGENT_B64 is not set"
  [[ "$want" =~ ^[a-f0-9]{64}$ ]] || die "MORROW_AGENT_SHA256 is not a sha256"
  local tmp
  tmp="$(mktemp)"
  printf "%s" "$b64" | base64 -d >"$tmp" 2>/dev/null || { rm -f "$tmp"; die "MORROW_AGENT_B64 is not base64"; }
  if ! printf "%s  %s\n" "$want" "$tmp" | sha256sum -c --quiet - >/dev/null 2>&1; then
    rm -f "$tmp"
    die "morrow-agent checksum mismatch"
  fi
  install -d -m 0755 -o root -g root "$MORROW_DIR"
  install -m 0755 -o root -g root "$tmp" "$MORROW_AGENT"
  rm -f "$tmp"
  log "installed $MORROW_AGENT"
}

# "<sha256>  <file>" check, quiet.
sha_ok() {
  printf '%s  %s\n' "$1" "$2" | sha256sum -c --quiet - >/dev/null 2>&1
}

# First line of `<tool> --version`, run with a throwaway HOME so nothing lands in /root.
tool_version() {
  local home out
  home="$(mktemp -d)"
  out="$(HOME="$home" GROK_DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 NO_BROWSER=true timeout 30 "$@" --version </dev/null 2>/dev/null | head -n1 || true)"
  rm -rf "$home"
  printf '%s' "$out"
}

need_curl() {
  command -v curl >/dev/null 2>&1 || { apt_update; apt_install ca-certificates curl; }
}

# The Node the Gemini bundle runs on: the image's own (the claude and codex CLIs use it), 20 or newer.
gemini_node() {
  local node major
  node="$(command -v node 2>/dev/null || true)"
  if [ -z "$node" ]; then
    node="$(find /usr/local/nvm/versions/node -mindepth 3 -maxdepth 3 -path '*/bin/node' -type f 2>/dev/null | sort -V | tail -n1)"
  fi
  [ -n "$node" ] && [ -x "$node" ] || return 1
  node="$(readlink -f "$node")"
  major="$("$node" -p 'process.versions.node.split(".")[0]' </dev/null 2>/dev/null || true)"
  [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 20 ] || return 1
  printf '%s' "$node"
}

install_gemini() {
  if [ "$(tool_version /usr/local/bin/gemini)" = "$GEMINI_VERSION" ]; then
    log "gemini $GEMINI_VERSION already installed"
    return
  fi
  local node work
  node="$(gemini_node)" || die "the Gemini CLI needs Node 20 or newer on the image"
  need_curl
  log "installing gemini $GEMINI_VERSION (node $node)"
  work="$(mktemp -d)"
  curl "${CURL_LIMITS[@]}" -fsSL --proto '=https' --tlsv1.2 -o "$work/gemini.tgz" "$GEMINI_URL"
  if ! sha_ok "$GEMINI_SHA256" "$work/gemini.tgz"; then
    rm -rf "$work"
    die "Gemini CLI checksum mismatch"
  fi
  mkdir -p "$work/x"
  tar -xzf "$work/gemini.tgz" --no-same-owner --no-same-permissions -C "$work/x"
  [ -f "$work/x/package/bundle/gemini.js" ] || { rm -rf "$work"; die "the Gemini CLI package has no bundle/gemini.js"; }
  rm -rf "$GEMINI_DIR"
  install -d -m 0755 -o root -g root "$(dirname "$GEMINI_DIR")"
  mv "$work/x/package" "$GEMINI_DIR"
  rm -rf "$work"
  chown -R root:root "$GEMINI_DIR"
  chmod -R a+rX,go-w "$GEMINI_DIR"
  # A wrapper, not a link: the bundle's `#!/usr/bin/env node` would depend on each caller's PATH.
  [[ "$node" =~ ^[A-Za-z0-9/._+-]+$ ]] || die "unexpected node path"
  printf '#!/bin/sh\nexec %s %s "$@"\n' "$node" "$GEMINI_DIR/bundle/gemini.js" >/usr/local/bin/gemini.tmp
  chmod 0755 /usr/local/bin/gemini.tmp
  mv -f /usr/local/bin/gemini.tmp /usr/local/bin/gemini
  # Engineers' own runs: no self-update (the install is read-only to them) and no usage reporting.
  install -d -m 0755 -o root -g root /etc/gemini-cli
  printf '%s\n' '{"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false},"privacy":{"usageStatisticsEnabled":false},"telemetry":{"enabled":false}}' >/etc/gemini-cli/settings.json
  chmod 0644 /etc/gemini-cli/settings.json
  [ "$(tool_version /usr/local/bin/gemini)" = "$GEMINI_VERSION" ] || die "gemini --version does not report $GEMINI_VERSION"
  log "installed gemini $GEMINI_VERSION"
}

install_cursor() {
  case "$(tool_version /usr/local/bin/cursor-agent)" in
    *"$CURSOR_VERSION"*) log "cursor-agent $CURSOR_VERSION already installed"; return ;;
  esac
  local arch sha work
  case "$(uname -m)" in
    x86_64 | amd64) arch="x64"; sha="$CURSOR_SHA256_X64" ;;
    aarch64 | arm64) arch="arm64"; sha="$CURSOR_SHA256_ARM64" ;;
    *) die "no Cursor Agent build for $(uname -m)" ;;
  esac
  need_curl
  log "installing cursor-agent $CURSOR_VERSION ($arch)"
  work="$(mktemp -d)"
  curl "${BIG_CURL_LIMITS[@]}" -fsSL --proto '=https' --tlsv1.2 -o "$work/cursor.tgz" \
    "https://downloads.cursor.com/lab/$CURSOR_VERSION/linux/$arch/agent-cli-package.tar.gz"
  if ! sha_ok "$sha" "$work/cursor.tgz"; then
    rm -rf "$work"
    die "Cursor Agent checksum mismatch"
  fi
  mkdir -p "$work/x"
  tar -xzf "$work/cursor.tgz" --strip-components=1 --no-same-owner -C "$work/x"
  rm -f "$work/cursor.tgz"
  [ -f "$work/x/cursor-agent" ] && [ -f "$work/x/node" ] || { rm -rf "$work"; die "the Cursor Agent package has no launcher"; }
  rm -rf "$CURSOR_DIR"
  install -d -m 0755 -o root -g root "$(dirname "$CURSOR_DIR")"
  mv "$work/x" "$CURSOR_DIR"
  rm -rf "$work"
  chown -R root:root "$CURSOR_DIR"
  chmod -R a+rX,go-w "$CURSOR_DIR"
  # Its launcher follows the link to find its own node. Never `agent`: Grok wants that name too.
  ln -sfn "$CURSOR_DIR/cursor-agent" /usr/local/bin/cursor-agent
  case "$(tool_version /usr/local/bin/cursor-agent)" in
    *"$CURSOR_VERSION"*) ;;
    *) die "cursor-agent --version does not report $CURSOR_VERSION" ;;
  esac
  log "installed cursor-agent $CURSOR_VERSION"
}

grok_supported() {
  case "$(uname -m)" in x86_64 | amd64) return 0 ;; *) return 1 ;; esac
}

install_grok() {
  if ! grok_supported; then
    log "skipping grok: only its x86_64 build is pinned"
    return
  fi
  case "$(tool_version /usr/local/bin/grok)" in
    *"$GROK_VERSION"*) log "grok $GROK_VERSION already installed"; return ;;
  esac
  need_curl
  command -v zstd >/dev/null 2>&1 || { apt_update; apt_install zstd; }
  log "installing grok $GROK_VERSION"
  local work
  work="$(mktemp -d)"
  curl "${BIG_CURL_LIMITS[@]}" -fsSL --proto '=https' --tlsv1.2 -o "$work/grok.zst" "$GROK_URL"
  if ! sha_ok "$GROK_ZST_SHA256" "$work/grok.zst"; then
    rm -rf "$work"
    die "Grok checksum mismatch"
  fi
  zstd -q -d -o "$work/grok" "$work/grok.zst" </dev/null
  if ! sha_ok "$GROK_SHA256" "$work/grok"; then
    rm -rf "$work"
    die "Grok binary checksum mismatch"
  fi
  install -d -m 0755 -o root -g root "$GROK_DIR"
  install -m 0755 -o root -g root "$work/grok" "$GROK_DIR/grok"
  rm -rf "$work"
  ln -sfn "$GROK_DIR/grok" /usr/local/bin/grok
  case "$(tool_version /usr/local/bin/grok)" in
    *"$GROK_VERSION"*) ;;
    *) die "grok --version does not report $GROK_VERSION" ;;
  esac
  log "installed grok $GROK_VERSION"
}

verify_tools() {
  local missing=0 tool
  local tools=(git gh sudo visudo agent-relay agent-relay-broker claude codex gemini cursor-agent)
  grok_supported && tools+=(grok)
  for tool in "${tools[@]}"; do
    if command -v "$tool" >/dev/null 2>&1; then
      log "ok: $tool -> $(command -v "$tool")"
    else
      log "missing: $tool"
      missing=1
    fi
  done
  relay_version_ok || { log "agent-relay version mismatch"; missing=1; }
  [ "$(tool_version /usr/local/bin/gemini)" = "$GEMINI_VERSION" ] || { log "gemini $GEMINI_VERSION missing"; missing=1; }
  case "$(tool_version /usr/local/bin/cursor-agent)" in *"$CURSOR_VERSION"*) ;; *) log "cursor-agent $CURSOR_VERSION missing"; missing=1 ;; esac
  if grok_supported; then
    case "$(tool_version /usr/local/bin/grok)" in *"$GROK_VERSION"*) ;; *) log "grok $GROK_VERSION missing"; missing=1 ;; esac
  fi
  # `agent` must not exist: the broker would treat it as Cursor and inject the workspace key.
  if command -v agent >/dev/null 2>&1; then log "unexpected: agent -> $(command -v agent)"; missing=1; fi
  bun_version_ok || { log "bun $BUN_VERSION missing"; missing=1; }
  if [ -f "$MORROW_AGENT" ] && [ "$(stat -c %U "$MORROW_AGENT")" = root ] \
    && printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}" | timeout 10 "$BUN_BIN" "$MORROW_AGENT" 2>/dev/null | grep -q "\"result\""; then
    log "ok: morrow-agent answers"
  else
    log "missing: morrow-agent"
    missing=1
  fi
  [ "$missing" -eq 0 ] || die "golden image is incomplete"
}

# Node id = hash(machine seed file + broker cwd). A seed or token cache left in
# the image would make every engineer VM claim the same node.
scrub_identity() {
  # Anchored on argv[0]: this script's own `bash -c "<script>"` argv contains
  # these words, and -x cannot match (comm is cut to 15 chars).
  pkill -f "$BROKER_PROC" 2>/dev/null || true
  pkill -f "$NODE_PROC" 2>/dev/null || true
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$BROKER_PROC" >/dev/null 2>&1 || break
    sleep 0.5
  done
  local home
  for home in /root /home/*; do
    [ -d "$home" ] || continue
    rm -rf -- "$home/.local/share/agent-relay" \
      "$home/.local/share/agentworkforce" \
      "$home/relay-node/.agentworkforce" \
      "$home/.agentworkforce/relay/workspace-key.json"
  done
  rm -rf /tmp/agent-relay-smoke.* /etc/agent-relay /var/lib/morrow/relay /etc/sudoers.d/morrow-relay-*
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 'morrow-relay-node.service' 2>/dev/null | grep -q morrow-relay-node; then
    die "a Relay node unit exists in the golden image"
  fi
  if pgrep -f "$BROKER_PROC" >/dev/null 2>&1; then
    die "a Relay broker is still running"
  fi
  apt-get clean >/dev/null 2>&1 || true
  log "scrubbed Relay identity and caches"
}

case "${MORROW_GOLDEN_STEP:-all}" in
  gh) install_gh ;;
  relay) install_relay ;;
  bun) install_bun ;;
  morrow) install_morrow_agent ;;
  gemini) install_gemini ;;
  cursor) install_cursor ;;
  grok) install_grok ;;
  verify) verify_tools ;;
  scrub) scrub_identity ;;
  all)
    install_gh
    install_relay
    install_bun
    install_morrow_agent
    install_gemini
    install_cursor
    install_grok
    verify_tools
    scrub_identity
    ;;
  *) die "unknown step" ;;
esac
printf '{"ok":true,"step":"%s"}\n' "${MORROW_GOLDEN_STEP:-all}"
