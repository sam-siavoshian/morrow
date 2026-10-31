# Agent Relay integration reference

For the implementation agent building the Relay integration. Everything below was checked against one of:

- **[pkg]** the installed packages in `backend/node_modules` (`@agent-relay/sdk@14.0.0`, `agent-relay@14.0.0`, `@relaycast/types@8.16.0`, `@relaycast/sdk@8.16.0`)
- **[src]** the GitHub source `AgentWorkforce/relay` (main branch, whose `packages/sdk` and `packages/cli` are at `14.0.0`, same as installed)
- **[docs]** `https://agentrelay.com/llms-full.txt` (the full current docs bundle), `docs/quickstart.md` and `docs/self-hosting/README.md` in the repo, and `docs/self-hosting.md` in `AgentWorkforce/relaycast`
- **[live]** a live run here: standalone `relaycast-engine` 11.1.0 (the version `agent-relay@14.0.0` pins for local use, `packages/cli/src/cli/commands/init.ts` L88) + a real `agent-relay node up` broker 14.0.0 + the SDK sketch in section 10. The broker advertised only a fake `cat` harness, so no coding CLI was launched.

Anything not covered by those is marked **UNVERIFIED**. Product questions that only Saam can answer are marked `TODO(saam):`.

---

## 0. Short version

- **Workspace** = one Relaycast workspace per team. Created with one unauthenticated `POST /v1/workspaces` (SDK: `AgentRelay.createWorkspace`). It returns the **workspace key** `rk_live_*` once. That key is the admin credential.
- **Node** = `agent-relay node up --broker-name <node>` run on the VM with `RELAY_WORKSPACE_KEY` (and `RELAY_BASE_URL` if self-hosted) in the environment. The broker mints its own node token (`POST /v1/nodes`) and opens an outbound WebSocket. There is **no separate enroll step** in this flow. Run it as the Linux user who owns the logged-in `claude`/`codex`.
- **Spawn** from our backend = SDK `messaging.placement.spawn({ capability: 'spawn:claude', node, confirm: true, input: { name, cli, task, channels, worker_cwd } })`, called with an **agent token** (not the workspace key). This is the exact call `agent-relay fleet spawn --node` makes.
- **Observe** = mint a read-only **observer token** `ot_live_*` from the workspace key, then `createObserverEventSource({ observerToken })`. You get a gap-free backfill from the durable event log plus the live `/v1/ws` stream. Lifecycle frames (`agent.exited`, `node.status.*`, `action.completed/failed`) come through as `type: 'unknown'` with the raw frame.
- **Message as a human** = register one `type: 'human'` identity per user once, store its `at_live_*` token, send with `client.sendMessage({ to: '#project' | '@agent', text, idempotencyKey })`.
- **MCP** is injected automatically into every broker-spawned `claude` (`--mcp-config`) and `codex` (`--config mcp_servers.agent-relay.*`). Tool names in the spec are correct.
- **Biggest risk:** every node and every spawned agent process holds the workspace admin key, and spawned agents run with permission bypass flags. Workspace = security boundary. Plan isolation per team accordingly.

---

## 1. Components

| Piece | What it is | Where it runs |
|---|---|---|
| Relaycast engine | Message store and router: workspaces, agents, channels, DMs, threads, deliveries, actions, nodes, realtime WS | Hosted at `https://cast.agentrelay.com`, or self-hosted `@relaycast/engine` (Node + SQLite or a standalone binary) [docs: relaycast-api] |
| Broker (`agent-relay-broker`, Rust) | The "node". Spawns harnesses in PTYs, injects messages, registers spawned agents, talks to the engine over `/v1/node/ws` | On each VM, started by `agent-relay node up` [docs: self-hosting/README.md] |
| `agent-relay` CLI | Wraps everything: `node up`, `fleet spawn`, `fleet release`, `workspace`, `observer`, `mcp` | VM (and our backend if we shell out) |
| `@agent-relay/sdk` | TypeScript client: messaging, placement (spawn), observer source, actions | Our Bun backend |
| `agent-relay mcp` | stdio MCP server that exposes messaging tools to an agent | Started by the broker for each spawned agent |

Two different realtime connections (spec section 7 is right about this):
- `GET /v1/node/ws` with a node token `nt_live_*`: delivery and control for a node. Only brokers use it.
- `GET /v1/ws` with an observer token `ot_live_*` and `stream:read`: read-only workspace events. "Never a delivery path." [docs: relaycast-api, WebSockets table]

---

## 2. Workspaces and credentials

### 2.1 Three ways to get a workspace

| Option | How | Account needed | Notes |
|---|---|---|---|
| Hosted Relaycast | `POST https://cast.agentrelay.com/v1/workspaces` (SDK `AgentRelay.createWorkspace({ name })`, CLI `relay init --hosted` or `agent-relay workspace create <name>`) | No. `POST /workspaces` auth is "none" [docs: relaycast-api, Workspaces table]; `relay init --hosted` calls `createWorkspace(name, HOSTED_ORIGIN)` with no login [src: packages/cli/src/cli/commands/init.ts L580-L596] | "The hosted service has a free tier, enough to try agents across machines." [src: docs/quickstart.md]. Quotas/limits are not published in the docs. **UNVERIFIED** which limits apply. Not exercised live here. |
| Self-hosted engine | Run `relaycast-engine --db ./relaycast.db --port 8787 --base-url https://relay.example.com` behind TLS that forwards WS upgrades, then `POST /v1/workspaces` | No | Single process, SQLite, Apache-2.0 open source. No billing or quotas by default. [docs: relaycast self-hosting sections 2, 6, 8]. **Verified live** with 11.1.0. |
| Local `relay init` | Starts a private engine on `127.0.0.1:8787` | No | Loopback only, so useless for cross-VM work. Also writes MCP config into local coding CLIs unless `--tools none`. Do not use on our backend host. [src: docs/quickstart.md] |
| Agent Relay Cloud | Cloud account, `agent-relay cloud enroll --token ocl_node_enr_...` | Yes | Only needed for Cloud sandboxes (`fleet spawn --sandbox`), hosted dashboards, shared sessions. Not needed for us. [src: docs/self-hosting/README.md "What stays hosted"; packages/cli/src/cli/commands/cloud.ts L953-L967] |

Recommendation for the hackathon: **hosted Relaycast** (zero infra, TLS + WSS already there), with `RELAY_BASE_URL` as config so a self-hosted engine can be dropped in. Fallback if hosted limits bite: self-host the standalone engine on a small public box with Caddy in front. Self-host blocker for production: anonymous `POST /v1/workspaces` is open on a self-hosted engine; the relaycast RUNBOOK requires blocking public workspace creation at the proxy [docs: relaycast self-hosting section 6].

Workspace creation response (self-host, live): `{ ok: true, data: { workspace_id, api_key: "rk_live_...", created_at, expires_at: null } }`. A new workspace auto-seeds a `general` channel [docs: relaycast self-hosting section 4; live]. The hosted docs say create is "idempotent by name; workspace key returned on first creation only" while the self-host guide says "Workspace names are not globally unique". Do not rely on name idempotency: store the key the first time, and use a random suffix in names (`team-<teamId>`).

### 2.2 Token types [docs: relaycast-api, Authentication]

