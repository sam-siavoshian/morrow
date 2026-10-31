#!/usr/bin/env bash
# Creates the engineer's Linux account (no sudo, no docker) and the root-owned
# directories the backend uses for git (credential files, mirrors, locks).
# Runs as root. Idempotent.
#
# Env: MORROW_USER  e.g. u0123456789ab
#
# Root never creates or chowns anything inside an existing home: agents run as
# that user with permission bypass and could plant symlinks there. Paths inside
# the home are created by the user itself.
set -Eeuo pipefail
umask 077
# Root runs useradd (in /usr/sbin): never depend on, or trust, the caller's PATH.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

die() { printf '[bootstrap-user] error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
user="${MORROW_USER:-}"
[[ "$user" =~ ^u[a-f0-9]{12}$ ]] || die "invalid user"

created=false
if ! id -u "$user" >/dev/null 2>&1; then
  # Exit 9 = created concurrently by another run; that is success.
  useradd --create-home --user-group --shell /bin/bash "$user" || [ $? -eq 9 ]
  created=true
fi
id -u "$user" >/dev/null 2>&1 || die "user was not created"

home="/home/$user"
[ -d "$home" ] && [ ! -L "$home" ] || die "home directory missing"
[ "$(stat -c %U "$home")" = "$user" ] || die "home directory has the wrong owner"
# /home is root-owned, so the user cannot swap this path for a symlink.
chmod 0750 "$home"

# Privilege groups: sudo/admin/wheel grant root, docker and lxd are root-equivalent.
for group in sudo admin wheel docker lxd; do
  if getent group "$group" >/dev/null && id -nG "$user" | tr ' ' '\n' | grep -qx "$group"; then
    gpasswd -d "$user" "$group" >/dev/null
  fi
done
if grep -rqsw -- "$user" /etc/sudoers /etc/sudoers.d 2>/dev/null; then
  die "user appears in sudoers"
fi

# 0711: the user must traverse to mirrors/<user> (0750 root:<user>, made by
# git.sh) but cannot list anything here. cred, locks and git-home are root-only.
install -d -m 0711 -o root -g root /var/lib/morrow /var/lib/morrow/mirrors
install -d -m 0700 -o root -g root /var/lib/morrow/cred /var/lib/morrow/locks /var/lib/morrow/git-home

# Group x on the work tree: the Relay broker runs as r<id> with this user's
# group and starts each CLI in its worktree (configure-node.sh). It can pass
# through, never list or write.
runuser -u "$user" -- mkdir -p -m 0710 "$home/work" "$home/work/.worktrees" </dev/null

# Subagents (docs/subagents.md): register the morrow-agent MCP server with the user's Claude Code, Codex and
# opencode, plus the Relay server for Cursor Agent and Grok (their only MCP source). Run as the user with a clean environment, so the files are the user's own and no value of ours is in
# them. Images built before morrow-agent lack it; that only means no subagent tools, never a failed bootstrap.
morrow_agent=false
if [ -x /usr/local/bin/bun ] && [ -f /opt/morrow/morrow-agent.js ]; then
  if runuser -u "$user" -- /usr/bin/env -i HOME="$home" PATH=/usr/local/bin:/usr/bin:/bin \
    /usr/local/bin/bun /opt/morrow/morrow-agent.js register </dev/null >/dev/null; then
    morrow_agent=true
  else
    printf '[bootstrap-user] warning: morrow-agent registration failed\n' >&2
  fi
fi

printf '{"created":%s,"morrowAgent":%s}\n' "$created" "$morrow_agent"
