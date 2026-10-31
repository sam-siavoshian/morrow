import { gzipSync } from "node:zlib";
import type { Freestyle, PtySession } from "freestyle";
import { z } from "zod";
import { freestyle } from "./client.ts";
import { invalidInput, toIntegrationError } from "./errors.ts";
import { loadVmScript } from "./exec.ts";
import { assertAgentName, assertLinuxUser, relayUserFor } from "./names.ts";

/** A follower ends itself after this long; the caller opens the next one from where it got to. */
export const FOLLOW_LIFETIME_S = 600;
export const MAX_FOLLOW_BACKLOG = 256 * 1024;
/** The script sends at most 32 KiB per line (about 44 KiB of base64); anything longer is not ours. */
const MAX_LINE = 128 * 1024;
const MAX_OFFSET = 1e15;

const Frame = z.union([
  z.object({ v: z.literal(1), start: z.number().int().nonnegative(), size: z.number().int().nonnegative() }),
  z.object({ o: z.number().int().nonnegative(), d: z.string().max(MAX_LINE).regex(/^[A-Za-z0-9+/]*={0,2}$/) }),
  z.object({ hb: z.number().int().nonnegative() }),
  z.object({ end: z.enum(["lifetime", "rotated", "missing"]) }),
  z.object({ unsafe: z.string().regex(/^[a-z_]{1,32}$/) }),
]);

export type FollowEndReason =
  /** The script reached its lifetime, saw the log replaced, or the log vanished: open another one. */
  | "lifetime"
  | "rotated"
  | "missing"
  /** The path is not the plain log the broker writes (see `vm/logfollow.sh`). Do not retry. */
  | "unsafe"
  /** The stream broke: the process exited or the socket closed without saying why, it went silent, or it spoke nonsense. */
  | "exited"
  | "closed"
  | "stalled"
  | "protocol";

export interface FollowEnd {
  reason: FollowEndReason;
  /** For server logs only. */
  detail?: string;
}

export interface LogFollowHandlers {
  /** The log is open and bytes from `start` follow. Fires again, with a new `start`, after the file shrank. */
  onStart(at: { start: number; size: number }): void;
  /** The log's bytes from `offset`, in order and without gaps since the last `onStart`. */
  onBytes(bytes: Uint8Array, offset: number): void;
  /** Exactly once, unless `stop()` came first. */
  onEnd(end: FollowEnd): void;
}

export interface LogFollower {
  /** Kills the follower on the VM. Safe to call more than once. */
  stop(): Promise<void>;
}

/**
 * The PTY command that runs `vm/logfollow.sh`. A PTY session takes no stdin or env, so the script travels inline,
 * gzipped and base64 encoded (it goes in the session URL, so it is kept short), and its values as arguments. Every value is checked first and
 * none can carry shell syntax: the name is `[A-Za-z0-9_-]`, the rest are integers.
 */
export function followCommand(script: string, args: { agentName: string; start: number | null; backlogBytes: number; lifetimeSec: number }): string {
  assertAgentName(args.agentName);
  const { start, backlogBytes, lifetimeSec } = args;
  if (start !== null && (!Number.isSafeInteger(start) || start < 0 || start > MAX_OFFSET)) throw invalidInput("Invalid log offset.");
  if (!Number.isInteger(backlogBytes) || backlogBytes < 0 || backlogBytes > MAX_FOLLOW_BACKLOG) throw invalidInput("Invalid log backlog size.");
  if (!Number.isInteger(lifetimeSec) || lifetimeSec < 5 || lifetimeSec > 3600) throw invalidInput("Invalid follow lifetime.");
  const body = script
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .join("\n");
  const b64 = gzipSync(Buffer.from(`${body}\n`, "utf8"), { level: 9 }).toString("base64");
  return `exec /bin/bash -c "$(printf %s ${b64} | base64 -d | gzip -dc)" morrow-logfollow ${args.agentName} ${start ?? -1} ${backlogBytes} ${lifetimeSec}`;
}

/**
 * Streams a Relay worker's log as it is written, for live inspect (`runtime/inspect.ts`): `vm/logfollow.sh` runs in a
 * Freestyle PTY session as the broker's Linux user (never root, the same reasoning as `readWorkerLogTail`) and prints
 * the log's new bytes as base64 JSON lines, so output reaches members as fast as the socket carries it, with no `exec`
 * per read. Each line carries its file offset; a gap, a line that is not ours, a silent stream (`stallMs` without even
 * a heartbeat) or a missing hello ends the follower rather than guessing.
 *
 * The session is killed on `stop()` and on any end. One the backend lost (a crash) ends itself at its lifetime.
 */