| Token | Prefix | Minted by | Secret? | Who holds it in our system |
|---|---|---|---|---|
| Workspace key | `rk_live_*` | `POST /workspaces` (returned once) | **Yes, admin** | Our backend (encrypted at rest, per team). Also every VM node (required, see 3.4). Never the browser. |
| Agent token | `at_live_*` | `POST /agents` (returned once), rotate with `POST /agents/{name}/rotate-token` | Yes | Our backend: one for the `dispatcher` identity, one per human user. The broker mints tokens for the agents it spawns; we never see those. |
| Node token | `nt_live_*` | `POST /nodes` with workspace key | Yes | The broker mints and caches it itself (`~/.local/share/agent-relay/node-tokens/<node_id>.json` on Linux via `dirs::data_local_dir`, mode 0600) [src: crates/broker/src/node_control.rs L142-L172, L1800-L1807; live] |
| Observer token | `ot_live_*` | `POST /observer-tokens` (workspace key only) | Yes, but read-only | Our backend's event fan-out process. Can be scoped to channels, `includeDms`, agent ids, expiry [pkg: messaging/thin-client.d.ts `RelayObserverTokenFilters`] |
| Webhook token | `wh_live_*` | `POST /webhooks` | Yes | Not needed |

WebSocket endpoints also accept `?token=` because WS clients cannot set headers; prefer the header, query strings land in logs [docs: relaycast-api]. The SDK observer source sends `Authorization: Bearer` when the runtime allows it and only falls back to `?token=` [src: packages/sdk/src/messaging/observer-source.ts L61-L118].

### 2.3 Free vs paid

- Self-hosted engine, broker, CLI, SDK: open source (Apache-2.0, `LICENSE` in the repo), free.
- Hosted Relaycast: free tier exists [src: docs/quickstart.md]. `https://agentrelay.com/pricing` returns 404. No published limits found. **UNVERIFIED.** Relaycast 11.1.0 added a "trial" plan for anonymous hosted workspaces (100 messages once, never reset; over it the API answers 429 `plan_limit_exceeded`), shipped off by default in PR #579; an older free tier listed 5 agents per workspace. Morrow maps `plan_limit_exceeded` to a final spawn failure that names the plan limit (`relay_quota`). SDK 14.0.0's `AgentRelay.createWorkspace` passes no account key, so an account-backed workspace would need `@relaycast/sdk` directly or a self-hosted engine.
- Cloud (sandboxes, dashboards, shared sessions, `cloud enroll`): needs a Cloud account [src: docs/self-hosting/README.md].

`TODO(saam):` confirm hosted free-tier limits with Agent Relay (hi(at)agentrelay.com per the self-hosting README) before relying on hosted in a live demo.

---

## 3. Nodes on remote Ubuntu VMs

### 3.1 Runtime requirements

- **Install path A (recommended):** the install script downloads a standalone `agent-relay` binary plus `agent-relay-broker` into `~/.agentworkforce/relay/bin` and launchers into `~/.local/bin`. "Standalone binary (no dependencies required!)", falls back to npm, then source [src: install.sh L1-L22, L1583-L1600]. Non-interactive (no prompts in the script).
- **Install path B:** `npm install -g agent-relay` needs **Node >= 22** (`engines.node: ">=22.0.0"` in `packages/cli/package.json`; same for the SDK [pkg: @agent-relay/sdk/package.json]). The quickstart says Node 22 or 24 [src: docs/quickstart.md]. The broker comes from the optional dep `@agent-relay/broker-linux-x64` / `-linux-arm64` [src: packages/harness-driver/package.json L73-L79].
- **Network:** outbound HTTPS + WSS to the Relaycast origin only. The broker's local API binds `127.0.0.1` on an OS-assigned port (`node up` sets `AGENT_RELAY_BROKER_PORT=0`) [src: packages/cli/src/cli/commands/node.ts L347-L350; live log `API listener bound on 127.0.0.1:<port>`]. No inbound ports needed.
- **Binaries on PATH for that user:** `claude`, `codex`, etc. The broker launches them by name from its own process environment. For MCP injection it also validates that it can launch `agent-relay mcp` [src: crates/broker/src/snippets.rs L1820-L1826].

### 3.2 Install (run as root via Freestyle `vm.exec`, short command)

```bash
# Create or pick the Linux user who will run claude/codex login (example: dev)
id dev >/dev/null 2>&1 || useradd -m -s /bin/bash dev

# Install Agent Relay for that user, pinned, no local engine, no install telemetry
sudo -u dev -H bash -lc '
  curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh \
  | AGENT_RELAY_VERSION=14.0.0 AGENT_RELAY_SKIP_RELAYCAST_ENGINE=1 AGENT_RELAY_TELEMETRY_DISABLED=1 bash
'
sudo -u dev -H bash -lc '~/.local/bin/agent-relay --version'
```

Env vars used are documented at the top of `install.sh` (L6-L14). `AGENT_RELAY_VERSION` accepts `14.0.0` or `v14.0.0` (the `v` is stripped, L298-L300). Do this in the pre-login snapshot (spec section 8), but see 3.6 before snapshotting.

### 3.3 Run the node as that user

`node up` options [src: packages/cli/src/cli/commands/core.ts L366-L401, node.ts L94-L105]: `--broker-name <name>` (this IS the fleet node name; default is the cwd basename), `--workspace-key <key>` (puts the key in argv, avoid), `--background`, `--state-dir`, `--no-spawn`, `--log-file`, `--log-level`, `--log-json`, `--force`.

Environment the broker reads:

| Var | Meaning | Source |
|---|---|---|
| `RELAY_WORKSPACE_KEY` | Workspace key (fallbacks `AGENT_RELAY_WORKSPACE_KEY`, `RELAY_API_KEY`) | [src: docs/self-hosting/README.md; packages/cli/src/cli/lib/workspace-env.ts] |
| `RELAY_BASE_URL` (or `RELAYCAST_BASE_URL`, which wins) | Engine origin; omit for hosted. Broker derives the WS URL from it and passes it to spawned agents' MCP | [src: docs/self-hosting/README.md] |
| `AGENT_RELAY_NODE_HARNESSES` | CSV of harnesses to advertise as `spawn:<h>`. **Default `claude,codex,gemini,opencode,muse,devin` regardless of what is installed** | [src: crates/broker/src/runtime/init.rs L999-L1098] |
| `AGENT_RELAY_NODE_MAX_AGENTS` | Node capacity; unset or 0 = unlimited | [src: crates/broker/src/runtime/init.rs L1100-L1109] |
| `AGENT_RELAY_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` | Telemetry off | [src: TELEMETRY.md] |

Foreground systemd unit (the foreground `node up` supervisor stays up until killed [live]):

```ini
# /etc/systemd/system/agent-relay-node.service
[Unit]
Description=Agent Relay node
After=network-online.target
Wants=network-online.target

[Service]
User=dev
# Dedicated dir, NOT the git checkout (see 3.5)
WorkingDirectory=/home/dev/relay-node
# root-owned 0600 file with RELAY_WORKSPACE_KEY=..., RELAY_BASE_URL=...
EnvironmentFile=/etc/agent-relay/node.env
Environment=AGENT_RELAY_NODE_HARNESSES=claude,codex
Environment=AGENT_RELAY_TELEMETRY_DISABLED=1
# Must contain where claude/codex live for this user
Environment=PATH=/home/dev/.local/bin:/home/dev/.agentworkforce/relay/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/dev/.local/bin/agent-relay node up --broker-name vm-alice --no-spawn
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
install -d -o dev -g dev /home/dev/relay-node
install -d -m 0755 /etc/agent-relay
umask 077; printf 'RELAY_WORKSPACE_KEY=%s\nRELAY_BASE_URL=%s\n' "$KEY" "$BASE_URL" > /etc/agent-relay/node.env
systemctl daemon-reload && systemctl enable --now agent-relay-node
```

