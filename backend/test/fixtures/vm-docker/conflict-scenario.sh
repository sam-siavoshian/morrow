#!/usr/bin/env bash
# Runs inside a throwaway ubuntu:24.04 container as root (see test/vm/conflictDocker.test.ts).
# A real merge conflict end to end through backend/vm/git.sh: two workstream branches edit the same line, the
# GitHub merge (emulated with `git merge-tree` on the bare repo, the same three-way merge) reports the conflict,
# a resolver works on the integration branch, the CHECK_CONFLICTS guard refuses unmerged paths and leftover
# markers, the resolution is published, and the merge is clean afterwards. Prints `RESULT <name> pass|fail
# <detail>` lines, then `DONE`.
set -Euo pipefail

VM=/vm
FX=/fixtures
TOKEN="gho_TESTSECRETtoken0123456789abcdefABCD"
U=u0123456789ab
REPO=acme/web
BARE=/srv/git/acme/web.git
INTEGRATION=morrow/t1/integration
API=morrow/t1/api
WEB=morrow/t1/web
WT=/home/$U/work/.worktrees/acme__web/morrow-t1-integration-0011aabb
SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

result() { printf 'RESULT %s %s %s\n' "$1" "$2" "${3:-}"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then result "$name" pass; else result "$name" fail; fi; }
json_field() { python3 -c 'import json,sys; v=json.loads(sys.stdin.read().strip().splitlines()[-1]).get(sys.argv[1]); print("" if v is None else str(v).lower() if isinstance(v,bool) else ",".join(v) if isinstance(v,list) else v)' "$1"; }

as_root() { env -i PATH="$SAFE_PATH" HOME=/root "$@" bash -c 'morrow_script="$(cat)" && exec /bin/bash -c "$morrow_script" morrow-vm' <"$VM/git.sh"; }
as_agent_exec() { runuser -u "$U" -- env -i PATH="$SAFE_PATH" HOME="/home/$U" "$@" bash -c 'morrow_script="$(cat)" && exec /bin/bash -c "$morrow_script" morrow-vm' <"$VM/git.sh"; }
# The worker in its worktree (its CLI's own git identity).
agent_git() { runuser -u "$U" -- env -i PATH="$SAFE_PATH" HOME="/home/$U" git -c user.name=worker -c user.email=w@x -C "$WT" "$@" </dev/null; }
agent_write() { runuser -u "$U" -- env -i PATH="$SAFE_PATH" bash -c 'printf "%s\n" "$2" >"$1"' _ "$WT/$1" "$2"; }
new_cred() {
  local name
  name="cred.$(openssl rand -hex 16)"
  (umask 077 && printf '%s' "$1" >"/var/lib/morrow/cred/$name")
  printf '%s' "$name"
}
commit_ci() { git -C "$1" -c user.name=s -c user.email=s@x add -A && git -C "$1" -c user.name=s -c user.email=s@x commit -qm "$2"; }

# GitHub's merges API on the bare repo: "noop" (already contained), "merged" (a merge commit on base), or
# "conflict" plus the conflicting paths, with base left alone.
gh_merge() {
  local base="$1" head="$2" base_sha head_sha out tree
  base_sha=$(git -C "$BARE" rev-parse "refs/heads/$base")
  head_sha=$(git -C "$BARE" rev-parse "$head")
  if git -C "$BARE" merge-base --is-ancestor "$head_sha" "$base_sha"; then echo noop; return; fi
  if out=$(git -C "$BARE" merge-tree --write-tree --name-only "$base_sha" "$head_sha"); then
    tree=$(head -n 1 <<<"$out")
    git -C "$BARE" update-ref "refs/heads/$base" "$(git -C "$BARE" -c user.name=gh -c user.email=gh@x commit-tree "$tree" -p "$base_sha" -p "$head_sha" -m "merge $head")"
    echo merged
  else
    # Line 1 is the tree; the conflicted paths follow up to the first blank line.
    echo "conflict $(sed -n '2,/^$/p' <<<"$out" | sed '/^$/d' | sort -u | tr '\n' ' ')"
  fi
}

# ---------- fake GitHub on 127.0.0.1:443 with a CA the system trusts ----------
echo "127.0.0.1 github.com" >>/etc/hosts
mkdir -p /srv/tls && cd /srv/tls
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Fake CA" -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=github.com" -keyout gh.key -out gh.csr 2>/dev/null
printf 'subjectAltName=DNS:github.com\n' >san.ext
openssl x509 -req -in gh.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile san.ext -out gh.pem 2>/dev/null
cp ca.pem /usr/local/share/ca-certificates/fake-ca.crt && update-ca-certificates >/dev/null 2>&1

