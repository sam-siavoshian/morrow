# Unified Agent Workforce: product + architecture spec

Source: Saam. Verbatim except formatting. Referenced SVGs (unified_agent_workforce_architecture.svg, unified_agent_workforce_ux.svg) were not provided.

## Vision

A coding platform where teams share subscriptions, their agents work together at the same time and communicate, no agent is isolated, it works with any harness, login is easy, and it is a multiplayer AI environment where each person's AI is not isolated, with beautiful UI/UX.

Cloud VM platform with subscription sharing between team members, strong agent communication via Agent Relay, infrastructure built on Terse.

Design direction:
- Dreamy cloud look, fonts, animations: Zephium (github.com/zephium-browser/website, github.com/zephium-browser/Zephium). Read the code, never guess.
- UX and features: t3code (github.com/pingdotgg/t3code). Main chat box behavior, sidebar, icons, favicons, shortcuts, style, user flow.
- Micro UI: opencode (github.com/anomalyco/opencode). Dot art, ASCII art, the 4x4 pixel radar in the header of a new tab, micro details.
- Runtime: Bun.

## Decisions (from Saam)

- Scope: the full product (sections 3-12), not only the section 13 demo. Everything must really work.
- Accounts: no vendor keys yet. Build everything against the vendor docs; real integrations behind config, activated when keys arrive.
- Account model: a team of 2 or 50 adds as many coding-CLI accounts as they own, each attached to a VM under their name. We manage and route across them: a bank / load balancer for subscriptions plus a unified coding and agent-communication platform.
- Auth: GitHub OAuth, encrypted httpOnly session cookie, team and membership stored in a Terse actor. No separate database.

## Core thesis

An engineering team's separately authenticated coding-agent environments become one coordinated workforce. Agents collaborate in parallel when useful, and unfinished work can continue on another available worker when one CLI becomes unavailable.

## 1. System boundary and ownership

| Component | Owns | Does not own |
|---|---|---|
| Our Next.js application | team membership, UX, user permissions, task intake, event aggregation | model-provider login secrets |
| Our planner | task breakdown, worker-count decisions, suitability and usage heuristics, placement intent | raw agent chat transport or PTY implementation |
| Terse TeamWorkforce actor | authoritative task state, atomic claims, leases, cooldown deadlines, change notifications, retry clocks | actual agent execution and model token accounting |
| Agent Relay / Relaycast | agent-node identity, channels/DMs/threads, message delivery, lifecycle, targeted agent spawn | Git source syncing and optimum workforce size |
| Freestyle | VM lifecycle, Ubuntu environment, filesystem, interactive PTYs, per-VM scoped client access | agent message routing and shared task state |
| Git remote + CI | isolated branches, durable code checkpoints, merges, tests, previews | chat memory, provider quotas |
| Worker monitor (ours) | per-CLI health, quota-error classification, context/checkpoint summaries, heartbeat | authoritative remaining-token values not exposed by provider |

Important distinction: VM, coding account, agent session and task assignment are different resources. One persistent VM may hold several distinct authenticated CLI profiles and may host more than one agent session. A model quota error affects the specific account/profile, not automatically every worker on the VM.

## 2. Terminology and identities

- Team: organization boundary for membership and approval.
- Project: one linked Git repository, Relay workspace and associated Terse actor instance.
- VM: persistent Freestyle Linux machine, owned by an engineer or explicitly delegated environment.
- RelayNode: Agent Relay enrolled runtime/provider attached to that VM and the team's messaging workspace.
- CLIProfile: one locally authenticated coding CLI + account on a VM (Claude Code, Codex, etc.). Tracks authStatus, availability, cooldownUntil and permitted task scope independently.
- Worker: one live CLI agent session, with a model/harness, Relay identity, task/branch, capacity lease and optional subordinate local agents.
- Task: a user objective with acceptance criteria; decomposed into workstreams only when parallelism is valuable.
- Lease: Terse reservation of a CLIProfile / worker slot for a task, with expiry and fencing token.

Each engineer must retain private terminal/auth access controls. The team-wide service can coordinate work submitted to authorized workers, but it should not broadcast login sessions or credentials into chat, Git, telemetry, or other VMs.

## 3. Product UX: user journey

### First-run setup
1. User signs into our app and creates/joins a team.
2. User connects a GitHub repository and chooses a team Relay workspace.
3. User chooses "Add my coding environment." Backend calls Freestyle to provision a persistent Ubuntu VM (from a clean prebuilt image) or attaches an authorized existing VM.
4. Browser displays a real PTY behind our authenticated terminal gateway, or a Freestyle identity-scoped client path. User runs claude/codex interactive login there. OAuth/session artifacts remain on VM disk under the correct Linux user.
5. Bootstrap Agent Relay onto the VM, enroll its node into the shared team workspace, start its agent runtime, register supported harnesses.
6. Health checks verify relay node online, CLI launchable, account authenticated (best effort) and Git checkout ready. User sees a Ready state per CLIProfile.

