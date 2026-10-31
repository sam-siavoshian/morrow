import { describe, expect, test } from "bun:test";
import type { LeaseView, ProfileView, SubagentView, TaskDetail, TraceEntry, TraceKind, WorkforceView, WorkstreamDetail } from "@morrow/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { selectTaskWorkers } from "@/lib/store/selectors";
import { agentTone, StatusPip } from "./agent-status";
import { parsePatch, shortCount } from "./diff";
import { deriveLanes } from "./lanes";
import { commitUrl, compareUrl, pullsUrl } from "./links";
import { leaseWhy } from "./end-reason";
import { stripSourceTag } from "./recovery";
import { cachedTaskDetail, coversLive, DETAIL_CACHE_SIZE, DETAIL_REFETCH_MS, refetchDelay, rememberTaskDetail } from "./use-task-detail";
import { subagentWorkerState, WorkerList, type WorkerRowData } from "./worker-list";
import { latestLeaseIds, orderWorkers, splitSubagents, waitingWorkstreams, workerState } from "./workers";

const profile = (id: string, patch: Partial<ProfileView> = {}): ProfileView => ({
  id,
  envId: "e-1",
  ownerUserId: "u-1",
  cli: "claude",
  label: `${id} label`,
  auth: "ok",
  availability: "busy",
  cooldownUntil: null,
  limitedReason: null,
  limitedSource: null,
  maxConcurrent: 1,
  activeLeases: 0,
  scopes: "all",
  lastSeenAt: null,
  ...patch,
});
const lease = (id: string, patch: Partial<LeaseView> = {}): LeaseView => ({
  id,
  taskId: "tk-1",
  workstreamId: "ws-api",
  profileId: "pr-ada",
  epoch: 1,
  agentName: `w-tk1-api-e1`,
  nodeName: "n-1",
  state: "running",
  createdAt: 100,
  ...patch,
});
const ws = (id: string, patch: Partial<WorkstreamDetail> = {}): WorkstreamDetail => ({
  id,
  role: id.replace("ws-", ""),
  title: id,
  why: "",
  branch: `morrow/tk1/${id}`,
  dependsOn: [],
  status: "active",
  leaseId: null,
  lastCheckpoint: null,
  ...patch,
});
const entry = (at: number, kind: TraceKind, message: string, refs: Partial<TraceEntry> = {}): TraceEntry => ({
  at,
  kind,
  message,
  leaseId: null,
  profileId: null,
  epoch: null,
  ...refs,
});
const task = (patch: Partial<TaskDetail> = {}): TaskDetail => ({
  id: "tk-1",
  projectId: "p-1",
  title: "Checkout",
  prompt: "",
  acceptance: [],
  createdBy: "u-1",
  status: "running",
  maxAgents: 3,
  plan: null,
  workstreams: [],
  verification: null,
  trace: [],
  createdAt: 50,
  updatedAt: 50,
  ...patch,
});

/** A handoff story: ada's Claude hits a usage limit, linus's Codex takes over. */
function story(upTo: number) {
  const steps: TraceEntry[] = [
    entry(100, "worker.reserved", "Reserved ada", { leaseId: "l-1", profileId: "pr-ada" }),
    entry(200, "worker.quota_limited", "[detected] ada label (claude) hit a usage limit: You've hit your limit. w-tk1-api-e1 stopped.", {
      leaseId: "l-1",
      profileId: "pr-ada",
    }),
    entry(300, "task.handoff_requested", 'Handing "api" from e1 to linus (codex) as w-tk1-api-e2, from checkpoint none', { leaseId: "l-2" }),
    entry(400, "task.checkpointed", "Checkpoint abc1234def56 on morrow/tk1/api by w-tk1-api-e1", { leaseId: "l-1" }),
    entry(500, "task.handoff_acked", 'w-tk1-api-e2 acknowledged the handoff of "api"', { leaseId: "l-2" }),
    entry(600, "task.verified", "Verified: 2/2 checks passed"),
  ].slice(0, upTo);
  const wf: WorkforceView = {
    profiles: {
      "pr-ada": profile("pr-ada", { availability: "limited", cooldownUntil: 9_999, limitedSource: "detected" }),
      "pr-linus": profile("pr-linus", { cli: "codex", ownerUserId: "u-2" }),
    },
    tasks: {},
    leases: {
      "l-1": lease("l-1", { state: "expired" }),
      ...(upTo >= 3 ? { "l-2": lease("l-2", { profileId: "pr-linus", epoch: 2, agentName: "w-tk1-api-e2", createdAt: 300 }) } : {}),
    },
  };
  const t = task({
    trace: steps,
    status: upTo >= 6 ? "completed" : upTo >= 2 && upTo < 5 ? "handoff" : "running",
    workstreams: [ws("ws-api", { status: upTo >= 6 ? "done" : upTo >= 2 && upTo < 5 ? "handoff" : "active", leaseId: upTo >= 3 ? "l-2" : "l-1" })],
    verification: upTo >= 6 ? { status: "passed", checks: [{ name: "tests", status: "passed", detail: "", url: null }, { name: "merge", status: "passed", detail: "", url: null }] } : null,
  });
  wf.tasks[t.id] = t;
  return { t, wf };
}

