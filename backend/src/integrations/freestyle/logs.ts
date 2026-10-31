import type { Freestyle } from "freestyle";
import { z } from "zod";
import { freestyle } from "./client.ts";
import { FreestyleIntegrationError, invalidInput } from "./errors.ts";
import { lastJsonLine, requireSuccess, runScript } from "./exec.ts";
import { assertAgentName, assertLinuxUser, relayUserFor } from "./names.ts";

export const MAX_LOG_TAIL_BYTES = 64 * 1024;
/** The script's own read gives up after 5 s (a FIFO swapped in); this covers exec overhead on top. */
const LOG_READ_TIMEOUT_MS = 15_000;

const LogTailWire = z.union([
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), size: z.number().int().nonnegative(), mtime: z.number().int(), b64: z.string().max(90_000) }),
  z.object({ unsafe: z.string().regex(/^[a-z_]{1,32}$/) }),
]);

export interface WorkerLogTail {
  text: string;
  /** True when older output was cut. */
  truncated: boolean;
  size: number;
  modifiedAt: string;
}

/**
 * Last `maxBytes` (<= 64 KiB) of a Relay worker's log, or null when there is none yet.
 *
 * The log lives in the Relay broker's private state directory (the broker runs as its own Linux user,
 * `relayUserFor`), and this text is streamed verbatim to every team member who inspects the worker
 * (`runtime/inspect.ts`), besides feeding the classifier. So it is read by `vm/logtail.sh` as the broker's
 * user, never as root: no swap (symlink, hardlink, symlinked parent, FIFO) can reach a file that user cannot
 * already read. The script opens the file once and checks what it opened through the descriptor (exact path,
 * regular file, owned by that user, one link), and takes size and bytes from that descriptor. Anything else
 * is refused as `unsafe_path`.
 *
 * Runs through `exec`, so the VM must be running; callers only read logs of live leases.
 */
export async function readWorkerLogTail(opts: {
  vmId: string;
  linuxUser: string;
  agentName: string;
  maxBytes?: number;
  client?: Freestyle;
}): Promise<WorkerLogTail | null> {
  const raw = await readWorkerLogBytes(opts);
  if (!raw) return null;
  const truncated = raw.size > raw.bytes.byteLength;
  let text = new TextDecoder("utf-8", { fatal: false }).decode(raw.bytes);
  if (truncated) {
    // Drop the partial first line (and any split UTF-8 sequence with it).
    const newline = text.indexOf("\n");
    text = newline === -1 ? "" : text.slice(newline + 1);
  }
  return { text, truncated, size: raw.size, modifiedAt: raw.modifiedAt };
}

export interface WorkerLogBytes {
  /** The last `maxBytes` (or fewer) bytes of the log, exactly as written: they end at byte `size`. */
  bytes: Uint8Array;
  /** The log's length in bytes when it was read. */
  size: number;
  modifiedAt: string;
}

/**
 * The same read as {@link readWorkerLogTail}, as raw bytes: nothing decoded or dropped, so a caller that tracks
 * offsets (live inspect, `runtime/inspect.ts`) can take exactly the bytes new since its last read.
 */
export async function readWorkerLogBytes(opts: {
  vmId: string;
  linuxUser: string;
  agentName: string;
  maxBytes?: number;
  client?: Freestyle;
}): Promise<WorkerLogBytes | null> {
  assertLinuxUser(opts.linuxUser);
  assertAgentName(opts.agentName);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(opts.vmId)) throw invalidInput("Invalid VM id.");
  const maxBytes = opts.maxBytes ?? MAX_LOG_TAIL_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOG_TAIL_BYTES) throw invalidInput("Invalid log tail size.");
  const vm = (opts.client ?? freestyle()).vms.ref(opts.vmId);

  const outcome = requireSuccess(
    await runScript(vm, {
      user: relayUserFor(opts.linuxUser),
      script: "logtail",
      timeoutMs: LOG_READ_TIMEOUT_MS,
      step: "read worker log",
      env: { AGENT_NAME: opts.agentName, MAX_BYTES: String(maxBytes) },
    }),
    "read worker log",
  );
  const parsed = LogTailWire.safeParse(lastJsonLine(outcome.stdout, "read worker log"));
  if (!parsed.success) throw new FreestyleIntegrationError("unexpected_output", "Read worker log returned unexpected output.", { retryable: true });
  const wire = parsed.data;
  if ("unsafe" in wire) {
    throw new FreestyleIntegrationError("unsafe_path", "Worker log is not a regular file owned by the Relay broker.", { detail: { reason: wire.unsafe } });
  }
  if (!wire.found) return null;

  let bytes = new Uint8Array(Buffer.from(wire.b64, "base64"));
  if (bytes.byteLength > maxBytes) bytes = bytes.subarray(bytes.byteLength - maxBytes);
  return { bytes, size: wire.size, modifiedAt: new Date(wire.mtime * 1000).toISOString() };
}
