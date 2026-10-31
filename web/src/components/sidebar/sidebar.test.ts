import { describe, expect, test } from "bun:test";
import type { TaskView, TraceKind, WorkforceView } from "@morrow/contracts";
import { ApiError } from "@/lib/api";
import { selectInbox } from "@/lib/store/selectors";
import { deleteFailure } from "./delete-task";
import { deriveProjectIdentity, githubOwnerAvatarUrl, parseRepoFullName, projectColorIndex, projectMonogram, PROJECT_ICON_COLORS } from "./project-identity";
import { parseShelves, parseVisits, VISIT_CAP, withVisit } from "./sidebar-prefs";
import {
  adjacentTaskId,
  DONE_PAGE_FIRST,
  isUnread,
  rowStatus,
  runStartedAt,
  taskBranches,
  taskIdFromPath,
  visibleTaskIds, isLiveWorker, liveHarnesses
} from "./task-meta";
import { formatAgo } from "./task-status";
import { resolveTreeKey } from "./tree-keys";
import { clampTravel, MAX_TRAVEL } from "./use-list-flip";

function task(id: string, patch: Partial<TaskView> = {}, trace: [TraceKind, number][] = [["task.created", 100]]): TaskView {
  return {
    id,
    projectId: "p-1",
    title: id,
    createdBy: "u-1",
    status: "running",
    maxAgents: 3,
    workstreams: [],
    trace: trace.map(([kind, at]) => ({ at, kind, message: kind, leaseId: null, profileId: null, epoch: null })),
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  };
}

describe("project identity", () => {
  test("monograms read like t3code's", () => {
    expect(projectMonogram("cumulus")).toBe("CS");
    expect(projectMonogram("web-app")).toBe("WA");
    expect(projectMonogram("api2")).toBe("A2");
    expect(projectMonogram("x")).toBe("XX");
    expect(projectMonogram("  ")).toBe("PR");
    expect(projectMonogram("--")).toBe("PR");
  });

  test("colours are stable, case-insensitive and in range", () => {
    expect(projectColorIndex("Cumulus")).toBe(projectColorIndex("cumulus"));
    for (const name of ["a", "relay", "freestyle", "", "日本語"]) {
      const index = projectColorIndex(name);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(PROJECT_ICON_COLORS.length);
    }
    expect(PROJECT_ICON_COLORS).toHaveLength(18);
    expect(deriveProjectIdentity("cumulus").colorClassName).toBe(PROJECT_ICON_COLORS[projectColorIndex("cumulus")]!.className);
  });

  test("repo names split on the first slash", () => {
    expect(parseRepoFullName("ada/cumulus")).toEqual({ owner: "ada", repo: "cumulus" });
    expect(parseRepoFullName("cumulus")).toEqual({ owner: null, repo: "cumulus" });
    expect(parseRepoFullName("/x")).toEqual({ owner: null, repo: "/x" });
    expect(parseRepoFullName("ada/")).toEqual({ owner: "ada", repo: "ada/" });
  });

  test("owner avatars only for real GitHub logins", () => {
    expect(githubOwnerAvatarUrl("ada-lovelace/cumulus")).toBe("https://avatars.githubusercontent.com/ada-lovelace?s=64");
    expect(githubOwnerAvatarUrl("ada/cumulus", 14)).toBe("https://avatars.githubusercontent.com/ada?s=40");
    for (const bad of ["cumulus", "-ada/x", "ada-/x", "a--b/x", "../evil/x", "evil.com/x", "a b/x", `${"a".repeat(40)}/x`, "%2e%2e/x"]) {
      expect(githubOwnerAvatarUrl(bad)).toBeNull();
    }
    expect(githubOwnerAvatarUrl(`${"a".repeat(39)}/x`)).not.toBeNull();
  });
});