describe("handoff story", () => {
  test("no failure, no reason on the row", () => {
    expect(leaseWhy(story(1).t.trace, "l-1")).toBeNull();
  });

  test("the limited worker's row says why in plain words, with the recorded text behind it", () => {
    const { t } = story(6);
    expect(leaseWhy(t.trace, "l-1")).toEqual({ text: "Hit a usage limit", detail: "ada label (claude) hit a usage limit: You've hit your limit. w-tk1-api-e1 stopped." });
    // The replacement's handoff entry never reads as the reason it ended.
    expect(leaseWhy(t.trace, "l-2")).toBeNull();
  });

  test("source tags", () => {
    expect(stripSourceTag("[manual] x")).toEqual({ text: "x", source: "manual" });
    expect(stripSourceTag("[detected] x")).toEqual({ text: "x", source: "detected" });
    expect(stripSourceTag("plain")).toEqual({ text: "plain", source: null });
  });
});

describe("workers", () => {
  test("states: working, cooldown, handed off, done, waiting", () => {
    const { t, wf } = story(3);
    const workers = selectTaskWorkers(wf, t.id);
    expect(workers.map((w) => workerState(w, t))).toEqual([
      { kind: "cooldown", until: 9_999 },
      { kind: "working", since: 300 },
    ]);
    const done = { ...t, workstreams: [{ ...t.workstreams[0]!, status: "done" as const }] };
    expect(workerState(workers[1]!, done)).toEqual({ kind: "done" });
    const released = { ...workers[0]!, lease: { ...workers[0]!.lease, state: "released" as const }, profile: profile("pr-ada") };
    expect(workerState(released, t)).toEqual({ kind: "stopped", reason: "Handed off" });
  });

  test("a finished workstream that dropped its lease id credits only its newest lease", () => {
    const { t, wf } = story(3);
    const workers = selectTaskWorkers(wf, t.id).map((w) => ({ ...w, lease: { ...w.lease, state: "released" as const }, profile: profile("pr-x") }));
    const finished = { ...t, workstreams: [{ ...t.workstreams[0]!, status: "done" as const, leaseId: null }] };
    const latest = latestLeaseIds(workers);
    expect([...latest]).toEqual([workers[1]!.lease.id]);
    expect(workers.map((w) => workerState(w, finished, latest.has(w.lease.id)))).toEqual([
      { kind: "stopped", reason: "Handed off" },
      { kind: "done" },
    ]);
  });

  test("waiting workstreams name what they wait on; order follows the plan", () => {
    const t = task({ workstreams: [ws("ws-api", { leaseId: "l-1" }), ws("ws-tests", { status: "pending", dependsOn: ["ws-api"] })] });
    expect(waitingWorkstreams(t)).toEqual([{ workstream: t.workstreams[1]!, on: "ws-api" }]);
    const wf: WorkforceView = {
      profiles: { "pr-ada": profile("pr-ada") },
      tasks: { [t.id]: t },
      leases: { b: lease("b", { workstreamId: "ws-tests", createdAt: 1 }), a: lease("a", { createdAt: 5 }) },
    };
    expect(orderWorkers(selectTaskWorkers(wf, t.id), t).map((w) => w.lease.id)).toEqual(["a", "b"]);
  });
});