### Main workspace / daily use
1. One prompt area: "Build Stripe checkout and webhook flow, with tests."
2. Planner examines the repository, code boundaries, requested urgency, available profiles, and previous context. Proposes a small number of useful concurrent workstreams, often 1-3, rather than maximizing agent count.
3. UI explains why each worker was chosen (e.g. frontend/backend can run independently; testing is gated until code exists). Human may cap worker count or choose an agent.
4. On Start, Terse reserves capacity and records the plan. Dispatcher asks Agent Relay for targeted spawns on selected nodes. Relay nodes start existing authenticated CLIs on their VMs.
5. Live screen shows agent topology (machine and harness), peer conversations, active branches/commits, tests, terminal inspect (permission-gated), preview, and capacity/cooldown states.
6. Agents contact each other directly using Relay DMs, channels and threads. User may send instructions to the team or a specific worker from the UI.
7. Completion requires code/artifact verification, not just a DONE message. UI shows integrated PR, tests, preview and unresolved issues.

### Interruption and recovery
1. Worker hits provider usage limit, exits, loses auth or becomes unreachable.
2. Worker monitor emits a structured event to our backend, which applies an idempotent transition in Terse.
3. Terse marks that specific CLIProfile unavailable, expires/retires its lease, and leaves independent teammates running.
4. Replan: first check if an existing working agent can absorb the task without harming its commitments; otherwise select one authorized ready profile on a different node. Do not automatically fill every available worker slot.
5. Build a handoff package from the latest committed checkpoint, task requirements, relevant decisions, changed files, tests and TODOs. Relay sends a task-specific handoff; Git transfers the actual code state.
6. Replacement agent checks out the branch/worktree and reports a task acknowledgement. Terse transitions the reservation and, eventually, verified completion.
7. An alarm or availability check reconsiders the exhausted CLI after its reset. The worker is not automatically reintroduced into an already-stable task.

## 4. Initial UI information architecture

Nav: Team / Project / Workforce / Activity / Settings.

Workforce: list of engineer-owned VMs, each containing one or more CLI cards (provider, auth, running sessions, estimated capacity, cooldown, permitted scopes); buttons "Open private terminal," "Pause VM if idle," "Disconnect." Distinguish VM power status from per-CLI account status.

Task composer: natural language prompt, Git branch/repo, Auto or Manual workforce, max parallel agents, optional per-task budget, acceptance criteria; planner explanation before starting.

Mission control: left agent topology, center Agent Relay live messages (filter channels/DMs/threads), right branch/test/preview panel, bottom task timeline and current decision trace. Clicking a worker opens its terminal (only if permitted), logs and task context.

Recovery view: failure event -> checkpoint reference -> selected replacement and reason -> agent ACK -> completed verification. Never suggest an account has a precise token balance if the CLI does not expose it.

## 5. Data plane vs control plane

Control plane (our app + planner + Terse) chooses who, how many, where, when. Communication plane (Relaycast + node runtime) carries direct agent communication and spawn/delivery status. Execution plane (Freestyle + authenticated CLI) runs shell/model work. Code plane (Git + CI) moves versioned code and proves correctness.

Peer interaction is not centrally scripted. Agents negotiate interfaces, ask questions, report changes, review related patches via Relay. Collaboration is triggered by useful events and dependencies; continuously broadcasting tokens wastes capacity.

Event protocol (our own schema, not a vendor API):

```ts
type WorkEvent = {
  id: string;                 // idempotent event id
  teamId: string;
  projectId: string;
  taskId?: string;
  workerId?: string;
  cliProfileId?: string;
  epoch?: number;              // fencing generation
  type:
    | "task.created" | "task.planned" | "worker.reserved"
    | "worker.ready" | "worker.blocked" | "worker.quota_limited"
    | "worker.offline" | "task.checkpointed" | "task.handoff_requested"
    | "task.handoff_acked" | "task.verified" | "worker.capacity_restored";
  data: Record<string, unknown>;
  at: string;
};
```

Avoid exactly-once illusions: Terse may make a state transition atomic, but a network call to spawn a worker and a Git commit are external side effects. Use a reservation/outbox record, durable request ID, idempotent retry, and reconcile Relay spawn status. A successful dispatch request is not proof that the agent is ready.

## 6. Terse actor model