# ---------- main, two workstream branches that edit the same line, and the integration branch ----------
mkdir -p /srv/git/acme && git init -q --bare -b main "$BARE"
git -C "$BARE" config http.receivepack true
seed=$(mktemp -d) && git -C "$seed" init -q -b main && mkdir -p "$seed/src" \
  && printf 'export const greeting = "hello";\nexport const n = 1;\n' >"$seed/src/shared.ts" && printf 'app\n' >"$seed/README.md" \
  && commit_ci "$seed" seed && git -C "$seed" push -q "$BARE" main
git -C "$seed" checkout -q -b "$API" main && printf 'export const greeting = "hello from the api";\nexport const n = 1;\n' >"$seed/src/shared.ts" \
  && printf 'api\n' >"$seed/api.txt" && commit_ci "$seed" api && git -C "$seed" push -q "$BARE" "$API"
git -C "$seed" checkout -q -b "$WEB" main && printf 'export const greeting = "hello from the web";\nexport const n = 1;\n' >"$seed/src/shared.ts" \
  && printf 'web\n' >"$seed/web.txt" && commit_ci "$seed" web && git -C "$seed" push -q "$BARE" "$WEB"
git -C "$BARE" update-ref "refs/heads/$INTEGRATION" "$(git -C "$BARE" rev-parse main)"
chown -R root:root /srv/git && chmod -R go-rwx /srv/git /srv/tls
SLOW_SECS=0 EXPECTED_TOKEN="$TOKEN" python3 "$FX/fake-github.py" /srv/tls/gh.pem /srv/tls/gh.key &
for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/443) 2>/dev/null && break; sleep 0.1; done

# ---------- the verifier's merge check: api merges, web conflicts on src/shared.ts ----------
out=$(gh_merge "$INTEGRATION" "refs/heads/$API")
[ "$out" = merged ] && result first_branch_merges pass || result first_branch_merges fail "$out"
before=$(git -C "$BARE" rev-parse "refs/heads/$INTEGRATION")
out=$(gh_merge "$INTEGRATION" "refs/heads/$WEB")
[ "$out" = "conflict src/shared.ts " ] && result second_branch_conflicts pass || result second_branch_conflicts fail "$out"
check conflict_left_integration_alone test "$(git -C "$BARE" rev-parse "refs/heads/$INTEGRATION")" = "$before"
# The verifier's file list: changed on both sides since they split (compare in each direction).
both=$(comm -12 <(git -C "$BARE" diff --name-only "$(git -C "$BARE" merge-base "$INTEGRATION" "$WEB")" "$INTEGRATION" | sort) <(git -C "$BARE" diff --name-only "$(git -C "$BARE" merge-base "$INTEGRATION" "$WEB")" "$WEB" | sort) | tr '\n' ' ')
[ "$both" = "src/shared.ts " ] && result both_sides_file_list pass || result both_sides_file_list fail "$both"

# ---------- the resolver's VM: clone through the mirror, worktree on the integration branch ----------
env -i PATH="$SAFE_PATH" MORROW_USER=$U bash "$VM/bootstrap-user.sh" >/dev/null
out=$(as_root OP=clone MORROW_USER=$U REPO_FULL_NAME=$REPO CRED_NAME="$(new_cred "$TOKEN")" 2>&1)
[ "$(json_field cloned <<<"$out")" = true ] && result clone pass || result clone fail "$out"
out=$(as_agent_exec OP=worktree REPO_FULL_NAME=$REPO BRANCH=$INTEGRATION BASE_BRANCH=main WT_PATH=$WT 2>&1)
[ "$(json_field created <<<"$out")" = true ] && [ "$(json_field head <<<"$out")" = "$before" ] && result resolver_worktree_on_integration pass || result resolver_worktree_on_integration fail "$out"

# ---------- the brief's steps: merge the conflicting branch, which stops on the conflict ----------
agent_git merge -q origin/$INTEGRATION >/dev/null 2>&1
if agent_git merge --no-ff -q origin/$WEB >/dev/null 2>&1; then result worker_merge_conflicts fail "merge succeeded"; else result worker_merge_conflicts pass; fi
check worker_tree_has_markers grep -q '^<<<<<<< ' "$WT/src/shared.ts"

# Unmerged paths: nothing is committed, and they are reported.
head_before=$(agent_git rev-parse HEAD)
out=$(as_agent_exec OP=commit CHECK_CONFLICTS=1 BRANCH=$INTEGRATION WT_PATH=$WT MESSAGE="morrow: ws-resolver done e1" 2>&1)
[ "$(json_field committed <<<"$out")" = false ] && [ "$(json_field unresolved <<<"$out")" = src/shared.ts ] && result unmerged_not_committed pass || result unmerged_not_committed fail "$out"
check unmerged_head_unchanged test "$(agent_git rev-parse HEAD)" = "$head_before"
check unmerged_merge_still_in_progress agent_git rev-parse -q --verify MERGE_HEAD

