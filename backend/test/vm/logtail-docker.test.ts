// Runs backend/vm/logtail.sh for real in a throwaway ubuntu:24.04 container, as the Relay broker's user, against
// a hostile log directory (symlinks, hardlinks, root-owned files, a symlinked parent, FIFOs, a FIFO swapped in mid-read,
// a 200 MB log). Needs Docker: `VM_DOCKER=1 bun test test/vm`. Skipped (and reported as skipped) otherwise.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const RUN = process.env.VM_DOCKER === "1";
if (!RUN) console.warn("SKIP logtail docker suite: set VM_DOCKER=1 (needs Docker and the ubuntu:24.04 image)");

const BACKEND = resolve(import.meta.dir, "../..");

interface Case {
  rc: number;
  ms: number;
  out: Record<string, unknown> | null;
}

async function scenario(): Promise<Map<string, Case>> {
  const name = `morrow-logtail-${randomBytes(4).toString("hex")}`;
  const proc = Bun.spawn(
    [
      "docker", "run", "--rm", "--name", name, "--network", "none",
      "-v", `${BACKEND}/vm:/vm:ro`, "-v", `${BACKEND}/test/fixtures/vm-docker:/t:ro`,
      "ubuntu:24.04", "bash", "/t/logtail-scenario.sh",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 || !stdout.includes("\nDONE")) throw new Error(`scenario failed (${code}): ${stderr.slice(-2000)}`);
    const cases = new Map<string, Case>();
    for (const line of stdout.split("\n")) {
      const [label, rc, ms, out] = line.split("\t");
      if (!label || rc === undefined || ms === undefined) continue;
      cases.set(label, { rc: Number(rc), ms: Number(ms), out: out ? (JSON.parse(out) as Record<string, unknown>) : null });
    }
    return cases;
  } finally {
    await Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" }).exited;
  }
}

describe.skipIf(!RUN)("logtail.sh in ubuntu:24.04", () => {
  test("reads only the broker's own plain log, bounded, and never hangs", async () => {
    const c = await scenario();
    const out = (label: string) => c.get(label)?.out;
    const text = (label: string) => Buffer.from(String(out(label)?.b64 ?? ""), "base64").toString("utf8");

    expect(out("normal")).toMatchObject({ found: true, size: 12 });
    expect(text("normal")).toBe("hello\nworld\n");
    expect(out("missing")).toEqual({ found: false });

    expect(out("symlink_root_file")).toEqual({ unsafe: "symlink" });
    expect(out("symlink_user_file")).toEqual({ unsafe: "symlink" });
    expect(out("hardlink_user_file")).toEqual({ unsafe: "hardlink" });
    expect(out("root_owned_readable")).toEqual({ unsafe: "wrong_owner" });
    expect(out("root_owned_unreadable")).toEqual({ unsafe: "unreadable" });
    expect(out("symlinked_parent")).toEqual({ unsafe: "path_changed" });
    expect(out("fifo")).toEqual({ unsafe: "not_a_file" });

    const huge = out("huge")!;
    expect(huge).toMatchObject({ found: true, size: 200 * 1024 * 1024 + 8 });
    const hugeBytes = Buffer.from(String(huge.b64), "base64");
    expect(hugeBytes.length).toBe(65_536);
    expect(hugeBytes.subarray(-8).toString()).toBe("the end\n");
    expect(c.get("huge")!.ms).toBeLessThan(3_000);

    expect(text("bounded")).toBe("hij\n");
    for (const label of ["as_root", "as_engineer", "bad_name", "bad_max"]) expect(c.get(label)?.rc).toBe(1);
    // Workers run as the engineer: the broker's logs are out of their reach both ways.
    expect(out("engineer_read")).toEqual({ read: false });
    expect(out("engineer_write")).toEqual({ wrote: false });

    const races = [...c.entries()].filter(([label]) => label.startsWith("race_"));
    expect(races.length).toBe(12);
    for (const [, r] of races) {
      expect(r.rc).toBe(0);
      // A FIFO swapped in after the pre-check is cut off by the inner timeout, never waited on forever.
      expect(r.ms).toBeLessThan(8_000);
      const ok = r.out?.found === true ? Buffer.from(String(r.out.b64), "base64").toString() === "plain\n" : typeof r.out?.unsafe === "string";
      expect(ok).toBe(true);
    }
  }, 240_000);
});
