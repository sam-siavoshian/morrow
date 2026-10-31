import { join } from "node:path";
import type { Vm } from "freestyle";
import { FreestyleIntegrationError, invalidInput, toIntegrationError } from "./errors.ts";

/** Scripts in `backend/vm/` that run on engineer VMs. */
export type VmScript = "bootstrap-user" | "configure-node" | "git" | "probe" | "run-test" | "golden-setup" | "plan" | "workfile" | "logtail" | "logfollow" | "usage" | "relay-worker";

export const VM_SCRIPT_DIR = join(import.meta.dir, "../../../vm");

/**
 * The only command string this integration ever sends. The script travels as
 * stdin and every value as env, so no caller input can become shell syntax.
 * Reading the whole script first means commands inside it see EOF on stdin
 * instead of swallowing the rest of the script.
 */
export const RUN_SCRIPT_COMMAND = 'morrow_script="$(cat)" && exec /bin/bash -c "$morrow_script" morrow-vm';

/** Older guest agents cap exec at five minutes. */
export const MAX_EXEC_TIMEOUT_MS = 300_000;

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_ENV_VALUE = 64 * 1024;
const STDERR_DETAIL_BYTES = 2048;

const scriptCache = new Map<VmScript, string>();

export async function loadVmScript(name: VmScript): Promise<string> {
  let body = scriptCache.get(name);
  if (body === undefined) {
    body = await Bun.file(join(VM_SCRIPT_DIR, `${name}.sh`)).text();
    scriptCache.set(name, body);
  }
  return body;
}

export interface ScriptRun {
  /** Linux user to run as; `root` for system changes. */
  user: string;
  script: VmScript;
  env?: Record<string, string>;
  timeoutMs: number;
  /** Short label for errors and logs, e.g. "bootstrap user". */
  step: string;
}

export interface ScriptOutcome {
  statusCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run a VM script. Never throws on a non-zero exit; see {@link requireSuccess}. */
export async function runScript(vm: Vm, run: ScriptRun): Promise<ScriptOutcome> {
  if (!Number.isInteger(run.timeoutMs) || run.timeoutMs < 1_000 || run.timeoutMs > MAX_EXEC_TIMEOUT_MS) {
    throw invalidInput(`Exec timeout for ${run.step} is out of range.`);
  }
  const env = run.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key) || typeof value !== "string" || value.length > MAX_ENV_VALUE || value.includes("\0")) {
      throw invalidInput(`Invalid environment for ${run.step}.`);
    }
  }
  const script = await loadVmScript(run.script);
  try {
    const result = await vm.exec({
      command: RUN_SCRIPT_COMMAND,
      linuxUser: run.user,
      env,
      timeoutMs: run.timeoutMs,
      stdin: Buffer.from(script, "utf8").toString("base64"),
    });
    return {
      statusCode: typeof result.statusCode === "number" ? result.statusCode : null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error) {
    throw toIntegrationError(error, capitalize(run.step));
  }
}

/** Turn a timeout or non-zero exit into a typed, retryable error. Scripts are idempotent, so retry is safe. */
export function requireSuccess(outcome: ScriptOutcome, step: string): ScriptOutcome {
  if (outcome.statusCode === 0) return outcome;
  const detail = { statusCode: outcome.statusCode, stderr: tail(outcome.stderr, STDERR_DETAIL_BYTES) };
  if (outcome.statusCode === null) {
    throw new FreestyleIntegrationError("exec_timeout", `${capitalize(step)} timed out on the VM.`, {
      retryable: true,
      detail,
    });
  }
  throw new FreestyleIntegrationError("exec_failed", `${capitalize(step)} failed on the VM (exit ${outcome.statusCode}).`, {
    retryable: true,
    detail,
  });
}

/** Scripts print one JSON object as their last stdout line. */
export function lastJsonLine(stdout: string, step: string): unknown {
  const line = stdout.trimEnd().split("\n").at(-1)?.trim() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new FreestyleIntegrationError("unexpected_output", `${capitalize(step)} returned unexpected output.`, {
      retryable: true,
      detail: { stdout: tail(stdout, 512) },
    });
  }
}

export function tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