# Marked resolved with the markers still in the file: the commit is local only, and the markers are reported.
agent_git add -A
out=$(as_agent_exec OP=commit CHECK_CONFLICTS=1 BRANCH=$INTEGRATION WT_PATH=$WT MESSAGE="morrow: ws-resolver done e1" 2>&1)
[ "$(json_field unresolved <<<"$out")" = src/shared.ts ] && result leftover_markers_reported pass || result leftover_markers_reported fail "$out"

# Resolved for real: both sides kept, markers gone, then committed with nothing left unresolved.
agent_write src/shared.ts 'export const greeting = "hello from the api and the web";
export const n = 1;'
agent_git add -A
out=$(as_agent_exec OP=commit CHECK_CONFLICTS=1 BRANCH=$INTEGRATION WT_PATH=$WT MESSAGE="morrow: ws-resolver done e1" 2>&1)
resolved_sha=$(json_field sha <<<"$out")
[ "$(json_field committed <<<"$out")" = true ] && [ "$(json_field unresolved <<<"$out")" = "" ] && result resolution_committed pass || result resolution_committed fail "$out"
check resolution_contains_web agent_git merge-base --is-ancestor origin/$WEB HEAD
check resolution_has_both_files test -f "$WT/api.txt" -a -f "$WT/web.txt"

# Published like any checkpoint: a fast-forward of the integration branch on GitHub, never forced.
out=$(as_root OP=publish MORROW_USER=$U REPO_FULL_NAME=$REPO BRANCH=$INTEGRATION CRED_NAME="$(new_cred "$TOKEN")" 2>&1)
[ "$(json_field pushed <<<"$out")" = true ] && [ "$(json_field sha <<<"$out")" = "$resolved_sha" ] && result resolution_published pass || result resolution_published fail "$out"
check published_is_fast_forward git -C "$BARE" merge-base --is-ancestor "$before" "refs/heads/$INTEGRATION"

# ---------- verifying again: both branches are already in, and the integration branch merges into main ----------
out="$(gh_merge "$INTEGRATION" "refs/heads/$API") $(gh_merge "$INTEGRATION" "refs/heads/$WEB")"
[ "$out" = "noop noop" ] && result reverify_merges_clean pass || result reverify_merges_clean fail "$out"
check reverify_pr_mergeable git -C "$BARE" merge-tree --write-tree "refs/heads/main" "refs/heads/$INTEGRATION"

# ---------- the default branch moves on and conflicts with the task's work ----------
up=$(mktemp -d) && git clone -q "$BARE" "$up" && printf 'export const greeting = "hello from main";\nexport const n = 1;\n' >"$up/src/shared.ts" \
  && commit_ci "$up" "main moved" && git -C "$up" push -q origin main
chown -R root:root /srv/git
out=$(gh_merge "$INTEGRATION" "refs/heads/main")
[ "$out" = "conflict src/shared.ts " ] && result base_branch_conflicts pass || result base_branch_conflicts fail "$out"
out=$(as_root OP=sync MORROW_USER=$U REPO_FULL_NAME=$REPO CRED_NAME="$(new_cred "$TOKEN")" 2>&1)
[ "$(json_field synced <<<"$out")" = true ] || result base_sync fail "$out"
out=$(as_agent_exec OP=worktree REPO_FULL_NAME=$REPO BRANCH=$INTEGRATION BASE_BRANCH=main WT_PATH=$WT 2>&1)
[ "$(json_field state <<<"$out")" = ok ] && result base_worktree_refreshed pass || result base_worktree_refreshed fail "$out"
agent_git merge --no-ff -q origin/main >/dev/null 2>&1
# Keeping this task's side changes nothing against HEAD; the merge is still concluded (MERGE_HEAD).
agent_git checkout -q --ours src/shared.ts && agent_git add -A
out=$(as_agent_exec OP=commit CHECK_CONFLICTS=1 BRANCH=$INTEGRATION WT_PATH=$WT MESSAGE="morrow: ws-resolver done e2" 2>&1)
[ "$(json_field committed <<<"$out")" = true ] && [ "$(json_field unresolved <<<"$out")" = "" ] && result ours_resolution_concludes_merge pass || result ours_resolution_concludes_merge fail "$out"
out=$(as_root OP=publish MORROW_USER=$U REPO_FULL_NAME=$REPO BRANCH=$INTEGRATION CRED_NAME="$(new_cred "$TOKEN")" 2>&1)
[ "$(json_field pushed <<<"$out")" = true ] && result base_resolution_published pass || result base_resolution_published fail "$out"
out=$(gh_merge "$INTEGRATION" "refs/heads/main")
[ "$out" = noop ] && result base_reverify_clean pass || result base_reverify_clean fail "$out"
check no_cred_files_at_end test -z "$(ls -A /var/lib/morrow/cred)"
echo DONE