Instances:
- TeamWorkforce(teamProjectId): authoritative assignments, ready/cooldown profile map, task states, limits, lease generation and alarm schedule.
- Optional later: TaskSession(taskId) for large or long-lived tasks. Not needed for the hackathon.

| Method | Transition |
|---|---|
| registerProfile(profile) | records a CLI profile and ownership |
| proposePlan(task, constraints) | records candidate task/workstreams; planner may run outside actor |
| reserveWorkers(taskId, targets, key) | atomic validation + fenced leases; rejects unavailable/duplicate claims |
| recordSpawnStatus(leaseId, eventId, status) | pending -> started / failed, idempotently |
| reportCheckpoint(taskId, sha, summary) | persists latest durable continuation reference |
| markProfileLimited(profileId, until, eventId) | cooldown + revoke future claims; trigger replan |
| requestHandoff(taskId, leaseEpoch) | creates pending replacement; no external calls inside transition |
| ackHandoff(taskId, replacementLease) | transfers ownership only after agent ACK |
| completeAndVerify(taskId, evidence) | verified result; releases claims |
| onAlarm() | due cooldowns/retries trigger reconciliation |

Use Terse @Persisted, @Atomic, @Emittable, actor WebSockets, and onAlarm. Reassign persisted objects/arrays rather than mutating nested fields in place. Do not indiscriminately use @Interleave on methods whose atomic transitions depend on serialization.

Terse stores concise task/assignment state, not every message, terminal byte, auth token or the codebase. Agent Relay and Git own those.

## 7. Agent Relay topology

