// `GET /api/teams/:teamId/leases/:leaseId/log`: an ended worker's last output, why it ended and what it left. Run
// through the real app and runner against the Freestyle mock VM, like live inspect. Covers who may read it (members,
// policy, the team's own leases only), what it returns (redacted, bounded) and every way the log can be missing.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerLogResponse } from "@morrow/contracts";
import { MAX_LOG_TAIL_BYTES, relayUserFor, workerLogPath } from "../../src/integrations/freestyle/index.ts";
import { redactLogSecrets, WorkerLogArchive } from "../../src/runtime/workerLogs.ts";
import { DEFAULT_PEOPLE, logLines, makeFixture, OTHER, TEAM, type Fixture } from "./helpers.ts";

let f: Fixture;
let envId: string;
let nodeName: string;
let linuxUser: string;
let relayUser: string;
let guest: ReturnType<Fixture["fs"]["mock"]["vms"]["get"]> & {};
let seq = 0;

beforeAll(async () => {
  // `u-reader` reads for the content tests; `u-limited` alone exhausts its rate limit.
  f = await makeFixture({ people: [...DEFAULT_PEOPLE, ["u-reader", "member"], ["u-limited", "member"]] });
  const env = await f.t.deps.runtime.environments.create(TEAM, "u-owner", "Main");
  await f.settle(env.id);
  const stored = (await f.actors.getEnvironment(TEAM, env.id))!;
  envId = env.id;
  nodeName = stored.nodeName!;
  linuxUser = stored.linuxUser!;
  relayUser = relayUserFor(linuxUser);
  guest = f.fs.mock.vms.get(stored.freestyleVmId!)!;
  // Another team's ended worker, on another team's environment.
  f.actors.putEnvironment(OTHER, { id: "e-foreign", ownerUserId: "u-out", phase: "ready", nodeName: "n-foreign", linuxUser: "cu-foreign", freestyleVmId: stored.freestyleVmId! });
  f.actors.putLease(OTHER, { id: "l-foreign", nodeName: "n-foreign", state: "failed", agentName: "w-foreign-ci-e1" });
});
afterAll(() => f.close());

beforeEach(async () => {
  f.team.policy.allowInspect = true;
  const stored = (await f.actors.getEnvironment(TEAM, envId))!;
  if (stored.phase !== "awaiting_login") await f.actors.updateEnvironment(TEAM, envId, { phase: "awaiting_login" });
});

const path = (leaseId: string, team = TEAM) => `/api/teams/${team}/leases/${leaseId}/log`;

/** An ended worker of a task with a trace and a checkpoint, and its log on the VM. */
function endedWorker(opts: { log?: string | null; state?: "expired" | "failed" | "released"; endReason?: string | null } = {}) {
  const n = ++seq;
  const leaseId = `l-end-${n}`;
  const agentName = `w-task${n}-ci-e${n}`;
  const taskId = `tk-task${n}`;
  f.actors.putLease(TEAM, {
    id: leaseId,
    nodeName,
    taskId,
    workstreamId: "ws-ci",
    epoch: n,
    agentName,
    state: opts.state ?? "expired",
    endReason: opts.endReason === undefined ? "agent exited: CLI not signed in (login expired)" : opts.endReason,
    updatedAt: 1_800_000_000_000 + n,
  });
  f.actors.putTask(TEAM, {
    id: taskId,
    workstreams: [
      {
        id: "ws-ci",
        title: "CI pipeline",
        branch: `morrow/task${n}/ci`,
        status: "handoff",
        leaseId,
        lastCheckpoint: { sha: "a".repeat(40), summary: "wired the workflow ghp_abcdefghijklmnopqrstuvwxyz0123456789", epoch: n, at: 1_800_000_000_100 },
      },
    ],
    trace: [
      { at: 1, kind: "worker.ready", message: `${agentName} is running`, leaseId, profileId: null, epoch: n },
      { at: 2, kind: "task.checkpointed", message: `Checkpoint ${"b".repeat(12)} on morrow/task${n}/ci by ${agentName}`, leaseId, profileId: null, epoch: n },
      { at: 3, kind: "task.checkpointed", message: `Checkpoint ${"a".repeat(12)} on morrow/task${n}/ci by ${agentName}`, leaseId, profileId: null, epoch: n },
      { at: 4, kind: "worker.offline", message: `${agentName} exited before finishing (CLI not signed in); its workstream needs a handoff`, leaseId, profileId: null, epoch: n },
      { at: 5, kind: "worker.offline", message: "someone else's end", leaseId: "l-other", profileId: null, epoch: 99 },
    ],
  });
  if (opts.log !== null) guest.guest.writeFile(workerLogPath(linuxUser, agentName), opts.log ?? "boot\nrunning tests\nerror: not logged in\n", { owner: relayUser });
  return { leaseId, agentName, taskId };
}

