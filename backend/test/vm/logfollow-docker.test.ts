// Runs backend/vm/logfollow.sh for real in a throwaway ubuntu:24.04 container: the exact PTY command the backend sends
// (followCommand), under a real PTY, as the Relay broker's user, against a growing, truncated, rotated and hostile log.
// Needs Docker: `VM_DOCKER=1 bun test test/vm`. Skipped (and reported as skipped) otherwise.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadVmScript } from "../../src/integrations/freestyle/exec.ts";
import { followCommand } from "../../src/integrations/freestyle/logstream.ts";

const RUN = process.env.VM_DOCKER === "1";
if (!RUN) console.warn("SKIP logfollow docker suite: set VM_DOCKER=1 (needs Docker and the ubuntu:24.04 image)");

const BACKEND = resolve(import.meta.dir, "../..");

interface Line {
  at: number | null;
  text: string;
}

async function scenario(): Promise<Map<string, Line[]>> {
  const script = await loadVmScript("logfollow");
  const cmd = (agentName: string, start: number | null, lifetimeSec: number, backlogBytes = 65_536) => followCommand(script, { agentName, start, backlogBytes, lifetimeSec });
  const env: Record<string, string> = {
    CMD_NORMAL: cmd("w-normal", null, 7),
    CMD_RESUME: cmd("w-resume", 6, 5),
    CMD_LATE: cmd("w-late", null, 5),
    CMD_ROTATED: cmd("w-rotated", null, 20),
    CMD_SYMLINK: cmd("w-symlink", null, 5),
    CMD_HARDLINK: cmd("w-hardlink", null, 5),
    CMD_ROOTOWNED: cmd("w-rootowned", null, 5),
    CMD_FIFO: cmd("w-fifo", null, 5),
    // What a tampered command line would carry: the script refuses it on its own.
    CMD_BAD_ARGS: cmd("w-normal", null, 5).replace(/ -1 65536 5$/, " ';id' 65536 5"),
  };
  const name = `morrow-logfollow-${randomBytes(4).toString("hex")}`;
  const proc = Bun.spawn(
    [
      "docker", "run", "--rm", "--name", name, "--network", "none",
      ...Object.keys(env).flatMap((k) => ["-e", k]),
      "-v", `${BACKEND}/test/fixtures/vm-docker:/t:ro`,
      "ubuntu:24.04", "bash", "/t/logfollow-scenario.sh",
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 || !stdout.includes("\nDONE")) throw new Error(`scenario failed (${code}): ${stderr.slice(-2000)}\n${stdout.slice(-2000)}`);
    const cases = new Map<string, Line[]>();
    for (const raw of stdout.split("\n")) {
      const [label, at, ...rest] = raw.split("\t");
      if (!label || at === undefined || rest.length === 0) continue;
      const lines = cases.get(label) ?? [];
      lines.push({ at: at === "-" ? null : Number(at), text: rest.join("\t") });
      cases.set(label, lines);
    }
    return cases;
  } finally {
    await Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" }).exited;
  }
}

const frames = (lines: Line[] | undefined) =>
  (lines ?? []).filter((l) => l.text.startsWith("{")).map((l) => ({ at: l.at!, frame: JSON.parse(l.text) as Record<string, unknown> }));
const rc = (lines: Line[] | undefined) => Number((lines ?? []).find((l) => l.text.startsWith("#rc "))?.text.slice(4));
const wroteAt = (lines: Line[] | undefined, what: string) => (lines ?? []).find((l) => l.text === `#wrote ${what}`)?.at ?? NaN;
/** The bytes the data frames carry, joined, from the frame at `from` on. */
const bytes = (f: ReturnType<typeof frames>) => Buffer.concat(f.filter((x) => "d" in x.frame).map((x) => Buffer.from(String(x.frame.d), "base64")));

describe.skipIf(!RUN)("logfollow.sh in ubuntu:24.04, under a PTY", () => {
  test("streams the log as it grows, offsets exact, fast, and ends cleanly", async () => {
    const c = await scenario();

    const normal = frames(c.get("normal"));
    expect(normal[0]!.frame).toEqual({ v: 1, start: 0, size: 12 });
    // Offsets are contiguous until the file shrank; then a new hello starts over from the new end's backlog.
    let expected = 0;
    let restarts = 0;
    for (const { frame } of normal.slice(1)) {
      if ("v" in frame) {
        restarts += 1;
        expect(frame).toEqual({ v: 1, start: 0, size: 2 });
        expected = 0;
      } else if ("o" in frame) {
        expect(frame.o).toBe(expected);
        expected += Buffer.from(String(frame.d), "base64").length;
        // One frame never carries more than 32 KiB.
        expect(Buffer.from(String(frame.d), "base64").length).toBeLessThanOrEqual(32_768);
      }
    }
    expect(restarts).toBe(1);
    const shrink = normal.findIndex((x) => x.frame.start === 0 && x.frame.size === 2);
    expect(bytes(normal.slice(0, shrink)).toString()).toBe(`hello\nworld\nmore\n${"z".repeat(100_000)}`);
    // The two halves of a split character arrive as two frames; joined, they are the character.
    expect(bytes(normal.slice(shrink)).toString()).toBe("x\né");
    expect(normal.at(-1)!.frame).toEqual({ end: "lifetime" });
    expect(rc(c.get("normal"))).toBe(0);

    // Latency: from the write to the frame on the PTY.
    const more = normal.find((x) => "d" in x.frame && Buffer.from(String(x.frame.d), "base64").toString() === "more\n")!;
    const latency = more.at - wroteAt(c.get("normal"), "5");
    console.log(`logfollow write-to-frame latency: ${latency} ms`);
    expect(latency).toBeLessThan(400);

    const resume = frames(c.get("resume"));
    expect(resume[0]!.frame).toEqual({ v: 1, start: 6, size: 12 });
    expect(bytes(resume).toString()).toBe("world\n");
    expect(resume.at(-1)!.frame).toEqual({ end: "lifetime" });

    const late = frames(c.get("late"));
    expect(late[0]!.frame).toEqual({ v: 1, start: 0, size: 6 });
    expect(bytes(late).toString()).toBe("first\n");

    const rotated = frames(c.get("rotated"));
    expect(bytes(rotated).toString()).toBe("old\n");
    expect(rotated.at(-1)!.frame).toEqual({ end: "rotated" });
    // Noticed within the 2 s inode check, not at the 20 s lifetime.
    expect(rotated.at(-1)!.at - wroteAt(c.get("rotated"), "rotate")).toBeLessThan(3_500);

    expect(frames(c.get("symlink")).map((x) => x.frame)).toEqual([{ unsafe: "symlink" }]);
    expect(frames(c.get("hardlink")).map((x) => x.frame)).toEqual([{ unsafe: "hardlink" }]);
    expect(frames(c.get("rootowned")).map((x) => x.frame)).toEqual([{ unsafe: "wrong_owner" }]);
    expect(frames(c.get("fifo")).map((x) => x.frame)).toEqual([{ unsafe: "not_a_file" }]);
    for (const label of ["as_root", "as_engineer", "bad_args"]) {
      expect(frames(c.get(label))).toEqual([]);
      expect(rc(c.get(label))).toBe(1);
    }
    // Every follower, its watchdog and the watchdog's sleep are gone.
    expect(c.get("leftover")?.[0]?.text).toBe("0");
  }, 120_000);
});
