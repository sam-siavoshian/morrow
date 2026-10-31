import { describe, expect, test } from "bun:test";
import type { LeaseView, ProfileView, RelayEventView, ServerFrame, TaskView, TeamView, TraceKind, WorkforceView } from "@morrow/contracts";
import { filterRelayEvents, mergeRelayEvents, relayEventKey, taskThreadRoots } from "./relay";
import { selectAskedTaskIds, selectInbox, selectTaskWorkers, taskRowStatus, viewerRelayName } from "./selectors";
import { applyMark, createTeamStore, GITHUB_KEYS_CAP, githubKey, initialTeamData, optimisticEnvironment, optimisticProfile, optimisticRemoveProfile, optimisticTeamField, reduceFrame, removeTask, type TeamField } from "./team-store";

const msg = (id: string, at: number, extra: Partial<Extract<RelayEventView, { type: "message" }>> = {}): RelayEventView => ({
  type: "message",
  id,
  channel: "proj-abc",
  conversationId: null,
  threadId: null,
  parentId: null,
  from: { name: "h-sam", kind: "human" },
  text: `message ${id}`,
  mentions: [],
  createdAt: at,
  ...extra,
});

function task(id: string, patch: Partial<TaskView> = {}, trace: TraceKind[] = ["task.created"]): TaskView {
  return {
    id,
    projectId: "p-1",
    title: id,
    createdBy: "u-1",
    status: "running",
    maxAgents: 3,
    workstreams: [],
    trace: trace.map((kind, i) => ({ at: i, kind, message: kind, leaseId: null, profileId: null, epoch: null })),
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  };
}

const lease = (id: string, taskId: string, patch: Partial<LeaseView> = {}): LeaseView => ({
  id,
  taskId,
  workstreamId: "ws-api",
  profileId: "pr-1",
  epoch: 1,
  agentName: `w-${taskId.replace(/[^a-z0-9]/g, "").slice(-8)}-api-e1`,
  nodeName: "n-env1",
  state: "running",
  createdAt: 200,
  ...patch,
});

const profile: ProfileView = {
  id: "pr-1",
  envId: "e-1",
  ownerUserId: "u-1",
  cli: "claude",
  label: "Sam's Claude",
  auth: "ok",
  availability: "busy",
  cooldownUntil: null,
  limitedReason: null,
  limitedSource: null,
  maxConcurrent: 1,
  activeLeases: 1,
  scopes: "all",
  lastSeenAt: null,
};

const workforce = (tasks: TaskView[], leases: LeaseView[] = []): WorkforceView => ({
  profiles: { [profile.id]: profile },
  tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  leases: Object.fromEntries(leases.map((l) => [l.id, l])),
});

const teamView: TeamView = {
  id: "t-1",
  name: "Core",
  slug: "core",
  viewerRole: "owner",
  members: [],
  projects: [],
  environments: [{ id: "e-1", ownerUserId: "u-1", name: "Box", linuxUser: null, nodeName: null, phase: "ready", vmState: "running", nodeOnline: true, lastError: null, createdAt: 1 }],
  policy: { allowInspect: true, maxParallelPerTask: 3 },
  relayReady: true,
};

describe("mergeRelayEvents", () => {
  test("dedupes by id, keeps time order, newest copy wins", () => {
    const a = msg("a", 10);
    const b = msg("b", 20);
    const merged = mergeRelayEvents([a, b], [msg("a", 10, { text: "edited" }), msg("c", 5)]);
    expect(merged.map(relayEventKey)).toEqual(["m:c", "m:a", "m:b"]);
    expect((merged[1] as { text: string }).text).toBe("edited");
  });

  test("fast path appends; a duplicate live event changes nothing", () => {
    const base = [msg("a", 10)];
    expect(mergeRelayEvents(base, [msg("b", 11)]).map(relayEventKey)).toEqual(["m:a", "m:b"]);
    expect(mergeRelayEvents(base, [])).toBe(base);
    expect(mergeRelayEvents(base, [msg("a", 10)])).toHaveLength(1);
  });

  test("caps at the newest N", () => {
    const many = Array.from({ length: 30 }, (_, i) => msg(`m${i}`, i));
    const capped = mergeRelayEvents(many.slice(0, 25), many.slice(25), 20);
    expect(capped).toHaveLength(20);
    expect(relayEventKey(capped[0]!)).toBe("m:m10");
    expect(relayEventKey(capped.at(-1)!)).toBe("m:m29");
    const one = mergeRelayEvents(capped, [msg("new", 99)], 20);
    expect(one).toHaveLength(20);
    expect(relayEventKey(one[0]!)).toBe("m:m11");
  });

  test("status events dedupe by subject, status and time", () => {
    const s = { type: "agent.status", agentName: "w-x-api-e1", status: "active", reason: null, nodeName: null, at: 5 } as const;
    expect(mergeRelayEvents([s], [{ ...s }, { ...s, status: "exited" }])).toHaveLength(2);
  });
});