describe("lanes", () => {
  test("a handoff lane: the first lease ends at the limit, the second runs to the task end", () => {
    const { t, wf } = story(6);
    const [lane] = deriveLanes(t, wf);
    expect(lane!.segments.map((s) => [s.leaseId, s.start, s.end, s.ending])).toEqual([
      ["l-1", 100, 200, "limit"],
      ["l-2", 300, 300, "done"],
    ]);
    expect(lane!.markers.map((m) => m.kind)).toEqual(["limit", "checkpoint", "ack"]);
  });

  test("a live lease has no end", () => {
    const { t, wf } = story(3);
    expect(deriveLanes(t, wf)[0]!.segments[1]).toMatchObject({ leaseId: "l-2", end: null, ending: null });
  });
});

describe("task detail", () => {
  test("a detail covers the live task once it is as new as the live view's last change", () => {
    const live = task({ updatedAt: 500 });
    expect(coversLive(null, live)).toBe(false);
    expect(coversLive(task({ updatedAt: 400 }), live)).toBe(false);
    expect(coversLive(task({ updatedAt: 500 }), live)).toBe(true);
    // A fetch can land after a change the live view has not shown yet.
    expect(coversLive(task({ updatedAt: 600 }), live)).toBe(true);
    expect(coversLive(task({ id: "tk-2", updatedAt: 900 }), live)).toBe(false);
    expect(coversLive(task(), null)).toBe(false);
  });

  test("refetches are spaced out so a busy task does not drain the read rate limit", () => {
    expect(refetchDelay(0, 1_000_000)).toBe(0);
    expect(refetchDelay(1_000, 1_000)).toBe(DETAIL_REFETCH_MS);
    expect(refetchDelay(1_000, 1_000 + DETAIL_REFETCH_MS - 200)).toBe(200);
    expect(refetchDelay(1_000, 1_000 + DETAIL_REFETCH_MS + 5)).toBe(0);
  });
});

describe("github links", () => {
  test("compare links are built from validated parts only", () => {
    const gh = "https://github.com";
    expect(compareUrl(gh, "northwind/web", "main", "morrow/livechec/ui")).toBe("https://github.com/northwind/web/compare/main...morrow/livechec/ui");
    expect(compareUrl(gh, "northwind/web", "main", "feat/a b")).toBeNull();
    expect(compareUrl(gh, "northwind/web", "main", "../../evil")).toBeNull();
    expect(compareUrl(gh, "evil.com/x/y", "main", "b")).toBeNull();
    expect(compareUrl(gh, "northwind/web", "main", "b?x=1#y")).toBeNull();
    expect(compareUrl(gh, "northwind/web", "main", "/abs")).toBeNull();
  });

  test("pull request list links carry the filter and refuse odd repo names", () => {
    expect(pullsUrl("https://github.com", "northwind/web", "open")).toBe("https://github.com/northwind/web/pulls?q=is%3Apr+is%3Aopen");
    expect(pullsUrl("https://github.com", "northwind/web", "all")).toBe("https://github.com/northwind/web/pulls?q=is%3Apr");
    expect(pullsUrl("javascript:alert(1)", "northwind/web", "closed")).toBe("https://github.com/northwind/web/pulls?q=is%3Apr+is%3Aclosed");
    expect(pullsUrl("https://github.com", "evil.com/x/y", "open")).toBeNull();
  });

  test("commit links need a real sha", () => {
    expect(commitUrl("https://github.com", "northwind/web", "abc1234")).toBe("https://github.com/northwind/web/commit/abc1234");
    expect(commitUrl("https://github.com", "northwind/web", "javascript:1")).toBeNull();
  });

  test("links follow GITHUB_WEB_URL; only http(s) bases are used, anything else falls back to github.com", () => {
    expect(commitUrl("https://ghe.example.com/", "northwind/web", "abc1234")).toBe("https://ghe.example.com/northwind/web/commit/abc1234");
    expect(compareUrl("http://127.0.0.1:8788", "northwind/web", "main", "b")).toBe("http://127.0.0.1:8788/northwind/web/compare/main...b");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://ghe.example.com", "//evil.com", "https://ghe.example.com/?x=1", "https://u:p@ghe.example.com", ""]) {
      expect(commitUrl(bad, "northwind/web", "abc1234")).toBe("https://github.com/northwind/web/commit/abc1234");
    }
  });
});