The systemd parts are standard systemd, not Relay docs. **UNVERIFIED** whether Freestyle VMs run systemd as PID 1. If not, start it with `sudo -u dev -H bash -lc 'cd ~/relay-node && RELAY_WORKSPACE_KEY=... agent-relay node up --broker-name vm-alice --no-spawn --background'` through `vm.exec`, and re-run that on resume. `TODO(saam):` confirm the Freestyle image has systemd, and the exact Linux user and PATH that `claude`/`codex` are installed under.

How a node shows up [live, `GET /v1/nodes`]:

```json
{ "id": "node_5fd0...", "name": "vm-alice", "role": "broker", "status": "online", "live": true, "handlers_live": true,
  "capabilities": [ {"name":"spawn:cat","kind":"capacity"}, {"name":"release","kind":"capacity"},
    {"name":"relay:live-agents:v1","kind":"capacity","metadata":{"names":[]}}, "..." ],
  "version": "relay-broker/14.0.0", "max_agents": 0, "active_agents": 0, "last_heartbeat_at": "..." }
```

Plus the broker registers **itself as an agent named after the node** (`vm-alice`, `type: "human"`) and an implicit `direct-<id>` node row [live]. So never give an agent or human identity the same name as a node.

Health check from our backend: `relay.nodes.get('vm-alice')` and require `status === 'online' && live && handlersLive` and the expected `spawn:<cli>` capability. On the VM: `agent-relay node status`.

### 3.4 Can a node run without the workspace key?

The broker mints its node token with the workspace key (`POST /v1/nodes` with `bearer_auth(workspace_key)`) [src: crates/broker/src/node_control.rs L457-L497]. `node.ts` mentions `RELAY_NODE_ID` + `RELAY_NODE_TOKEN` for Cloud enrollment [src: packages/cli/src/cli/commands/node.ts L164-L183, L207-L212], but the broker also needs a workspace session (`relay ready workspace_key_set=true` [live]). **UNVERIFIED** that a node can run with only a node token. Assume every VM holds the workspace key.

### 3.5 Files the node writes (live, cwd + HOME)

- `<cwd>/.agentworkforce/relay/workspace-key.json` (0600, contains the workspace key) plus state, dedup, pending, dead-letter files and `team/worker-logs/<agent>.log`. **Run `node up` from a dedicated directory, never inside the repo checkout**, or an agent could commit the key. Pass the repo path per spawn with `worker_cwd`.
- `~/.local/share/agent-relay/machine-id` and node token cache (Linux path per `dirs::data_local_dir`; seen under `Library/Application Support` on macOS in the live run).
- Logs under the user's log dir (`agentworkforce/relay/<name>.log.<date>` seen live).

### 3.6 Snapshot hazard (spec section 8)

Node id = hash of a per-machine seed file + the broker's cwd [src: crates/broker/src/node_control.rs L1783-L1798; runtime/init.rs L939-L962]. If a snapshot is taken after `node up` ran once, every clone shares the machine-id and token cache. Two brokers with the same node id fight over one delivery socket and "messages stop reaching the first" [src: packages/cli/src/cli/commands/node.ts L264-L333]. Install in the snapshot, but **never run `node up` before snapshotting**, or delete `~/.local/share/agent-relay`, `~/.local/share/agentworkforce` and `~/relay-node/.agentworkforce` before taking it.

---

## 4. Spawning agents on a specific node from our backend

### 4.1 What `fleet spawn --node` actually does [src: packages/cli/src/cli/commands/fleet.ts]

Flags (L567-L620): `<cli>` positional, `--name` (required), `--task` / `--task-file`, `--node` (alias `--target-node`), `--channel`, `--model`, `--cwd`, `--session-ref`, `--no-confirm`, `--confirm-timeout` (default 360000 ms, floor 95000 for verified targeted spawns, L99-L112, L713-L722), plus workforce metadata `--organization --project --workstream --role --objective`, and Cloud-only `--sandbox*`. Accepted CLIs: `claude codex gemini aider goose grok muse opencode devin` (L87-L97). **Cursor is not a fleet spawn harness.**

Targeted path (L1191-L1294):
1. If no agent token, register a throwaway identity `fleet-spawn-launcher-<8hex>` with the workspace key (`workspace.register(..., { strict: true })`).
2. `new AgentRelay({ agentToken })` then `relay.messaging.placement.spawn({ capability: 'spawn:<cli>', node, failFast: true, confirm, confirmTimeoutMs, input: { name, cli, task, channels: [channel], model, worker_cwd, ...metadata, session_ref } })`.
3. Release the launcher with `deleteAgent: true`.

Why an agent token: placement goes through `commands.invoke` (action invocation) which "requires an agent-scoped connection" [pkg: messaging/types.d.ts `commands.invoke`]; REST `POST /actions/{name}/invoke` is agent-token only [docs: relaycast-api]. Our backend should keep one long-lived `dispatcher` identity (type `system`) instead of minting launchers per call.

### 4.2 Field rules enforced by the broker

| Field | Rule | Source |
|---|---|---|
| `name` | Must be unused on that node, else `spawn_agent_name_in_use`. Released names stay registered unless released with `deleteAgent` | [src: crates/broker/src/runtime/fleet.rs L1828-L1839; fleet.ts L255-L270; live] |
| `cli` | Must match an advertised `spawn:<cli>` capability, else `RelayPlacementError('capability_mismatch')` | [live] |
| `task` | PTY harnesses: body cap **14,336 UTF-8 bytes**; oversize is rejected before launch. For longer briefs write a file on the node and send a short pointer | [src: docs/harnesses/injection.md] |
| `worker_cwd` | **Absolute, existing directory on the node**, else `spawn_failed: worker_cwd is not resolvable` | [src: crates/broker/src/runtime/relaycast_events.rs L95-L131; live] |
| `channels` | Array of channel names (`#` optional). Without it the worker joined `general` and the broker's default channel [live] | [src: relaycast_events.rs L241-L277] |
| `model` | Passed through to the harness | [src: fleet.rs L1863] |
| `spawn_mode: 'task_exit'` / `exit_after_task: true` | Agent exits after the task instead of idling | [src: fleet.rs L1865-L1878] |

The engine also returns `address: "<name>@<node>"` on the agent record [live: `GET /v1/agents/<name>` returned `"address": "w-ver-207c25@vm-alice"`]. Names are workspace-wide, so the spec's `agent-<taskShort>-<role>@<node>` maps to name `agent-<taskShort>-<role>` and the engine supplies `@<node>`.

### 4.3 Status and lifecycle

Return value [pkg: messaging/types.d.ts `RelaySpawnPlacementAck`]: `{ invocationId, status, dispatchedNodeId, node?, placement: { capability, node?, attempts, queued, state: 'accepted' | 'ready', confirmed }, confirmation?: RelayActionInvocation }`.

- `confirm: true` with default `verifyReady` (true for `spawn:*`): the broker holds the action open until the harness proves readiness (90 s window that starts after launch), success output is `{ spawned: true, ready: true, name }` [pkg: types.d.ts L575-L613; src: crates/broker/src/runtime/fleet.rs L247, L272]. **Use this.**
- `confirm: false`: returns as soon as the engine accepts. "A successful dispatch request is not proof that the agent is ready" (the spec is right).
- **Trap (live):** `confirm: true, verifyReady: false` launched the worker, but the SDK threw `spawn_failed ... without explicit spawned:true and a ready boolean proof`, because the broker's unverified output was `{ agent_id, name, invocation_id, session_ref }`. Do not use that combination.