describe("reduceFrame", () => {
  const base = initialTeamData("t-1");

  test("github.changed moves the version of the list and each pull request it names, and stays bounded", () => {
    const frame = (pulls: number[], list: boolean, at: number) => ({ kind: "github.changed", teamId: "t-1", data: { projectId: "p-1", pulls, list, at } }) as const;
    expect(reduceFrame(base, frame([], false, 5))).toEqual({});
    const one = { ...base, ...reduceFrame(base, frame([7], true, 10)) };
    expect(one.github).toEqual({ [githubKey("p-1")]: 10, [githubKey("p-1", 7)]: 10 });
    const two = { ...one, ...reduceFrame(one, frame([8], false, 20)) };
    expect(two.github[githubKey("p-1", 8)]).toBe(20);
    expect(two.github[githubKey("p-1")]).toBe(10);
    let state = base;
    for (let n = 1; n <= GITHUB_KEYS_CAP + 25; n++) state = { ...state, ...reduceFrame(state, frame([n], false, n)) };
    expect(Object.keys(state.github)).toHaveLength(GITHUB_KEYS_CAP);
    // The oldest go first; the newest survive.
    expect(state.github[githubKey("p-1", 1)]).toBeUndefined();
    expect(state.github[githubKey("p-1", GITHUB_KEYS_CAP + 25)]).toBe(GITHUB_KEYS_CAP + 25);
  });

  test("snapshots replace", () => {
    expect(reduceFrame(base, { kind: "team.view", teamId: "t-1", data: teamView }).team).toBe(teamView);
    const wf = workforce([task("tk-1")]);
    expect(reduceFrame(base, { kind: "workforce.view", teamId: "t-1", data: wf }).workforce).toBe(wf);
    expect(reduceFrame(base, { kind: "hello", teamId: "t-1", userId: "u-1" }).viewerId).toBe("u-1");
  });

  test("snapshots keep the identity of everything that did not change", () => {
    const first = workforce([task("tk-1"), task("tk-2")], [lease("l-1", "tk-1")]);
    const one = { ...base, ...reduceFrame(base, { kind: "workforce.view", teamId: "t-1", data: first }) };
    // The same content again (a fresh parse of the same frame) changes nothing at all.
    expect(reduceFrame(one, { kind: "workforce.view", teamId: "t-1", data: structuredClone(first) })).toEqual({});
    expect(reduceFrame({ ...one, team: teamView }, { kind: "team.view", teamId: "t-1", data: structuredClone(teamView) })).toEqual({});

    // One task moved: it and the containers are new, its siblings and the leases are the old objects.
    const next = structuredClone(first);
    next.tasks["tk-2"] = task("tk-2", { status: "completed", updatedAt: 200 });
    const two = reduceFrame(one, { kind: "workforce.view", teamId: "t-1", data: next }).workforce!;
    expect(two).not.toBe(one.workforce);
    expect(two.tasks["tk-2"]!.status).toBe("completed");
    expect(two.tasks["tk-1"]).toBe(one.workforce!.tasks["tk-1"]!);
    expect(two.leases).toBe(one.workforce!.leases);
    expect(two).toEqual(next);

    // A removed task is gone, not kept from before.
    const fewer = structuredClone(next);
    delete fewer.tasks["tk-1"];
    const three = reduceFrame({ ...one, workforce: two }, { kind: "workforce.view", teamId: "t-1", data: fewer }).workforce!;
    expect(Object.keys(three.tasks)).toEqual(["tk-2"]);
    expect(three.tasks["tk-2"]).toBe(two.tasks["tk-2"]!);
  });

  test("relay.event merges; a duplicate is a no-op", () => {
    const one = { ...base, ...reduceFrame(base, { kind: "relay.event", teamId: "t-1", seq: 1, data: msg("a", 1) }) };
    expect(one.relayEvents).toHaveLength(1);
    expect(reduceFrame(one, { kind: "relay.event", teamId: "t-1", seq: 1, data: msg("a", 1) })).toEqual({});
  });

  test("history: a requested page moves the cursor, a reconnect snapshot does not rewind it", () => {
    const store = createTeamStore("t-1");
    const s = () => store.getState();
    s().applyFrame({ kind: "relay.history", teamId: "t-1", data: [msg("m5", 5)], channel: "general", nextBefore: "m5" });
    expect(s().history.general).toEqual({ nextBefore: "m5", loading: false });

    expect(s().beginHistory("general")).toEqual({ before: "m5" });
    expect(s().beginHistory("general")).toBeNull();
    s().applyFrame({ kind: "relay.history", teamId: "t-1", data: [msg("m2", 2)], channel: "general", nextBefore: "m2" });
    expect(s().history.general).toEqual({ nextBefore: "m2", loading: false });

    // Reconnect: the server resends the newest page; the paging cursor stays put.
    s().applyFrame({ kind: "relay.history", teamId: "t-1", data: [msg("m5", 5), msg("m6", 6)], channel: "general", nextBefore: "m5" });
    expect(s().history.general!.nextBefore).toBe("m2");
    expect(s().relayEvents.map(relayEventKey)).toEqual(["m:m2", "m:m5", "m:m6"]);

    s().beginHistory("general");
    s().applyFrame({ kind: "relay.history", teamId: "t-1", data: [], channel: "general", nextBefore: null });
    expect(s().beginHistory("general")).toBeNull();
  });

  test("history: cancel undoes a request that never went out; error frames unstick loading", () => {
    const store = createTeamStore("t-1");
    const s = () => store.getState();
    expect(s().beginHistory("proj-abc")).toEqual({ before: null });
    s().cancelHistory("proj-abc");
    expect(s().history["proj-abc"]).toBeUndefined();

    s().beginHistory("proj-abc");
    s().applyFrame({ kind: "error", teamId: "t-1", code: "internal", message: "Something went wrong." });
    expect(s().history["proj-abc"]!.loading).toBe(false);
    expect(s().lastError).toEqual({ code: "internal", message: "Something went wrong." });
  });

  test("env.view replaces the environment and clears its stale live status", () => {
    const state = { ...base, team: teamView, envStatus: { "e-1": { envId: "e-1", vmState: "paused" as const, nodeOnline: false, at: 3 } } };
    const updated = { ...teamView.environments[0]!, phase: "paused" as const, vmState: "paused" as const };
    const next = reduceFrame(state, { kind: "env.view", teamId: "t-1", data: updated });
    expect(next.team!.environments).toEqual([updated]);
    expect(next.envStatus).toEqual({});
    const added = reduceFrame(state, { kind: "env.view", teamId: "t-1", data: { ...updated, id: "e-2" } });
    expect(added.team!.environments.map((e) => e.id)).toEqual(["e-1", "e-2"]);
  });

  test("env.status is keyed by environment", () => {
    const frame: ServerFrame = { kind: "env.status", teamId: "t-1", data: { envId: "e-1", vmState: "running", nodeOnline: true, at: 9 } };
    expect(reduceFrame(base, frame).envStatus).toEqual({ "e-1": frame.data });
  });

  test("toast frames do not touch the store", () => {
    const store = createTeamStore("t-1");
    const before = store.getState();
    store.getState().applyFrame({ kind: "toast", teamId: "t-1", data: { level: "info", title: "Hi", body: null } });
    expect(store.getState()).toBe(before);
  });
});

