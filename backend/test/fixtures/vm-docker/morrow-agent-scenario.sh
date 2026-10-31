#!/usr/bin/env bash
# Runs inside a throwaway ubuntu:24.04 container as root (see test/vm/morrow-agent-docker.test.ts). /bun holds the
# official Linux bun binary (checked against golden-setup.sh's pinned sha256 by the test). Installs morrow-agent the
# way the golden image does, creates an engineer with bootstrap-user.sh while fake Relay credentials sit in the
# environment, and proves the three CLI configs register the server, no credential lands in any file, and git.sh
# keeps the broker's opencode.json and any credential-bearing file out of a checkpoint commit.
# Prints `RESULT <name> pass|fail <detail>` lines, then `DONE`.
set -Euo pipefail

VM=/vm
U=u0123456789ab
H=/home/$U
SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKSPACE_KEY="rk_live_PLANTEDworkspacekey0123456789"
AGENT_TOKEN="at_live_PLANTEDagenttoken0123456789"

result() { printf 'RESULT %s %s %s\n' "$1" "$2" "${3:-}"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then result "$name" pass; else result "$name" fail; fi; }
# Freestyle exec: script on stdin, values in env.
as_root() { local script="$1"; shift; env -i PATH="$SAFE_PATH" HOME=/root "$@" bash -c 'morrow_script="$(cat)" && exec /bin/bash -c "$morrow_script" morrow-vm' <"$VM/$script"; }

# ---------- golden: bun and morrow-agent ----------
install -m 0755 -o root -g root /bun/bun /usr/local/bin/bun
check bun_runs bash -c '[ "$(/usr/local/bin/bun --version)" = 1.4.4 ]'

B64="$(base64 -w0 "$VM/morrow-agent.js")"
SHA="$(sha256sum "$VM/morrow-agent.js" | cut -d' ' -f1)"
BAD_SHA="$(printf '%064d' 0)"
if as_root golden-setup.sh MORROW_GOLDEN_STEP=morrow MORROW_AGENT_B64="$B64" MORROW_AGENT_SHA256="$BAD_SHA" >/tmp/bad.out 2>/tmp/bad.err; then
  result golden_rejects_bad_checksum fail
else
  check golden_rejects_bad_checksum bash -c '! [ -e /opt/morrow/morrow-agent.js ] && grep -q "checksum mismatch" /tmp/bad.err'
fi
out="$(as_root golden-setup.sh MORROW_GOLDEN_STEP=morrow MORROW_AGENT_B64="$B64" MORROW_AGENT_SHA256="$SHA" 2>/tmp/golden.err)"
check golden_morrow_step bash -c "[ '$out' = '{\"ok\":true,\"step\":\"morrow\"}' ]"
check golden_script_root_owned bash -c '[ "$(stat -c "%U %a" /opt/morrow/morrow-agent.js)" = "root 755" ] && [ "$(stat -c "%U %a" /opt/morrow)" = "root 755" ]'
check golden_script_matches cmp /opt/morrow/morrow-agent.js "$VM/morrow-agent.js"
check golden_verify_ping bash -c 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}" | timeout 10 /usr/local/bin/bun /opt/morrow/morrow-agent.js | grep -q "\"result\""'

# ---------- bootstrap-user.sh with credentials in the environment ----------
boot="$(as_root bootstrap-user.sh MORROW_USER="$U" RELAY_WORKSPACE_KEY="$WORKSPACE_KEY" RELAY_API_KEY="$WORKSPACE_KEY" RELAY_AGENT_TOKEN="$AGENT_TOKEN" 2>/tmp/boot.err)"
check bootstrap_registered bash -c "[ '$boot' = '{\"created\":true,\"morrowAgent\":true}' ]"
[ "$boot" = '{"created":true,"morrowAgent":true}' ] || result bootstrap_output info "$boot $(tr '\n' ' ' </tmp/boot.err)"

CLAUDE="$H/.claude.json"
CODEX="$H/.codex/config.toml"
OPENCODE="$H/.config/opencode/opencode.json"
for f in "$CLAUDE" "$CODEX" "$OPENCODE"; do
  name="$(basename "$f")"
  check "owned_by_user_$name" bash -c "[ \"\$(stat -c '%U %a' '$f')\" = '$U 600' ]"
done
check claude_registers_morrow python3 - "$CLAUDE" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))["mcpServers"]["morrow-agent"]
assert s["type"] == "stdio" and s["command"] == "/usr/local/bin/bun" and s["args"] == ["/opt/morrow/morrow-agent.js"]
assert s["env"] == {"RELAY_AGENT_NAME": "${RELAY_AGENT_NAME}", "RELAY_AGENT_TOKEN": "${RELAY_AGENT_TOKEN}", "RELAY_BASE_URL": "${RELAY_BASE_URL:-https://cast.agentrelay.com}"}
PY
check codex_registers_morrow python3 - "$CODEX" <<'PY'
import sys, tomllib
s = tomllib.load(open(sys.argv[1], "rb"))["mcp_servers"]["morrow-agent"]
assert s["command"] == "/usr/local/bin/bun" and s["args"] == ["/opt/morrow/morrow-agent.js"]
assert s["env_vars"] == ["RELAY_AGENT_NAME", "RELAY_AGENT_TOKEN", "RELAY_BASE_URL"]
assert "env" not in s
PY
check opencode_registers_morrow python3 - "$OPENCODE" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))["mcp"]["morrow-agent"]
assert s == {"type": "local", "command": ["/usr/local/bin/bun", "/opt/morrow/morrow-agent.js"], "enabled": True}
PY