Errors [pkg: messaging/relaycast-placement.d.ts]: `RelayPlacementError.code` in `capability_mismatch | placement_queue_full | placement_ttl_expired | no_eligible_node | node_unavailable | sandbox_policy_mismatch | unmapped_repo | spawn_failed | spawn_retryable | spawn_unconfirmed`, plus `state`, `dispatchState: 'dispatched' | 'not_dispatched' | 'unknown'`, `invocationId`, `receipt`. `spawn_unconfirmed` means "may still be running; retrying can duplicate work" (`RelaySpawnPlacementState` doc). A node name the engine has never seen throws a plain `RelayError` (`not_found`, 404, "Node not found"), not a `RelayPlacementError` [live].

Read a spawn back without relaunching: `messaging.commands.getInvocation('spawn', invocationId)` (what `fleet spawn-status` does, fleet.ts L507-L565). Live output: `{ invocationId, actionName: 'spawn', callerName, dispatchedNodeId, input: {..., target_node, ttl_override_ms}, output: {...}, status: 'completed' | 'failed', error, completedAt }`.

Lifecycle events on the observer stream [live]:

| Event | When |
|---|---|
| `action.invoked` (normalized `actionInvoked`) | Spawn dispatched |
| `agent.status.active` (raw, `agent_name`, `subject_agent_id`) | Spawned agent registered |
| `action.completed` / `action.failed` (raw, `invocation_id`, `output`, `error`) | Node's terminal result |
| `agent.exited` (raw, `agent_id`, `agent_name`, `node_id`, `invocation_id`, `reason: deregistered \| missing_from_inventory \| released`) | Agent gone [pkg: @relaycast/types events.d.ts L271-L283] |
| `node.status.online` / `node.status.offline` (`reason: deregistered \| liveness_timeout \| disconnected`) | Node up/down [pkg: events.d.ts L284-L297] |
| `agent.status.offline` | Presence lost |

Agent records carry the link back to the spawn: `metadata.fleet = { node_id, invocation_id, registered_at }`, plus `metadata.cli`, `metadata.host`, `metadata.objective` [live]. Live worker names per node are in the node capability `relay:live-agents:v1` → `metadata.names` [live].

**Reconcile, do not trust one signal (live findings):**
1. A verified spawn of a harness that never became ready was reported `action.failed: spawn_agent_name_in_use` after about 48 s, while the worker was **still listed live** on the node. (Seen with the fake `cat` harness, which never reports readiness. A real `claude` normally becomes ready in seconds, but the reconcile rule stands.)
2. `release` returned `status: 'dispatched'`, then the engine emitted `agent.exited (reason: deregistered)` and the node's live list emptied, but the release action itself ended `action.failed: agent_release_generation_conflict`. Treat `agent.exited` + the live-agents list as truth, not the release action result.

So the outbox loop for `recordSpawnStatus` should be: spawn with our own idempotency (agent name derived from lease id) → on any error or timeout, read `nodes.get(node)` live-agents and `agents.get(name).metadata.fleet.invocation_id` → only then mark started/failed. Observed invocation ids looked like `inv_idem_<64 hex>` for spawns; how that id is derived is **UNVERIFIED**, so do not use it for dedupe.

### 4.4 Harness selection

- Selected by `capability: 'spawn:<cli>'` plus `input.cli`. The broker detects claude/codex/gemini/opencode/grok/cursor/muse/droid/devin for MCP wiring [src: crates/broker/src/snippets.rs L1785-L1820].
- Advertised set = `AGENT_RELAY_NODE_HARNESSES` or the default list (3.3). **Set it explicitly per VM to the CLIs that are installed and logged in**, otherwise placement can route `spawn:gemini` to a VM without gemini.
- Spawned agents get permission-bypass flags injected: claude `--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`, gemini `--yolo`, grok `--always-approve` [src: crates/broker/src/worker.rs L1072-L1095]. The source comment says this "means any actor who can trigger agent.add gets agents with no permission guardrails".

### 4.5 Local worker control on a VM

`agent-relay node agent spawn|new|list|release|set-model|attach` exist [src: packages/cli/src/cli/commands/local-agent.ts L819-L1030]. They talk to the local broker's HTTP API on 127.0.0.1 via `connection.json`, so from our backend they are only usable through `vm.exec` on that VM. Prefer the SDK fleet path.

### 4.6 Release

`createWorkspaceClient({ workspaceKey, baseUrl }).agents.release({ name, reason, deleteAgent })`, which is what `fleet release` does [src: fleet.ts L1435-L1525; pkg: thin-client.d.ts]. `deleteAgent: true` frees the name for reuse.

---

## 5. Messaging from our backend

Facts [pkg + live]:
- `relay.workspace.register({ name, type: 'human' | 'agent' | 'system', metadata })` returns a live `RelayAgentClient` with `.token`. Without `{ strict: true }` it **adopts an existing name and rotates its token, invalidating the old one** [pkg: facade.d.ts `RelayWorkspace.register`]. Register once, store the token, then `relay.workspace.reconnect({ apiToken })`.
- With only a workspace key, the SDK refuses `channels.create/join/invite/members`, `messages.send/reply/direct/react/search/readers`, `inbox.get` and `events.connect` (`requires agentToken or agentClient`), even though REST allows the workspace key for `POST /channels` [pkg: dist/messaging/relaycast.js `requireAgentClient`; live]. Act through an identity.
- Workspace key is enough for reads: `relay.agents.list()`, `relay.channels.list()`, `relay.messages.list(channel, { limit, before, after })`, `relay.threads.get(id)`, `relay.nodes.list()` [live].
- Posting to a channel without joining it was accepted (engine 11.1.0) [live]. Joining explicitly is still cheap.
- Same `idempotencyKey` returned the same message id [live]. Use our message row id.
- `mode: 'wait'` (default) queues for the recipient's next idle boundary; `'steer'` requests immediate injection and may interrupt work. "A successful send confirms enqueue only" [pkg: messaging/types.d.ts L12-L19].

Sending as a user:

```ts
const saam = await relay.workspace.reconnect({ apiToken: storedHumanToken });
await saam.sendMessage({ to: '#project', text, idempotencyKey: msgRowId });           // channel
await saam.sendMessage({ to: '@agent-t1-backend', text, idempotencyKey });            // DM
await saam.sendMessage({ to: ['@a', '@b'], text, idempotencyKey });                    // group DM
await saam.reply({ messageId: rootId, text, idempotencyKey });                         // thread reply
```

IDs and threading [live]: message ids are numeric strings (`"241467389263060992"`); a thread reply has `threadId === parentId === <root id>`; DM `conversationId` looks like `dm_<hex>`; channel history shows `replyCount`. `RelayMessage` fields: `id, messageId, kind, text, from {id,name}, target, channel {id,name}, conversationId, threadId, parentId, mode, createdAt, metadata, attachments, replyCount, reactions, mentions` [pkg: messaging/types.d.ts L218-L240].

Read receipts: `client.messages.readers(messageId)` (agent token). A send that returns `queued_unconfirmed` (CLI wording) means stored, not yet read; do not resend [src: docs/quickstart.md "Reading delivery status"].

---

## 6. Live activity stream for our UI

Use the observer plane, server-side only:

```ts
const { token } = await createObserverToken({ workspaceKey, name: 'ui-backend', baseUrl, filters: { includeDms: true } });
const source = createObserverEventSource({ observerToken: token, baseUrl, sinceSeq: savedCursor, onCursor: persistCursor });
source.on('any', (e) => fanOutToBrowsers(e));
source.connect();
```