async function read(who: string, leaseId: string): Promise<{ status: number; body: WorkerLogResponse & { error?: { code: string } } }> {
  const res = await f.call(who, "GET", path(leaseId));
  return { status: res.status, body: (await res.json()) as never };
}

describe("authorization: exactly like live inspect", () => {
  test("any member reads it; an outsider gets 404; no session gets 401", async () => {
    const { leaseId } = endedWorker();
    for (const who of ["u-owner", "u-admin", "u-member"]) expect((await read(who, leaseId)).status).toBe(200);
    expect((await read("u-out", leaseId)).status).toBe(404);
    expect((await f.t.request(path(leaseId), { method: "GET" })).status).toBe(401);
  });

  test("team policy off: 403 for everyone, before the lease is even looked up", async () => {
    const { leaseId } = endedWorker();
    f.team.policy.allowInspect = false;
    const res = await read("u-owner", leaseId);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("forbidden");
    expect((await read("u-member", "l-does-not-exist")).status).toBe(403);
  });

  test("another team's lease is a plain 404, from this team's path and from theirs", async () => {
    expect((await read("u-owner", "l-foreign")).status).toBe(404);
    // A member of TEAM cannot use OTHER's path either (not a member there).
    expect((await f.call("u-owner", "GET", path("l-foreign", OTHER))).status).toBe(404);
  });

  test("malformed and unknown ids are 404; a live lease is 409 (it streams)", async () => {
    for (const bad of ["..%2F..%2Fetc", "x".repeat(200), "%00"]) expect((await f.call("u-member", "GET", path(bad))).status).toBe(404);
    expect((await read("u-member", "l-nope")).status).toBe(404);
    f.actors.putLease(TEAM, { id: "l-live", nodeName, state: "running", agentName: "w-live-ci-e1" });
    const live = await read("u-member", "l-live");
    expect(live.status).toBe(409);
    expect(live.body.error?.code).toBe("conflict");
  });
});

