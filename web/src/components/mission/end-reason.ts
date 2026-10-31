import type { TraceEntry, TraceKind, WorkerLogUnavailable } from "@morrow/contracts";
import { stripSourceTag } from "./recovery";

/** Why a worker ended, in plain words: `text` fits a row ("CLI not signed in"); `detail` is what the system recorded. */
export type EndWhy = { text: string; detail: string | null };

/**
 * Trace kinds that end or block a lease (their `leaseId` is the lease that ended). `task.handoff_requested` is left out on
 * purpose: its lease is the replacement, not the worker that stopped.
 */
const ENDING: ReadonlySet<TraceKind> = new Set(["worker.blocked", "worker.offline", "worker.quota_limited", "task.failed", "task.cancelled", "task.conflict_gave_up"]);

/** Recorded phrases (actor `endReason`, the monitor's detail, dispatcher errors) to plain words, first match wins. */
const PLAIN: [RegExp, string | ((m: RegExpExecArray) => string)][] = [
  [/not signed in|login expired|auth(?:entication)? required|please (?:run )?\/?login|not logged in/i, "CLI not signed in"],
  [/usage limit|rate limit|quota/i, "Hit a usage limit"],
  [/missing from relay|missing_from_inventory/i, "Lost by Relay (missing from its list)"],
  [/vm stopped reporting|node offline|node stopped reporting/i, "Its VM stopped responding"],
  [/\bpaused\b/i, "Its VM was paused"],
  [/never reported running|did not start in time/i, "Never started"],
  [/exit(?:ed)?(?: with)? code[ :=]*(\d{1,3})|exit_code_(\d{1,3})/i, (m) => `Exited with code ${m[1] ?? m[2]}`],
  [/crash/i, "Crashed"],
  [/spawn failed|failed to start|could not start/i, "Failed to start"],
  [/profile removed/i, "Its CLI profile was removed"],
  [/task cancelled|cancelled by/i, "Cancelled"],
  [/workstream completed/i, "Finished its workstream"],
  [/task finished/i, "Task finished"],
  [/its parent .* stopped/i, "Its parent worker stopped"],
  [/process exited|agent exited|exited before finishing/i, "Exited before finishing"],
];

/** The part of a trace message or end reason that says why: "w-x exited before finishing (CLI not signed in); …" → "CLI not signed in". */
export function recordedDetail(text: string): string | null {
  const message = stripSourceTag(text).text.trim();
  const exited = /exited before finishing(?: \((.*)\))?; its workstream needs a handoff$/.exec(message);
  if (exited) return exited[1]?.trim() || null;
  const failed = /failed to start(?:: (.+))?$/.exec(message);
  if (failed) return failed[1]?.trim() || null;
  const couldNot = /^Could not start \S+: (.+)$/.exec(message);
  if (couldNot) return couldNot[1]!.trim();
  const reason = /^(?:agent exited|spawn failed|the agent exited|the agent failed to start): (.+)$/.exec(message);
  if (reason) return reason[1]!.trim();
  return message || null;
}

/** Plain words for a recorded reason. Unknown text is shown as recorded, trimmed. */
export function plainWhy(recorded: string | null | undefined): EndWhy | null {
  if (!recorded?.trim()) return null;
  const detail = recordedDetail(recorded);
  const haystack = `${detail ?? ""} ${recorded}`;
  for (const [re, to] of PLAIN) {
    const m = re.exec(haystack);
    if (m) return { text: typeof to === "string" ? to : to(m), detail: detail ?? recorded };
  }
  const text = (detail ?? recorded).replace(/\s+/g, " ").trim();
  return { text: text.length > 80 ? `${text.slice(0, 79)}…` : text, detail: detail ?? recorded };
}

/** The newest trace entry that ended `leaseId`, or null. */
export function endingEntry(trace: readonly TraceEntry[] | null | undefined, leaseId: string): TraceEntry | null {
  if (!trace) return null;
  for (let i = trace.length - 1; i >= 0; i--) {
    const entry = trace[i]!;
    if (entry.leaseId === leaseId && ENDING.has(entry.kind)) return entry;
  }
  return null;
}

/** Why `leaseId` ended, from its task's trace. Null when the trace does not say (or is not loaded yet). */
export function leaseWhy(trace: readonly TraceEntry[] | null | undefined, leaseId: string): EndWhy | null {
  const entry = endingEntry(trace, leaseId);
  if (!entry) return null;
  if (entry.kind === "task.cancelled") return { text: "Cancelled", detail: stripSourceTag(entry.message).text };
  const why = plainWhy(entry.message);
  // An exit with nothing recorded (a lease that ended before reasons were kept) still says what is known.
  if (why && entry.kind === "worker.offline" && recordedDetail(entry.message) === null) return { text: "Exited before finishing", detail: "No reason was recorded." };
  return why;
}

/** The log route's reason codes in words a member can act on. */
export const UNAVAILABLE_TEXT: Record<WorkerLogUnavailable, { title: string; description: string }> = {
  not_configured: { title: "Logs aren't available here", description: "This server has no cloud environments, so there is no worker log to read." },
  environment_gone: { title: "Its environment is gone", description: "The environment this worker ran on was disconnected or deleted, and its log went with the VM." },
  environment_paused: { title: "Its VM is paused", description: "The environment's owner can resume it to read this log. Reading a log never wakes a paused VM." },
  environment_unavailable: { title: "Its VM isn't ready", description: "The environment is starting or reported an error. Try again once it is ready." },
  log_missing: { title: "No log was written", description: "This worker left no log on its VM. It likely never started." },
  log_refused: { title: "Log not read", description: "The log file on the VM is not the plain file the broker writes, so it was not read." },
  vm_unreachable: { title: "Log unavailable right now", description: "The VM didn't answer. Try again in a moment." },
};
