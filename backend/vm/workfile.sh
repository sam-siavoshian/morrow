#!/usr/bin/env bash
# Writes one Morrow note (a long brief or a handoff package) into a worktree,
# as the engineer user. Committing and pushing it is the git script's
# `checkpoint` op. Prints one JSON line.
#
# Env: WT_PATH, REL_PATH (.morrow/briefs/<name>.md or .morrow/handoff/<name>.md), CONTENT_B64
#
# The note directory may be agent-writable, so symlinks there are refused:
# a worker cannot redirect the write elsewhere in the engineer's home.
set -Eeuo pipefail
umask 077

die() { printf '[workfile] error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "must not run as root"
wt="${WT_PATH:-}"
rel="${REL_PATH:-}"
case "$wt" in "$HOME/work/.worktrees/"*) ;; *) die "worktree path outside the worktree root" ;; esac
[[ "$wt" != *"/../"* && "$wt" != *"/./"* ]] || die "invalid worktree path"
[ -e "$wt/.git" ] || die "worktree missing"
[[ "$rel" =~ ^\.morrow/(briefs|handoff)/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}\.md$ ]] || die "invalid note path"

dir="$wt/${rel%/*}"
for d in "$wt/.morrow" "$dir"; do
  [ ! -L "$d" ] || die "note directory is a symlink"
done
mkdir -p -- "$dir"
target="$wt/$rel"
tmp="$(mktemp -p "$dir" .note.XXXXXXXXXX)"
if ! printf '%s' "${CONTENT_B64:-}" | base64 -d >"$tmp" 2>/dev/null; then
  rm -f -- "$tmp"
  die "invalid content"
fi
# rename(2) replaces a symlink at the target instead of following it.
mv -fT -- "$tmp" "$target"
printf '{"path":"%s","bytes":%d}\n' "$rel" "$(stat -c %s -- "$target")"
