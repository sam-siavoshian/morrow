// followWorkerLog through the real Freestyle SDK against the mock's PTY WebSocket: what it opens (as whom, which
// command), how it reads the follower's lines, and that every way it ends kills the session. The script itself runs
// for real in test/vm/logfollow-docker.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { followCommand, followWorkerLog, type FollowEnd, type LogFollower } from "../../src/integrations/freestyle/index.ts";
import { loadVmScript } from "../../src/integrations/freestyle/exec.ts";
import type { MockPty } from "../fixtures/freestyle-mock/server.ts";
import { waitFor } from "../runtime/helpers.ts";
import { useMock } from "./helpers.ts";

const USER = "u0123456789ab";
const RELAY = "r0123456789ab";
const AGENT = "w-task1-be-e1";

let ctx: ReturnType<typeof useMock>;
let vmId: string;
beforeEach(async () => {
  ctx = useMock();
  ({ vmId } = await ctx.client.vms.create({ firewall: { rules: [] } }));
});
afterEach(() => ctx.restore());

function follow(overrides: Partial<Parameters<typeof followWorkerLog>[0]> = {}) {
  const events: Array<{ start: number; size: number } | { bytes: string; offset: number } | FollowEnd> = [];
  const ended: FollowEnd[] = [];
  const opened = followWorkerLog({
    client: ctx.client,
    vmId,
    linuxUser: USER,
    agentName: AGENT,
    start: null,
    backlogBytes: 65_536,
    onStart: (at) => events.push(at),
    onBytes: (bytes, offset) => events.push({ bytes: Buffer.from(bytes).toString(), offset }),
    onEnd: (end) => {
      events.push(end);
      ended.push(end);
    },
    ...overrides,
  });
  return { opened, events, ended };
}

