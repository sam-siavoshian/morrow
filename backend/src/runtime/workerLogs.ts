import type { EnvironmentPhase, WorkerLogResponse, WorkerLogUnavailable } from "@morrow/contracts";
import type { Freestyle } from "freestyle";
import { FreestyleIntegrationError, MAX_LOG_TAIL_BYTES, readWorkerLogTail, type WorkerLogTail } from "../integrations/freestyle/index.ts";
import { conflict } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import type { RuntimeActors, StoredLease, StoredTask } from "./actors.ts";
import { redactSecrets } from "./inspect.ts";

const LIVE = new Set(["reserved", "spawning", "running"]);
/** Phases whose VM is running, so `exec` reads the log without waking anything. A paused VM is never started. */
const READABLE: ReadonlySet<EnvironmentPhase> = new Set(["awaiting_login", "ready"]);
/**
 * Trace kinds that end or block a worker: the newest one for a lease says how it ended. Not `task.handoff_requested`:
 * its lease is the replacement.
 */
const ENDING = new Set(["worker.blocked", "worker.offline", "worker.quota_limited", "task.failed", "task.cancelled", "task.conflict_gave_up"]);
const CHECKPOINT_SHA = /\bCheckpoint ([0-9a-f]{7,40})\b/;

/**
 * Credential shapes `redactSecrets` (the live inspect stream's filter) does not cover. A finished log is read again and
 * again, long after the run, so it gets these too: AWS access keys, Slack, Google API keys, Stripe secret/restricted
 * keys, npm tokens, bearer headers, and any `sk-`/`gho_`-style token however short its tail.
 */
const EXTRA_SECRETS: [RegExp, string][] = [
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "$1[redacted]"],
  [/\b(xox[abposr]-)[A-Za-z0-9-]+/g, "$1[redacted]"],
  [/\b(AIza)[0-9A-Za-z_-]{20,}/g, "$1[redacted]"],
  [/\b((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]+/g, "$1[redacted]"],
  [/\b(npm_)[A-Za-z0-9]{20,}/g, "$1[redacted]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, "$1[redacted]"],
  [/(\bsk-|\bgh[opusr]_)(?!\[redacted\])[A-Za-z0-9_-]{8,}/g, "$1[redacted]"],
];

/** Everything the live stream redacts, plus `EXTRA_SECRETS`. */
export function redactLogSecrets(text: string): string {
  let out = redactSecrets(text);
  for (const [re, to] of EXTRA_SECRETS) out = out.replace(re, to);
  return out;
}

export interface ArchivedLog {
  /** Redacted. */
  text: string;
  truncated: boolean;
  size: number;
  modifiedAt: string;
}

/**
 * The last log tail the backend read of each worker, redacted, so an ended worker's log can still be shown after its VM
 * is paused or deleted. In memory and bounded twice (entries and total characters), least recently used first out. It
 * does not survive a backend restart: a restarted backend reads the VM again, and a log on a deleted VM is then gone.
 */
export class WorkerLogArchive {
  readonly #entries = new Map<string, ArchivedLog>();
  readonly #maxEntries: number;
  readonly #maxChars: number;
  #chars = 0;

  constructor(options: { maxEntries?: number; maxChars?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 256;
    // A 64 KiB tail decodes to at most 64 Ki UTF-16 units, so this holds ~64 full tails (about 16 MiB of strings).
    this.#maxChars = options.maxChars ?? 4 * 1024 * 1024;
  }

  get size(): number {
    return this.#entries.size;
  }

  get chars(): number {
    return this.#chars;
  }

  remember(teamId: string, agentName: string, tail: WorkerLogTail): void {
    const entry: ArchivedLog = { text: redactLogSecrets(tail.text), truncated: tail.truncated, size: tail.size, modifiedAt: tail.modifiedAt };
    if (entry.text.length > this.#maxChars) return;
    const k = key(teamId, agentName);
    this.#drop(k);
    this.#entries.set(k, entry);
    this.#chars += entry.text.length;
    while (this.#entries.size > this.#maxEntries || this.#chars > this.#maxChars) this.#drop(this.#entries.keys().next().value!);
  }

  get(teamId: string, agentName: string): ArchivedLog | null {
    const k = key(teamId, agentName);
    const entry = this.#entries.get(k);
    if (!entry) return null;
    this.#entries.delete(k);
    this.#entries.set(k, entry);
    return entry;
  }

  #drop(k: string): void {
    const old = this.#entries.get(k);
    if (!old) return;
    this.#entries.delete(k);
    this.#chars -= old.text.length;
  }
}

export interface WorkerLogServiceOptions {
  actors: Pick<RuntimeActors, "getLease" | "getTask" | "listEnvironments">;
  client: () => Freestyle;
  /** Cloud environments configured on this server. */
  enabled: boolean;
  log: Logger;
  archive?: WorkerLogArchive;
}

type LogRead = Pick<WorkerLogResponse, "log" | "unavailable">;

/**
 * An ended worker's last output, why it ended and what it left (`GET /api/teams/:teamId/leases/:leaseId/log`). The
 * caller has checked membership and `policy.allowInspect`; this scopes the lease to the team (another team's lease is
 * not found) and refuses a live one (that is the live inspect stream's job).
 *
 * The log is read exactly as live inspect reads it (`readWorkerLogTail`: the fixed VM script, as the broker's own Linux
 * user, at most 64 KiB), only while the environment's VM is running. Failing that, the archived copy from the last
 * read; failing that, a reason code. Concurrent requests for the same worker share one VM read.
 */
export class WorkerLogService {
  readonly archive: WorkerLogArchive;
  readonly #o: WorkerLogServiceOptions;
  readonly #inflight = new Map<string, Promise<LogRead>>();

  constructor(options: WorkerLogServiceOptions) {
    this.#o = options;
    this.archive = options.archive ?? new WorkerLogArchive();
  }

  /** The monitor's periodic read of a running worker's log: kept so the log outlives its VM. */
  remember(teamId: string, agentName: string, tail: WorkerLogTail): void {
    this.archive.remember(teamId, agentName, tail);
  }

  /** Null when the team has no such lease. Throws `conflict` for a live one. */
  async read(teamId: string, leaseId: string): Promise<WorkerLogResponse | null> {
    const lease = await this.#o.actors.getLease(teamId, leaseId);
    if (!lease) return null;
    if (LIVE.has(lease.state)) throw conflict("This worker is still running. Its log streams live.");
    const [task, logRead] = await Promise.all([
      this.#o.actors.getTask(teamId, lease.taskId).catch((error: unknown) => {
        this.#o.log.warn("worker log: task unavailable", { teamId, leaseId, error });
        return null;
      }),
      this.#shared(teamId, lease),
    ]);
    return {
      leaseId: lease.id,
      agentName: lease.agentName,
      state: lease.state,
      end: endOf(lease, task),
      contribution: contributionOf(lease, task),
      ...logRead,
    };
  }

  #shared(teamId: string, lease: StoredLease): Promise<LogRead> {
    const k = key(teamId, lease.agentName);
    const running = this.#inflight.get(k);
    if (running) return running;
    const read = this.#readLog(teamId, lease).finally(() => this.#inflight.delete(k));
    this.#inflight.set(k, read);
    return read;
  }

  async #readLog(teamId: string, lease: StoredLease): Promise<LogRead> {
    const fallback = (reason: WorkerLogUnavailable): LogRead => {
      const kept = this.archive.get(teamId, lease.agentName);
      return kept ? { log: { ...kept, source: "archive" }, unavailable: null } : { log: null, unavailable: reason };
    };
    if (!this.#o.enabled) return fallback("not_configured");
    const envs = await this.#o.actors.listEnvironments(teamId);
    // A node name belongs to one environment; prefer a connected one if an old record shares it.
    const matching = envs.filter((e) => e.nodeName === lease.nodeName);
    const env = matching.find((e) => e.phase !== "disconnected") ?? matching[0];
    if (!env || env.phase === "disconnected" || !env.freestyleVmId || !env.linuxUser) return fallback("environment_gone");
    if (env.phase === "paused") return fallback("environment_paused");
    if (!READABLE.has(env.phase)) return fallback("environment_unavailable");
    try {
      const tail = await readWorkerLogTail({
        client: this.#o.client(),
        vmId: env.freestyleVmId,
        linuxUser: env.linuxUser,
        agentName: lease.agentName,
        maxBytes: MAX_LOG_TAIL_BYTES,
      });
      if (!tail) return fallback("log_missing");
      this.archive.remember(teamId, lease.agentName, tail);
      const kept = this.archive.get(teamId, lease.agentName);
      const text = kept?.text ?? redactLogSecrets(tail.text);
      return { log: { text, truncated: tail.truncated, size: tail.size, modifiedAt: tail.modifiedAt, source: "vm" }, unavailable: null };
    } catch (error) {
      const unsafe = error instanceof FreestyleIntegrationError && error.kind === "unsafe_path";
      this.#o.log.warn("worker log read failed", { teamId, leaseId: lease.id, unsafe, error });
      return unsafe ? { log: null, unavailable: "log_refused" } : fallback("vm_unreachable");
    }
  }
}