describe("task detail cache", () => {
  const detail = (id: string, updatedAt: number) => ({ id, updatedAt }) as unknown as TaskDetail;

  test("keeps the newest copy and forgets the oldest past the cap", () => {
    rememberTaskDetail("t-cache", detail("tk-a", 5));
    rememberTaskDetail("t-cache", detail("tk-a", 3));
    expect(cachedTaskDetail("t-cache", "tk-a")?.updatedAt).toBe(5);
    expect(cachedTaskDetail("t-other", "tk-a")).toBeNull();
    for (let i = 0; i < DETAIL_CACHE_SIZE; i++) rememberTaskDetail("t-cache", detail(`tk-${i}`, 1));
    expect(cachedTaskDetail("t-cache", "tk-a")).toBeNull();
    expect(cachedTaskDetail("t-cache", `tk-${DETAIL_CACHE_SIZE - 1}`)).not.toBeNull();
  });
});

describe("subagents", () => {
  const record = (leaseId: string, patch: Partial<SubagentView> = {}): SubagentView => ({
    leaseId,
    parentLeaseId: "l-1",
    agentName: `w-tk1-api-sub-e${leaseId.slice(2)}`,
    parentAgentName: "w-tk1-api-e1",
    cli: "codex",
    profileId: "pr-cx",
    role: "review",
    task: "Review the auth diff.",
    status: "running",
    summary: null,
    createdAt: 200,
    finishedAt: null,
    ...patch,
  });
  function setup(records?: SubagentView[]) {
    const t = task({ workstreams: [ws("ws-api", { leaseId: "l-1" })] });
    const wf: WorkforceView = {
      profiles: { "pr-ada": profile("pr-ada"), "pr-cx": profile("pr-cx", { cli: "codex" }) },
      tasks: { [t.id]: t },
      leases: {
        "l-1": lease("l-1"),
        "l-7": lease("l-7", { profileId: "pr-cx", epoch: 7, agentName: "w-tk1-api-sub-e7", parentLeaseId: "l-1", state: "spawning", createdAt: 200 }),
      },
    };
    return { t, wf, split: splitSubagents(selectTaskWorkers(wf, t.id), records) };
  }

  test("subagents are never top-level workers and nest under their parent", () => {
    const { t, split } = setup();
    expect(split.workers.map((w) => w.lease.id)).toEqual(["l-1"]);
    expect(split.subagents.get("l-1")).toEqual([
      { leaseId: "l-7", parentLeaseId: "l-1", agentName: "w-tk1-api-sub-e7", cli: "codex", role: null, task: null, summary: null, status: "starting", startedAt: 200, finishedAt: null },
    ]);
    // The parent is still the newest lease of its workstream, so it keeps its own state.
    expect(latestLeaseIds(split.workers).has("l-1")).toBe(true);
    expect(workerState(split.workers[0]!, t, true)).toEqual({ kind: "working", since: 100 });
  });

  test("records fill in the live lease and bring back finished subagents", () => {
    const done = record("l-5", { agentName: "w-tk1-api-sub-e5", cli: "opencode", status: "completed", summary: "All good.\nOne nit.", createdAt: 150, finishedAt: 180 });
    const { split } = setup([done, record("l-7")]);
    const kids = split.subagents.get("l-1")!;
    expect(kids.map((k) => [k.leaseId, k.status, k.role])).toEqual([
      ["l-5", "completed", "review"],
      ["l-7", "starting", "review"],
    ]);
    expect(kids[1]!.task).toBe("Review the auth diff.");
    // A record that ended wins over a live lease that trails it.
    const { split: later } = setup([record("l-7", { status: "failed", summary: "Could not run." })]);
    expect(later.subagents.get("l-1")![0]!.status).toBe("failed");
  });

  test("lanes ignore subagents: the parent keeps its segment", () => {
    const { t, wf } = setup();
    const [lane] = deriveLanes(t, wf);
    expect(lane!.segments.map((s) => s.leaseId)).toEqual(["l-1"]);
    expect(lane!.segments[0]!.end).toBeNull();
  });

  test("status words follow the worker vocabulary", () => {
    expect(subagentWorkerState({ status: "running", startedAt: 5 })).toEqual({ kind: "working", since: 5 });
    expect(subagentWorkerState({ status: "completed", startedAt: 5 })).toEqual({ kind: "done" });
    expect(subagentWorkerState({ status: "cancelled", startedAt: 5 })).toEqual({ kind: "stopped", reason: "Stopped" });
  });

  test("the list renders children under the parent, collapsed, with text never parsed as HTML", () => {
    const evil = record("l-7", { status: "completed", summary: "<img src=x onerror=alert(1)>" });
    const { split } = setup([evil]);
    const row: WorkerRowData = {
      key: "l-1",
      agentName: "w-tk1-api-e1",
      label: "api e1",
      cli: "claude",
      owner: null,
      ownership: "Claude Code",
      vm: null,
      state: { kind: "working", since: 100 },
      profileLabel: null,
      subagents: split.subagents.get("l-1"),
    };
    const html = renderToStaticMarkup(createElement(WorkerList, { rows: [row], selected: null, onSelect: () => {} }));
    expect(html).toContain('aria-label="Subagents of api e1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Codex");
    expect(html).toContain("review");
    expect(html).not.toContain("<img");
    const none = renderToStaticMarkup(createElement(WorkerList, { rows: [{ ...row, subagents: [] }], selected: null, onSelect: () => {} }));
    expect(none).not.toContain("Subagents of");
  });
});

describe("diff lines", () => {
  const patch = "@@ -1,3 +1,4 @@\n line one\n-old two\n+new two\n+added\n line three\n\\ No newline at end of file\n";

  test("numbers old and new lines across a hunk", () => {
    const { lines, rest } = parsePatch(patch);
    expect(rest).toBe(0);
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["hunk", null, null, "@@ -1,3 +1,4 @@"],
      ["context", 1, 1, "line one"],
      ["del", 2, null, "old two"],
      ["add", null, 2, "new two"],
      ["add", null, 3, "added"],
      ["context", 3, 4, "line three"],
      ["note", null, null, "\\ No newline at end of file"],
    ]);
  });

  test("caps lines and says how many are left; markup stays text; CRLF is fine", () => {
    const { lines, rest } = parsePatch(patch, 3);
    expect(lines).toHaveLength(3);
    expect(rest).toBe(4);
    expect(parsePatch("@@ -1 +1 @@\n+<script>alert(1)</script>").lines[1]!.text).toBe("<script>alert(1)</script>");
    expect(parsePatch("@@ -10,2 +20,2 @@\r\n a\r\n b").lines.map((l) => l.newNo)).toEqual([null, 20, 21]);
  });

  test("short counts", () => {
    expect([0, 999, 1000, 1250, 9999, 12_345].map(shortCount)).toEqual(["0", "999", "1k", "1.2k", "9.9k", "12k"]);
  });
});

