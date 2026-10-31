// `/realtime/inspect/:leaseId` through the real server dispatch: who may open it, what it streams, and
// when it ends. The worker log lives on a Freestyle mock VM.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { InspectFrame } from "@morrow/contracts";
import { relayUserFor, workerLogPath } from "../../src/integrations/freestyle/index.ts";
import { redactSecrets } from "../../src/runtime/inspect.ts";
import { startServer, type RunningServer } from "../../src/server.ts";
import { ORIGIN } from "../support/app.ts";
import { makeFixture, TEAM, waitFor, type Fixture } from "./helpers.ts";
import { screenOf } from "./screen.ts";

const AGENT = "w-task1-be-e1";
let f: Fixture;
let server: RunningServer;
let base: string;
let logPath: string;
let guest: ReturnType<Fixture["fs"]["mock"]["vms"]["get"]> & {};
let linuxUser: string;
/** The broker's account owns the worker logs; the log reader runs as it. */
let relayUser: string;
let leaseSeq = 0;
let lease = "";

beforeAll(async () => {
  f = await makeFixture({ timing: { inspectPollMs: 20 } });
  const env = await f.t.deps.runtime.environments.create(TEAM, "u-owner", "Main");
  await f.settle(env.id);
  const stored = (await f.actors.getEnvironment(TEAM, env.id))!;
  linuxUser = stored.linuxUser!;
  relayUser = relayUserFor(linuxUser);
  guest = f.fs.mock.vms.get(stored.freestyleVmId!)!;
  logPath = workerLogPath(linuxUser, AGENT);
  server = startServer(f.t.deps, { port: 0, hostname: "127.0.0.1" });
  base = `ws://127.0.0.1:${server.url.port}/realtime/inspect/`;
});
afterAll(async () => {
  await server.shutdown("test");
  await f.close();
});

beforeEach(async () => {
  lease = `l-${++leaseSeq}`;
  const stored = (await f.actors.listEnvironments(TEAM))[0]!;
  f.actors.putLease(TEAM, { id: lease, nodeName: stored.nodeName!, agentName: AGENT });
  guest.guest.writeFile(logPath, "boot\r\nready\r\n", { owner: relayUser });
  f.team.policy.allowInspect = true;
});

const ticketFor = (userId: string, leaseId = lease) => f.t.deps.tickets.issue(userId, TEAM, { purpose: "inspect", leaseId }).ticket;

/** The upgrade request as a plain fetch, to read the rejection status. */
async function upgradeStatus(leaseId: string, ticket: string, origin = ORIGIN): Promise<number> {
  const res = await fetch(`${base.replace("ws://", "http://")}${leaseId}?ticket=${encodeURIComponent(ticket)}`, {
    headers: { upgrade: "websocket", connection: "Upgrade", origin, "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" },
  });
  return res.status;
}

function connect(ticket: string, leaseId = lease) {
  const frames: InspectFrame[] = [];
  const ws = new WebSocket(`${base}${leaseId}?ticket=${encodeURIComponent(ticket)}`, { headers: { origin: ORIGIN } } as never);
  let closed: { code: number } | null = null;
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as InspectFrame);
  ws.onclose = (e) => (closed = { code: e.code });
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
  return { ws, frames, opened, closed: () => closed };
}

const output = (frames: InspectFrame[]) => frames.filter((x): x is Extract<InspectFrame, { kind: "inspect.output" }> => x.kind === "inspect.output");
const idle = { leases: 0, sockets: 0, streaming: 0, polling: 0 };

