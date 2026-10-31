import { describe, expect, test } from "bun:test";
import {
  RelayError,
  RelayPlacementError,
  type RelayMessage,
  normalizeMessagingEvent,
  type ObserverEventSourceOptions,
  type RelayMessagingEventsSurface,
  type RelayNode,
} from "@agent-relay/sdk";
import { CliKind, RelayEventView, ServerFrame, type RelayMessageView } from "@morrow/contracts";
import {
  ExitLedger,
  MAX_TASK_BRIEF_BYTES,
  RelayConfigError,
  RelayIntegrationError,
  TeamRelayObserver,
  classifySpawnError,
  conventionKind,
  createSenderKindResolver,
  decideWorkerState,
  humanAgentName,
  initialReconcileMemo,
  isConclusiveExit,
  isHandoffAck,
  loadRelayConfig,
  nodeHealthFrom,
  parseLifecycle,
  parseRelayBaseUrl,
  projectChannelName,
  READ_ONLY_ARGS,
  BRIDGED_HARNESS,
  RELEASE_ABSENCE,
  reconcileWorker,
  spawnPlacementInput,
  validateSpawnRequest,
  WATCH_ABSENCE,
  workerAgentName,
  workspaceNameFor,
  type RelayReader,
} from "../../src/integrations/relay/index.ts";
import { markFromEvent, messageEventContext, messageToView } from "../../src/integrations/relay/normalize.ts";
import frames from "../fixtures/relay/frames.json";