Behaviour [src: packages/sdk/src/messaging/observer-source.ts L330-L420; pkg: observer-source.d.ts]:
1. Opens the live `/v1/ws` stream and buffers frames.
2. Backfills `GET /v1/workspace/events?since=<cursor>` page by page (max 500) until `latest_seq`.
3. Emits backfill then live frames, deduped and ordered by `seq`. Auto-reconnects with capped backoff and re-backfills on every reopen. Degrades to live-only if backfill 404s or times out (30 s default).

Verified live: started after messages existed, it replayed them from `seq` 0, then received live channel messages, thread replies and DMs (DMs only because `includeDms: true`; default excludes DMs [pkg: thin-client.d.ts]).

Event shapes delivered to `on('any')` are the normalized `RelayMessagingEvent` union [pkg: messaging/types.d.ts L705-L807]: `messageCreated {channel, message}`, `messageUpdated`, `threadReply {channel, parentId, message}`, `dmReceived | groupDmReceived {conversationId, message}`, `channelCreated`, `memberJoined`, `messageRead`, `reactionAdded`, `actionInvoked`, and **`unknown {sourceType, raw}` for everything else** (`agent.status.*`, `agent.exited`, `node.status.*`, `action.completed/failed`, `delivery.*`) [src: packages/sdk/src/messaging/normalize.ts L682-L828]. The raw frames carry `seq`.

Do not use `new AgentRelay({ observerToken }).addListener(...)` for the UI: its public `RelayEvent` union has no `agent.exited`, `node.*` or `delivery.*` [pkg: listeners.d.ts L262-L290], so lifecycle events are dropped.

Only one `on('any')` subscriber per process is needed; fan out from there over our own SSE/WS, filtered per team. Persist the cursor (per team) in Terse or wherever we keep small state, so a backend restart resumes without gaps or duplicates.

Alternative: HTTP push via `POST /subscriptions` with HMAC `X-Relay-Signature` [docs: relaycast-api, Webhooks And Subscriptions]. Not tested here.

---

## 7. MCP injection

- The broker injects the Relay MCP server into each spawned agent [src: crates/broker/src/snippets.rs L1785-L1960]:
  - claude: `--mcp-config <json>` with `mcpServers["agent-relay"]`, additive (no `--strict-mcp-config`, so project `.mcp.json` still loads).
  - codex: `--config mcp_servers.agent-relay.command=...`, `...args=["mcp"]`, and env entries `RELAY_API_KEY`, `RELAY_BASE_URL`, `RELAY_AGENT_NAME`, `RELAY_AGENT_TYPE="agent"`, `RELAY_STRICT_AGENT_NAME="1"`, `RELAY_AGENT_TOKEN`.
  - gemini, droid, devin, grok, opencode, cursor, muse: file/config based.
  - Skipped when the spawn sets skip-relay-prompt or `AGENT_RELAY_LOCAL_ONLY=1` [src: crates/broker/src/worker.rs L638-L670].
- So yes, **spawned agents get the tools automatically**. Nothing is written to `~/.claude` / `~/.codex` for spawned agents (args, not config files), except the codex update-check flag in args.
- Tool names [src: packages/cli/src/cli/mcp/messaging-tools.ts, mcp/workspace.ts, mcp/action-tools.ts, agent-relay-mcp.ts]: `register_agent, list_agents, add_agent, remove_agent, create_workspace, set_workspace_key, spawn, submit_result, query_nodes, get_observer_url, create_channel, join_channel, leave_channel, list_channels, invite_to_channel, set_channel_topic, archive_channel, post_message, send_dm, send_group_dm, reply_to_thread, get_message_thread, list_messages, list_dms, search_messages, add_reaction, remove_reaction, check_inbox, mark_message_read, get_message_readers, upload_file, download_file, list_actions, invoke_action`. All five in the spec (`send_dm, post_message, check_inbox, list_agents, reply_to_thread`) exist. In Claude Code they appear as `mcp__agent-relay__<tool>`.
- Note the `spawn` and `add_agent` MCP tools: any agent can spawn more agents. Our planner should own spawning; tell agents in the task brief not to call `spawn`.
- For an engineer's own interactive session (not broker-spawned) the MCP has to be installed with `relay init --tools claude,codex --scope project --yes` (or `--url/--key` for self-host) [src: docs/quickstart.md]. Not needed for our worker flow.
- Inbound messages land in the agent's chat between turns, prefixed as coming through Agent Relay [docs: For agents]. `check_inbox` is a fallback, not the main delivery path [docs: agent-relay-mcp, Delivery Through MCP].

---

## 8. Delivery guarantees, disconnects, pause/resume

What the docs and source say:
- Deliveries are a durable per-recipient queue (`GET /deliveries`, `POST /deliveries/{id}/ack|fail|defer`). `/v1/node/ws` delivers with per-agent sequencing and cumulative acks. "Reconnecting nodes replay unacked work through GET /deliveries plus the ack/fail/defer endpoints, so delivery survives disconnects." [docs: relaycast-api]
- The broker only advances its cumulative ack over a contiguous prefix of confirmed receipts [src: crates/broker/src/node_control.rs L1375-L1521].
- Receipt into a PTY means harness acceptance (activity, composer cleared, or echo). A body parked in the composer gets one bounded submit-key retry, the body itself is never replayed [src: docs/harnesses/injection.md]. Effectively at-least-once to the node, at-most-once into the composer. Do not build on exactly-once.
- Broker side: heartbeat every 12 s, read-idle timeout 48 s, reconnect backoff 1 s to 30 s, re-mint node token after 401 (max 5 times), inventory refresh every 60 s because "Relaycast's agent-presence lease expires after five minutes" [src: crates/broker/src/node_control.rs L30-L72].

What was observed live:
- `kill -9` of the broker: `node.status.offline (reason: disconnected)` about 1.5 s later; that node's agents went `agent.status.offline`.

Pause/resume (spec 8 and 11): a paused VM does not close its TCP socket, so the engine should eventually report `liveness_timeout`. The engine-side timeout value is **UNVERIFIED**. On resume the broker hits its 48 s read-idle timeout or a failed write, reconnects, and replays inventory. Messages sent while paused stay queued as deliveries. Whether agents whose presence lease expired (pause longer than 5 minutes) are cleanly re-adopted is **UNVERIFIED**. Our worker monitor should wait for `node.status.online` and the expected names in `relay:live-agents:v1` before declaring the worker ready again.

Self-host caveats: idempotency windows and live sequences are in memory and reset on engine restart; webhook deliveries in flight are lost on restart [docs: relaycast self-hosting section 8].

---

## 9. Auth and security

Never in the browser: workspace key, agent tokens, node tokens, observer tokens. The browser talks only to our backend's authenticated SSE/WS. `get_observer_url` / `agent-relay observer` produce a URL for the hosted observer dashboard; only use that if we accept a bearer link with a limited lifetime (`expires_in_hours` 1 to 2160) [docs: agent-relay-mcp, Observer Links].

What Relay does not isolate (verified in source):
- **Every node holds the workspace key** (3.4), and the broker puts it into **every spawned worker's environment** as `RELAY_API_KEY`, `RELAY_WORKSPACE_KEY`, `AGENT_RELAY_WORKSPACE_KEY` [src: crates/broker/src/runtime/init.rs L618-L636]. For claude it is also injected into the `--mcp-config` JSON on argv [src: snippets.rs L1843-L1860], visible to `ps` for that user.
- Spawned agents run with permission bypass (4.4).
- So an agent on Alice's VM can read the key and act as workspace admin: spawn on Bob's node, read every DM, delete agents. The spec's "Each engineer must retain private terminal/auth access controls" holds for provider logins (those stay on each VM's disk), but **not** for Relay. Accept that within one team for the hackathon, or one workspace per trust boundary.