describe("row status", () => {
  test("follows the shared precedence and labels", () => {
    expect(rowStatus(task("t", { status: "planned" }), 0, false)).toEqual({ kind: "approval", label: "Review plan", since: null });
    expect(rowStatus(task("t", {}, [["worker.blocked", 5]]), 0, false)?.kind).toBe("input");
    expect(rowStatus(task("t", { status: "handoff" }), 1, false)?.kind).toBe("recovering");
    expect(rowStatus(task("t", { status: "planning", createdAt: 42 }), 0, false)).toEqual({ kind: "planning", label: "Planning", since: 42 });
    expect(rowStatus(task("t", { status: "verifying" }), 0, false)?.kind).toBe("verifying");
    expect(rowStatus(task("t", { status: "failed" }), 0, false)?.kind).toBe("failed");
    expect(rowStatus(task("t", { status: "cancelled" }), 0, true)).toBeNull();
  });

  test("a merge conflict being resolved reads Resolving conflict, timed from the latest conflict", () => {
    const t = task("t", { status: "resolving" }, [["task.conflict_detected", 50], ["task.resolver_reserved", 55], ["task.conflict_detected", 90]]);
    expect(rowStatus(t, 1, false)).toEqual({ kind: "resolving", label: "Resolving conflict", since: 90 });
    expect(rowStatus(task("t", { status: "resolving" }, []), 0, false)).toEqual({ kind: "resolving", label: "Resolving conflict", since: null });
    expect(rowStatus(t, 1, false, true)?.kind).toBe("input");
  });

  test("a worker's open question to the viewer reads Needs input, even while it works", () => {
    expect(rowStatus(task("t"), 2, false, true)).toEqual({ kind: "input", label: "Needs input", since: null });
    expect(rowStatus(task("t", { status: "handoff" }), 0, false, true)?.kind).toBe("input");
    expect(rowStatus(task("t", { status: "planned" }), 0, false, true)?.kind).toBe("approval");
    expect(rowStatus(task("t", { status: "failed" }), 0, false, true)?.kind).toBe("failed");
  });

  test("running is Working with a timer only while a worker is live", () => {
    const t = task("t", { createdAt: 1 }, [["task.created", 1], ["task.planned", 10], ["worker.reserved", 20]]);
    expect(rowStatus(t, 2, false)).toEqual({ kind: "working", label: "Working", since: 20 });
    expect(rowStatus(t, 0, false)).toEqual({ kind: "waiting", label: "Waiting", since: null });
  });

  test("done only shows while unread", () => {
    expect(rowStatus(task("t", { status: "completed" }), 0, true)?.label).toBe("Done");
    expect(rowStatus(task("t", { status: "completed" }), 0, false)).toBeNull();
  });

  test("the run starts at the first reservation after the latest plan", () => {
    const replanned = task("t", { createdAt: 1 }, [["worker.reserved", 5], ["task.planned", 10], ["worker.reserved", 30], ["worker.reserved", 40]]);
    expect(runStartedAt(replanned)).toBe(30);
    expect(runStartedAt(task("t", { createdAt: 7 }, [["task.planned", 3]]))).toBe(7);
  });

  test("the run start the actor read from the whole trace wins over the view's short tail", () => {
    // The tail no longer holds the reservation; the actor still reported it.
    const tail = task("t", { createdAt: 1, runStartedAt: 30, traceTotal: 90 }, [["task.checkpointed", 80]]);
    expect(runStartedAt(tail)).toBe(30);
    expect(rowStatus(tail, 1, false)).toEqual({ kind: "working", label: "Working", since: 30 });
    expect(runStartedAt(task("t", { createdAt: 7, runStartedAt: null }, [["worker.reserved", 9]]))).toBe(7);
  });

  test("branches dedupe, active first", () => {
    const ws = (branch: string, status: "active" | "done") => ({ branch, status }) as unknown as TaskView["workstreams"][number];
    expect(taskBranches(task("t", { workstreams: [ws("a", "done"), ws("b", "active"), ws("a", "active"), ws("", "active")] }))).toEqual(["b", "a"]);
  });

  test("unread means completed after the last visit, never for unvisited", () => {
    const done = task("t", { status: "completed", updatedAt: 200 });
    expect(isUnread(done, 100)).toBe(true);
    expect(isUnread(done, 200)).toBe(false);
    expect(isUnread(done, undefined)).toBe(false);
    expect(isUnread(task("t", { updatedAt: 200 }), 100)).toBe(false);
  });
});