describe("config", () => {
  test("defaults to hosted and validates", () => {
    expect(loadRelayConfig({}).baseUrl).toBe("https://cast.agentrelay.com");
    expect(loadRelayConfig({ RELAY_BASE_URL: " " }).baseUrl).toBe("https://cast.agentrelay.com");
    expect(loadRelayConfig({ RELAY_BASE_URL: "https://relay.example.com/" }).baseUrl).toBe("https://relay.example.com");
    expect(parseRelayBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(parseRelayBaseUrl("http://127.0.0.1:8787/x//")).toBe("http://127.0.0.1:8787/x");
    for (const bad of ["http://relay.example.com", "ftp://x", "https://u:p@x.com", "https://x.com/?token=1", "https://x.com/#a", "nope"])
      expect(() => parseRelayBaseUrl(bad)).toThrow(RelayConfigError);
  });
});

describe("names", () => {
  test("worker names are lease-unique and disjoint from nodes and humans", () => {
    expect(workerAgentName("ab12", "backend", 7)).toBe("w-ab12-backend-e7");
    expect(() => workerAgentName("AB", "x", 1)).toThrow(RelayIntegrationError);
    expect(() => workerAgentName("ab", "x", 0)).toThrow(RelayIntegrationError);
    expect(() => workerAgentName("ab", "x_y", 1)).toThrow(RelayIntegrationError);
    expect(humanAgentName("Saam-Dev")).toBe("h-saam-dev");
    for (const bad of ["-x", "x-", "a--b", "a b", "a".repeat(40), ""]) expect(() => humanAgentName(bad)).toThrow(RelayIntegrationError);
    expect(projectChannelName("p1")).toBe("proj-p1");
    expect(workspaceNameFor("t-abc")).toBe("morrow-t-abc");
    expect(() => workspaceNameFor("t/abc")).toThrow(RelayIntegrationError);
  });
});

describe("spawn validation", () => {
  const ok = { name: "w-ab-be-e1", node: "n-env1", cli: "claude", task: "do it", channels: ["proj-p1"], workerCwd: "/home/u/work/r/b" };
  test("accepts a good request", () => {
    expect(validateSpawnRequest(ok).channels).toEqual(["proj-p1"]);
    expect(validateSpawnRequest({ ...ok, channels: ["#proj-p1", "proj-p1"] }).channels).toEqual(["proj-p1"]);
  });
  test("a subagent joins no channel and may be read-only; readOnly only passes through when true", () => {
    expect(validateSpawnRequest({ ...ok, channels: [] }).channels).toEqual([]);
    expect(validateSpawnRequest({ ...ok, channels: [], readOnly: true })).toMatchObject({ channels: [], readOnly: true });
    expect(validateSpawnRequest({ ...ok, readOnly: false })).not.toHaveProperty("readOnly");
    for (const cli of ["claude", "codex", "opencode"]) expect(validateSpawnRequest({ ...ok, cli, readOnly: true }).readOnly).toBe(true);
  });
  test("rejects bad names, cwd, cli, channels", () => {
    const bad: Array<Partial<typeof ok> & { readOnly?: unknown }> = [
      { name: "agent-1" },
      { name: "n-env1" },
      { node: "vm alice" },
      { node: "alice" },
      { workerCwd: "relative/dir" },
      { workerCwd: "/home/../etc" },
      { workerCwd: "/home/u\nrm -rf /" },
      { cli: "claude; rm -rf /" },
      { channels: ["Bad Channel"] },
      { channels: Array.from({ length: 9 }, (_, i) => `proj-p${i}`) },
      { channels: "proj-p1" as unknown as string[] },
      { readOnly: "yes" },
      { task: "   " },
    ];
    for (const patch of bad) {
      let error: unknown;
      try {
        validateSpawnRequest({ ...ok, ...patch } as Parameters<typeof validateSpawnRequest>[0]);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RelayIntegrationError);
      expect((error as RelayIntegrationError).code).toBe("invalid_input");
    }
  });
  test("oversize brief is a typed error with byte counts, measured in UTF-8", () => {
    const exact = "a".repeat(MAX_TASK_BRIEF_BYTES);
    expect(validateSpawnRequest({ ...ok, task: exact }).task.length).toBe(MAX_TASK_BRIEF_BYTES);
    // 4-byte characters: under the limit in UTF-16 length, over it in UTF-8 bytes.
    const emoji = "😀".repeat(MAX_TASK_BRIEF_BYTES / 4 + 1);
    try {
      validateSpawnRequest({ ...ok, task: emoji });
      throw new Error("expected brief_too_large");
    } catch (e) {
      expect((e as RelayIntegrationError).code).toBe("brief_too_large");
      expect((e as RelayIntegrationError).details).toEqual({ bytes: MAX_TASK_BRIEF_BYTES + 4, limit: MAX_TASK_BRIEF_BYTES });
    }
  });
});

describe("spawnPlacementInput", () => {
  const req = { name: "w-ab-be-e1", node: "n-env1", cli: "claude", task: "do it", channels: ["proj-p1"], workerCwd: "/home/u/work/r/b" };
  test("claude and codex use the node's default harness", () => {
    for (const cli of ["claude", "codex"]) {
      const input = spawnPlacementInput({ ...req, cli, model: "m-1" });
      expect(input).toEqual({ name: req.name, cli, task: "do it", channels: ["proj-p1"], worker_cwd: req.workerCwd, model: "m-1" });
      expect(input).not.toHaveProperty("harnessConfig");
    }
  });
  test("opencode names the agent-relay agent so the broker writes no opencode.json", () => {
    const input = spawnPlacementInput({ ...req, cli: "opencode" });
    expect(input.harnessConfig).toEqual({ runtime: "pty", command: "opencode", args: ["--agent", "agent-relay"] });
    expect(input).not.toHaveProperty("model");
    expect(spawnPlacementInput({ ...req, cli: "opencode", model: "x/y" }).model).toBe("x/y");
  });
  test("a read-only subagent starts each CLI with its own read-only switches, and no channel", () => {
    const expected: Record<string, string[]> = {
      claude: ["--tools", "Read,Grep,Glob,WebFetch,WebSearch"],
      codex: ["--sandbox", "read-only", "--ask-for-approval", "never"],
      opencode: ["--agent", "agent-relay-readonly"],
    };
    for (const cli of ["claude", "codex", "opencode"]) {
      const input = spawnPlacementInput({ ...req, cli, channels: [], readOnly: true });
      expect(input.harnessConfig).toEqual({ runtime: "pty", command: cli, args: expected[cli] });
      expect(READ_ONLY_ARGS[cli]).toEqual(expected[cli]!);
      // Sent empty on purpose: the broker falls back to its default channel only when the key is missing.
      expect(input.channels).toEqual([]);
    }
    // No edit, write or shell tool for Claude Code.
    for (const tool of ["Edit", "Write", "Bash", "NotebookEdit"]) expect(expected.claude![1]!.split(",")).not.toContain(tool);
    expect(spawnPlacementInput({ ...req, cli: "codex", readOnly: false })).not.toHaveProperty("harnessConfig");
  });
  test("Cursor Agent, Gemini CLI and Grok always start under their morrow-<cli> name, never their own", () => {
    const normal: Record<string, { command: string; args: string[] }> = {
      cursor: { command: "morrow-cursor", args: ["--force", "--approve-mcps", "--trust", "--disable-auto-update"] },
      gemini: { command: "morrow-gemini", args: ["--approval-mode", "yolo"] },
      grok: { command: "morrow-grok", args: ["--always-approve", "--trust"] },
    };
    const readOnly: Record<string, string[]> = {
      cursor: ["--mode", "ask", "--approve-mcps", "--trust", "--disable-auto-update"],
      gemini: ["--approval-mode", "plan"],
      grok: ["--permission-mode", "plan", "--trust"],
    };
    for (const cli of ["cursor", "gemini", "grok"]) {
      const input = spawnPlacementInput({ ...req, cli, model: "m-1" });
      expect(input).toMatchObject({ name: req.name, cli, model: "m-1" });
      expect(input.harnessConfig).toEqual({ runtime: "pty", ...normal[cli]! });
      expect(BRIDGED_HARNESS[cli]).toEqual(normal[cli]!);
      const ro = spawnPlacementInput({ ...req, cli, channels: [], readOnly: true });
      expect(ro.harnessConfig).toEqual({ runtime: "pty", command: normal[cli]!.command, args: readOnly[cli] });
      expect(READ_ONLY_ARGS[cli]).toEqual(readOnly[cli]!);
      // Read-only drops every auto-approve switch.
      for (const flag of ["--force", "--yolo", "yolo", "--always-approve"]) expect(readOnly[cli]).not.toContain(flag);
    }
    // The broker sets up Relay with the workspace key for these exact names: no harness may use one.
    for (const cli of CliKind.options) {
      const command = (spawnPlacementInput({ ...req, cli }).harnessConfig as { command?: string } | undefined)?.command;
      expect(["gemini", "grok", "cursor", "cursor-agent", "agent"]).not.toContain(command);
      expect(["gemini", "grok", "cursor", "cursor-agent", "agent"]).not.toContain((spawnPlacementInput({ ...req, cli, readOnly: true }).harnessConfig as { command: string }).command);
    }
  });
});

describe("classifySpawnError", () => {
  const p = (code: RelayPlacementError["code"], message = "m", invocationId = "inv_1") =>
    new RelayPlacementError(code, message, { capability: "spawn:claude", attempts: 1, invocationId });
  test("maps every placement code", () => {
    const table: Array<[RelayPlacementError, string, string]> = [
      [p("spawn_unconfirmed"), "unconfirmed", "spawn_unconfirmed"],
      [p("spawn_retryable"), "retryable", "spawn_retryable"],
      [p("node_unavailable"), "retryable", "node_unavailable"],
      [p("no_eligible_node"), "retryable", "no_eligible_node"],
      [p("placement_queue_full"), "retryable", "placement_queue_full"],
      [p("placement_ttl_expired"), "retryable", "placement_ttl_expired"],
      [p("capability_mismatch"), "failed", "capability_mismatch"],
      [p("sandbox_policy_mismatch"), "failed", "sandbox_policy_mismatch"],
      [p("unmapped_repo"), "failed", "unmapped_repo"],
      [p("spawn_failed", "spawn_agent_name_in_use"), "unconfirmed", "name_in_use"],
      [p("spawn_failed", "spawn_failed: worker_cwd is not resolvable: '/x'"), "failed", "bad_cwd"],
      [p("spawn_failed", "spawn_failed: agent 'n-a' is the broker self"), "failed", "name_is_node"],
      [p("spawn_failed", "harness_never_ready"), "failed", "spawn_failed"],
    ];
    for (const [error, outcome, code] of table) {
      const result = classifySpawnError(error);
      expect([result.outcome, result.code]).toEqual([outcome, code] as never);
      expect(result.invocationId).toBe("inv_1");
    }
  });
  test("maps RelayError and unknown errors conservatively", () => {
    expect(classifySpawnError(new RelayError("not_found", "Node not found", { statusCode: 404 }))).toMatchObject({ outcome: "failed", code: "node_not_found" });
    expect(classifySpawnError(new RelayError("rate_limited", "slow", { statusCode: 429 }))).toMatchObject({ outcome: "retryable" });
    // The SDK folds the server's 429 plan_limit_exceeded into rate_limited and keeps the original as rawCode.
    expect(classifySpawnError(new RelayError("rate_limited", "trial cap", { statusCode: 429, rawCode: "plan_limit_exceeded" }))).toMatchObject({ outcome: "failed", code: "relay_quota" });
    expect(classifySpawnError(new RelayError("rate_limited", "slow", { statusCode: 429, rawCode: "rate_limit_exceeded" }))).toMatchObject({ outcome: "retryable", code: "relay_unavailable" });
    expect(classifySpawnError(new RelayError("transport_error", "reset"))).toMatchObject({ outcome: "unconfirmed" });
    expect(classifySpawnError(new RelayError("unauthorized", "no", { statusCode: 401 }))).toMatchObject({ outcome: "failed", code: "relay_rejected" });
    expect(classifySpawnError(new TypeError("fetch failed"))).toMatchObject({ outcome: "unconfirmed", code: "transport_unknown" });
  });
});

describe("normalize", () => {
  test("every captured frame type maps to a contract-valid view (or is ignored)", () => {
    const at = 1_700_000_000_000;
    const msg = (raw: unknown, kind: "human" | "system" | "agent") => {
      const placed = messageEventContext(normalizeMessagingEvent(raw))!;
      return RelayEventView.parse(messageToView(placed.message, placed.context, kind, at));
    };
    expect(msg(frames.messageCreated, "human")).toEqual({
      type: "message",
      id: "241476504506986496",
      channel: "proj-abc",
      conversationId: null,
      threadId: null,
      parentId: null,
      from: { name: "h-saam", kind: "human" },
      text: "hello <b>x</b>",
      mentions: [],
      createdAt: at,
    });
    expect(msg(frames.threadReply, "system")).toMatchObject({ channel: "proj-abc", threadId: "241476504506986496", parentId: "241476504506986496" });
    expect(msg(frames.dmReceived, "human")).toMatchObject({ channel: null, conversationId: "dm_24dc9fe38780c3ef062d6e64" });

    expect(parseLifecycle(frames.agentActive, at)).toEqual({
      kind: "agent.status",
      agentName: "w-t1-be-e445",
      agentId: "241476988424810496",
      status: "active",
      at: Date.parse("2020-01-02T03:04:05.467Z"),
    });
    expect(parseLifecycle(frames.agentOfflineNoTopLevelName, at)).toMatchObject({ agentName: "w-t1-be-e445", status: "offline" });
    expect(parseLifecycle(frames.agentExited, at)).toMatchObject({ kind: "agent.exited", reason: "missing_from_inventory", invocationId: expect.stringMatching(/^inv_idem_/) });
    expect(parseLifecycle(frames.nodeOffline, at)).toMatchObject({ kind: "node.status", nodeName: "n-alice", status: "offline", reason: "disconnected" });
    expect(parseLifecycle(frames.nodeOnlineNoName, at)).toMatchObject({ kind: "node.status", nodeName: null, status: "online" });
    expect(parseLifecycle(frames.actionCompleted, at)).toBeNull();
    expect(parseLifecycle(frames.memberJoined, at)).toBeNull();
    expect(parseLifecycle({ type: "agent.exited" }, at)).toBeNull();
    expect(parseLifecycle(null, at)).toBeNull();
    expect(messageEventContext(normalizeMessagingEvent(frames.memberJoined))).toBeNull();
  });
});

describe("ack", () => {
  const view = (name: string, text: string): RelayMessageView => ({
    type: "message",
    id: "1",
    channel: "proj-p",
    conversationId: null,
    threadId: "9",
    parentId: "9",
    from: { name, kind: "agent" },
    text,
    mentions: [],
    createdAt: 1,
  });
  const lease = { leaseId: "l-abc.1", agentName: "w-t1-be-e2" };
  test("accepts only the lease's own agent with the exact token", () => {
    expect(isHandoffAck(view("w-t1-be-e2", "ACK l-abc.1"), lease)).toBe(true);
    expect(isHandoffAck(view("w-t1-be-e2", "  ACK l-abc.1  picking up"), lease)).toBe(true);
    expect(isHandoffAck(view("w-t1-evil-e1", "ACK l-abc.1"), lease)).toBe(false);
    expect(isHandoffAck(view("h-saam", "ACK l-abc.1"), lease)).toBe(false);
    expect(isHandoffAck(view("w-t1-be-e2", "ack l-abc.1"), lease)).toBe(false);
    expect(isHandoffAck(view("w-t1-be-e2", "ACK l-abc.10"), lease)).toBe(false);
    expect(isHandoffAck(view("w-t1-be-e2", "ACK l-abcx1"), lease)).toBe(false);
    expect(isHandoffAck(view("w-t1-be-e2", "please ACK l-abc.1"), lease)).toBe(false);
  });
});

describe("decideWorkerState", () => {
  const T0 = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (s: number) => T0 + s * 1000;
  /** `names: null` is a record without the live-agents capability; `hb` is the heartbeat second. */
  const node = (names: string[] | null, hb: number | null, status: "online" | "offline" = "online", live = true): RelayNode => ({
    name: "n-a",
    status,
    live,
    activeAgents: 1,
    ...(hb === null ? {} : { lastHeartbeatAt: new Date(at(hb)).toISOString() }),
    capabilities: [{ name: "spawn:claude" }, ...(names ? [{ name: "relay:live-agents:v1", kind: "capacity", metadata: { names } }] : [])],
  });
  const obs = (n: RelayNode | null, s: number, extra: Partial<Parameters<typeof decideWorkerState>[0]> = {}) => ({
    node: n,
    agent: null,
    exit: undefined,
    expectedInvocationId: null,
    now: at(s),
    ...extra,
  });
  const W = "w-x-e1";

  test("running while listed; gone only after three absences on newer heartbeats spanning 30 s", () => {
    let r = decideWorkerState(obs(node([W], 0), 1), initialReconcileMemo(), W);
    expect([r.state, r.reason]).toEqual(["running", "live"]);
    r = decideWorkerState(obs(node([], 18), 20), r.memo, W);
    expect([r.state, r.reason, r.memo.absentReads]).toEqual(["unknown", "absent_unconfirmed", 1]);
    // The same heartbeat read again is the same observation.
    r = decideWorkerState(obs(node([], 18), 22), r.memo, W);
    expect([r.state, r.memo.absentReads]).toEqual(["unknown", 1]);
    r = decideWorkerState(obs(node([], 38), 40), r.memo, W);
    expect([r.state, r.memo.absentReads]).toEqual(["unknown", 2]);
    // Three reads, but only 25 s apart.
    r = decideWorkerState(obs(node([], 44), 45), r.memo, W);
    expect([r.state, r.memo.absentReads]).toEqual(["unknown", 3]);
    r = decideWorkerState(obs(node([], 54), 55), r.memo, W);
    expect([r.state, r.reason, r.memo.firstAbsentAt]).toEqual(["gone", "absent", at(20)]);
    // Reappearing resets the streak.
    r = decideWorkerState(obs(node([], 60), 61), initialReconcileMemo(), W);
    r = decideWorkerState(obs(node([], 72), 73), r.memo, W);
    r = decideWorkerState(obs(node([W], 84), 85), r.memo, W);
    expect([r.state, r.memo]).toEqual(["running", initialReconcileMemo()]);
  });

  test("a record without inventory, a stale one or one without a heartbeat proves nothing and keeps the streak", () => {
    // Live on hosted Relay under load: online, live, one active agent, fresh heartbeat, no live-agents capability.
    let r = decideWorkerState(obs(node([], 10), 11), initialReconcileMemo(), W);
    const streak = r.memo;
    for (let s = 20; s <= 300; s += 20) {
      r = decideWorkerState(obs(node(null, s - 1), s), r.memo, W);
      expect([r.state, r.reason]).toEqual(["unknown", "inventory_missing"]);
    }
    expect(r.memo).toEqual(streak);
    r = decideWorkerState(obs(node([], 100), 161), streak, W);
    expect([r.state, r.reason, r.memo]).toEqual(["unknown", "inventory_stale", streak]);
    r = decideWorkerState(obs(node([], null), 161), streak, W);
    expect([r.state, r.reason]).toEqual(["unknown", "inventory_stale"]);
  });

  test("absence within the grace after a start is not counted", () => {
    const startedAt = at(100);
    let r = decideWorkerState(obs(node([], 120), 121, { startedAt }), initialReconcileMemo(), W);
    expect([r.state, r.reason, r.memo.absentReads]).toEqual(["unknown", "starting", 0]);
    r = decideWorkerState(obs(node([], 159), 160, { startedAt }), r.memo, W);
    expect([r.state, r.reason, r.memo.absentReads]).toEqual(["unknown", "absent_unconfirmed", 1]);
  });

  test("an inferred exit is not proof; the broker's word, a release or an older engine's bare exit is", () => {
    const exit = (reason: string | null, invocationId = "inv_a") => ({ agentName: W, invocationId, reason, at: 1 });
    const inferred = { exit: exit("missing_from_inventory"), expectedInvocationId: "inv_a" };
    // The incident: the engine said missing_from_inventory while the broker still listed the worker.
    expect(decideWorkerState(obs(node([W], 10), 11, inferred), initialReconcileMemo(), W).state).toBe("running");
    expect(decideWorkerState(obs(node(null, 10), 11, inferred), initialReconcileMemo(), W).reason).toBe("inventory_missing");
    expect(decideWorkerState(obs(node([], 10), 11, inferred), initialReconcileMemo(), W).reason).toBe("absent_unconfirmed");
    for (const reason of ["deregistered", "released", null]) {
      const r = decideWorkerState(obs(node([W], 10), 11, { exit: exit(reason), expectedInvocationId: "inv_a" }), initialReconcileMemo(), W);
      expect([r.state, r.reason]).toEqual(["gone", "exited"]);
    }
    expect(decideWorkerState(obs(node([W], 10), 11, { exit: exit("released"), expectedInvocationId: "inv_b" }), initialReconcileMemo(), W).state).toBe("running");
    expect(isConclusiveExit({ reason: "missing_from_inventory" })).toBe(false);
  });

  test("offline or missing node is unknown and resets the streak", () => {
    let r = decideWorkerState(obs(node([], 10), 11), initialReconcileMemo(), W);
    expect(r.memo.absentReads).toBe(1);
    r = decideWorkerState(obs(node([], 30, "offline"), 31), r.memo, W);
    expect([r.state, r.reason, r.memo]).toEqual(["unknown", "node_offline", initialReconcileMemo()]);
    expect(decideWorkerState(obs(node([], 10, "online", false), 11), initialReconcileMemo(), W).reason).toBe("node_offline");
    expect(decideWorkerState(obs(null, 0), initialReconcileMemo(), W).reason).toBe("node_missing");
  });

  test("after our own release, two newer heartbeats without the worker suffice", () => {
    let r = decideWorkerState(obs(node([], 10), 11), initialReconcileMemo(), W, RELEASE_ABSENCE);
    expect(r.state).toBe("unknown");
    r = decideWorkerState(obs(node([], 10), 13), r.memo, W, RELEASE_ABSENCE);
    expect(r.state).toBe("unknown");
    r = decideWorkerState(obs(node([], 22), 23), r.memo, W, RELEASE_ABSENCE);
    expect([r.state, r.reason]).toEqual(["gone", "absent"]);
    expect(decideWorkerState(obs(node(null, 22), 23), r.memo, W, RELEASE_ABSENCE).state).toBe("unknown");
    expect(WATCH_ABSENCE.reads).toBeGreaterThan(RELEASE_ABSENCE.reads);
  });

  test("a failed read is unknown and keeps the streak", async () => {
    const memo = { absentReads: 2, firstAbsentAt: at(1), lastAbsentHeartbeatAt: at(1) };
    const down = async () => {
      throw new Error("The database is temporarily overloaded");
    };
    const reader = { getNode: down, getAgent: down, agentType: down, nodeNameById: down } as unknown as RelayReader;
    expect(await reconcileWorker({ reader, agentName: W, nodeName: "n-a", memo })).toEqual({ state: "unknown", reason: "read_failed", invocationId: null, memo });
  });

  test("an inference never replaces the proof held for the same incarnation", () => {
    const ledger = new ExitLedger();
    ledger.record({ agentName: W, invocationId: "inv_a", reason: "released", at: 1 });
    ledger.record({ agentName: W, invocationId: "inv_a", reason: "missing_from_inventory", at: 2 });
    expect(ledger.get(W)?.reason).toBe("released");
    ledger.record({ agentName: W, invocationId: "inv_b", reason: "missing_from_inventory", at: 3 });
    expect(ledger.get(W)).toMatchObject({ invocationId: "inv_b", reason: "missing_from_inventory" });
    ledger.record({ agentName: W, invocationId: "inv_b", reason: "deregistered", at: 4 });
    expect(ledger.get(W)?.reason).toBe("deregistered");
  });

  test("exit ledger is bounded", () => {
    const ledger = new ExitLedger(3);
    for (let i = 0; i < 10; i++) ledger.record({ agentName: `w-a-e${i}`, invocationId: null, reason: null, at: i });
    expect(ledger.size).toBe(3);
    expect(ledger.get("w-a-e0")).toBeUndefined();
    expect(ledger.get("w-a-e9")?.at).toBe(9);
  });
});

describe("node health", () => {
  test("healthy only when every signal agrees", () => {
    const base: RelayNode = {
      name: "n-a",
      status: "online",
      live: true,
      handlersLive: true,
      capabilities: [
        { name: "spawn:claude" },
        { name: "spawn:codex" },
        { name: "relay:live-agents:v1", metadata: { names: ["w-a-e1", 5] } },
      ],
      activeAgents: 1,
      lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
    };
    const h = nodeHealthFrom("n-a", base);
    expect(h).toMatchObject({ healthy: true, harnesses: ["claude", "codex"], liveAgents: ["w-a-e1"], activeAgents: 1 });
    expect(nodeHealthFrom("n-a", { ...base, handlersLive: false }).healthy).toBe(false);
    expect(nodeHealthFrom("n-a", null)).toMatchObject({ exists: false, healthy: false });
  });
});

describe("sender kinds", () => {
  test("registry first, cached, convention on failure, in-flight deduped", async () => {
    let calls = 0;
    const kinds = createSenderKindResolver({
      lookup: async (name) => {
        calls++;
        if (name === "boom") throw new Error("down");
        return ({ "h-saam": "human", dispatcher: "system", "n-a": "human", "w-a-e1": "agent" } as const)[name as "h-saam"] ?? null;
      },
    });
    expect(await Promise.all([kinds.kindOf("h-saam"), kinds.kindOf("h-saam")])).toEqual(["human", "human"]);
    expect(calls).toBe(1);
    expect(await kinds.kindOf("h-saam")).toBe("human");
    expect(calls).toBe(1);
    expect(await kinds.kindOf("n-a")).toBe("system");
    expect(await kinds.kindOf("w-a-e1")).toBe("agent");
    expect(await kinds.kindOf("boom")).toBe("agent");
    expect(await kinds.kindOf("h-deleted")).toBe("human");
    expect(conventionKind("dispatcher")).toBe("system");
  });
  test("cache is bounded", async () => {
    const kinds = createSenderKindResolver({ lookup: async () => "agent", maxEntries: 5 });
    for (let i = 0; i < 50; i++) await kinds.kindOf(`w-a-e${i}`);
    expect(kinds.size).toBe(5);
  });
});

/** A durable log + emitter that behaves like createObserverEventSource (onCursor right before each emit). */
function fakeLog() {
  const log: Array<{ seq: number; raw: unknown }> = [];
  const connects: number[] = [];
  let active: { opts: ObserverEventSourceOptions; handlers: Array<(e: unknown) => void>; stopped: boolean } | null = null;
  const emitFrom = async (state: NonNullable<typeof active>, since: number) => {
    let cursor = since;
    for (const row of log) {
      if (state.stopped) return;
      if (row.seq <= cursor) continue;
      cursor = row.seq;
      state.opts.onCursor?.(row.seq);
      for (const h of state.handlers) h(normalizeMessagingEvent(row.raw));
      await Promise.resolve();
    }
  };
  const create = (opts: ObserverEventSourceOptions): RelayMessagingEventsSurface => {
    const state = { opts, handlers: [] as Array<(e: unknown) => void>, stopped: false };
    return {
      connect() {
        connects.push(opts.sinceSeq ?? 0);
        active = state;
        void emitFrom(state, opts.sinceSeq ?? 0);
      },
      async disconnect() {
        state.stopped = true;
      },
      subscribe() {},
      unsubscribe() {},
      on(_event, handler) {
        state.handlers.push(handler as (e: unknown) => void);
        return () => {};
      },
    };
  };
  /** `lost` writes to the log without delivering live, like the SDK's backfill/socket-open race. */
  const append = (raw: Record<string, unknown>, lost = false) => {
    const seq = log.length + 1;
    log.push({ seq, raw: { ...raw, seq } });
    if (active && !active.stopped && !lost) {
      active.opts.onCursor?.(seq);
      for (const h of active.handlers) h(normalizeMessagingEvent({ ...raw, seq }));
    }
  };
  return { create, append, connects, log };
}

const chanMsg = (i: number, from = "h-saam") => ({
  type: "message.created",
  channel: "proj-p",
  message: { id: String(1000 + i), agent_name: from, text: `m${i}`, created_at: "2020-01-01T00:00:00.000Z" },
});

const stubReader: RelayReader = {
  getNode: async () => null,
  getAgent: async () => null,
  agentType: async (name) => (name.startsWith("h-") ? "human" : name === "dispatcher" ? "system" : "agent"),
  nodeNameById: async (id) => (id === "node_1" ? "n-one" : null),
};

describe("TeamRelayObserver (fake source)", () => {
  const make = (log: ReturnType<typeof fakeLog>, extra: Partial<ConstructorParameters<typeof TeamRelayObserver>[0]> = {}) => {
    const published: ServerFrame[] = [];
    const saves: number[] = [];
    let stored: number | null = null;
    const observer = new TeamRelayObserver({
      teamId: "t-1",
      config: { baseUrl: "http://localhost:1" },
      observerToken: "ot_live_test",
      reader: stubReader,
      cursorStore: {
        load: async () => stored,
        save: async (seq) => {
          saves.push(seq);
          stored = seq;
        },
      },
      publish: (_team, frame) => {
        published.push(ServerFrame.parse(frame));
      },
      createSource: log.create,
      gapCheckIntervalMs: 0,
      ...extra,
    });
    return { observer, published, saves, setStored: (v: number | null) => (stored = v), getStored: () => stored };
  };

  test("publishes in seq order with seq attached, resumes without gaps or duplicates", async () => {
    const log = fakeLog();
    for (let i = 1; i <= 5; i++) log.append(chanMsg(i));
    const a = make(log);
    await a.observer.start();
    await Bun.sleep(20);
    log.append(chanMsg(6, "dispatcher"));
    await Bun.sleep(20);
    await a.observer.stop();
    expect(a.published.map((f) => (f.kind === "relay.event" ? f.seq : -1))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(a.published.at(-1)).toMatchObject({ data: { from: { name: "dispatcher", kind: "system" } } });
    expect(a.getStored()).toBe(6);

    for (let i = 7; i <= 9; i++) log.append(chanMsg(i));
    const b = make(log);
    b.setStored(a.getStored());
    await b.observer.start();
    await Bun.sleep(20);
    await b.observer.stop();
    expect(log.connects.at(-1)).toBe(6);
    expect(b.published.map((f) => (f.kind === "relay.event" ? f.seq : -1))).toEqual([7, 8, 9]);
  });

  test("lifecycle hooks fire in order; node ids resolve to names; throwing hooks do not stop the stream", async () => {
    const log = fakeLog();
    const seen: string[] = [];
    const { observer, published } = make(log, {
      callbacks: {
        onAgentActive: (e) => void seen.push(`active:${e.agentName}`),
        onAgentExited: (e) => {
          seen.push(`exited:${e.agentName}:${e.nodeName}`);
          throw new Error("hook bug");
        },
        onNodeStatus: (e) => void seen.push(`node:${e.nodeName}:${e.status}`),
        onMessage: (m) => void seen.push(`msg:${m.text}`),
      },
    });
    await observer.start();
    log.append({ type: "agent.status.active", agent_name: "w-a-e1", timestamp: "2020-01-01T00:00:00.000Z" });
    log.append({ type: "agent.exited", agent_id: "1", agent_name: "w-a-e1", node_id: "node_1", invocation_id: "inv_1", reason: "released" });
    log.append({ type: "node.status.offline", node_id: "node_1", node_name: null, reason: "disconnected" });
    log.append({ type: "action.completed", invocation_id: "inv_1" });
    log.append(chanMsg(1));
    await Bun.sleep(30);
    await observer.stop();
    expect(seen).toEqual(["active:w-a-e1", "exited:w-a-e1:n-one", "node:n-one:offline", "msg:m1"]);
    expect(published.map((f) => (f.kind === "relay.event" ? f.data.type : f.kind))).toEqual(["agent.status", "agent.status", "node.status", "message"]);
    expect(observer.exits.get("w-a-e1")?.invocationId).toBe("inv_1");
    expect(observer.cursor).toBe(5);
  });

  test("queue overflow drops and resumes from the cursor: every event exactly once, in order", async () => {
    const log = fakeLog();
    for (let i = 1; i <= 60; i++) log.append(chanMsg(i));
    const published: number[] = [];
    const observer = new TeamRelayObserver({
      teamId: "t-1",
      config: { baseUrl: "http://localhost:1" },
      observerToken: "ot_live_test",
      reader: stubReader,
      cursorStore: { load: async () => null, save: async () => {} },
      publish: async (_t, frame) => {
        await Bun.sleep(1);
        if (frame.kind === "relay.event") published.push(frame.seq!);
      },
      maxQueue: 7,
      createSource: log.create,
    });
    await observer.start();
    const deadline = Date.now() + 5000;
    while (published.length < 60 && Date.now() < deadline) await Bun.sleep(10);
    await observer.stop();
    expect(published).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(observer.health().resubscribes).toBeGreaterThan(0);
    expect(log.connects.length).toBeGreaterThan(1);
  });

  test("cursor writes are throttled and the final cursor is written on stop", async () => {
    const log = fakeLog();
    const t = make(log, { flushIntervalMs: 300 });
    await t.observer.start();
    const started = Date.now();
    for (let i = 1; i <= 40; i++) {
      log.append(chanMsg(i));
      await Bun.sleep(20);
    }
    const elapsed = Date.now() - started;
    expect(t.saves.length).toBeLessThanOrEqual(Math.ceil(elapsed / 300) + 1);
    await t.observer.stop();
    expect(t.saves.at(-1)).toBe(40);
  });

  test("auth failure is surfaced once; a failed cursor load refuses to start", async () => {
    let authFailures = 0;
    const log = fakeLog();
    let reportError: ((e: unknown) => void) | undefined;
    const t = make(log, {
      onAuthFailure: () => authFailures++,
      createSource: (opts) => {
        reportError = opts.onError;
        return log.create(opts);
      },
    });
    await t.observer.start();
    reportError!(new Error("observer backfill failed: HTTP 401 for GET /v1/workspace/events"));
    reportError!(new Error("observer backfill failed: HTTP 401 for GET /v1/workspace/events"));
    expect(authFailures).toBe(1);
    expect(t.observer.health().authFailed).toBe(true);
    await t.observer.replaceToken("ot_live_new");
    expect(t.observer.health().authFailed).toBe(false);
    await t.observer.stop();

    const broken = new TeamRelayObserver({
      teamId: "t-1",
      config: { baseUrl: "http://localhost:1" },
      observerToken: "x",
      reader: stubReader,
      cursorStore: { load: async () => Promise.reject(new Error("terse down")), save: async () => {} },
      publish: () => {},
      createSource: log.create,
    });
    await expect(broken.start()).rejects.toThrow("terse down");
    expect(broken.health().running).toBe(false);
  });

  test("frames that fail the contract are dropped, publish errors do not stall", async () => {
    const log = fakeLog();
    let calls = 0;
    const observer = new TeamRelayObserver({
      teamId: "t-1",
      config: { baseUrl: "http://localhost:1" },
      observerToken: "x",
      reader: stubReader,
      cursorStore: { load: async () => null, save: async () => {} },
      publish: () => {
        calls++;
        throw new Error("hub down");
      },
      createSource: log.create,
    });
    await observer.start();
    log.append({ type: "node.status.online", node_id: "node_unknown", node_name: null });
    log.append(chanMsg(1));
    log.append(chanMsg(2));
    await Bun.sleep(20);
    await observer.stop();
    expect(calls).toBe(2);
    expect(observer.cursor).toBe(3);
  });

  test("gap check: a log head ahead of a silent stream resubscribes once and recovers the lost events", async () => {
    const log = fakeLog();
    const urls: string[] = [];
    const head = (status = 200) =>
      (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ ok: true, data: { events: [], latest_seq: log.log.length } }), { status });
      }) as unknown as typeof fetch;
    const t = make(log, { gapCheckIntervalMs: 200, fetch: head() });
    await t.observer.start();
    log.append(chanMsg(1));
    log.append(chanMsg(2), true);
    log.append(chanMsg(3), true);
    const deadline = Date.now() + 6000;
    while (t.published.length < 3 && Date.now() < deadline) await Bun.sleep(50);
    await Bun.sleep(700);
    await t.observer.stop();
    expect(t.published.map((f) => (f.kind === "relay.event" ? f.seq : -1))).toEqual([1, 2, 3]);
    expect(t.observer.health().resubscribes).toBe(1);
    expect(log.connects).toEqual([0, 1]);
    expect(urls[0]).toBe("http://localhost:1/v1/workspace/events?since=1&limit=1");
  }, 10_000);

  test("gap check: a head the backfill cannot reach is retried once, never in a loop; 401 surfaces as auth failure", async () => {
    const log = fakeLog();
    let authFailures = 0;
    const fetchHead = (async () => new Response(JSON.stringify({ ok: true, data: { latest_seq: 99 } }))) as unknown as typeof fetch;
    const t = make(log, { gapCheckIntervalMs: 200, fetch: fetchHead });
    await t.observer.start();
    await Bun.sleep(3200);
    await t.observer.stop();
    expect(t.observer.health().resubscribes).toBe(1);

    const denied = make(log, {
      gapCheckIntervalMs: 200,
      onAuthFailure: () => authFailures++,
      fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
    });
    await denied.observer.start();
    await Bun.sleep(700);
    await denied.observer.stop();
    expect(authFailures).toBe(1);
    expect(denied.observer.health().authFailed).toBe(true);
  }, 10_000);
});