describe("what it returns", () => {
  test("the log tail, why the worker ended, and what it left", async () => {
    const { leaseId, agentName } = endedWorker();
    const { status, body } = await read("u-reader", leaseId);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      leaseId,
      agentName,
      state: "expired",
      unavailable: null,
      log: { text: "boot\nrunning tests\nerror: not logged in\n", truncated: false, source: "vm" },
      end: {
        reason: "agent exited: CLI not signed in (login expired)",
        at: expect.any(Number),
        trace: { kind: "worker.offline", message: expect.stringContaining("(CLI not signed in)") },
      },
      contribution: { workstreamId: "ws-ci", workstreamTitle: "CI pipeline", checkpoints: 2, completed: false, lastCheckpoint: { sha: "a".repeat(40) } },
    });
    // Agent text is redacted too.
    expect(body.contribution!.lastCheckpoint!.summary).toBe("wired the workflow ghp_[redacted]");
    expect((await f.call("u-reader", "GET", path(leaseId))).headers.get("cache-control")).toBe("no-store");
  });

  test("leases that ended before reasons were kept: null reason, the trace still says", async () => {
    const { leaseId } = endedWorker({ endReason: null, state: "failed" });
    const { body } = await read("u-reader", leaseId);
    expect(body.end.reason).toBeNull();
    expect(body.end.trace?.kind).toBe("worker.offline");
  });

  test("secrets in the log never leave: the live stream's filter plus vendor tokens", async () => {
    const secrets = [
      "rk_live_abcdefghijklmnop0123",
      "gho_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghp_short123456",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "sk-proj-abcdefghij",
      "sk_live_51Habcdefghijklmnop",
      "AKIAABCDEFGHIJKLMNOP",
      "xoxb-1234-5678-abcdefgh",
      "AIzaSyA1234567890abcdefghijklmnopqrstu",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    ];
    const log = [...secrets.map((s) => `token=${s}`), '{"access_token":"plain-secret-value"}', "Authorization: Bearer abcdefghijklmnopqrstuvwx", "\u001b[31mred text\u001b[0m"].join("\n");
    const { leaseId } = endedWorker({ log: `${log}\n` });
    const { body } = await read("u-reader", leaseId);
    const text = body.log!.text;
    for (const s of secrets) expect(text).not.toContain(s.slice(-10));
    expect(text).not.toContain("plain-secret-value");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwx");
    // ANSI is kept for the terminal view.
    expect(text).toContain("\u001b[31mred text\u001b[0m");
    // Nor do they reach the backend's own logs.
    for (const s of secrets) expect(logLines.join("\n")).not.toContain(s);
  });

  test("size cap: only the last 64 KiB, cut at a line", async () => {
    const line = (i: number) => `line ${String(i).padStart(6, "0")} ${"x".repeat(80)}\n`;
    const big = Array.from({ length: 2000 }, (_, i) => line(i)).join("");
    const { leaseId } = endedWorker({ log: big });
    const { body } = await read("u-reader", leaseId);
    expect(body.log!.truncated).toBe(true);
    expect(body.log!.size).toBe(Buffer.byteLength(big));
    expect(Buffer.byteLength(body.log!.text)).toBeLessThanOrEqual(MAX_LOG_TAIL_BYTES);
    expect(body.log!.text.endsWith(line(1999))).toBe(true);
    expect(body.log!.text.startsWith("line ")).toBe(true);
  });
});

describe("failure modes: a reason code, never a 5xx", () => {
  test("no log file on the VM: log_missing", async () => {
    const { leaseId } = endedWorker({ log: null });
    const { status, body } = await read("u-reader", leaseId);
    expect(status).toBe(200);
    expect(body).toMatchObject({ log: null, unavailable: "log_missing", end: { reason: expect.any(String) } });
  });

  test("a planted or swapped file is refused, not read: log_refused", async () => {
    const { leaseId, agentName } = endedWorker({ log: "secret" });
    guest.guest.files.get(workerLogPath(linuxUser, agentName))!.symlink = true;
    expect((await read("u-reader", leaseId)).body).toMatchObject({ log: null, unavailable: "log_refused" });
  });

  test("paused VM: never woken; the archived copy if there is one, else environment_paused", async () => {
    const fresh = endedWorker({ log: null });
    const seen = endedWorker({ log: "seen before the pause\n" });
    expect((await read("u-reader", seen.leaseId)).body.log?.source).toBe("vm");
    await f.actors.updateEnvironment(TEAM, envId, { phase: "paused" });
    expect((await read("u-reader", fresh.leaseId)).body).toMatchObject({ log: null, unavailable: "environment_paused" });
    expect((await read("u-reader", seen.leaseId)).body).toMatchObject({ unavailable: null, log: { text: "seen before the pause\n", source: "archive" } });
  });

  test("provisioning or errored VM: environment_unavailable", async () => {
    const { leaseId } = endedWorker({ log: null });
    await f.actors.updateEnvironment(TEAM, envId, { phase: "error" });
    expect((await read("u-reader", leaseId)).body.unavailable).toBe("environment_unavailable");
  });

  test("environment gone (no environment on that node): environment_gone, end reason still shown", async () => {
    const n = ++seq;
    f.actors.putLease(TEAM, { id: `l-gone-${n}`, nodeName: "n-000000000000", state: "failed", agentName: `w-gone-ci-e${n}`, endReason: "spawn failed" });
    const { status, body } = await read("u-reader", `l-gone-${n}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ log: null, unavailable: "environment_gone", end: { reason: "spawn failed" }, contribution: null });
  });

  test("Freestyle or the VM not answering: vm_unreachable", async () => {
    const n = ++seq;
    f.actors.putEnvironment(TEAM, { id: `e-broken-${n}`, ownerUserId: "u-owner", phase: "ready", nodeName: `n-broken${n}`, linuxUser, freestyleVmId: "vm-does-not-exist" });
    f.actors.putLease(TEAM, { id: `l-broken-${n}`, nodeName: `n-broken${n}`, state: "expired", agentName: `w-broken-ci-e${n}` });
    const { status, body } = await read("u-reader", `l-broken-${n}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ log: null, unavailable: "vm_unreachable" });
  });

  test("the task cannot be read: the log still comes back, without contribution", async () => {
    const { leaseId } = endedWorker();
    const original = f.actors.getTask;
    f.actors.getTask = async () => {
      throw new Error("actor down");
    };
    try {
      const { status, body } = await read("u-reader", leaseId);
      expect(status).toBe(200);
      expect(body).toMatchObject({ contribution: null, end: { trace: null }, log: { source: "vm" } });
    } finally {
      f.actors.getTask = original;
    }
  });
});