describe("inbox", () => {
  test("row status precedence", () => {
    expect(taskRowStatus(task("a", { status: "planned" }, ["task.created", "worker.blocked"]))).toBe("approval");
    expect(taskRowStatus(task("a", { status: "running" }, ["worker.blocked"]))).toBe("input");
    expect(taskRowStatus(task("a", { status: "draft" }, ["task.created", "worker.blocked"]))).toBe("input");
    expect(taskRowStatus(task("a", { status: "handoff" }, ["worker.blocked"]))).toBe("input");
    expect(taskRowStatus(task("a", { status: "handoff" }))).toBe("recovering");
    expect(taskRowStatus(task("a", { status: "running" }, ["worker.quota_limited"]))).toBe("recovering");
    expect(taskRowStatus(task("a", { status: "running" }))).toBe("running");
    expect(taskRowStatus(task("a", { status: "draft" }))).toBe("planning");
    expect(taskRowStatus(task("a", { status: "verifying" }))).toBe("verifying");
    expect(taskRowStatus(task("a", { status: "resolving" }))).toBe("resolving");
    // A worker's question still comes first; resolving outranks a usage limit seen earlier in the run.
    expect(taskRowStatus(task("a", { status: "resolving" }, ["worker.blocked"]))).toBe("input");
    expect(taskRowStatus(task("a", { status: "resolving" }, ["worker.quota_limited"]))).toBe("resolving");
    expect(taskRowStatus(task("a", { status: "failed" }, ["worker.blocked"]))).toBe("failed");
    expect(taskRowStatus(task("a", { status: "completed" }))).toBe("done");
    expect(taskRowStatus(task("a", { status: "cancelled" }))).toBe("cancelled");
  });

  test("groups, precedence inside a group, then newest first, with a project filter", () => {
    const wf = workforce([
      task("run-old", { updatedAt: 1 }),
      task("run-new", { updatedAt: 9 }),
      task("verify", { status: "verifying", updatedAt: 5 }),
      task("input", { updatedAt: 1 }, ["worker.blocked"]),
      task("approve", { status: "planned", updatedAt: 0 }),
      task("recover", { status: "handoff" }),
      task("resolve", { status: "resolving", updatedAt: 1_000 }),
      task("failed", { status: "failed", updatedAt: 50 }),
      task("done", { status: "completed", updatedAt: 60 }),
      task("other", { projectId: "p-2", status: "planned" }),
    ]);
    const inbox = selectInbox(wf, { projectId: "p-1" });
    expect(inbox["needs-you"].map((t) => t.id)).toEqual(["approve", "input"]);
    expect(inbox.running.map((t) => t.id)).toEqual(["run-new", "verify", "run-old"]);
    expect(inbox.recovering.map((t) => t.id)).toEqual(["resolve", "recover"]);
    expect(inbox.done.map((t) => t.id)).toEqual(["failed", "done"]);
    expect(selectInbox(wf)["needs-you"]).toHaveLength(3);
    expect(selectInbox(null)).toEqual({ "needs-you": [], running: [], recovering: [], done: [] });
  });
});