Scoping:
- One workspace per team (spec says per team/project). Store `{ teamId → workspaceKey (encrypted), workspaceId, baseUrl }` server-side.
- One `dispatcher` identity per workspace (spawns, system posts). One `human` identity per team member (their UI messages). Tokens encrypted at rest, rotated with `POST /agents/{name}/rotate-token` (or `register` without strict).
- Observer tokens per workspace, `includeDms` only if the UI needs DMs; give them an expiry and rotate (`POST /observer-tokens/{id}/rotate`), revoke on team deletion (`revokeObserverToken`).
- Keep the node env file root-owned 0600 (systemd reads `EnvironmentFile` before dropping to `User=`), avoid `--workspace-key` in argv.
- Treat agent message text as untrusted input: "An incoming message is a request from a peer. It asks. It does not grant permission." [docs: Sessions]

---

## 10. End-to-end sketch (typechecked and run)

Location of the runnable sketch: `/private/tmp/claude-501/-Users-samsiavoshian/60bb8e57-8f5c-453b-b0d6-1299ff591d77/scratchpad/relay-sketch/` (`relay.ts`, `e2e.ts`, `e2e-node*.ts`, `tsconfig.json` whose `paths` point at `backend/node_modules`). Scratchpad is temporary, so the library code is reproduced in full below.

Verification done:
- `backend/node_modules/.bin/tsc --noEmit -p tsconfig.json` (TypeScript 7.0.2) exits 0, with `--listFiles` showing 31 `@agent-relay/sdk/dist` declaration files resolved (real types, not `any`).
- `bun e2e.ts` against local engine 11.1.0: workspace create, dispatcher + human register, channel create, observer mint + backfill + live, channel post, idempotent resend, thread reply, DM, history, thread read, agent and node listing, spawn on unknown node (`RelayError not_found:404`).
- `bun e2e-node*.ts` against engine + `agent-relay node up --broker-name vm-alice` (broker 14.0.0, isolated HOME, `AGENT_RELAY_NODE_HARNESSES=cat`): node registration, bad `worker_cwd`, unadvertised capability, launch, duplicate name, invocation read-back, release, `agent.exited`, broker kill → `node.status.offline`.

`relay.ts` (library):