describe("sidebar order", () => {
  const inbox = selectInbox({
    tasks: Object.fromEntries(
      [
        task("plan", { status: "planned", updatedAt: 5 }),
        task("run", { updatedAt: 4 }),
        task("heal", { status: "handoff", updatedAt: 3 }),
        ...Array.from({ length: 12 }, (_, i) => task(`done${i}`, { status: "completed", updatedAt: 100 - i })),
      ].map((t) => [t.id, t]),
    ),
  } as WorkforceView);
  const open = { "needs-you": true, running: true, recovering: true, done: true };

  test("walks open shelves in order and pages Done", () => {
    const ids = visibleTaskIds(inbox, open, DONE_PAGE_FIRST);
    expect(ids.slice(0, 3)).toEqual(["plan", "run", "heal"]);
    expect(ids).toHaveLength(3 + DONE_PAGE_FIRST);
    expect(visibleTaskIds(inbox, { ...open, running: false, done: false }, 10)).toEqual(["plan", "heal"]);
  });

  test("previous and next stop at the ends", () => {
    const order = ["a", "b", "c"];
    expect(adjacentTaskId(order, "b", 1)).toBe("c");
    expect(adjacentTaskId(order, "b", -1)).toBe("a");
    expect(adjacentTaskId(order, "c", 1)).toBeNull();
    expect(adjacentTaskId(order, "a", -1)).toBeNull();
    expect(adjacentTaskId(order, null, 1)).toBe("a");
    expect(adjacentTaskId(order, "gone", -1)).toBe("c");
    expect(adjacentTaskId([], null, 1)).toBeNull();
  });

  test("task ids come out of team paths only", () => {
    expect(taskIdFromPath("/t/team-1/tasks/task-9")).toBe("task-9");
    expect(taskIdFromPath("/t/team-1/tasks/task-9/files")).toBe("task-9");
    expect(taskIdFromPath("/t/team-1/tasks/a%20b")).toBe("a b");
    expect(taskIdFromPath("/t/team-1/tasks/%E0%A4%A")).toBeNull();
    expect(taskIdFromPath("/t/team-1/workforce")).toBeNull();
    expect(taskIdFromPath(null)).toBeNull();
  });
});

describe("prefs", () => {
  test("shelves default open and ignore junk", () => {
    expect(parseShelves(null)).toEqual({ "needs-you": true, running: true, recovering: true, done: true });
    expect(parseShelves("{oops")).toEqual(parseShelves(null));
    expect(parseShelves('{"done":false,"running":"no"}')).toEqual({ "needs-you": true, running: true, recovering: true, done: false });
  });

  test("visits keep valid ids and sane times only", () => {
    expect(parseVisits('{"task-1":5,"bad id":5,"t2":-1,"t3":"x","t4":1e400}')).toEqual({ "task-1": 5 });
    expect(parseVisits("[1,2]")).toEqual({});
    expect(parseVisits(null)).toEqual({});
  });

  test("visits drop the oldest past the cap", () => {
    let visits = {};
    for (let i = 1; i <= VISIT_CAP + 5; i++) visits = withVisit(visits, `t${i}`, i);
    expect(Object.keys(visits)).toHaveLength(VISIT_CAP);
    expect(visits).not.toHaveProperty("t1");
    expect(visits).toHaveProperty(`t${VISIT_CAP + 5}`);
    expect(withVisit({ a: 1 }, "a", 9)).toEqual({ a: 9 });
  });
});

