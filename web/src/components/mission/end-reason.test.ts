import { describe, expect, test } from "bun:test";
import type { LeaseView, TaskView, TraceEntry, WorkerLogResponse } from "@morrow/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EndedLogView, endedWhy } from "./ended-log";
import { endingEntry, leaseWhy, plainWhy, recordedDetail, UNAVAILABLE_TEXT } from "./end-reason";
import { rememberTaskDetail } from "./use-task-detail";
import { WorkerList, type WorkerRowData } from "./worker-list";
import { workerState } from "./workers";

const entry = (kind: TraceEntry["kind"], message: string, leaseId: string | null = "l-1", at = 1): TraceEntry => ({ at, kind, message, leaseId, profileId: null, epoch: 1 });

describe("plain words for why a worker ended", () => {
  test("pulls the recorded part out of trace messages and end reasons", () => {
    expect(recordedDetail("w-x exited before finishing (CLI not signed in); its workstream needs a handoff")).toBe("CLI not signed in");
    expect(recordedDetail("w-x exited before finishing; its workstream needs a handoff")).toBeNull();
    expect(recordedDetail("w-x failed to start: never reported running")).toBe("never reported running");
    expect(recordedDetail("Could not start w-x: Start worker: Relay refused the request")).toBe("Start worker: Relay refused the request");
    expect(recordedDetail("agent exited: missing from Relay")).toBe("missing from Relay");
    expect(recordedDetail("[detected] ada's Claude (claude) hit a usage limit: resets 5pm")).toBe("ada's Claude (claude) hit a usage limit: resets 5pm");
  });

  test("maps what the system recorded to a short phrase a member can act on", () => {
    const cases: [string, string][] = [
      ["agent exited: CLI not signed in (login expired)", "CLI not signed in"],
      ["agent exited: process exited; log: Please run /login", "CLI not signed in"],
      ["usage limit (detected)", "Hit a usage limit"],
      ["agent exited: missing from Relay", "Lost by Relay (missing from its list)"],
      ["agent exited: its VM stopped reporting", "Its VM stopped responding"],
      ["spawn failed: never reported running", "Never started"],
      ["did not start in time", "Never started"],
      ["agent exited: process exited (exit code 137)", "Exited with code 137"],
      ["agent exited: crashed, then its VM stopped reporting", "Its VM stopped responding"],
      ["spawn failed: Start worker: Relay refused the request", "Failed to start"],
      ["profile removed", "Its CLI profile was removed"],
      ["task cancelled", "Cancelled"],
      ["workstream completed", "Finished its workstream"],
      ["agent exited", "Exited before finishing"],
    ];
    for (const [recorded, text] of cases) expect({ recorded, text: plainWhy(recorded)?.text }).toEqual({ recorded, text });
    expect(plainWhy("")).toBeNull();
    expect(plainWhy(null)).toBeNull();
    // Unknown text is shown as recorded, bounded.
    expect(plainWhy("something new happened")).toEqual({ text: "something new happened", detail: "something new happened" });
    expect(plainWhy("z".repeat(300))!.text.length).toBeLessThanOrEqual(80);
  });

  test("finds the entry that ended this lease, never a replacement's handoff or another lease's end", () => {
    const trace = [
      entry("worker.ready", "w-x is running"),
      entry("worker.offline", "w-x exited before finishing (CLI not signed in); its workstream needs a handoff", "l-1", 5),
      entry("task.handoff_requested", "Handing ci from e1 to ...", "l-2", 6),
      entry("worker.offline", "w-y exited before finishing (missing from Relay); its workstream needs a handoff", "l-2", 7),
    ];
    expect(endingEntry(trace, "l-1")?.at).toBe(5);
    expect(leaseWhy(trace, "l-1")).toEqual({ text: "CLI not signed in", detail: "CLI not signed in" });
    expect(leaseWhy(trace, "l-2")?.text).toBe("Lost by Relay (missing from its list)");
    expect(leaseWhy(trace, "l-3")).toBeNull();
    expect(leaseWhy(undefined, "l-1")).toBeNull();
    // Older exits recorded nothing: say so instead of guessing.
    expect(leaseWhy([entry("worker.offline", "w-x exited before finishing; its workstream needs a handoff")], "l-1")).toEqual({
      text: "Exited before finishing",
      detail: "No reason was recorded.",
    });
    expect(leaseWhy([entry("task.cancelled", "Cancelled by ada")], "l-1")?.text).toBe("Cancelled");
  });

  test("every log reason code has words", () => {
    for (const value of Object.values(UNAVAILABLE_TEXT)) {
      expect(value.title.length).toBeGreaterThan(0);
      expect(value.description).not.toContain("—");
    }
  });
});

