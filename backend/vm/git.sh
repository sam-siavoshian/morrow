#!/usr/bin/env bash
# Git operations for one engineer environment. Prints one JSON line.
#
# OP=sync     (root)  MORROW_USER, REPO_FULL_NAME, CRED_NAME (optional)
# OP=clone    (root)  MORROW_USER, REPO_FULL_NAME, CRED_NAME (optional)
# OP=publish  (root)  MORROW_USER, REPO_FULL_NAME, BRANCH, CRED_NAME (optional)
# OP=worktree (user)  REPO_FULL_NAME, BRANCH, BASE_BRANCH, WT_PATH
# OP=commit   (user)  BRANCH, WT_PATH, MESSAGE, AUTHOR_NAME, AUTHOR_EMAIL, CHECK_CONFLICTS (optional, 1)
# OP=status   (user)  REPO_FULL_NAME, BRANCH, WT_PATH   (read-only: changes not yet committed, commits not yet pushed)
#
# Only root talks to GitHub, and only from a root-owned bare mirror per repo at
# /var/lib/morrow/mirrors/<user>/<owner>__<name>.git, whose config root alone
# writes. The token never enters an environment or argv: the backend writes it
# to a root-only file (CRED_NAME in /var/lib/morrow/cred) and the credential
# helper reads it; the file is removed on exit. The engineer's repos fetch from
# the mirror by local path (group-readable, never writable) and hold no secret.
# Publishing moves a branch into the mirror over a pipe from `git upload-pack`
# run AS THE ENGINEER, so root never opens the agent-writable repo or its
# config; root only receives a pack, as from any untrusted remote, fsck'd.
set -Eeuo pipefail
umask 077

readonly CRED_DIR="/var/lib/morrow/cred"
readonly MIRROR_ROOT="/var/lib/morrow/mirrors"
readonly LOCK_DIR="/var/lib/morrow/locks"
readonly GIT_HOME="/var/lib/morrow/git-home"
readonly SAFE_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# runuser is in /usr/sbin: never depend on, or trust, the caller's PATH.
export PATH="$SAFE_PATH"

die() { printf '[git] error: %s\n' "$*" >&2; exit 1; }

# POSIX sh (git runs helpers through /bin/sh). Answers only https://github.com.
# shellcheck disable=SC2016  # expanded by the helper's shell, not here
readonly CREDENTIAL_HELPER='!f() { [ "$1" = get ] || exit 0; p=; h=; while IFS== read -r k v; do [ -n "$k" ] || break; case "$k" in protocol) p=$v ;; host) h=$v ;; esac; done; [ "$p" = https ] && [ "$h" = github.com ] || exit 0; [ -n "${MORROW_GIT_TOKEN_FILE:-}" ] && [ -f "$MORROW_GIT_TOKEN_FILE" ] || exit 0; t=$(cat "$MORROW_GIT_TOKEN_FILE"); [ -n "$t" ] || exit 0; printf "username=x-access-token\npassword=%s\n" "$t"; }; f'

# Root's network git. Only command-line config and the mirror's own root-owned
# config apply: system and global config are off, hooks and fsmonitor are off,
# https is the only transport.
network_git() {
  HOME="$GIT_HOME" PATH="$SAFE_PATH" GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ASKPASS=/bin/false \
    git -c credential.helper= -c "credential.helper=$CREDENTIAL_HELPER" \
    -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.askPass=/bin/false \
    -c protocol.allow=never -c protocol.https.allow=always \
    -c http.sslVerify=true -c http.proxy= -c push.gpgSign=false -c submodule.recurse=false \
    -c transfer.fsckObjects=true \
    "$@" </dev/null
}

# Root's local git on the mirror (no network, no token).
mirror_git() {
  HOME="$GIT_HOME" PATH="$SAFE_PATH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@" </dev/null
}

# The engineer's local git. Repo config is agent-writable; nothing secret is around.
local_git() {
  GIT_CONFIG_NOSYSTEM=1 git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false "$@" </dev/null
}