describe("a worker asks the viewer", () => {
  // tk-abc12345's workers are w-abc12345-*; tk-def67890's are w-def67890-*.
  const a = task("tk-abc12345");
  const b = task("tk-def67890");
  const wf = workforce([a, b], [lease("l-1", a.id), lease("l-2", b.id)]);
  const W = "w-abc12345-api-e1";
  const fromWorker = (id: string, at: number, extra: Partial<Extract<RelayEventView, { type: "message" }>> = {}) =>
    msg(id, at, { from: { name: W, kind: "agent" }, ...extra });
  const fromViewer = (id: string, at: number, extra: Partial<Extract<RelayEventView, { type: "message" }>> = {}) =>
    msg(id, at, { from: { name: "h-ada", kind: "human" }, ...extra });
  const asked = (events: RelayEventView[], seen: Record<string, number> = {}, workforceView: WorkforceView | null = wf, viewer: string | null = "h-ada") =>
    [...selectAskedTaskIds(events, workforceView, viewer, seen)].sort();

  test("the viewer's Relay name comes from the member list, lowercased", () => {
    const team = { ...teamView, members: [{ userId: "u-1", login: "Ada", name: null, avatarUrl: null, role: "member" as const }] };
    expect(viewerRelayName(team, "u-1")).toBe("h-ada");
    expect(viewerRelayName(team, "u-2")).toBeNull();
    expect(viewerRelayName(team, null)).toBeNull();
    expect(viewerRelayName(null, "u-1")).toBeNull();
  });

  test("a mention (Relay's list or @name in the text, any case) asks; someone else's name does not", () => {
    expect(asked([fromWorker("m1", 10, { mentions: ["h-ada"] })])).toEqual([a.id]);
    expect(asked([fromWorker("m1", 10, { mentions: ["@H-Ada"] })])).toEqual([a.id]);
    expect(asked([fromWorker("m1", 10, { text: "Which schema, @h-ada?" })])).toEqual([a.id]);
    expect(asked([fromWorker("m1", 10, { text: "@H-ADA should this be paged" })])).toEqual([a.id]);
    expect(asked([fromWorker("m1", 10, { text: "Asking @h-adam and @h-bob", mentions: ["h-adam"] })])).toEqual([]);
    expect(asked([fromWorker("m1", 10, { text: "email h-ada@example.com" })])).toEqual([]);
    expect(asked([fromWorker("m1", 10, { text: "no question here" })])).toEqual([]);
  });

  test("only the task's own workers ask: humans, the dispatcher and unknown agents do not", () => {
    expect(asked([msg("m1", 10, { from: { name: "h-bob", kind: "human" }, mentions: ["h-ada"] })])).toEqual([]);
    expect(asked([msg("m1", 10, { from: { name: "dispatcher", kind: "system" }, mentions: ["h-ada"] })])).toEqual([]);
    expect(asked([msg("m1", 10, { from: { name: "w-zzzzzzzz-api-e1", kind: "agent" }, mentions: ["h-ada"] })])).toEqual([]);
    // Matched by name prefix too, so an ended lease that left the view still counts.
    expect(asked([msg("m1", 10, { from: { name: "w-def67890-web-e7", kind: "agent" }, mentions: ["h-ada"] })])).toEqual([b.id]);
  });

  test("a DM counts in a conversation the viewer takes part in, not in someone else's", () => {
    const dm = { channel: null, conversationId: "c-1" };
    // Relay does not say who a DM is for: before the viewer writes there, it is not theirs.
    expect(asked([fromWorker("m1", 10, dm)])).toEqual([]);
    expect(asked([fromViewer("v1", 5, dm), fromWorker("m1", 10, dm)])).toEqual([a.id]);
    expect(asked([fromViewer("v1", 5, { channel: null, conversationId: "c-2" }), fromWorker("m1", 10, dm)])).toEqual([]);
  });

  test("a later reply in the same place clears it; a reply elsewhere or earlier does not; a new question opens again", () => {
    const q = fromWorker("q1", 10, { mentions: ["h-ada"] });
    expect(asked([q, fromViewer("r1", 20)])).toEqual([]);
    expect(asked([q, fromViewer("r1", 20, { channel: "proj-other" })])).toEqual([a.id]);
    expect(asked([fromViewer("r0", 5), q])).toEqual([a.id]);
    expect(asked([q, fromViewer("r1", 20), fromWorker("q2", 30, { mentions: ["h-ada"] })])).toEqual([a.id]);
    // Thread reply to the question, even from another channel view.
    expect(asked([q, fromViewer("r1", 20, { channel: null, threadId: "q1", parentId: "q1" })])).toEqual([]);
    // DM question, answered in the DM.
    const dm = { channel: null, conversationId: "c-1" };
    expect(asked([fromViewer("v1", 5, dm), fromWorker("m1", 10, dm), fromViewer("v2", 15, dm)])).toEqual([]);
    // Someone else answering does not clear the viewer's question.
    expect(asked([q, msg("r1", 20, { from: { name: "h-bob", kind: "human" } })])).toEqual([a.id]);
  });

  test("opening the task after the question clears it until a newer question arrives", () => {
    const q = fromWorker("q1", 10, { mentions: ["h-ada"] });
    expect(asked([q], { [a.id]: 9 })).toEqual([a.id]);
    expect(asked([q], { [a.id]: 10 })).toEqual([]);
    expect(asked([q], { [a.id]: Number.POSITIVE_INFINITY })).toEqual([]);
    expect(asked([q, fromWorker("q2", 30, { mentions: ["h-ada"] })], { [a.id]: 20 })).toEqual([a.id]);
    // Seeing another task changes nothing.
    expect(asked([q], { [b.id]: 50 })).toEqual([a.id]);
  });

  test("finished tasks, no viewer and no workforce never ask", () => {
    const q = fromWorker("q1", 10, { mentions: ["h-ada"] });
    for (const status of ["completed", "failed", "cancelled"] as const)
      expect(asked([q], {}, workforce([{ ...a, status }, b], [lease("l-1", a.id)]))).toEqual([]);
    expect(asked([q], {}, wf, null)).toEqual([]);
    expect(asked([q], {}, null)).toEqual([]);
    // Status events are ignored.
    expect(asked([{ type: "agent.status", agentName: W, status: "active", reason: null, nodeName: null, at: 10 }])).toEqual([]);
  });

  test("an asked task is Needs input in the inbox, below a plan to approve, above recovering", () => {
    const set = new Set([a.id, "tk-plan", "tk-done"]);
    expect(taskRowStatus(a, true)).toBe("input");
    expect(taskRowStatus({ ...a, status: "planned" }, true)).toBe("approval");
    expect(taskRowStatus({ ...a, status: "handoff" }, true)).toBe("input");
    expect(taskRowStatus({ ...a, status: "completed" }, true)).toBe("done");
    const inbox = selectInbox(
      workforce([a, task("tk-recover", { status: "handoff" }), task("tk-plan", { status: "planned" }), task("tk-done", { status: "completed" })]),
      { asked: set },
    );
    expect(inbox["needs-you"].map((t) => t.id)).toEqual(["tk-plan", a.id]);
    expect(inbox.recovering.map((t) => t.id)).toEqual(["tk-recover"]);
    expect(inbox.done.map((t) => t.id)).toEqual(["tk-done"]);
  });
});