describe("inspect authorization (before upgrade)", () => {
  test("a realtime ticket does not open inspect, and is burned trying", async () => {
    const realtime = f.t.deps.tickets.issue("u-member", TEAM).ticket;
    expect(await upgradeStatus(lease, realtime)).toBe(401);
    expect(f.t.deps.tickets.consume(realtime)).toBeNull();
  });

  test("a ticket for one lease does not open another", async () => {
    const other = `l-other-${leaseSeq}`;
    f.actors.putLease(TEAM, { id: other, nodeName: (await f.actors.listEnvironments(TEAM))[0]!.nodeName! });
    expect(await upgradeStatus(other, ticketFor("u-member", lease))).toBe(401);
  });

  test("a foreign origin is refused without burning the ticket", async () => {
    const ticket = ticketFor("u-member");
    expect(await upgradeStatus(lease, ticket, "https://evil.example")).toBe(403);
    const ok = connect(ticket);
    await ok.opened;
    ok.ws.close();
  });

  test("tickets are single use", async () => {
    const ticket = ticketFor("u-member");
    const first = connect(ticket);
    await first.opened;
    first.ws.close();
    expect(await upgradeStatus(lease, ticket)).toBe(401);
  });

  test("a non-member holding a ticket for the team gets 404", async () => {
    expect(await upgradeStatus(lease, ticketFor("u-out"))).toBe(404);
  });

  test("a finished lease gets 404", async () => {
    f.actors.leases.get(TEAM)!.get(lease)!.state = "released";
    expect(await upgradeStatus(lease, ticketFor("u-member"))).toBe(404);
  });

  test("team policy off gets 403", async () => {
    f.team.policy.allowInspect = false;
    expect(await upgradeStatus(lease, ticketFor("u-member"))).toBe(403);
  });

  test("garbage lease ids and missing tickets are refused", async () => {
    expect(await upgradeStatus("..%2F..%2Fetc", ticketFor("u-member"))).toBe(404);
    expect(await upgradeStatus(lease, "")).toBe(401);
  });
});

describe("inspect stream", () => {
  test("hello with the PTY size, the current screen, then only new bytes; input is dropped; ends with the lease", async () => {
    const execsBefore = f.fs.mock.execLog.length;
    const s = connect(ticketFor("u-member"));
    await s.opened;
    await waitFor(() => output(s.frames).length >= 1, 2_000, "backlog");
    expect(s.frames[0]).toEqual({ kind: "inspect.hello", leaseId: lease, agentName: AGENT, cols: 80, rows: 40 });
    expect(output(s.frames)[0]!.reset).toBe(true);
    expect(await screenOf(output(s.frames))).toEqual(["boot", "ready"]);

    s.ws.send("rm -rf / \n");
    guest.guest.writeFile(logPath, "boot\r\nready\r\nstep 1\r\n", { owner: relayUser });
    await waitFor(() => output(s.frames).length >= 2, 2_000, "delta");
    expect(output(s.frames)[1]).toEqual({ kind: "inspect.output", data: "step 1\r\n", reset: false });
    await Bun.sleep(80);
    expect(output(s.frames).length).toBe(2);
    // The only thing run on the VM is the log reader, as the broker's user; nothing typed reached it.
    const execs = f.fs.mock.execLog.slice(execsBefore);
    expect(execs.length).toBeGreaterThan(0);
    for (const e of execs) expect(e).toMatchObject({ script: "logtail", body: { linuxUser: relayUser } });

    f.actors.leases.get(TEAM)!.get(lease)!.state = "released";
    await waitFor(() => s.closed() !== null, 2_000, "close");
    expect(s.frames.at(-1)).toEqual({ kind: "inspect.end", reason: "lease_ended" });
    expect(f.t.deps.runtime.inspect.stats()).toEqual(idle);
  });

  test("viewers share one poller; a removed member is cut off at once", async () => {
    const a = connect(ticketFor("u-member"));
    const b = connect(ticketFor("u-admin"));
    await Promise.all([a.opened, b.opened]);
    await waitFor(() => output(a.frames).length >= 1 && output(b.frames).length >= 1, 2_000, "backlogs");
    expect(f.t.deps.runtime.inspect.stats()).toEqual({ leases: 1, sockets: 2, streaming: 0, polling: 1 });

    // Fired and not awaited, as the members route does (the Relay cleanup that follows is not under test here).
    void f.t.deps.teamEvents.emitMemberRemoved({ teamId: TEAM, userId: "u-member", removedBy: "u-owner" });
    await waitFor(() => a.closed() !== null, 2_000, "member cut off");
    expect(a.frames.at(-1)).toEqual({ kind: "inspect.end", reason: "not_authorized" });
    expect(b.closed()).toBeNull();
    b.ws.close();
    await waitFor(() => f.t.deps.runtime.inspect.stats().sockets === 0, 2_000, "all closed");
  });

  test("sign-out everywhere ends that user's inspect streams at once", async () => {
    const a = connect(ticketFor("u-member"));
    const b = connect(ticketFor("u-admin"));
    await Promise.all([a.opened, b.opened]);
    const res = await f.call("u-member", "POST", "/api/auth/logout?everywhere=1");
    expect(res.status).toBe(204);
    await waitFor(() => a.closed() !== null, 2_000, "signed-out user cut off");
    expect(a.frames.at(-1)).toEqual({ kind: "inspect.end", reason: "not_authorized" });
    expect(b.closed()).toBeNull();
    b.ws.close();
    await waitFor(() => f.t.deps.runtime.inspect.stats().sockets === 0, 2_000, "all closed");
  });

  test("credentials a worker prints are masked before they reach members", async () => {
    guest.guest.writeFile(logPath, "env: RELAY_API_KEY=rk_live_SECRET123 GH_TOKEN=gho_SECRET456\r\n", { owner: relayUser });
    const s = connect(ticketFor("u-member"));
    await s.opened;
    await waitFor(() => output(s.frames).length >= 1, 2_000, "backlog");
    expect(await screenOf(output(s.frames))).toEqual(["env: RELAY_API_KEY=rk_live_[redacted] GH_TOKEN=gho_[redacted]"]);
    expect(JSON.stringify(s.frames)).not.toContain("SECRET");
    s.ws.close();
    await waitFor(() => f.t.deps.runtime.inspect.stats().sockets === 0, 2_000, "closed");
  });

  test("a log that is not a regular file owned by the broker's user is never read", async () => {
    // Root, or the engineer (whose workers run as them), never owns a real worker log.
    for (const owner of ["root", linuxUser]) {
      guest.guest.writeFile(logPath, "planted\n", { owner });
      const s = connect(ticketFor("u-member"));
      await s.opened;
      await waitFor(() => s.closed() !== null, 2_000, "close");
      expect(s.frames.at(-1)).toEqual({ kind: "inspect.end", reason: "unavailable" });
      expect(output(s.frames)).toEqual([]);
    }
  });
});