valid_user() { [[ "$1" =~ ^u[a-f0-9]{12}$ ]]; }
valid_repo() {
  [[ "$1" =~ ^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$ ]] || return 1
  case "${1#*/}" in . | .. | *.git) return 1 ;; esac
}
valid_branch() {
  [[ "$1" =~ ^[A-Za-z0-9._/-]{1,200}$ ]] && [[ "$1" != -* ]] && git check-ref-format --branch "$1" >/dev/null 2>&1
}
repo_dir_of() { printf '%s' "${1/\//__}"; }

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# GitHub said no to these credentials (or there were none for a private repo).
auth_failure() { grep -qiE 'authentication failed|could not read (username|password)|terminal prompts disabled|repository not found|returned error: 40[134]|permission to .* denied|403' "$1"; }

# ---------- root side ----------

require_root_env() {
  [ "$(id -u)" -eq 0 ] || die "$OP must run as root"
  user="${MORROW_USER:-}"
  repo="${REPO_FULL_NAME:-}"
  valid_user "$user" || die "invalid user"
  valid_repo "$repo" || die "invalid repo"
  id -u "$user" >/dev/null 2>&1 || die "user does not exist"
  [ -d "$CRED_DIR" ] && [ -d "$GIT_HOME" ] || die "bootstrap has not run"
  repo_dir="$(repo_dir_of "$repo")"
  mirror="$MIRROR_ROOT/$user/$repo_dir.git"
  url="https://github.com/$repo.git"
  cred=""
  local name="${CRED_NAME:-}"
  if [ -n "$name" ]; then
    [[ "$name" =~ ^cred\.[a-f0-9]{32}$ ]] || die "invalid credential name"
    cred="$CRED_DIR/$name"
    [ -f "$cred" ] && [ ! -L "$cred" ] || die "credential file missing"
  fi
  # Whatever happens below, the token file goes away with this process.
  # shellcheck disable=SC2064  # the path is fixed now on purpose
  trap "rm -f -- '$cred'" EXIT
  # Files a crashed backend never removed (it removes its own after every call).
  find "$CRED_DIR" -maxdepth 1 -type f -name 'cred.*' -mmin +15 -delete 2>/dev/null || true
}

# Serializes root work on one mirror; held until the script exits.
lock_mirror() {
  install -d -m 0700 -o root -g root "$LOCK_DIR"
  exec 9>"$LOCK_DIR/$user.$repo_dir.lock"
  flock -w 240 9 || die "mirror is busy"
}

# Creates the mirror once. It is readable (never writable) by the engineer's
# group: files 0640, directories 2750 so new objects keep the group.
ensure_mirror() {
  install -d -m 0711 -o root -g root "$MIRROR_ROOT"
  install -d -m 0750 -o root -g "$user" "$MIRROR_ROOT/$user"
  mirror_created=false
  [ -d "$mirror" ] && return
  local tmp
  tmp="$(mktemp -d -p "$MIRROR_ROOT/$user" .init.XXXXXXXXXX)"
  mirror_git init --quiet --bare "$tmp"
  mirror_git -C "$tmp" config core.sharedRepository 0640
  mirror_git -C "$tmp" config gc.autoDetach false
  mirror_git -C "$tmp" config transfer.fsckObjects true
  chgrp -R "$user" "$tmp"
  find "$tmp" -type d -exec chmod 2750 {} +
  find "$tmp" -type f -exec chmod 0640 {} +
  mv -T -- "$tmp" "$mirror"
  mirror_created=true
}