describe("task workers and relay events", () => {
  const t = task("tk-abc12345", { workstreams: [{ id: "ws-api", branch: "b", status: "active", leaseId: "l-2" }] });
  const l1 = lease("l-1", t.id, { state: "expired", createdAt: 100 });
  const l2 = lease("l-2", t.id, { epoch: 2, agentName: "w-abc12345-api-e2", createdAt: 300 });
  const other = lease("l-9", "tk-zzz99999", { agentName: "w-zzz99999-api-e1" });
  const wf = workforce([t], [l2, other, l1]);

  test("workers: every lease of the task, oldest first, joined", () => {
    const workers = selectTaskWorkers(wf, t.id);
    expect(workers.map((w) => [w.lease.id, w.live])).toEqual([
      ["l-1", false],
      ["l-2", true],
    ]);
    expect(workers[1]!.profile).toBe(profile);
    expect(workers[1]!.workstream?.id).toBe("ws-api");
    expect(selectTaskWorkers(wf, "missing")).toEqual([]);
  });

  test("relay events: worker messages, mentions, lease ids, lifecycle; nothing from other tasks", () => {
    const events: RelayEventView[] = [
      msg("1", 1, { from: { name: "w-abc12345-api-e1", kind: "agent" } }),
      msg("2", 2, { mentions: ["w-abc12345-api-e2"] }),
      msg("3", 3, { from: { name: "w-abc12345-api-e2", kind: "agent" }, text: "ACK l-2" }),
      msg("4", 4, { from: { name: "dispatcher", kind: "system" }, text: "DONE l-2 shipped" }),
      msg("5", 5, { from: { name: "w-zzz99999-api-e1", kind: "agent" } }),
      msg("6", 6),
      { type: "agent.status", agentName: "w-abc12345-api-e2", status: "active", reason: null, nodeName: "n-env1", at: 7 },
      { type: "agent.status", agentName: "w-zzz99999-api-e1", status: "active", reason: null, nodeName: "n-env1", at: 8 },
      { type: "node.status", nodeName: "n-env1", status: "offline", reason: null, at: 150 },
      { type: "node.status", nodeName: "n-env1", status: "online", reason: null, at: 50 },
    ];
    const keys = filterRelayEvents(events, { taskId: t.id }, wf).map(relayEventKey);
    expect(keys).toEqual(["m:1", "m:2", "m:3", "m:4", "a:w-abc12345-api-e2:active:7", "n:n-env1:offline:150"]);
    expect(filterRelayEvents(events, { taskId: "missing" }, wf)).toEqual([]);
    expect(filterRelayEvents(events, { channel: "#proj-abc", types: ["message"] }, null)).toHaveLength(6);
    expect(filterRelayEvents(events, { agentName: "w-zzz99999-api-e1" }, null).map(relayEventKey)).toEqual(["m:5", "a:w-zzz99999-api-e1:active:8"]);
  });

  test("relay events: Morrow updates belong to the task they name or whose workers they reach", () => {
    const system = { name: "dispatcher", kind: "system" as const };
    const events: RelayEventView[] = [
      msg("1", 1, { from: system, channel: null, conversationId: "c1", text: "@w-abc12345-api-e2 Web is done", notice: { kind: "workstream_done", taskId: t.id, to: ["w-abc12345-api-e2"] } }),
      msg("2", 2, { from: system, channel: null, conversationId: "c2", text: "@w-zzz99999-api-e1 API is done", notice: { kind: "workstream_done", taskId: "tk-zzz99999", to: ["w-zzz99999-api-e1"] } }),
      // A notice that names no task still belongs to the task of the worker it reached.
      msg("3", 3, { from: system, channel: null, conversationId: "c3", text: "@w-abc12345-api-e2 status", notice: { kind: "status", taskId: null, to: ["w-abc12345-api-e2"] } }),
      // Naming another task's lease id in the text does not pull another task's notice in.
      msg("4", 4, { from: system, channel: null, conversationId: "c4", text: "@w-zzz99999-api-e1 about l-2", notice: { kind: "status", taskId: "tk-zzz99999", to: ["w-zzz99999-api-e1"] } }),
    ];
    expect(filterRelayEvents(events, { taskId: t.id }, wf).map(relayEventKey)).toEqual(["m:1", "m:3"]);
    expect(filterRelayEvents(events, { agentName: "w-zzz99999-api-e1" }, null).map(relayEventKey)).toEqual(["m:2", "m:4"]);
  });
});

