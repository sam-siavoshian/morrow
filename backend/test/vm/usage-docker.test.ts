// Runs backend/vm/usage.sh for real in a throwaway ubuntu:24.04 container, as the engineer user, against fake
// `curl` and `codex app-server` binaries: live readings, expired and unscoped logins, vendor errors, a token
// shaped to inject curl config, a Codex rollout fallback and a hung app server. Checks the token never reaches
// argv, env or output. Needs Docker: `VM_DOCKER=1 bun test test/vm`. The container installs jq with apt, or
// mounts a static Linux jq from `VM_DOCKER_JQ=<dir holding jq>` when apt is unreachable.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { parseUsageOutput } from "../../src/integrations/freestyle/usage.ts";

const RUN = process.env.VM_DOCKER === "1";
if (!RUN) console.warn("SKIP usage docker suite: set VM_DOCKER=1 (needs Docker and the ubuntu:24.04 image)");

const BACKEND = resolve(import.meta.dir, "../..");
const NOW = Date.parse("2037-06-15T10:20:00.000Z");

interface Case {
  rc: number;
  ms: number;
  line: string;
}

async function scenario(): Promise<{ cases: Map<string, Case>; leaks: string[] }> {
  const name = `morrow-usage-${randomBytes(4).toString("hex")}`;
  const jq = process.env.VM_DOCKER_JQ ? ["-v", `${process.env.VM_DOCKER_JQ}:/jq:ro`] : [];
  const proc = Bun.spawn(
    ["docker", "run", "--rm", "--name", name, "-v", `${BACKEND}/vm:/vm:ro`, "-v", `${BACKEND}/test/fixtures/vm-docker:/t:ro`, ...jq, "ubuntu:24.04", "bash", "/t/usage-scenario.sh"],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 || !stdout.includes("\nDONE")) throw new Error(`scenario failed (${code}): ${stderr.slice(-2000)}`);
    const cases = new Map<string, Case>();
    const leaks: string[] = [];
    for (const row of stdout.split("\n")) {
      const [label, a, b, line] = row.split("\t");
      if (label === "LEAK" && a) leaks.push(a);
      else if (label && a !== undefined && b !== undefined) cases.set(label, { rc: Number(a), ms: Number(b), line: line ?? "" });
    }
    return { cases, leaks };
  } finally {
    await Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" }).exited;
  }
}

describe.skipIf(!RUN)("usage.sh in ubuntu:24.04", () => {
  test("reads both CLIs' windows, degrades to fixed words, never leaks the token and never hangs", async () => {
    const { cases, leaks } = await scenario();
    expect(leaks).toEqual([]);
    const report = (label: string) => {
      const c = cases.get(label)!;
      expect(c.rc).toBe(0);
      expect(c.line).not.toContain("SECRETTOKEN");
      return parseUsageOutput(c.line, NOW);
    };

    const live = report("live");
    expect(live.ok).toBe(true);
    expect(live.claude.usage!.windows).toEqual([
      { kind: "five_hour", label: "5-hour", usedPercent: 37.5, resetsAt: Date.parse("2037-06-15T14:00:00.000Z") },
      { kind: "weekly", label: "Weekly", usedPercent: 62, resetsAt: Date.parse("2037-06-19T09:00:00Z") },
      { kind: "other", label: "Weekly Sonnet", usedPercent: 12, resetsAt: null },
    ]);
    expect(live.codex.usage).toEqual({
      windows: [
        { kind: "five_hour", label: "5-hour", usedPercent: 23, resetsAt: 2_128_705_200_000 },
        { kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: 2_129_304_800_000 },
      ],
      observedAt: NOW,
      source: "probe",
    });
    expect(cases.get("live")!.ms).toBeLessThan(5_000);

    const expired = report("expired_and_rollout");
    expect(expired.claude).toEqual({ status: "expired", usage: null });
    expect(expired.codex.usage).toMatchObject({ observedAt: Date.parse("2037-06-15T10:12:03.120Z"), windows: [{ usedPercent: 55.5 }, { usedPercent: 41 }] });

    expect(report("no_scope_and_rollout_after_crash").claude.status).toBe("no_scope");
    expect(report("rejected").claude.status).toBe("rejected");
    expect(report("throttled").claude.status).toBe("throttled");
    expect(report("garbage").claude.status).toBe("unavailable");
    expect(report("injection").claude.status).toBe("no_login");

    const nothing = report("nothing_and_hang");
    expect(nothing.claude.status).toBe("no_login");
    expect(nothing.codex.status).toBe("no_data");
    // A hung app server is cut off by the script's own timeout, well inside the exec timeout.
    expect(cases.get("nothing_and_hang")!.ms).toBeLessThan(20_000);
  }, 240_000);
});