describe("reactions, read receipts and attachments", () => {
  const ctx = { channel: "proj-p", conversationId: null, threadId: null, parentId: null };
  const base = { id: "m-1", text: "hi", from: { id: "w-a-e1", name: "w-a-e1" }, createdAt: "2020-01-01T00:00:00.000Z" };

  test("a stored message carries attachment metadata, reaction groups and its read count; nothing else", () => {
    const raw = {
      ...base,
      attachments: [
        { id: "f-1", filename: "schema\u0007.sql", contentType: "text/plain", sizeBytes: 42 },
        { type: "url", url: "javascript:alert(1)" },
        { id: "", filename: "x" },
        { id: "f-2", sizeBytes: -1 },
      ],
      reactions: [
        { emoji: "+1", count: 2, agents: ["w-b-e1", "h-saam"] },
        { emoji: "", count: 1, agents: [] },
        { emoji: "eyes", count: -3, agents: ["w-c-e1"] },
      ],
      readByCount: 3,
    } as unknown as RelayMessage;
    const view = messageToView(raw, ctx, "agent", 0);
    expect(view.attachments).toEqual([
      { id: "f-1", filename: "schema.sql", contentType: "text/plain", sizeBytes: 42 },
      { id: "f-2", filename: "file", contentType: null, sizeBytes: null },
    ]);
    expect(view.reactions).toEqual([
      { emoji: "+1", count: 2, agents: ["w-b-e1", "h-saam"] },
      { emoji: "eyes", count: 1, agents: ["w-c-e1"] },
    ]);
    expect(view.readByCount).toBe(3);
    expect(RelayEventView.safeParse(view).success).toBe(true);
    const plain = messageToView(base as unknown as RelayMessage, ctx, "agent", 0);
    expect(plain.attachments).toBeUndefined();
    expect(plain.reactions).toBeUndefined();
    expect(plain.readByCount).toBeUndefined();
  });

  test("reaction and read events become marks; incomplete ones are dropped", () => {
    const added = markFromEvent(normalizeMessagingEvent({ type: "message.reacted", message_id: "m-1", emoji: "+1", agent_name: "w-b-e1", action: "added" }), 5);
    expect(added).toEqual({ type: "reaction", messageId: "m-1", emoji: "+1", agentName: "w-b-e1", removed: false, at: 5 });
    const removed = markFromEvent(normalizeMessagingEvent({ type: "message.reacted", message_id: "m-1", emoji: "+1", agent_name: "w-b-e1", action: "removed" }), 5);
    expect(removed).toMatchObject({ type: "reaction", removed: true });
    const read = markFromEvent(normalizeMessagingEvent({ type: "message.read", message_id: "m-1", agent_name: "h-saam", read_at: "2020-01-01T00:00:01.000Z" }), 5);
    expect(read).toEqual({ type: "read", messageId: "m-1", agentName: "h-saam", at: Date.parse("2020-01-01T00:00:01.000Z") });
    expect(markFromEvent(normalizeMessagingEvent({ type: "message.reacted", message_id: "m-1", emoji: "+1", agent_name: "" }), 5)).toBeNull();
    expect(markFromEvent(normalizeMessagingEvent({ type: "message.reacted", message_id: "", emoji: "+1", agent_name: "w-b-e1" }), 5)).toBeNull();
    expect(markFromEvent(normalizeMessagingEvent({ type: "message.reacted", message_id: "m-1", emoji: "x".repeat(65), agent_name: "w-b-e1" }), 5)).toBeNull();
    expect(markFromEvent(normalizeMessagingEvent({ type: "message.read", message_id: "m-1", agent_name: "" }), 5)).toBeNull();
  });

  test("the observer publishes marks as relay.mark frames and never hands them to orchestration", async () => {
    const log = fakeLog();
    const published: ServerFrame[] = [];
    const seen: string[] = [];
    const observer = new TeamRelayObserver({
      teamId: "t-1",
      config: { baseUrl: "http://localhost:1" },
      observerToken: "ot_live_test",
      reader: stubReader,
      cursorStore: { load: async () => null, save: async () => {} },
      publish: (_team, frame) => {
        published.push(ServerFrame.parse(frame));
      },
      createSource: log.create,
      gapCheckIntervalMs: 0,
      callbacks: { onMessage: (m) => void seen.push(m.text) },
    });
    await observer.start();
    log.append(chanMsg(1));
    log.append({ type: "message.reacted", message_id: "1001", emoji: "+1", agent_name: "w-a-e1", action: "added" });
    log.append({ type: "message.read", message_id: "1001", agent_name: "h-saam", read_at: "2020-01-01T00:00:01.000Z" });
    log.append({ type: "message.reacted", message_id: "1001", emoji: "+1", agent_name: "" });
    await Bun.sleep(30);
    await observer.stop();
    expect(seen).toEqual(["m1"]);
    const marks = published.filter((f) => f.kind === "relay.mark");
    expect(marks.map((f) => (f.kind === "relay.mark" ? [f.seq, f.data.type, f.data.agentName] : null))).toEqual([
      [2, "reaction", "w-a-e1"],
      [3, "read", "h-saam"],
    ]);
    expect(observer.cursor).toBe(4);
  });
});