describe("optimisticTeamField", () => {
  const name: TeamField<string> = { read: (t) => t.name, write: (t, v) => ({ ...t, name: v }) };
  const inspect: TeamField<boolean> = { read: (t) => t.policy.allowInspect, write: (t, v) => ({ ...t, policy: { ...t.policy, allowInspect: v } }) };
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
    return { promise, resolve, reject };
  };

  test("shows the guess at once, then the server's view", async () => {
    const store = createTeamStore("t-1", teamView);
    const server = deferred<TeamView>();
    const done = optimisticTeamField(store, name, "  New  ", () => server.promise);
    expect(store.getState().team!.name).toBe("  New  ");
    server.resolve({ ...teamView, name: "New" });
    await done;
    expect(store.getState().team!.name).toBe("New");
  });

  test("a failure puts only that field back and rethrows", async () => {
    const store = createTeamStore("t-1", teamView);
    const rename = deferred<TeamView>();
    const renaming = optimisticTeamField(store, name, "New", () => rename.promise);
    const toggling = optimisticTeamField(store, inspect, false, async () => ({ ...teamView, policy: { ...teamView.policy, allowInspect: false } }));
    await toggling;
    rename.reject(new Error("nope"));
    await expect(renaming).rejects.toThrow("nope");
    expect(store.getState().team!.name).toBe("Core");
    expect(store.getState().team!.policy.allowInspect).toBe(false);
  });

  test("a newer value from the socket is never rolled back", async () => {
    const store = createTeamStore("t-1", teamView);
    const rename = deferred<TeamView>();
    const renaming = optimisticTeamField(store, name, "Mine", () => rename.promise);
    store.getState().applyFrame({ kind: "team.view", teamId: "t-1", data: { ...teamView, name: "Theirs" } } as ServerFrame);
    rename.reject(new Error("conflict"));
    await expect(renaming).rejects.toThrow();
    expect(store.getState().team!.name).toBe("Theirs");
  });

  test("no team loaded yet: nothing to guess, the server's answer still lands", async () => {
    const store = createTeamStore("t-1", null);
    await optimisticTeamField(store, name, "X", async () => ({ ...teamView, name: "X" }));
    expect(store.getState().team!.name).toBe("X");
    const empty = createTeamStore("t-1", null);
    await expect(optimisticTeamField(empty, name, "X", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(empty.getState().team).toBeNull();
  });
});

describe("optimistic environment and profile writes", () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
    return { promise, resolve, reject };
  };
  const env = teamView.environments[0]!;
  const vmState = (store: ReturnType<typeof createTeamStore>) => store.getState().team!.environments[0]!.vmState;

  test("pause shows Pausing at once, then the server's view", async () => {
    const store = createTeamStore("t-1", teamView);
    const server = deferred<typeof env>();
    const done = optimisticEnvironment(store, { ...env, vmState: "pausing" }, () => server.promise);
    expect(vmState(store)).toBe("pausing");
    server.resolve({ ...env, vmState: "paused" });
    await done;
    expect(vmState(store)).toBe("paused");
  });

  test("a failure puts the old view back; a newer socket view is never rolled back or overwritten", async () => {
    const store = createTeamStore("t-1", teamView);
    const failing = optimisticEnvironment(store, { ...env, vmState: "pausing" }, async () => Promise.reject(new Error("nope")));
    await expect(failing).rejects.toThrow("nope");
    expect(vmState(store)).toBe("running");

    const server = deferred<typeof env>();
    const pausing = optimisticEnvironment(store, { ...env, vmState: "pausing" }, () => server.promise);
    store.getState().applyFrame({ kind: "env.view", teamId: "t-1", data: { ...env, vmState: "paused" } });
    // The HTTP answer is older than the socket's: it must not drag the view back to Pausing.
    server.resolve({ ...env, vmState: "pausing" });
    await pausing;
    expect(vmState(store)).toBe("paused");
  });

  test("a socket view equal to the guess still counts as the server's word", async () => {
    const store = createTeamStore("t-1", teamView);
    const server = deferred<typeof env>();
    const pausing = optimisticEnvironment(store, { ...env, vmState: "pausing" }, () => server.promise);
    store.getState().applyFrame({ kind: "team.view", teamId: "t-1", data: { ...teamView, environments: [{ ...env, vmState: "pausing" }] } });
    server.reject(new Error("timeout"));
    await expect(pausing).rejects.toThrow("timeout");
    expect(vmState(store)).toBe("pausing");
  });

  test("removeTask drops a deleted task and leaves the rest; an unknown id changes nothing", () => {
    const store = createTeamStore("t-1", teamView);
    store.getState().applyFrame({ kind: "workforce.view", teamId: "t-1", data: workforce([task("tk-1"), task("tk-2")]) });
    const keep = store.getState().workforce!.tasks["tk-2"];
    removeTask(store, "tk-1");
    expect(Object.keys(store.getState().workforce!.tasks)).toEqual(["tk-2"]);
    expect(store.getState().workforce!.tasks["tk-2"]).toBe(keep);
    const before = store.getState().workforce;
    removeTask(store, "tk-1");
    expect(store.getState().workforce).toBe(before);
  });

  test("workers at once shows at once, takes the server's answer, and goes back on failure", async () => {
    const store = createTeamStore("t-1", teamView);
    store.getState().applyFrame({ kind: "workforce.view", teamId: "t-1", data: workforce([]) });
    const server = deferred<ProfileView>();
    const saving = optimisticProfile(store, { ...profile, maxConcurrent: 6 }, () => server.promise);
    expect(store.getState().workforce!.profiles[profile.id]!.maxConcurrent).toBe(6);
    server.resolve({ ...profile, maxConcurrent: 6, label: "From server" });
    await saving;
    expect(store.getState().workforce!.profiles[profile.id]).toMatchObject({ maxConcurrent: 6, label: "From server" });

    const failing = deferred<ProfileView>();
    const refused = optimisticProfile(store, { ...profile, maxConcurrent: 2 }, () => failing.promise);
    expect(store.getState().workforce!.profiles[profile.id]!.maxConcurrent).toBe(2);
    failing.reject(new Error("forbidden"));
    await expect(refused).rejects.toThrow("forbidden");
    expect(store.getState().workforce!.profiles[profile.id]!.maxConcurrent).toBe(6);
  });

  test("a newer workforce view wins over a late answer or a failed change", async () => {
    const store = createTeamStore("t-1", teamView);
    store.getState().applyFrame({ kind: "workforce.view", teamId: "t-1", data: workforce([]) });
    const fresh = { ...workforce([]), profiles: { [profile.id]: { ...profile, maxConcurrent: 3 } } };
    const late = deferred<ProfileView>();
    const saving = optimisticProfile(store, { ...profile, maxConcurrent: 6 }, () => late.promise);
    store.getState().applyFrame({ kind: "workforce.view", teamId: "t-1", data: fresh });
    late.resolve({ ...profile, maxConcurrent: 6 });
    await saving;
    expect(store.getState().workforce!.profiles[profile.id]!.maxConcurrent).toBe(3);

    const failing = deferred<ProfileView>();
    const refused = optimisticProfile(store, { ...profile, maxConcurrent: 8 }, () => failing.promise);
    store.getState().applyFrame({ kind: "workforce.view", teamId: "t-1", data: { ...fresh, profiles: { [profile.id]: { ...profile, maxConcurrent: 5 } } } });
    failing.reject(new Error("late"));
    await expect(refused).rejects.toThrow("late");
    expect(store.getState().workforce!.profiles[profile.id]!.maxConcurrent).toBe(5);
  });

  test("a change to a profile the view no longer has adds nothing", async () => {
    const store = createTeamStore("t-1", teamView);
    store.getState().applyFrame({ kind: "workforce.view", teamId: "t-1", data: { ...workforce([]), profiles: {} } });
    await optimisticProfile(store, { ...profile, maxConcurrent: 6 }, async () => ({ ...profile, maxConcurrent: 6 }));
    expect(store.getState().workforce!.profiles).toEqual({});
  });

  test("removing a CLI hides it at once and brings it back on failure", async () => {
    const store = createTeamStore("t-1", teamView);
    store.getState().applyFrame({ kind: "workforce.view", teamId: "t-1", data: workforce([]) });
    const server = deferred<void>();
    const removing = optimisticRemoveProfile(store, profile.id, () => server.promise);
    expect(store.getState().workforce!.profiles[profile.id]).toBeUndefined();
    server.reject(new Error("forbidden"));
    await expect(removing).rejects.toThrow("forbidden");
    expect(store.getState().workforce!.profiles[profile.id]).toEqual(profile);
  });

  test("a failed removal stays settled when a newer workforce view arrived", async () => {
    const store = createTeamStore("t-1", teamView);
    store.getState().applyFrame({ kind: "workforce.view", teamId: "t-1", data: workforce([]) });
    const server = deferred<void>();
    const removing = optimisticRemoveProfile(store, profile.id, () => server.promise);
    store.getState().applyFrame({ kind: "workforce.view", teamId: "t-1", data: { ...workforce([]), profiles: {} } });
    server.reject(new Error("late"));
    await expect(removing).rejects.toThrow("late");
    expect(store.getState().workforce!.profiles).toEqual({});
  });
});