const session = (): MockPty => [...ctx.mock.vms.get(vmId)!.pty.values()].at(-1)!;
const say = (line: string) => ctx.mock.ptyOutput(vmId, session().id, line);
const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("followWorkerLog", () => {
  test("runs logfollow.sh in a PTY as the broker's user, never the engineer or root, with checked arguments only", async () => {
    const f = follow({ start: 1234, backlogBytes: 4096, lifetimeSec: 60 });
    const follower = await f.opened;
    const s = session();
    expect(s.linuxUser).toBe(RELAY);
    expect(s.exec).toBe(followCommand(await loadVmScript("logfollow"), { agentName: AGENT, start: 1234, backlogBytes: 4096, lifetimeSec: 60 }));
    const m = s.exec!.match(/^exec \/bin\/bash -c "\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| gzip -dc\)" morrow-logfollow (\S+) (\S+) (\S+) (\S+)$/)!;
    expect(m.slice(2)).toEqual([AGENT, "1234", "4096", "60"]);
    // The inline script is logfollow.sh, minus comments and indentation.
    const inline = gunzipSync(Buffer.from(m[1]!, "base64")).toString();
    expect(inline).toContain('log="/var/lib/morrow/relay/$me/relay-node/.agentworkforce/relay/team/worker-logs/$name.log"');
    expect(inline).not.toContain("# ");
    await follower.stop();
  });

  test("refuses anything that could become shell syntax before opening anything", async () => {
    const script = await loadVmScript("logfollow");
    for (const agentName of ["w;id", "$(id)", "a b", "", "-rf"]) {
      expect(() => followCommand(script, { agentName, start: null, backlogBytes: 1, lifetimeSec: 60 })).toThrow();
    }
    for (const start of [-1, 1.5, Number.NaN, 2 ** 60]) expect(() => followCommand(script, { agentName: AGENT, start, backlogBytes: 1, lifetimeSec: 60 })).toThrow();
    expect(() => followCommand(script, { agentName: AGENT, start: null, backlogBytes: 10_000_000, lifetimeSec: 60 })).toThrow();
    expect(() => followCommand(script, { agentName: AGENT, start: null, backlogBytes: 1, lifetimeSec: 1 })).toThrow();
    await expect(followWorkerLog({ client: ctx.client, vmId, linuxUser: "root", agentName: AGENT, start: null, backlogBytes: 1, onStart() {}, onBytes() {}, onEnd() {} })).rejects.toThrow();
    await expect(followWorkerLog({ client: ctx.client, vmId: "../x", linuxUser: USER, agentName: AGENT, start: null, backlogBytes: 1, onStart() {}, onBytes() {}, onEnd() {} })).rejects.toThrow();
    expect(ctx.mock.vms.get(vmId)!.pty.size).toBe(0);
  });

  test("hello, then bytes in order across split chunks and CRLF; ignores the guest's own noise", async () => {
    const f = follow();
    const follower = await f.opened;
    say("Welcome to Ubuntu\r\n");
    say('{"v":1,"start":5,"size":12}\r\n{"o":5,"d":"');
    say(`${b64("hello ")}"}\n{"o":11,"d":"${b64("w")}"}`);
    say("\n");
    await waitFor(() => f.events.length >= 3, 2_000, "frames");
    expect(f.events).toEqual([{ start: 5, size: 12 }, { bytes: "hello ", offset: 5 }, { bytes: "w", offset: 11 }]);
    // A heartbeat keeps it alive and says nothing.
    say('{"hb":12}\n');
    await Bun.sleep(30);
    expect(f.events.length).toBe(3);
    await follower.stop();
    expect(ctx.mock.vms.get(vmId)!.pty.size).toBe(0);
    expect(f.ended).toEqual([]);
  });

  test("a gap, a foreign frame or an unparseable line ends it, and the session is killed", async () => {
    for (const bad of [`{"o":99,"d":"${b64("x")}"}`, '{"o":0,"d":"!!"}', '{"exec":"rm -rf /"}', "{nope"]) {
      const f = follow();
      await f.opened;
      say('{"v":1,"start":0,"size":1}\n');
      say(`${bad}\n`);
      await waitFor(() => f.ended.length === 1, 2_000, `end on ${bad}`);
      expect(f.ended[0]!.reason).toBe("protocol");
      await waitFor(() => ctx.mock.vms.get(vmId)!.pty.size === 0, 2_000, "session killed");
    }
  });

  test("bytes before a hello are a protocol error", async () => {
    const f = follow();
    await f.opened;
    say(`{"o":0,"d":"${b64("x")}"}\n`);
    await waitFor(() => f.ended.length === 1, 2_000, "end");
    expect(f.ended[0]!.reason).toBe("protocol");
  });

  test("the script's own ends pass through; unsafe carries its reason", async () => {
    for (const [line, end] of [
      ['{"end":"lifetime"}', { reason: "lifetime" }],
      ['{"end":"rotated"}', { reason: "rotated" }],
      ['{"unsafe":"symlink"}', { reason: "unsafe", detail: "symlink" }],
    ] as const) {
      const f = follow();
      await f.opened;
      say(`${line}\n`);
      await waitFor(() => f.ended.length === 1, 2_000, line);
      expect(f.ended[0]).toEqual(end);
      await waitFor(() => ctx.mock.vms.get(vmId)!.pty.size === 0, 2_000, "session killed");
    }
  });

  test("silence ends it as stalled; no hello ends it as protocol; a closed socket as closed", async () => {
    const quiet = follow({ stallMs: 80, helloTimeoutMs: 5_000 });
    await quiet.opened;
    say('{"v":1,"start":0,"size":0}\n');
    await waitFor(() => quiet.ended.length === 1, 2_000, "stall");
    expect(quiet.ended[0]!.reason).toBe("stalled");

    const mute = follow({ helloTimeoutMs: 60 });
    await mute.opened;
    await waitFor(() => mute.ended.length === 1, 2_000, "no hello");
    expect(mute.ended[0]).toEqual({ reason: "protocol", detail: "no hello" });

    const dropped = follow();
    await dropped.opened;
    say('{"v":1,"start":0,"size":0}\n');
    for (const ws of session().sockets) ws.close(1011, "gone");
    await waitFor(() => dropped.ended.length === 1, 2_000, "closed");
    expect(dropped.ended[0]!.reason).toBe("closed");
  });

  test("an endless line is cut off, not buffered", async () => {
    const f = follow();
    await f.opened;
    say(`{"o":0,"d":"${"A".repeat(140 * 1024)}`);
    await waitFor(() => f.ended.length === 1, 2_000, "end");
    expect(f.ended[0]).toEqual({ reason: "protocol", detail: "line too long" });
  });

  test("an unreachable VM rejects the open; stop() twice is fine", async () => {
    ctx.mock.vms.get(vmId)!.data.state = "stopped";
    await expect(follow().opened).rejects.toThrow();
    ctx.mock.vms.get(vmId)!.data.state = "running";
    const follower: LogFollower = await follow().opened;
    await follower.stop();
    await follower.stop();
  });
});