function endOf(lease: StoredLease, task: StoredTask | null): WorkerLogResponse["end"] {
  const entry = task?.trace.findLast((e) => e.leaseId === lease.id && ENDING.has(e.kind)) ?? null;
  return {
    reason: lease.endReason ? redactLogSecrets(lease.endReason) : null,
    at: typeof lease.updatedAt === "number" ? lease.updatedAt : null,
    trace: entry ? { kind: entry.kind, message: redactLogSecrets(entry.message), at: entry.at } : null,
  };
}

function contributionOf(lease: StoredLease, task: StoredTask | null): WorkerLogResponse["contribution"] {
  if (!task) return null;
  const ws = task.workstreams.find((w) => w.id === lease.workstreamId) ?? null;
  const mine = task.trace.filter((e) => e.leaseId === lease.id && e.kind === "task.checkpointed");
  const own = ws?.lastCheckpoint && ws.lastCheckpoint.epoch === lease.epoch ? ws.lastCheckpoint : null;
  const newest = mine.at(-1);
  const short = newest ? CHECKPOINT_SHA.exec(newest.message)?.[1] : undefined;
  return {
    workstreamId: lease.workstreamId,
    workstreamTitle: ws?.title ?? null,
    branch: ws?.branch ?? null,
    checkpoints: Math.max(mine.length, own ? 1 : 0),
    lastCheckpoint: own
      ? { sha: own.sha, summary: own.summary ? clip(redactLogSecrets(own.summary), 300) : null, at: own.at }
      : newest && short
        ? { sha: short, summary: null, at: newest.at }
        : null,
    completed: lease.state === "released" && (lease.endReason === "workstream completed" || (ws?.status === "done" && own !== null)),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function key(teamId: string, agentName: string): string {
  return `${teamId}/${agentName}`;
}