- One Relay workspace per team/project (depending on isolation policy).
- On each VM, install Agent Relay, enroll a named node, run its agent runtime as the intended Linux user (the one with access to that CLI's authenticated profile).
- Nodes attach to the central Relaycast engine over WebSocket. Engine delivers messages to node-owned agent sessions and replays unacknowledged deliveries.
- Multi-machine dispatch: targeted fleet spawn with --node, --name, --task, --cwd, --channel. Local worker control: agent-relay node agent spawn/list/release.
- Autonomous collaboration: inject Relay MCP tools into supported CLIs (send_dm, post_message, check_inbox, list_agents, reply_to_thread).
- Relay observer/read-only event stream for live activity view. Never put workspace/node credentials in the browser. Node message delivery and observer stream are different connections.

Channels: #project for shared decisions; task threads for requirements/bugs; DMs for direct dependencies. UI merges into a timeline but keeps true Relay message IDs and threading.

Agent identity: agent-<taskShort>-<role>@<node> or stable equivalent; bound to task and node. Map to our workerId.

## 8. Freestyle VM topology

- Persistent Ubuntu VM per contributing environment, with one or more authenticated CLI profiles on disk.
- Provision via freestyle.vms.create from a clean Freestyle Ubuntu base image (includes claude, codex and other coding agents). Install Relay + Git tooling in a pre-login snapshot.
- Terminals via Freestyle PTY; bridge its server-authenticated WebSocket through our backend terminal proxy or a scoped identity-token mechanism, enforcing user access.
- vm.exec for short setup/health commands; long-running sessions use Relay's PTY runtime / Freestyle PTY, not vm.exec (5-minute max timeout).
- Track VM running/paused independently from CLI ready/busy/cooldown.
- Pause only when no active CLI session, broker activity or required task uses the VM. Pausing freezes memory and processes and makes the Relay node offline; on resume, wait for broker reconnect and health checks.
- VM snapshots must not replicate authenticated profiles across engineers.

## 9. Git, code ownership and context

- All workers clone the same repo into separate worktrees or feature branches.
- Planner assigns initial file/subsystem ownership. Shared-file edits get negotiated via Relay and recorded in coordination state first.
- Git remote is the canonical checkpoint. Commit/push meaningful progress periodically, not only at a quota error.
- Handoff = branch + SHA + acceptance criteria + decisions + changed files + outstanding tests + errors. New worker fetches/checks out, confirms context, sends ACK.
- A designated integrator (can be an existing worker) merges and runs tests. No separate integrator until needed.
- A Relay message is not a code transfer. Git moves the bytes.

## 10. Adaptive scheduler

Hard constraints: VM alive, node online, suitable CLI installed, auth valid, account not in cooldown, owner permissions, per-CLI concurrency, task cap, project policy, node capacity, worktree isolation.

Incremental sizing:
1. Read task and repo context.
2. Propose independent, testable workstreams (often one).
3. Start with minimum capable worker set.
4. For each extra agent estimate: saved time + new skill coverage + risk reduction - duplicated context reads - coordination burden - merge risk - expected usage.
5. Add only if net positive and isolatable. Keep unused profiles on standby.
6. Re-evaluate only at meaningful events: blocker, completed dependency, usage error, agent unavailable, new parallel work, integration.
7. Consolidate down when parallel work is gone.

First demo: transparent heuristics (1 agent for tiny change, 2 for separable full-stack, 3 only with an independently useful test/integration stream). Do not claim optimal efficiency without benchmarks.

Capability scoring per CLIProfile, not per VM: tooling, task fit, loaded context, readiness, capacity estimate, startup time, past success, cost/usage risk.

Quota signals: CLI error output, provider status commands, recent failures, reset time if exposed, manual override, conservative fallback. Show ready / limited / estimated capacity, never invented precision.

## 11. Failure semantics

| Fault | Detection | Action |
|---|---|---|
| Provider usage limit | CLI error classifier + health probe | cooldown only affected profile; checkpoint/handoff if incomplete |
| CLI auth expired | login/error classifier | mark auth_required; notify owner; do not route blindly |
| Agent process dies | Relay lifecycle + timeout | reconcile lease, use latest checkpoint, reassign if justified |
| Relay node disconnects | node liveness TTL | mark uncertain, attempt reconnection; avoid immediate duplicate execution |
| Freestyle VM paused | Freestyle lifecycle state | no new work, resume if needed, wait for node and CLI readiness |
| Terse restart | persisted actor restore | replay pending outbox/reconciliation; fence old reservations |
| Duplicate network event | event ID / lease epoch | idempotently ignore |
| Git merge conflict | integration / CI | ask relevant live agents to resolve; no unlimited reviewers |

Leases and fencing are essential. A reappearing disconnected worker's old lease must not overwrite a newer worker's output. Coordinator validates task generation and branch ownership before accepting completion.

## 12. Minimal platform APIs (illustrative)

```
POST   /api/teams
POST   /api/projects                  # link repo + Relay workspace
POST   /api/environments              # provision Freestyle VM
POST   /api/environments/:id/terminal # scoped PTY gateway/session
POST   /api/environments/:id/profiles # register CLI account, no credential transfer
GET    /api/workforce                 # flattened VM, profiles, Relay node status
POST   /api/tasks                     # store objective, plan task
POST   /api/tasks/:id/start           # atomic Terse reserve + Relay dispatch
POST   /api/tasks/:id/message         # message appropriate Relay identities
POST   /api/events/worker             # signed worker monitor / Relay callbacks
GET    /api/tasks/:id/events          # BFF SSE/WS stream for mission control
GET    /api/tasks/:id/artifacts       # PR, tests, commit, preview refs
```

Signed server-originated events, per-team authorization, idempotency keys. Never accept a raw worker.quota_limited event from a browser client as authoritative.

## 13. Hackathon scope

Must work live:
- Two Freestyle VMs with one authenticated CLI each, separate Agent Relay nodes in one Relay workspace.
- Real task split into two parallel workstreams. They exchange at least two genuinely useful Relay messages and produce code on separate branches.
- Terse atomic reservation with visible ready -> busy -> completed state.
- Git checkpoint/commit, integration and test result.
- Simulated or real quota-limit event moves one profile to cooldown, creates one non-duplicative handoff to an available profile, continues from actual code.
- Dashboard showing task, agents, conversations, commits and handoff reason.

Skip: universal provider login, accurate global token meter, billing, dozens of agent accounts, autonomous arbitrary repo merge, per-agent long-term memory, production GKE Terse deploy, deep multi-tenant security audit, native IDE, predictive optimal agent selection.

If integration fails: prioritize real Relay cross-VM communication + real Freestyle sessions; use Terse for a tiny real actor state machine rather than claiming a fake integration. Never present a scripted event as a measured provider quota.

## 14. Documentation references

- Agent Relay architecture: https://agentrelay.com/docs/architecture
- Agent Relay workspaces: https://agentrelay.com/docs/workspaces
- Agent Relay fleet setup: https://agentrelay.com/docs/fleet-setup
- Agent Relay targeted spawn: https://github.com/AgentWorkforce/relay/blob/main/packages/cli/src/cli/commands/fleet.ts
- Agent Relay messaging SDK: https://github.com/AgentWorkforce/relay/blob/main/packages/sdk/src/messaging/thin-client.ts
- Freestyle VMs: https://www.freestyle.sh/docs/vms
- Freestyle PTY: https://www.freestyle.sh/docs/vms/pty
- Freestyle client identities: https://www.freestyle.sh/docs/vms/client-sessions
- Freestyle lifecycle: https://www.freestyle.sh/docs/vms/lifecycle
- Terse TypeScript reference: https://github.com/TerseAI/durable-actors/blob/main/docs/reference/typescript-guide.md
- Terse examples: https://github.com/TerseAI/durable-actors/tree/main/examples