describe("worker rows say why", () => {
  const lease = (state: LeaseView["state"]): LeaseView => ({
    id: "l-1",
    taskId: "tk-why",
    workstreamId: "ws-1",
    profileId: "cp-1",
    epoch: 1,
    agentName: "w-why-ci-e1",
    nodeName: "n-1",
    state,
    createdAt: 1,
  });
  const task = { id: "tk-why", status: "running", workstreams: [{ id: "ws-1", branch: "b", status: "handoff", leaseId: "l-2" }] } as unknown as TaskView;
  const trace = [entry("worker.blocked", "Could not start w-why-ci-e1: Start worker: Claude Code is not signed in")];

  test("from a trace it is given, or from the detail this tab loaded", () => {
    const failed = { lease: lease("failed"), profile: null, workstream: null, live: false };
    expect(workerState(failed, task, false, trace)).toEqual({
      kind: "failed",
      why: { text: "CLI not signed in", detail: "Start worker: Claude Code is not signed in" },
    });
    // Nothing loaded yet: no reason, no guess.
    expect(workerState(failed, task)).toEqual({ kind: "failed" });
    rememberTaskDetail("t-1", { id: "tk-why", updatedAt: 1, trace } as never);
    expect(workerState(failed, task)).toMatchObject({ kind: "failed", why: { text: "CLI not signed in" } });
    const expired = { lease: lease("expired"), profile: null, workstream: null, live: false };
    expect(workerState(expired, task, false, [entry("worker.offline", "w exited before finishing (missing from Relay); its workstream needs a handoff")])).toMatchObject({
      kind: "stopped",
      reason: "Handed off",
      why: { text: "Lost by Relay (missing from its list)" },
    });
  });

  test("the row shows it under the name, with what was recorded for hover and screen readers", () => {
    const row: WorkerRowData = {
      key: "l-1",
      agentName: "w-why-ci-e1",
      label: "ci e1",
      cli: "claude",
      owner: null,
      ownership: "ada's Claude Code",
      vm: null,
      state: { kind: "failed", why: { text: "CLI not signed in", detail: "Start worker: Claude Code is not signed in" } },
      profileLabel: null,
    };
    const html = renderToStaticMarkup(createElement(WorkerList, { rows: [row], selected: null, onSelect: () => {} }));
    expect(html).toContain("Why:");
    expect(html).toContain("CLI not signed in");
    expect(html).toContain('title="Start worker: Claude Code is not signed in"');
    expect(html).toContain("text-danger");
    const plain = renderToStaticMarkup(createElement(WorkerList, { rows: [{ ...row, state: { kind: "failed" } }], selected: null, onSelect: () => {} }));
    expect(plain).not.toContain("Why:");
  });
});

describe("the Log tab for an ended worker", () => {
  const response = (patch: Partial<WorkerLogResponse> = {}): WorkerLogResponse => ({
    leaseId: "l-1",
    agentName: "w-why-ci-e9",
    state: "expired",
    end: { reason: "agent exited: CLI not signed in (login expired)", at: 1_800_000_000_000, trace: null },
    contribution: {
      workstreamId: "ws-1",
      workstreamTitle: "CI",
      branch: "morrow/abcd1234/ci",
      checkpoints: 2,
      lastCheckpoint: { sha: "0123456789abcdef0123456789abcdef01234567", summary: "wired the workflow", at: 1 },
      completed: false,
    },
    log: { text: "boot\nerror: not logged in\n", truncated: false, size: 25, modifiedAt: new Date(0).toISOString(), source: "vm" },
    unavailable: null,
    ...patch,
  });
  const render = (data: WorkerLogResponse) =>
    renderToStaticMarkup(createElement(EndedLogView, { data, terminal: createElement("pre", { "data-testid": "terminal" }, data.log?.text ?? "") }));

  test("header: ended, last output, why, and what it left; then the log", () => {
    const html = render(response());
    expect(html).toContain("Stopped");
    expect(html).toContain("last output");
    expect(html).toContain("Why: CLI not signed in.");
    expect(html).toContain("2 checkpoints");
    expect(html).toContain("0123456");
    expect(html).toContain("morrow/abcd1234/ci");
    expect(html).toContain('data-testid="terminal"');
    expect(html).toContain("error: not logged in");
  });

  test("a failed start with no checkpoints, from the trace when no reason was kept", () => {
    const data = response({
      state: "failed",
      end: { reason: null, at: null, trace: { kind: "worker.blocked", message: "w-x failed to start: never reported running", at: 1 } },
      contribution: { workstreamId: "ws-1", workstreamTitle: null, branch: null, checkpoints: 0, lastCheckpoint: null, completed: false },
    });
    expect(endedWhy(data)?.text).toBe("Never started");
    const html = render(data);
    expect(html).toContain("Failed");
    expect(html).toContain("No checkpoints");
  });

  test("log unavailable: the reason in words instead of the terminal, the header still says why", () => {
    for (const code of ["environment_paused", "environment_gone", "log_missing", "vm_unreachable"] as const) {
      const html = render(response({ log: null, unavailable: code }));
      expect(html).toContain(UNAVAILABLE_TEXT[code].title.replace("'", "&#x27;"));
      expect(html).not.toContain('data-testid="terminal"');
      expect(html).toContain("Why: CLI not signed in.");
    }
  });

  test("no reason anywhere: says so; archived copy and cut output are labelled", () => {
    const html = render(
      response({
        end: { reason: null, at: null, trace: null },
        log: { text: "x\n", truncated: true, size: 99_999, modifiedAt: new Date(0).toISOString(), source: "archive" },
      }),
    );
    expect(html).toContain("No reason was recorded");
    expect(html).toContain("copy kept from its last read");
    expect(html).toContain("Older output was cut");
  });
});