# A register run as the user WITH the credentials in its own environment (no env -i) still writes none of them.
runuser -u "$U" -- env HOME="$H" PATH="$SAFE_PATH" RELAY_WORKSPACE_KEY="$WORKSPACE_KEY" RELAY_API_KEY="$WORKSPACE_KEY" \
  AGENT_RELAY_WORKSPACE_KEY="$WORKSPACE_KEY" RELAY_AGENT_TOKEN="$AGENT_TOKEN" RELAY_AGENT_NAME=w-ab12cd34-api-e5 \
  /usr/local/bin/bun /opt/morrow/morrow-agent.js register </dev/null >/dev/null 2>&1
before="$(sha256sum "$CLAUDE" "$CODEX" "$OPENCODE")"
as_root bootstrap-user.sh MORROW_USER="$U" >/tmp/boot2.out 2>&1
check bootstrap_idempotent bash -c "[ \"\$(sha256sum '$CLAUDE' '$CODEX' '$OPENCODE')\" = '$before' ] && grep -qx '{\"created\":false,\"morrowAgent\":true}' /tmp/boot2.out"
leaks="$(grep -rlE 'PLANTED|_live_' "$H" /opt/morrow 2>/dev/null || true)"
check no_credential_in_any_file bash -c "[ -z '$leaks' ]"
[ -z "$leaks" ] || result leaked_into info "$leaks"

# ---------- the server as the engineer, as a CLI would start it ----------
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | runuser -u "$U" -- env -i HOME="$H" PATH="$SAFE_PATH" RELAY_AGENT_NAME=w-ab12cd34-api-e5 RELAY_AGENT_TOKEN="$AGENT_TOKEN" timeout 10 /usr/local/bin/bun /opt/morrow/morrow-agent.js >/tmp/worker.out
check worker_tools grep -q '"name":"delegate_task"' /tmp/worker.out
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | runuser -u "$U" -- env -i HOME="$H" PATH="$SAFE_PATH" RELAY_AGENT_NAME=w-ab12cd34-api-sub-e7 RELAY_AGENT_TOKEN="$AGENT_TOKEN" timeout 10 /usr/local/bin/bun /opt/morrow/morrow-agent.js >/tmp/child.out
check child_tools bash -c 'grep -q "\"name\":\"report_result\"" /tmp/child.out && ! grep -q delegate_task /tmp/child.out'
printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"subagent_options","arguments":{}}}' \
  | runuser -u "$U" -- env -i HOME="$H" PATH="$SAFE_PATH" RELAY_AGENT_NAME=w-ab12cd34-api-e5 RELAY_WORKSPACE_KEY="$WORKSPACE_KEY" timeout 10 /usr/local/bin/bun /opt/morrow/morrow-agent.js >/tmp/nokey.out
check workspace_key_alone_fails_closed bash -c 'grep -q "No Relay agent token" /tmp/nokey.out && grep -q "\"isError\":true" /tmp/nokey.out'

# ---------- git.sh: the broker's opencode.json and credentials stay out of a checkpoint ----------
agent() { runuser -u "$U" -- env -i PATH="$SAFE_PATH" HOME="$H" GIT_CONFIG_NOSYSTEM=1 "$@" </dev/null; }
MAIN="$H/work/acme__web"
WT="$H/work/.worktrees/acme__web/morrow-t1-api-0011aabb"
agent git init -q -b main "$MAIN"
agent bash -c "cd '$MAIN' && printf 'a\n' >readme.md && printf '{}\n' >config.json && git add -A && git -c user.name=t -c user.email=t@t commit -qm init"
agent git -C "$MAIN" worktree add -q -b morrow/t1/api "$WT"
agent bash -c "cd '$WT' && printf '{\"mcp\":{\"agent-relay\":{\"environment\":{\"RELAY_AGENT_TOKEN\":\"$AGENT_TOKEN\"}}}}\n' >opencode.json \
  && printf 'key=%s\n' '$WORKSPACE_KEY' >notes.txt && printf '{\"token\":\"at_test_abc123\"}\n' >config.json && printf 'b\n' >feature.txt"
commit="$(runuser -u "$U" -- env -i PATH="$SAFE_PATH" HOME="$H" OP=commit BRANCH=morrow/t1/api WT_PATH="$WT" MESSAGE=checkpoint \
  bash -c 'morrow_script="$(cat)" && exec /bin/bash -c "$morrow_script" morrow-vm' <"$VM/git.sh" 2>/tmp/commit.err)"
check commit_ran bash -c "printf '%s' '$commit' | grep -q '\"committed\":true'"
committed="$(agent git -C "$WT" show --name-only --format= HEAD | sort | tr '\n' ' ')"
check commit_has_only_clean_files bash -c "[ '$committed' = 'feature.txt ' ]"
[ "$committed" = "feature.txt " ] || result committed_files info "$committed"
check commit_has_no_credential bash -c "! runuser -u '$U' -- git -C '$WT' log -p --all | grep -qE 'PLANTED|_live_|at_test_'"
check opencode_json_excluded bash -c "grep -qx '/opencode.json' '$MAIN/.git/info/exclude' && [ -z \"\$(runuser -u '$U' -- git -C '$WT' status --porcelain -- opencode.json)\" ]"
check credential_files_left_unstaged bash -c "runuser -u '$U' -- git -C '$WT' status --porcelain | grep -q '^?? notes.txt' && runuser -u '$U' -- git -C '$WT' status --porcelain | grep -q '^ M config.json'"
check commit_warned_without_secret bash -c "grep -q 'left notes.txt out of the commit' /tmp/commit.err && ! grep -q PLANTED /tmp/commit.err"

echo DONE
