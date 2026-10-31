import { CliKind, type ProfileAuth } from "@morrow/contracts";
import type { Freestyle } from "freestyle";
import { z } from "zod";
import { freestyle } from "./client.ts";
import { runScript } from "./exec.ts";
import { assertLinuxUser } from "./names.ts";

export const PROBE_TIMEOUT_MS = 20_000;

const CliProbeWire = z.object({
  installed: z.boolean(),
  version: z.string().max(64).nullable(),
  auth: z.enum(["ok", "auth_required", "unknown"]),
  authSource: z.enum(["status_command", "credential_file", "none"]),
  credentialModifiedAt: z.number().int().nonnegative().nullable(),
});

const ProbeWire = z.object({
  v: z.literal(1),
  clis: z.object(Object.fromEntries(CliKind.options.map((cli) => [cli, CliProbeWire])) as Record<CliKind, typeof CliProbeWire>),
  relay: z.object({
    installed: z.boolean(),
    version: z.string().max(64).nullable(),
    node: z.enum(["active", "starting", "inactive", "unknown"]),
  }),
});

export interface CliProbe {
  installed: boolean;
  version: string | null;
  auth: ProfileAuth;
  /** How `auth` was decided: the CLI's status command, or only the credential file's existence. */
  authSource: "status_command" | "credential_file" | "none";
  /** Credential file mtime, epoch ms (stat only, never read). */
  credentialModifiedAt: number | null;
}

export interface ProbeReport {
  /** False when the probe itself failed; every CLI is then `unknown`. */
  ok: boolean;
  error: "timeout" | "exec_failed" | "bad_output" | null;
  clis: Record<CliKind, CliProbe>;
  relay: { installed: boolean; version: string | null; node: "active" | "starting" | "inactive" | "unknown" };
  probedAt: number;
}

const UNKNOWN_CLI: CliProbe = {
  installed: false,
  version: null,
  auth: "unknown",
  authSource: "none",
  credentialModifiedAt: null,
};

function failedReport(error: ProbeReport["error"], now: number): ProbeReport {
  return {
    ok: false,
    error,
    clis: Object.fromEntries(CliKind.options.map((cli) => [cli, { ...UNKNOWN_CLI }])) as Record<CliKind, CliProbe>,
    relay: { installed: false, version: null, node: "unknown" },
    probedAt: now,
  };
}

/** Parse probe.sh output. Anything malformed degrades to `unknown`, never to `ok`. */
export function parseProbeOutput(stdout: string, now = Date.now()): ProbeReport {
  const line = stdout.trimEnd().split("\n").at(-1) ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return failedReport("bad_output", now);
  }
  const parsed = ProbeWire.safeParse(raw);
  if (!parsed.success) return failedReport("bad_output", now);
  const clis = {} as Record<CliKind, CliProbe>;
  for (const cli of CliKind.options) {
    const wire = parsed.data.clis[cli];
    clis[cli] = {
      installed: wire.installed,
      version: wire.version,
      // A CLI that is not installed cannot be logged in.
      auth: wire.installed ? wire.auth : "unknown",
      authSource: wire.authSource,
      credentialModifiedAt: wire.credentialModifiedAt === null ? null : wire.credentialModifiedAt * 1000,
    };
  }
  return { ok: true, error: null, clis, relay: parsed.data.relay, probedAt: now };
}

/**
 * Run the health probe as the engineer's Linux user. Exec-level failures
 * (timeout, crash, garbage) come back as a report with `ok: false`; API errors
 * (VM gone, provider down) throw FreestyleIntegrationError.
 */
export async function probeEnvironment(opts: { vmId: string; linuxUser: string; client?: Freestyle }): Promise<ProbeReport> {
  assertLinuxUser(opts.linuxUser);
  const vm = (opts.client ?? freestyle()).vms.ref(opts.vmId);
  const outcome = await runScript(vm, {
    user: opts.linuxUser,
    script: "probe",
    timeoutMs: PROBE_TIMEOUT_MS,
    step: "health probe",
  });
  const now = Date.now();
  if (outcome.statusCode === null) return failedReport("timeout", now);
  if (outcome.statusCode !== 0) return failedReport("exec_failed", now);
  return parseProbeOutput(outcome.stdout, now);
}