export async function followWorkerLog(
  opts: {
    vmId: string;
    linuxUser: string;
    agentName: string;
    /** The first byte wanted; null for the last `backlogBytes`. A start past the end also gets the backlog. */
    start: number | null;
    backlogBytes: number;
    lifetimeSec?: number;
    client?: Freestyle;
    /** No hello within this long ends the follower as `protocol`. */
    helloTimeoutMs?: number;
    /** No line at all (the script beats every 5 s) for this long ends it as `stalled`. */
    stallMs?: number;
  } & LogFollowHandlers,
): Promise<LogFollower> {
  assertLinuxUser(opts.linuxUser);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(opts.vmId)) throw invalidInput("Invalid VM id.");
  const relayUser = relayUserFor(opts.linuxUser);
  const exec = followCommand(await loadVmScript("logfollow"), {
    agentName: opts.agentName,
    start: opts.start,
    backlogBytes: opts.backlogBytes,
    lifetimeSec: opts.lifetimeSec ?? FOLLOW_LIFETIME_S,
  });
  const vm = (opts.client ?? freestyle()).vms.ref(opts.vmId);
  const helloTimeoutMs = opts.helloTimeoutMs ?? 15_000;
  const stallMs = opts.stallMs ?? 20_000;

  const decoder = new TextDecoder();
  let buffer = "";
  let session: PtySession | null = null;
  let done = false;
  /** An end that came while the open was still in flight: reported once the caller holds the follower. */
  let ready = false;
  let pendingEnd: FollowEnd | null = null;
  let expected: number | null = null;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (helloTimer) clearTimeout(helloTimer);
    if (stallTimer) clearTimeout(stallTimer);
    helloTimer = stallTimer = null;
  };
  const kill = async () => {
    const s = session;
    if (!s) return;
    session = null;
    try {
      await vm.pty.close(s.sessionId, { linuxUser: relayUser });
    } catch {
      // Already gone (it exited, or the VM stopped). A follower that outlived this ends at its lifetime.
    }
    s.detach();
  };
  const end = (reason: FollowEndReason, detail?: string) => {
    if (done) return;
    done = true;
    clearTimers();
    void kill();
    const result: FollowEnd = detail === undefined ? { reason } : { reason, detail };
    if (ready) opts.onEnd(result);
    else pendingEnd = result;
  };
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => end("stalled"), stallMs);
    stallTimer.unref?.();
  };

  const onLine = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Anything the guest prints before the script starts is not ours; frames always start with `{`.
    if (!line.startsWith("{")) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return end("protocol", "unparseable line");
    }
    const parsed = Frame.safeParse(json);
    if (!parsed.success) return end("protocol", "unexpected frame");
    const frame = parsed.data;
    if ("v" in frame) {
      if (helloTimer) clearTimeout(helloTimer);
      helloTimer = null;
      expected = frame.start;
      opts.onStart({ start: frame.start, size: frame.size });
    } else if ("o" in frame) {
      if (expected === null || frame.o !== expected) return end("protocol", "offset gap");
      const bytes = new Uint8Array(Buffer.from(frame.d, "base64"));
      if (bytes.byteLength === 0) return;
      expected += bytes.byteLength;
      opts.onBytes(bytes, frame.o);
    } else if ("end" in frame) {
      end(frame.end);
    } else if ("unsafe" in frame) {
      end("unsafe", frame.unsafe);
    }
  };

  const onData = (chunk: Uint8Array) => {
    if (done) return;
    armStall();
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1 && !done) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      onLine(line);
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_LINE) end("protocol", "line too long");
  };

  helloTimer = setTimeout(() => end("protocol", "no hello"), helloTimeoutMs);
  helloTimer.unref?.();
  armStall();
  let opened: PtySession;
  try {
    opened = await vm.pty.open({
      exec,
      linuxUser: relayUser,
      cols: 200,
      rows: 24,
      onData,
      onExit: (code) => end("exited", `exit ${code}`),
      onClose: (info) => end("closed", `socket ${info.code}`),
      onError: () => end("closed", "socket error"),
    });
  } catch (error) {
    done = true;
    clearTimers();
    throw toIntegrationError(error, "Follow worker log");
  }
  session = opened;
  ready = true;
  if (done) {
    void kill();
    const late = pendingEnd;
    if (late) queueMicrotask(() => opts.onEnd(late));
  }

  return {
    async stop() {
      done = true;
      clearTimers();
      await kill();
    },
  };
}
