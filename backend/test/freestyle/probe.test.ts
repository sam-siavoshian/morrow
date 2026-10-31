import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseProbeOutput, probeEnvironment } from "../../src/integrations/freestyle/index.ts";
import { useMock } from "./helpers.ts";

const cli = (o: Partial<{ installed: boolean; version: string | null; auth: string; authSource: string; credentialModifiedAt: number | null }> = {}) => ({
  installed: true,
  version: "2.1.3 (Claude Code)",
  auth: "ok",
  authSource: "status_command",
  credentialModifiedAt: 1_700_000_000,
  ...o,
});
const line = (clis: Record<string, unknown>, relay: Record<string, unknown> = { installed: true, version: "14.0.0", node: "active" }) =>
  JSON.stringify({ v: 1, clis: { claude: cli(), codex: cli(), opencode: cli(), cursor: cli(), gemini: cli(), grok: cli(), ...clis }, relay });

describe("parseProbeOutput", () => {
  test("logged in via status command", () => {
    const r = parseProbeOutput(line({}));
    expect(r.ok).toBe(true);
    expect(r.clis.claude).toEqual({ installed: true, version: "2.1.3 (Claude Code)", auth: "ok", authSource: "status_command", credentialModifiedAt: 1_700_000_000_000 });
    expect(r.relay.node).toBe("active");
  });

  test("auth_required from status command, and from a missing credential file", () => {
    const r = parseProbeOutput(
      line({ claude: cli({ auth: "auth_required", credentialModifiedAt: null }), codex: cli({ auth: "auth_required", authSource: "credential_file", credentialModifiedAt: null }) }),
    );
    expect(r.clis.claude.auth).toBe("auth_required");
    expect(r.clis.codex).toMatchObject({ auth: "auth_required", authSource: "credential_file", credentialModifiedAt: null });
  });

  test("credential file present but no status command: unknown, never ok", () => {
    const r = parseProbeOutput(line({ claude: cli({ auth: "unknown", authSource: "credential_file" }) }));
    expect(r.clis.claude.auth).toBe("unknown");
    expect(r.clis.claude.credentialModifiedAt).toBe(1_700_000_000_000);
  });

  test("not installed is unknown even if the wire claims ok", () => {
    const r = parseProbeOutput(line({ opencode: cli({ installed: false, version: null, auth: "ok", authSource: "none" }) }));
    expect(r.clis.opencode).toMatchObject({ installed: false, auth: "unknown" });
  });

  test("reports every CLI kind, the newer ones included", () => {
    const r = parseProbeOutput(line({ gemini: cli({ installed: false, version: null, auth: "unknown", authSource: "none", credentialModifiedAt: null }), grok: cli({ auth: "auth_required", authSource: "credential_file" }) }));
    expect(Object.keys(r.clis).sort()).toEqual(["claude", "codex", "cursor", "gemini", "grok", "opencode"]);
    expect(r.clis.cursor.auth).toBe("ok");
    expect(r.clis.gemini).toMatchObject({ installed: false, auth: "unknown" });
    expect(r.clis.grok).toMatchObject({ auth: "auth_required", authSource: "credential_file" });
  });

  test("takes the last line, ignoring login-shell noise above it", () => {
    expect(parseProbeOutput(`motd banner\n${line({})}\n`).ok).toBe(true);
  });

  test.each([
    ["empty", ""],
    ["garbage", "not json"],
    ["wrong version", JSON.stringify({ v: 2 })],
    ["bad auth value", line({ claude: cli({ auth: "yes" }) })],
    ["oversized version", line({ claude: cli({ version: "x".repeat(65) }) })],
    ["missing relay", JSON.stringify({ v: 1, clis: { claude: cli(), codex: cli(), opencode: cli(), cursor: cli(), gemini: cli(), grok: cli() } })],
    ["missing a CLI", JSON.stringify({ v: 1, clis: { claude: cli(), codex: cli(), opencode: cli() }, relay: { installed: true, version: "14.0.0", node: "active" } })],
  ])("malformed output (%s) degrades to all-unknown", (_name, stdout) => {
    const r = parseProbeOutput(stdout);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("bad_output");
    expect(Object.keys(r.clis)).toHaveLength(6);
    for (const c of Object.values(r.clis)) expect(c.auth).toBe("unknown");
  });
});

describe("probeEnvironment against the mock", () => {
  let ctx: ReturnType<typeof useMock>;
  beforeEach(() => {
    ctx = useMock();
  });
  afterEach(() => ctx.restore());

  async function vmWithUser(user: string) {
    const { vmId } = await ctx.client.vms.create({ firewall: { rules: [] } });
    ctx.mock.vms.get(vmId)!.guest.users.add(user);
    return vmId;
  }

  test("runs as the engineer with a 20 s timeout and parses each CLI", async () => {
    const user = "u0123456789ab";
    const vmId = await vmWithUser(user);
    ctx.mock.vms.get(vmId)!.guest.cliAuth.set(user, {
      claude: { installed: true, auth: "ok" },
      codex: { installed: true, auth: "unknown", source: "credential_file" },
      opencode: { installed: false, auth: "unknown" },
    });
    const r = await probeEnvironment({ vmId, linuxUser: user });
    expect(r.ok).toBe(true);
    expect(r.clis.claude.auth).toBe("ok");
    expect(r.clis.codex).toMatchObject({ auth: "unknown", authSource: "credential_file" });
    expect(r.clis.opencode.installed).toBe(false);
    const exec = ctx.mock.execLog.at(-1)!;
    expect(exec.body.linuxUser).toBe(user);
    expect(exec.body.timeoutMs).toBe(20_000);
    expect(exec.script).toBe("probe");
  });

  test("exec timeout (statusCode null) yields a failed report, not an exception", async () => {
    const user = "u0123456789ab";
    const vmId = await vmWithUser(user);
    const guest = ctx.mock.vms.get(vmId)!.guest;
    const run = guest.run.bind(guest);
    guest.run = (call) => ({ ...run(call), durationMs: 60_000 });
    const r = await probeEnvironment({ vmId, linuxUser: user });
    expect(r).toMatchObject({ ok: false, error: "timeout" });
    expect(r.clis.claude.auth).toBe("unknown");
  });

  test("refuses root and malformed users before any exec", async () => {
    const vmId = await vmWithUser("u0123456789ab");
    await expect(probeEnvironment({ vmId, linuxUser: "root" })).rejects.toThrow("Invalid Linux user");
    await expect(probeEnvironment({ vmId, linuxUser: "u01234; rm -rf /" })).rejects.toThrow("Invalid Linux user");
    expect(ctx.mock.execLog.length).toBe(0);
  });
});