describe("cost and abuse bounds", () => {
  test("concurrent readers of one worker share one VM read", async () => {
    const { leaseId } = endedWorker();
    const runs = { n: 0 };
    const vms = f.fs.client.vms;
    const ref = vms.ref.bind(vms);
    vms.ref = ((id: string) => {
      runs.n += 1;
      return ref(id);
    }) as typeof vms.ref;
    try {
      const results = await Promise.all(["u-owner", "u-admin", "u-member"].map((who) => read(who, leaseId)));
      for (const r of results) expect(r.body.log?.source).toBe("vm");
      expect(runs.n).toBe(1);
    } finally {
      vms.ref = ref;
    }
  });

  test("rate limited per user (each read can be a VM exec)", async () => {
    const { leaseId } = endedWorker();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await f.call("u-limited", "GET", path(leaseId))).status);
    expect(statuses).toContain(429);
    // Another member is not affected.
    expect((await read("u-reader", leaseId)).status).toBe(200);
  });

  test("the archive is bounded by entries and by characters, oldest out first", () => {
    const archive = new WorkerLogArchive({ maxEntries: 3, maxChars: 100 });
    const tail = (text: string) => ({ text, truncated: false, size: text.length, modifiedAt: new Date(0).toISOString() });
    for (const name of ["a", "b", "c", "d"]) archive.remember("t", name, tail("x".repeat(10)));
    expect(archive.size).toBe(3);
    expect(archive.get("t", "a")).toBeNull();
    archive.remember("t", "big", tail("y".repeat(90)));
    expect(archive.chars).toBeLessThanOrEqual(100);
    expect(archive.get("t", "big")?.text).toHaveLength(90);
    // Larger than the whole budget: not kept, nothing evicted for it.
    archive.remember("t", "huge", tail("z".repeat(101)));
    expect(archive.get("t", "huge")).toBeNull();
    expect(archive.get("t", "big")).not.toBeNull();
    // Stored redacted, keyed by team.
    archive.remember("t", "s", tail("rk_live_abcdefghijklmnop0123"));
    expect(archive.get("t", "s")?.text).toBe("rk_live_[redacted]");
    expect(archive.get("other", "s")).toBeNull();
  });

  test("redaction leaves ordinary text alone", () => {
    const plain = "task-runner ok; desk-check passed; skipped 3 tests; ghost_text fine";
    expect(redactLogSecrets(plain)).toBe(plain);
  });
});