describe("agent status looks the same everywhere", () => {
  test("tones and status marks", () => {
    expect((["working", "starting", "waiting", "cooldown"] as const).map((k) => agentTone(k))).toEqual(["live", "live", "live", "live"]);
    expect([agentTone("done"), agentTone("failed"), agentTone("stopped")]).toEqual(["done", "failed", "ended"]);
    expect(renderToStaticMarkup(createElement(StatusPip, { kind: "working" }))).toBe("");
    expect(renderToStaticMarkup(createElement(StatusPip, { kind: "failed" }))).toContain("text-danger");
    expect(renderToStaticMarkup(createElement(StatusPip, { kind: "done" }))).toContain("text-success");
    expect(renderToStaticMarkup(createElement(StatusPip, { kind: "cooldown" }))).toContain("text-warning");
    expect(renderToStaticMarkup(createElement(StatusPip, { kind: "stopped" }))).toContain("bg-faint");
  });

  test("a failed or handed-off worker row is dimmed with its mark; a live one is not", () => {
    const base = { key: "k", agentName: "w-ab12-api-e1", label: "api e1", cli: "claude" as const, owner: null, ownership: "Claude Code", vm: null, profileLabel: null };
    const failed = renderToStaticMarkup(createElement(WorkerList, { rows: [{ ...base, state: { kind: "failed" } }], selected: null, onSelect: () => {} }));
    const live = renderToStaticMarkup(createElement(WorkerList, { rows: [{ ...base, state: { kind: "working", since: 1 } }], selected: null, onSelect: () => {} }));
    expect(failed).toContain("saturate-");
    expect(failed).toContain("text-danger");
    expect(live).not.toContain("saturate-");
    expect(live).not.toContain("grayscale");
  });
});