# GitHub -> mirror. Prints nothing; sets sync_reason on failure.
fetch_github() {
  local err
  err="$(mktemp)"
  sync_reason=""
  if MORROW_GIT_TOKEN_FILE="$cred" network_git -C "$mirror" fetch --quiet --prune --no-tags "$url" "+refs/heads/*:refs/heads/*" 2>"$err"; then
    if [ "$mirror_created" = true ]; then
      local head
      head="$(MORROW_GIT_TOKEN_FILE="$cred" network_git ls-remote --symref "$url" HEAD 2>/dev/null | awk '$1 == "ref:" && $3 == "HEAD" { print $2; exit }')" || true
      if [[ "$head" == refs/heads/* ]] && valid_branch "${head#refs/heads/}"; then
        mirror_git -C "$mirror" symbolic-ref HEAD "$head"
      fi
    fi
  else
    sync_reason=failed
    auth_failure "$err" && sync_reason=auth
    sed -e 's/[^[:print:]\t]//g' "$err" | tail -n 5 >&2 || true
  fi
  rm -f -- "$err"
}

op_sync() {
  require_root_env
  lock_mirror
  ensure_mirror
  fetch_github
  if [ -n "$sync_reason" ]; then
    printf '{"synced":false,"reason":"%s"}\n' "$sync_reason"
    return
  fi
  printf '{"synced":true}\n'
}

# Sync, then the engineer clones the mirror into their home as themselves.
op_clone() {
  require_root_env
  lock_mirror
  ensure_mirror
  fetch_github
  if [ -n "$sync_reason" ]; then
    printf '{"cloned":false,"reason":"%s"}\n' "$sync_reason"
    return
  fi
  local home="/home/$user" dest="/home/$user/work/$repo_dir"
  # So the engineer's own `git fetch origin` can read the root-owned mirror.
  as_user git config --global --get-all safe.directory 2>/dev/null | grep -qxF -- "$mirror" \
    || as_user git config --global --add safe.directory "$mirror"
  if as_user test -d "$dest/.git"; then
    printf '{"cloned":false}\n'
    return
  fi
  local tmp="$home/work/.clone-$repo_dir"
  as_user rm -rf -- "$tmp"
  as_user git -c "safe.directory=$mirror" -c protocol.file.allow=always -c core.hooksPath=/dev/null \
    clone --quiet --no-local --no-hardlinks --origin origin -- "$mirror" "$tmp" || die "clone from mirror failed"
  if ! as_user mv -T -- "$tmp" "$dest"; then
    as_user rm -rf -- "$tmp" || true
    as_user test -d "$dest/.git" || die "could not move the checkout into place"
  fi
  printf '{"cloned":true}\n'
}

# Branch from the engineer's repo -> mirror -> GitHub. Never force-pushes.
op_publish() {
  require_root_env
  local branch="${BRANCH:-}"
  valid_branch "$branch" || die "invalid branch"
  lock_mirror
  ensure_mirror
  # A mirror made just now (older VM) has none of GitHub's history to negotiate with.
  if [ "$mirror_created" = true ]; then
    fetch_github
    [ -z "$sync_reason" ] || { printf '{"pushed":false,"reason":"%s"}\n' "$sync_reason"; return; }
  fi

  # `ext::` runs this exact argv (no shell). upload-pack runs as the engineer
  # with an empty environment; --strict opens exactly this git dir.
  local source="/home/$user/work/$repo_dir/.git" incoming="refs/morrow/incoming/$branch"
  local transport="ext::runuser -u $user -- /usr/bin/env -i PATH=$SAFE_PATH HOME=/home/$user GIT_CONFIG_NOSYSTEM=1 git upload-pack --strict --timeout=120 $source"
  mirror_git -C "$mirror" -c protocol.allow=never -c protocol.ext.allow=always -c transfer.fsckObjects=true -c fetch.fsckObjects=true \
    fetch --quiet --no-tags --no-write-fetch-head "$transport" "+refs/heads/$branch:$incoming" || die "could not read the branch from the engineer's repository"
  local sha
  sha="$(mirror_git -C "$mirror" rev-parse --verify --quiet "$incoming^{commit}")" || die "branch has no commit"

  local err reason
  err="$(mktemp)"
  if MORROW_GIT_TOKEN_FILE="$cred" network_git -C "$mirror" push --quiet --no-verify "$url" "$sha:refs/heads/$branch" >/dev/null 2>"$err"; then
    rm -f -- "$err"
    mirror_git -C "$mirror" update-ref "refs/heads/$branch" "$sha"
    printf '{"sha":"%s","pushed":true}\n' "$sha"
    return
  fi
  reason=failed
  if grep -qiE 'non-fast-forward|fetch first|\[rejected\]' "$err"; then
    reason=rejected
  elif auth_failure "$err"; then
    reason=auth
  fi
  sed -e 's/[^[:print:]\t]//g' "$err" | tail -n 5 >&2 || true
  rm -f -- "$err"
  printf '{"sha":"%s","pushed":false,"reason":"%s"}\n' "$sha" "$reason"
}

# Runs as the engineer with a clean environment (nothing of root's leaks in).
as_user() {
  runuser -u "$user" -- /usr/bin/env -i PATH="$SAFE_PATH" HOME="/home/$user" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 "$@" </dev/null
}

# ---------- engineer side ----------

op_worktree() {
  [ "$(id -u)" -ne 0 ] || die "worktree must not run as root"
  local repo="${REPO_FULL_NAME:-}" branch="${BRANCH:-}" base="${BASE_BRANCH:-}" wt="${WT_PATH:-}"
  valid_repo "$repo" || die "invalid repo"
  valid_branch "$branch" || die "invalid branch"
  valid_branch "$base" || die "invalid base branch"
  local repo_dir user
  repo_dir="$(repo_dir_of "$repo")"
  user="$(id -un)"
  local main="$HOME/work/$repo_dir" root="$HOME/work/.worktrees/$repo_dir/" mirror="$MIRROR_ROOT/$user/$repo_dir.git"
  case "$wt" in "$root"*) ;; *) die "worktree path outside the worktree root" ;; esac
  [[ "${wt#"$root"}" =~ ^[A-Za-z0-9._-]{1,120}$ ]] || die "invalid worktree path"
  [ -d "$main/.git" ] || die "repository is not cloned"
  [ -d "$mirror" ] || die "mirror missing"

  local_git -C "$main" -c "safe.directory=$mirror" -c protocol.file.allow=always \
    fetch --quiet --prune --no-tags "$mirror" "+refs/heads/*:refs/remotes/origin/*" || die "fetch from mirror failed"
  local_git -C "$main" worktree prune

  local created=false state=ok
  if [ -e "$wt/.git" ]; then
    local current
    current="$(local_git -C "$wt" symbolic-ref --short -q HEAD || true)"
    [ "$current" = "$branch" ] || die "worktree is on a different branch"
    if local_git -C "$main" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
      if [ -n "$(local_git -C "$wt" status --porcelain)" ]; then
        state=dirty
      elif ! local_git -C "$wt" merge --ff-only --quiet "refs/remotes/origin/$branch" >/dev/null 2>&1; then
        state=diverged
      fi
    fi
  else
    (umask 077 && mkdir -p "$(dirname -- "$wt")")
    if local_git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
      local_git -C "$main" worktree add --quiet "$wt" "$branch"
    elif local_git -C "$main" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
      local_git -C "$main" worktree add --quiet --track -b "$branch" "$wt" "refs/remotes/origin/$branch"
    else
      local_git -C "$main" show-ref --verify --quiet "refs/remotes/origin/$base" || die "base branch not found"
      local_git -C "$main" worktree add --quiet --no-track -b "$branch" "$wt" "refs/remotes/origin/$base"
    fi
    created=true
  fi
  exclude_agent_config "$wt"
  # The Relay broker (r<id>, in this user's group) starts the worker here: it
  # may pass through these directories, never list or write them.
  chmod g+x -- "$HOME/work" "$HOME/work/.worktrees" "${root%/}" "$wt"
  local head
  head="$(local_git -C "$wt" rev-parse HEAD)"
  printf '{"path":"%s","head":"%s","created":%s,"state":"%s"}\n' "$(json_escape "$wt")" "$head" "$created" "$state"
}

# The Relay broker writes the opencode config it starts opencode with (Relay credentials included) into the
# worker's working directory, the worktree. Keep it out of `git status` and `add -A` (info/exclude is shared by
# every worktree of the repo; the project's .gitignore is never touched).
# .agentworkforce/ is where Relay's MCP server pins a workspace (key included) in its working directory.
readonly AGENT_CONFIG_FILES=("opencode.json" ".agentworkforce/")

exclude_agent_config() {
  local wt="$1" exclude file
  exclude="$(local_git -C "$wt" rev-parse --git-path info/exclude)" || return 0
  case "$exclude" in /*) ;; *) exclude="$wt/$exclude" ;; esac
  mkdir -p -- "$(dirname -- "$exclude")"
  for file in "${AGENT_CONFIG_FILES[@]}"; do
    grep -qxF -- "/$file" "$exclude" 2>/dev/null || printf "/%s\n" "$file" >>"$exclude"
  done
}

# Never commit a Relay credential: a staged file holding one (an agent config the broker wrote, a tracked
# opencode.json it merged into, anything a worker copied) is taken back out of the index before the commit.
unstage_credentials() {
  local wt="$1" path
  while IFS= read -r -d "" path; do
    [ -n "$path" ] || continue
    # Not a pipe: under pipefail, grep -q closing early would fail the producer and hide a match.
    if grep -qaE "(^|[^A-Za-z0-9_-])(rk|at|nt)_(live|test)_[A-Za-z0-9]" < <(local_git -C "$wt" show ":$path" 2>/dev/null); then
      local_git -C "$wt" reset -q -- "$path" >/dev/null 2>&1 || local_git -C "$wt" rm -q --cached -- "$path" >/dev/null 2>&1 || true
      printf "[git] warning: left %q out of the commit: it holds a Relay credential\n" "$path" >&2
    fi
  done < <(local_git -C "$wt" diff --cached --name-only -z --diff-filter=ACMR)
}

op_commit() {
  [ "$(id -u)" -ne 0 ] || die "commit must not run as root"
  local branch="${BRANCH:-}" wt="${WT_PATH:-}" message="${MESSAGE:-}"
  local author_name="${AUTHOR_NAME:-Morrow}" author_email="${AUTHOR_EMAIL:-agent@morrow.invalid}"
  valid_branch "$branch" || die "invalid branch"
  case "$wt" in "$HOME/work/.worktrees/"*) ;; *) die "worktree path outside the worktree root" ;; esac
  [ -e "$wt/.git" ] || die "worktree missing"
  [ -n "$message" ] || die "empty message"
  local current
  current="$(local_git -C "$wt" symbolic-ref --short -q HEAD || true)"
  [ "$current" = "$branch" ] || die "worktree is on a different branch"

  # A conflict resolver's tree: unmerged paths are never committed (`add -A` would mark them resolved).
  local unresolved=""
  if [ "${CHECK_CONFLICTS:-}" = 1 ]; then
    unresolved="$(local_git -C "$wt" -c core.quotePath=true diff --name-only --diff-filter=U | head -n 20 || true)"
    if [ -n "$unresolved" ]; then
      printf '{"sha":"%s","committed":false,"unresolved":%s}\n' "$(local_git -C "$wt" rev-parse HEAD)" "$(json_lines "$unresolved")"
      return
    fi
  fi

  exclude_agent_config "$wt"
  local_git -C "$wt" add -A
  unstage_credentials "$wt"
  local committed=false
  # A merge in progress is concluded even when its resolution changed nothing against HEAD.
  if ! local_git -C "$wt" diff --cached --quiet || local_git -C "$wt" rev-parse -q --verify MERGE_HEAD >/dev/null; then
    GIT_AUTHOR_NAME="$author_name" GIT_AUTHOR_EMAIL="$author_email" \
      GIT_COMMITTER_NAME="$author_name" GIT_COMMITTER_EMAIL="$author_email" \
      local_git -C "$wt" commit --quiet --no-verify -m "$message"
    committed=true
  fi
  # Conflict markers anywhere in what this branch would publish (committed by the worker or just now).
  if [ "${CHECK_CONFLICTS:-}" = 1 ] && local_git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    unresolved="$(local_git -C "$wt" -c core.quotePath=true diff --check "refs/remotes/origin/$branch" HEAD 2>/dev/null \
      | sed -n 's/^\(.*\):[0-9]*: leftover conflict marker$/\1/p' | sort -u | head -n 20 || true)"
  fi
  printf '{"sha":"%s","committed":%s,"unresolved":%s}\n' "$(local_git -C "$wt" rev-parse HEAD)" "$committed" "$(json_lines "$unresolved")"
}

# What a person would commit and push from the web app. Read-only for the worktree: the change list comes
# from a throwaway copy of the index (`add -A -N` there marks untracked files), so the real index, a merge in
# progress and the agent's own staging are untouched. Paths are NUL-separated and base64'd (never parsed
# here); each stream is cut at STATUS_LIMIT bytes and the backend drops a cut record and reports truncation.
readonly STATUS_LIMIT=32768
op_status() {
  [ "$(id -u)" -ne 0 ] || die "status must not run as root"
  local repo="${REPO_FULL_NAME:-}" branch="${BRANCH:-}" wt="${WT_PATH:-}"
  valid_repo "$repo" || die "invalid repo"
  valid_branch "$branch" || die "invalid branch"
  local repo_dir user
  repo_dir="$(repo_dir_of "$repo")"
  user="$(id -un)"
  local main="$HOME/work/$repo_dir" root="$HOME/work/.worktrees/$repo_dir/" mirror="$MIRROR_ROOT/$user/$repo_dir.git"
  case "$wt" in "$root"*) ;; *) die "worktree path outside the worktree root" ;; esac
  [[ "${wt#"$root"}" =~ ^[A-Za-z0-9._-]{1,120}$ ]] || die "invalid worktree path"
  if [ ! -e "$wt/.git" ]; then
    printf '{"exists":false}\n'
    return
  fi
  local current
  current="$(local_git -C "$wt" symbolic-ref --short -q HEAD || true)"
  [ "$current" = "$branch" ] || die "worktree is on a different branch"
  local head
  head="$(local_git -C "$wt" rev-parse --verify -q HEAD)" || die "worktree has no commit"

  # What the mirror last saw of GitHub (refreshed on every sync and publish). Best effort: offline is fine.
  if [ -d "$main/.git" ] && [ -d "$mirror" ]; then
    local_git -C "$main" -c "safe.directory=$mirror" -c protocol.file.allow=always \
      fetch --quiet --no-tags "$mirror" "+refs/heads/*:refs/remotes/origin/*" >/dev/null 2>&1 || true
  fi
  local unpushed
  if local_git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    unpushed="$(local_git -C "$wt" rev-list --count "refs/remotes/origin/$branch..HEAD")"
  else
    unpushed="$(local_git -C "$wt" rev-list --count HEAD --not --remotes=origin)"
  fi

  local tmp index
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # the path is fixed now on purpose
  trap "rm -rf -- '$tmp'" EXIT
  index="$(local_git -C "$wt" rev-parse --path-format=absolute --git-path index)"
  if [ -f "$index" ]; then cp -- "$index" "$tmp/index"; fi
  GIT_INDEX_FILE="$tmp/index" local_git -C "$wt" add -A -N >/dev/null 2>&1 || true
  local names stats conflicts
  names="$(GIT_INDEX_FILE="$tmp/index" local_git -C "$wt" diff --no-renames --no-ext-diff --no-color --name-status -z HEAD 2>/dev/null | head -c $((STATUS_LIMIT + 1)) | base64 -w0 || true)"
  stats="$(GIT_INDEX_FILE="$tmp/index" local_git -C "$wt" diff --no-renames --no-ext-diff --no-textconv --no-color --numstat -z HEAD 2>/dev/null | head -c $((STATUS_LIMIT + 1)) | base64 -w0 || true)"
  conflicts="$(local_git -C "$wt" diff --name-only -z --diff-filter=U 2>/dev/null | head -c $((STATUS_LIMIT + 1)) | base64 -w0 || true)"
  printf '{"exists":true,"head":"%s","unpushed":%s,"names":"%s","stats":"%s","conflicts":"%s"}\n' "$head" "${unpushed:-0}" "$names" "$stats" "$conflicts"
}

# One path per line (already C-quoted by git, so printable) -> a JSON array of strings.
json_lines() {
  local out="" line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    out+="${out:+,}\"$(json_escape "$line")\""
  done <<<"$1"
  printf '[%s]' "$out"
}

case "${OP:-}" in
  sync) op_sync ;;
  clone) op_clone ;;
  publish) op_publish ;;
  worktree) op_worktree ;;
  commit) op_commit ;;
  status) op_status ;;
  *) die "unknown op" ;;
esac