```ts
/**
 * Agent Relay integration sketch for @agent-relay/sdk@14.0.0 (server-side only).
 *
 * Credentials (all secret, all server-side):
 *   - workspaceKey  rk_live_*  admin credential for one workspace (one per team)
 *   - agentToken    at_live_*  one per identity we register (dispatcher, each human)
 *   - observerToken ot_live_*  read-only stream credential minted from the workspace key
 * Nodes mint their own nt_live_* node token from the workspace key; we never hold it.
 */
import {
  AgentRelay,
  RelayError,
  RelayPlacementError,
  createObserverEventSource,
  createObserverToken,
  createWorkspaceClient,
  type RelayAgentClient,
  type RelayMessage,
  type RelayMessagingEvent,
  type RelayMessagingEventsSurface,
  type RelayNode,
  type RelaySpawnPlacementAck,
} from '@agent-relay/sdk';

export interface RelayConfig {
  /** Hosted: https://cast.agentrelay.com (SDK default). Self-hosted: your engine origin. */
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// 1. Workspace

/** Create a workspace (no auth needed on POST /v1/workspaces). Persist the key, it is shown once. */
export async function createTeamWorkspace(cfg: RelayConfig, name: string): Promise<{ relay: AgentRelay; workspaceKey: string; workspaceId: string | undefined }> {
  const relay = await AgentRelay.createWorkspace({ name, baseUrl: cfg.baseUrl });
  if (!relay.workspaceKey) throw new Error('Relay did not return a workspace key');
  const info = await relay.workspace.info();
  return { relay, workspaceKey: relay.workspaceKey, workspaceId: info.id };
}

/** Reconnect with a persisted workspace key. */
export function connectWorkspace(cfg: RelayConfig, workspaceKey: string): AgentRelay {
  return new AgentRelay({ workspaceKey, baseUrl: cfg.baseUrl });
}

// ---------------------------------------------------------------------------
// 2. Identities the backend acts as

/**
 * Register an identity ONCE and persist its token. `register` without `strict`
 * adopts an existing name and ROTATES its token, which invalidates the old one,
 * so never call it per request. Use `reconnect({ apiToken })` afterwards.
 */
export async function registerIdentity(
  relay: AgentRelay,
  name: string,
  type: 'agent' | 'human' | 'system',
  metadata: Record<string, unknown> = {},
): Promise<{ client: RelayAgentClient; token: string }> {
  const client = await relay.workspace.register({ name, type, metadata });
  if (!client.token) throw new Error(`No agent token returned for ${name}`);
  return { client, token: client.token };
}

export function reconnectIdentity(relay: AgentRelay, apiToken: string): Promise<RelayAgentClient> {
  return relay.workspace.reconnect({ apiToken });
}

// ---------------------------------------------------------------------------
// 3. Fleet: list nodes, targeted spawn, status, release

export async function listOnlineNodes(relay: AgentRelay): Promise<RelayNode[]> {
  const nodes = await relay.nodes.list();
  return nodes.filter((n) => n.status === 'online' && n.live !== false);
}

export interface SpawnRequest {
  node: string;          // fleet node name (the broker name the VM ran `node up` with)
  name: string;          // workspace-unique agent name, e.g. agent-t1a2-backend
  cli: 'claude' | 'codex' | 'gemini' | 'opencode' | 'muse' | 'devin';
  task: string;          // <= 14,336 UTF-8 bytes for PTY harnesses
  cwd?: string;          // ABSOLUTE existing directory on the node
  channel?: string;      // channel name without '#'
  model?: string;
  waitForReady?: boolean; // default true: block until the harness proves readiness
}

/**
 * Targeted spawn, same wire call `agent-relay fleet spawn --node` makes
 * (packages/cli/src/cli/commands/fleet.ts). Requires an AGENT token, because it
 * is an action invocation (POST /v1/actions/{name}/invoke is agent-token only).
 */
export async function spawnOnNode(cfg: RelayConfig, dispatcherToken: string, req: SpawnRequest): Promise<RelaySpawnPlacementAck> {
  const asDispatcher = new AgentRelay({ agentToken: dispatcherToken, baseUrl: cfg.baseUrl });
  const confirm = req.waitForReady ?? true;
  return asDispatcher.messaging.placement.spawn({
    capability: `spawn:${req.cli}`,
    node: req.node,
    failFast: true,
    confirm,
    ...(confirm ? { confirmTimeoutMs: 360_000 } : {}), // CLI default; must be >= 95,000
    input: {
      name: req.name,
      cli: req.cli,
      task: req.task,
      ...(req.channel ? { channels: [req.channel] } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.cwd ? { worker_cwd: req.cwd } : {}),
    },
  });
}

/** Map a placement failure to something our Terse outbox can act on. */
export function classifySpawnError(error: unknown):
  | { kind: 'retryable'; code: string; invocationId?: string }
  | { kind: 'maybe_running'; code: string; invocationId?: string }
  | { kind: 'failed'; code: string; message: string; invocationId?: string } {
  if (error instanceof RelayError) {
    // e.g. targeting a node name the workspace has never seen -> "Node not found" (not a RelayPlacementError)
    return error.retryable
      ? { kind: 'retryable', code: `${error.code}:${error.status}` }
      : { kind: 'failed', code: `${error.code}:${error.status}`, message: error.message };
  }
  if (!(error instanceof RelayPlacementError)) {
    return { kind: 'failed', code: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
  const base = error.invocationId ? { invocationId: error.invocationId } : {};
  switch (error.code) {
    case 'spawn_unconfirmed':
      // Node accepted but no terminal result inside the budget. Do NOT respawn; poll getInvocation.
      return { kind: 'maybe_running', code: error.code, ...base };
    case 'spawn_retryable':
    case 'node_unavailable':
    case 'no_eligible_node':
      return { kind: 'retryable', code: error.code, ...base };
    default:
      return { kind: 'failed', code: error.code, message: error.message, ...base };
  }
}

/** Read an earlier spawn back without launching another (what `fleet spawn-status` does). */
export async function getSpawnInvocation(cfg: RelayConfig, dispatcherToken: string, invocationId: string) {
  const asDispatcher = new AgentRelay({ agentToken: dispatcherToken, baseUrl: cfg.baseUrl });
  return asDispatcher.messaging.commands.getInvocation('spawn', invocationId);
}

/** Release a worker (what `fleet release` does). deleteAgent frees the name for reuse. */
export async function releaseWorker(cfg: RelayConfig, workspaceKey: string, name: string, reason: string, deleteAgent = false) {
  const ws = createWorkspaceClient({ workspaceKey, baseUrl: cfg.baseUrl });
  return ws.agents.release({ name, reason, deleteAgent });
}

// ---------------------------------------------------------------------------
// 4. Messaging as a human identity

/**
 * The SDK requires an agent token for channels.create/join/invite and for every
 * send (RelaycastMessagingClient.requireAgentClient), even though the REST API
 * accepts the workspace key for POST /channels. So act through an identity.
 */
export async function ensureChannel(actor: RelayAgentClient, name: string, topic?: string): Promise<void> {
  const existing = await actor.channels.list();
  if (!existing.some((c) => c.name === name)) {
    await actor.channels.create({ name, ...(topic ? { topic } : {}) });
  }
}

/** `to`: '#channel', '@agent' (DM) or ['@a','@b'] (group DM). Idempotency key = our message row id. */
export function sendAsUser(user: RelayAgentClient, to: string | string[], text: string, idempotencyKey: string): Promise<RelayMessage> {
  return user.sendMessage({ to, text, idempotencyKey });
}

export function replyAsUser(user: RelayAgentClient, messageId: string, text: string, idempotencyKey: string): Promise<RelayMessage> {
  return user.reply({ messageId, text, idempotencyKey });
}

// ---------------------------------------------------------------------------
// 5. Observer stream for the UI (server-side; fan out over our own SSE/WS)

export async function mintObserverToken(cfg: RelayConfig, workspaceKey: string, name: string): Promise<string> {
  const minted = await createObserverToken({
    workspaceKey,
    name, // must be unique per workspace
    baseUrl: cfg.baseUrl,
    scopes: ['stream:read', 'messages:read', 'threads:read', 'dms:read', 'channels:read', 'agents:read', 'nodes:read', 'deliveries:read', 'activity:read'],
    filters: { includeDms: true }, // DMs are excluded unless asked for
  });
  if (!minted.token) throw new Error('Observer token material missing (it is only returned on create)');
  return minted.token;
}

export type UiEvent =
  | { kind: 'message'; type: RelayMessagingEvent['type']; message: RelayMessage; channel?: string; conversationId?: string; parentId?: string }
  | { kind: 'lifecycle'; sourceType: string; raw: unknown }
  | { kind: 'other'; type: string };

/**
 * Durable-log backfill + live /v1/ws stream, deduped by seq. Persist the cursor
 * (onCursor) and pass it back as sinceSeq after a restart to resume gap-free.
 * Lifecycle frames (agent.exited, node.status.*, action.completed,
 * agent.status.*, delivery.*) are not normalized by the SDK; they arrive as
 * type 'unknown' with the raw frame.
 */
export function startObserver(
  cfg: RelayConfig,
  observerToken: string,
  onEvent: (e: UiEvent) => void,
  opts: { sinceSeq?: number; onCursor?: (seq: number) => void; onError?: (err: unknown) => void } = {},
): RelayMessagingEventsSurface {
  const source = createObserverEventSource({
    observerToken,
    baseUrl: cfg.baseUrl,
    ...(opts.sinceSeq !== undefined ? { sinceSeq: opts.sinceSeq } : {}),
    ...(opts.onCursor ? { onCursor: opts.onCursor } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
  source.on('any', (event) => {
    switch (event.type) {
      case 'messageCreated':
      case 'messageUpdated':
        onEvent({ kind: 'message', type: event.type, message: event.message, channel: event.channel });
        return;
      case 'threadReply':
        onEvent({ kind: 'message', type: event.type, message: event.message, channel: event.channel, parentId: event.parentId });
        return;
      case 'dmReceived':
      case 'groupDmReceived':
        onEvent({ kind: 'message', type: event.type, message: event.message, conversationId: event.conversationId });
        return;
      case 'unknown':
        onEvent({ kind: 'lifecycle', sourceType: event.sourceType ?? 'unknown', raw: event.raw });
        return;
      default:
        onEvent({ kind: 'other', type: event.type });
    }
  });
  source.connect();
  return source;
}
```

Flow (from `e2e.ts`, condensed):

```ts
const cfg = { baseUrl: process.env.RELAY_BASE_URL! };
const { relay, workspaceKey } = await createTeamWorkspace(cfg, `team-${teamId}`);           // store key encrypted
const dispatcher = await registerIdentity(relay, 'platform-dispatcher', 'system');          // store token
const saam = await registerIdentity(relay, 'saam', 'human', { githubLogin: 'saam' });       // store token
await ensureChannel(dispatcher.client, 'project', 'Shared decisions');
const observer = startObserver(cfg, await mintObserverToken(cfg, workspaceKey, 'ui-backend'), pushToSse, { sinceSeq, onCursor });
for (const [node, role] of [['vm-alice', 'backend'], ['vm-bob', 'frontend']]) {
  try {
    await spawnOnNode(cfg, dispatcher.token, { node, name: `agent-t1-${role}`, cli: 'claude', task: brief(role), channel: 'project', cwd: '/home/dev/work/repo' });
  } catch (err) { await outbox.record(classifySpawnError(err)); }                           // then reconcile (4.3)
}
await sendAsUser(saam.client, '#project', 'Kickoff: build Stripe checkout', msgRowId);
```

Bun notes: Bun has a global `WebSocket` that accepts a `headers` option, which the observer source uses [src: observer-source.ts L108-L118; live under Bun 1.4.4]. Set `AGENT_RELAY_TELEMETRY_DISABLED=1` in the backend env if we do not want SDK telemetry headers.

---

## 11. Spec corrections

Section 7, line by line:

1. "One Relay workspace per team/project" → fine. But know that the workspace key is shared with every VM and every agent (section 9), so the workspace is the only security boundary.
2. "On each VM, install Agent Relay, enroll a named node, run its agent runtime as the intended Linux user" → mostly right. **There is no separate enroll command in the workspace-key flow**; `agent-relay node up --broker-name <node>` with `RELAY_WORKSPACE_KEY` mints the node itself. `agent-relay cloud enroll --token` is the Cloud-account flow. Run from a dedicated directory, not the repo (3.5).
3. "Nodes attach to the central Relaycast engine over WebSocket. Engine ... replays unacknowledged deliveries." → correct (`/v1/node/ws`, cumulative acks, replay through `/deliveries`). Add: delivery into the CLI happens at the agent's next idle boundary by default (`mode: 'wait'`), and is at-least-once to the node, not exactly-once.
4. "targeted fleet spawn with --node, --name, --task, --cwd, --channel" → flags exist. Corrections: `--cwd` must be an **absolute existing path on the node** (not relative); fleet requires exactly one of `--task` / `--task-file`; the CLI path needs a workspace key or agent token and mints a throwaway launcher identity per call. From our backend use the SDK (`messaging.placement.spawn`) with a dispatcher agent token instead of shelling out. Confirmation must be on to get real start evidence.
5. "Local worker control: agent-relay node agent spawn/list/release" → exists, but it hits the broker's loopback API, so only via `vm.exec` on that VM.
6. "inject Relay MCP tools into supported CLIs (send_dm, post_message, check_inbox, list_agents, reply_to_thread)" → names correct, injection is automatic for broker-spawned agents. Add: agents also get `spawn`/`add_agent`, and run with permission-bypass flags.
7. "Relay observer/read-only event stream ... Never put workspace/node credentials in the browser. Node message delivery and observer stream are different connections." → correct. Add: use `createObserverEventSource` directly, the SDK's `addListener` drops lifecycle events.
8. "UI ... keeps true Relay message IDs and threading" → doable: `messageId`, `threadId`/`parentId`, `conversationId` are on every event.
9. "Agent identity: agent-<taskShort>-<role>@<node>" → the engine already gives `address = <name>@<node>`. The name part must be unique workspace-wide, can't reuse a node name (the broker registers an agent with the node's name), and a released name stays taken unless released with `deleteAgent`. So include the lease epoch: `agent-<taskShort>-<role>-e<epoch>`.

Elsewhere:

- Section 14 links `https://agentrelay.com/docs/architecture`, `/docs/workspaces`, `/docs/fleet-setup` return **404**. Current sources: `https://agentrelay.com/llms-full.txt`, `/docs/markdown/relaycast-api.md`, `/docs/markdown/agent-relay-mcp.md`, and the repo's `docs/quickstart.md` and `docs/self-hosting/README.md`.
- Section 1 table says Agent Relay owns "agent-node identity ... lifecycle, targeted agent spawn" → right, but Relay spawn status is not trustworthy as a single signal (4.3). The worker monitor must reconcile with node live-agents and `agent.exited`.
- Section 3 step 5 "register supported harnesses" → this is `AGENT_RELAY_NODE_HARNESSES`. The default advertises six harnesses whether or not they are installed.
- Section 8 "Install Relay + Git tooling in a pre-login snapshot" → fine only if `node up` never ran before the snapshot (3.6), otherwise clones share a node id.
- Section 2 "should not broadcast login sessions or credentials into ... other VMs" → Relay itself broadcasts the workspace key to every VM and agent. Provider logins stay local, Relay credentials do not.

---

## 12. Gaps and risks for a 5-hour build

Ranked by how likely they are to bite during the demo:

1. **Harness readiness on Freestyle.** The verified spawn waits for the broker to prove the harness is ready (up to 90 s after launch). If `claude` shows a first-run screen (trust folder, theme, login) in a PTY, readiness or task injection (`prompt_unproven` after 15 s) can fail. Smoke test one real `claude` and one `codex` spawn on a logged-in Freestyle VM first thing. **UNVERIFIED here** (no real CLI was launched).
2. **PATH/user mismatch.** The broker inherits the PATH of whatever started it. Under systemd or `vm.exec`, `claude`/`codex` may not be on PATH, or the login lives under a different user. `TODO(saam):` which user and install path does the Freestyle image use for claude/codex?
3. **Spawn status lies in edge cases** (4.3). Build reconcile from day one: names from lease ids, read live-agents + `agent.exited`.
4. **Hosted free-tier limits unknown.** Have `RELAY_BASE_URL` switchable to a self-hosted engine (standalone binary, about 1 minute to start, verified here).
5. **Workspace key everywhere + bypass flags** (section 9). Fine for a single-team demo; a real security issue for "team of 50". `TODO(saam):` accept one workspace per team as the trust boundary, or do we need per-engineer isolation (which Relay does not give us)?
6. **Snapshot cloning duplicates node identity** (3.6).
7. **Pause/resume timings** are unverified (8). Show "uncertain" in the UI until `node.status.online` and live-agents agree.
8. **Task size**: 14,336 bytes max for PTY task injection. Handoff packages (spec 3, recovery step 5) must go through Git or a file on the VM, with a short Relay message pointing at it.
9. **Self-host only:** anonymous workspace creation is open; in-memory idempotency resets on restart.
10. **Token rotation on register**: calling `workspace.register` twice for the same name silently kills the first token. Register once per identity, persist, then `reconnect`.

Minimal build order that fits 5 hours:
1. Backend: create workspace (hosted), register dispatcher + humans, mint observer token, observer → SSE. (Sketch above, about 1 hour.)
2. VM bootstrap: install script + `node up` as the CLI user with `AGENT_RELAY_NODE_HARNESSES=claude` (or `codex`), health check via `nodes.get`.
3. Spawn two workers on two nodes in `#project`, render events, send a user message.
4. Reconcile loop + `agent.exited` → Terse transitions.

---

## 13. Source index

Installed (`backend/node_modules`):
- `@agent-relay/sdk/dist/agent-relay.d.ts` (AgentRelay, observer mode options), `facade.d.ts` (register/reconnect/sendMessage/reply), `listeners.d.ts` (public event union), `messaging/types.d.ts` (RelayMessaging, placement input/ack, events), `messaging/thin-client.d.ts` (createWorkspaceClient, createObserverToken, scopes), `messaging/observer-source.d.ts`, `messaging/relaycast-placement.d.ts` (RelayPlacementError), `dist/messaging/relaycast.js` (`requireAgentClient` list)
- `@relaycast/types/dist/events.d.ts`, `subscription.js`, `agent.js`
- `agent-relay/package.json` (bins `agent-relay`, `relay`), `@agent-relay/broker-darwin-arm64`

GitHub `AgentWorkforce/relay`:
- `packages/cli/src/cli/commands/fleet.ts`, `node.ts`, `core.ts`, `init.ts`, `workspace.ts`, `cloud.ts`, `local-agent.ts`, `observer.ts`
- `packages/cli/src/cli/mcp/messaging-tools.ts`, `mcp/workspace.ts`, `mcp/action-tools.ts`, `agent-relay-mcp.ts`
- `packages/sdk/src/messaging/relaycast.ts` (placement.spawn), `observer-source.ts`, `normalize.ts`, `thin-client.ts`
- `crates/broker/src/runtime/init.rs`, `runtime/fleet.rs`, `runtime/relaycast_events.rs`, `node_control.rs`, `worker.rs`, `snippets.rs`
- `docs/quickstart.md`, `docs/self-hosting/README.md`, `docs/harnesses/injection.md`, `install.sh`, `TELEMETRY.md`, `LICENSE`

Docs:
- `https://agentrelay.com/llms-full.txt` (Introduction, Sessions, For agents, Relaycast API, Agent Relay MCP)
- `https://github.com/AgentWorkforce/relaycast/blob/main/docs/self-hosting.md`