describe("tree keyboard", () => {
  const row = (key: string, parent?: string, expanded?: boolean) =>
    ({
      dataset: { treeKey: key, treeParent: parent },
      getAttribute: (name: string) => (name === "aria-expanded" && expanded !== undefined ? String(expanded) : null),
    }) as unknown as HTMLElement;
  const shelfOpen = row("shelf:running", undefined, true);
  const a = row("a", "shelf:running");
  const b = row("b", "shelf:running");
  const shelfClosed = row("shelf:done", undefined, false);
  const rows = [shelfOpen, a, b, shelfClosed];

  test("arrows, Home and End move focus and stop at the ends", () => {
    expect(resolveTreeKey("ArrowDown", a, rows)).toEqual({ focus: b });
    expect(resolveTreeKey("ArrowUp", a, rows)).toEqual({ focus: shelfOpen });
    expect(resolveTreeKey("ArrowUp", shelfOpen, rows)).toBeNull();
    expect(resolveTreeKey("ArrowDown", shelfClosed, rows)).toBeNull();
    expect(resolveTreeKey("Home", b, rows)).toEqual({ focus: shelfOpen });
    expect(resolveTreeKey("End", a, rows)).toEqual({ focus: shelfClosed });
    expect(resolveTreeKey("End", shelfClosed, rows)).toBeNull();
  });

  test("right opens or enters a shelf, left closes it or climbs out", () => {
    expect(resolveTreeKey("ArrowRight", shelfClosed, rows)).toEqual({ click: shelfClosed });
    expect(resolveTreeKey("ArrowRight", shelfOpen, rows)).toEqual({ focus: a });
    expect(resolveTreeKey("ArrowRight", a, rows)).toBeNull();
    expect(resolveTreeKey("ArrowLeft", shelfOpen, rows)).toEqual({ click: shelfOpen });
    expect(resolveTreeKey("ArrowLeft", b, rows)).toEqual({ focus: shelfOpen });
    expect(resolveTreeKey("ArrowLeft", shelfClosed, rows)).toBeNull();
  });

  test("space activates, other keys and unknown rows do nothing", () => {
    expect(resolveTreeKey(" ", a, rows)).toEqual({ click: a });
    expect(resolveTreeKey("x", a, rows)).toBeNull();
    expect(resolveTreeKey("ArrowDown", row("ghost"), rows)).toBeNull();
  });
});

describe("small formatters", () => {
  test("time ago", () => {
    expect(formatAgo(-5)).toBe("now");
    expect(formatAgo(59_999)).toBe("now");
    expect(formatAgo(60_000)).toBe("1m");
    expect(formatAgo(3_600_000)).toBe("1h");
    expect(formatAgo(86_400_000 * 6)).toBe("6d");
    expect(formatAgo(86_400_000 * 15)).toBe("2w");
  });

  test("flip travel is capped both ways", () => {
    expect(clampTravel(500)).toBe(MAX_TRAVEL);
    expect(clampTravel(-500)).toBe(-MAX_TRAVEL);
    expect(clampTravel(12)).toBe(12);
  });
});

describe("live workers in the inbox", () => {
  const worker = (id: string, cli: "claude" | "codex", extra: { live?: boolean; parentLeaseId?: string } = {}) =>
    ({
      lease: { id, parentLeaseId: extra.parentLeaseId },
      profile: { cli },
      workstream: null,
      live: extra.live ?? true,
    }) as unknown as import("@/lib/store").TaskWorker;

  test("a subagent is part of its parent's work, not another agent", () => {
    const workers = [worker("l-1", "claude"), worker("l-2", "codex", { parentLeaseId: "l-1" }), worker("l-3", "codex", { live: false })];
    expect(workers.filter(isLiveWorker).map((w) => w.lease.id)).toEqual(["l-1"]);
    expect(liveHarnesses(workers)).toEqual(["claude"]);
  });
});

describe("delete failures", () => {
  test("say plainly what went wrong, never internals", () => {
    expect(deleteFailure(new ApiError("not_found", "Task not found.", 404))).toBe("It was already deleted.");
    expect(deleteFailure(new ApiError("forbidden", "Only the task's creator or a team admin can delete it.", 403))).toBe("Only the task's creator or a team admin can delete it.");
    expect(deleteFailure(new Error("socket hang up at 10.0.0.3"))).toBe("Try again in a moment.");
  });
});