describe("peer coordination data", () => {
  const base = initialTeamData("t-1");
  const reaction = (messageId: string, agentName: string, emoji = "+1", removed = false) => ({ type: "reaction" as const, messageId, emoji, agentName, removed, at: 1 });
  const read = (messageId: string, agentName: string) => ({ type: "read" as const, messageId, agentName, at: 1 });

  test("marks: reactions toggle per agent, reads count once, nothing changed keeps identity, oldest messages drop at the cap", () => {
    let marks = applyMark({}, reaction("m-1", "w-a-e1"));
    expect(marks["m-1"]).toEqual({ reactions: { "+1": { "w-a-e1": true } }, readBy: [] });
    expect(applyMark(marks, reaction("m-1", "w-a-e1"))).toBe(marks);
    marks = applyMark(marks, reaction("m-1", "w-a-e1", "+1", true));
    expect(marks["m-1"]!.reactions["+1"]).toEqual({ "w-a-e1": false });
    marks = applyMark(applyMark(marks, read("m-1", "h-sam")), read("m-1", "w-b-e1"));
    expect(applyMark(marks, read("m-1", "h-sam"))).toBe(marks);
    expect(marks["m-1"]!.readBy).toEqual(["h-sam", "w-b-e1"]);
    let many = {};
    for (let i = 0; i < 12; i++) many = applyMark(many, read(`m-${i}`, "h-sam"), 10);
    expect(Object.keys(many)).toEqual(Array.from({ length: 10 }, (_, i) => `m-${i + 2}`));
    let readers = {};
    for (let i = 0; i < 60; i++) readers = applyMark(readers, read("m-1", `w-r${i}-e1`));
    expect((readers as Record<string, { readBy: string[] }>)["m-1"]!.readBy).toHaveLength(50);
  });

  test("relay.mark frames update marks; a thread page merges events without moving a channel cursor", () => {
    const one = { ...base, ...reduceFrame(base, { kind: "relay.mark", teamId: "t-1", seq: 3, data: reaction("m-1", "w-a-e1") }) };
    expect(one.relayMarks["m-1"]!.reactions["+1"]).toEqual({ "w-a-e1": true });
    expect(reduceFrame(one, { kind: "relay.mark", teamId: "t-1", seq: 3, data: reaction("m-1", "w-a-e1") })).toEqual({});
    const withCursor = { ...one, history: { "proj-abc": { nextBefore: "c-1", loading: false } } };
    const reply = msg("r-1", 5, { threadId: "k-1", parentId: "k-1" });
    const two = reduceFrame(withCursor, { kind: "relay.history", teamId: "t-1", channel: null, data: [reply], nextBefore: null, thread: "k-1" });
    expect(two.relayEvents!.map(relayEventKey)).toEqual(["m:r-1"]);
    expect(two.history).toBeUndefined();
    expect(two.threads).toEqual({ "k-1": true });
  });

  test("a task's thread replies belong to the task, from anyone; another task's thread does not", () => {
    const t = task("tk-abc12345", { workstreams: [{ id: "ws-api", branch: "b", status: "active", leaseId: null }] });
    const wf = workforce([t]);
    const kick = msg("k-1", 1, { from: { name: "dispatcher", kind: "system" }, text: "Task thread", notice: { kind: "kickoff", taskId: t.id, to: [] } });
    const otherKick = msg("k-2", 1, { from: { name: "dispatcher", kind: "system" }, text: "Task thread", notice: { kind: "kickoff", taskId: "tk-other", to: [] } });
    const forged = msg("k-3", 1, { from: { name: "w-zzz99999-api-e1", kind: "agent" }, notice: { kind: "kickoff", taskId: t.id, to: [] } });
    const events: RelayEventView[] = [
      kick,
      otherKick,
      forged,
      msg("r-1", 2, { threadId: "k-1", parentId: "k-1" }),
      msg("r-2", 3, { threadId: "k-2", parentId: "k-2" }),
      msg("r-3", 4, { threadId: "k-3", parentId: "k-3" }),
    ];
    expect([...taskThreadRoots(events, t.id)]).toEqual(["k-1"]);
    expect(filterRelayEvents(events, { taskId: t.id }, wf).map(relayEventKey)).toEqual(["m:k-1", "m:k-3", "m:r-1"]);
  });
});