describe("redactSecrets", () => {
  test("masks CLI login files and OpenAI-style tokens a test could print", () => {
    const codexAuth = JSON.stringify({
      OPENAI_API_KEY: "sk-proj-AAAAbbbbCCCCdddd1234",
      tokens: { id_token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl", access_token: "opaque-access-value", refresh_token: "rt_AbCdEfGhIjKlMnOpQrSt", account_id: "acct-1" },
    });
    const claudeCreds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-SECRET", refreshToken: "sk-ant-ort01-SECRET", expiresAt: 1 } });
    const bare = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig_part-1 and rt_ZZZZZZZZZZZZZZZZZZZZ";
    const out = redactSecrets([codexAuth, claudeCreds, bare].join("\n"));
    for (const secret of ["AAAAbbbb", "c2lnbmF0dXJl", "opaque-access-value", "AbCdEfGhIjKl", "oat01-SECRET", "ort01-SECRET", "eyJhIjoxfQ", "ZZZZZZZZ"]) {
      expect(out).not.toContain(secret);
    }
    // Ids and timestamps that are not secrets stay readable.
    expect(out).toContain('"account_id":"acct-1"');
    expect(out).toContain('"expiresAt":1');
  });

  test("leaves ordinary words alone", () => {
    const text = "task-runner rt_sigaction sk-learn eyJ alone, a.b.c, ask-me";
    expect(redactSecrets(text)).toBe(text);
  });

  test("masks Relay, GitHub and Anthropic credential shapes, keeps the rest", () => {
    const text = [
      "RELAY_API_KEY=rk_live_AbC123_-xyz",
      '{"token":"at_live_q1"} nt_live_n ot_live_o',
      "GH_TOKEN=gho_abcdefABCDEF0123 ghp_x ghu_y ghs_z ghr_w github_pat_11AA_bb",
      "ANTHROPIC_API_KEY=sk-ant-api03-AAAA_bbbb",
      "plain words: high_score ghost_town rk_live",
    ].join("\n");
    const out = redactSecrets(text);
    for (const secret of ["AbC123", "q1", "nt_live_n\b", "abcdefABCDEF0123", "11AA_bb", "api03-AAAA"]) expect(out).not.toMatch(new RegExp(secret));
    expect(out).toContain("rk_live_[redacted]");
    expect(out).toContain("gho_[redacted] ghp_[redacted] ghu_[redacted] ghs_[redacted] ghr_[redacted] github_pat_[redacted]");
    expect(out).toContain("sk-ant-[redacted]");
    expect(out).toContain("plain words: high_score ghost_town rk_live");
  });
});
