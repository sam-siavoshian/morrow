// Why the monitor ended a lease, as the one line the actor keeps on the lease (`endReason`) and puts in the trace.
// The monitor's own reasons are short internal phrases ("reconcile: absent"); members read this one, so it says what
// happened in their terms and, when the worker's log said why, quotes that. Never more than the actor accepts.
import { redactSecrets } from "../runtime/inspect.ts";
import type { Signal } from "./classifier.ts";

/** The actor's limit for `recordSpawnStatus(..., detail)`. */
export const END_DETAIL_MAX = 120;

const KNOWN: Record<string, string> = {
  "agent exited": "process exited",
  "reconcile: exited": "process exited",
  "reconcile: absent": "missing from Relay",
  "login expired": "CLI not signed in (login expired)",
  "node offline": "its VM stopped reporting",
  "worker crashed and its node stopped reporting": "crashed, then its VM stopped reporting",
  "never reported running": "never reported running",
};

const SIGNAL_TEXT: Partial<Record<Signal["kind"], string>> = {
  auth_required: "CLI not signed in",
  usage_limit: "hit a usage limit",
  crash: "crashed",
};

/**
 * One line, no secrets, no control characters. Characters outside the BMP (emoji) are dropped, so cutting at `max`
 * UTF-16 units can never split a surrogate pair: the actor rejects broken text, and a rejected end would leave the
 * lease live.
 */
function clean(text: string, max: number): string {
  const line = redactSecrets(text)
    .replace(/[\uD800-\uDFFF]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * `why`: the monitor's reason, optionally with Relay's exit reason in parentheses ("agent exited (code 1)").
 * `signal`: the last limit/auth/crash signal the worker's log showed, if any.
 */
export function endDetail(why: string, signal: Signal | null): string {
  const paren = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(why);
  const base = (paren ? paren[1]! : why).trim();
  const relayReason = paren ? clean(paren[2]!.replace(/_/g, " "), 40) : "";
  let text = KNOWN[base] ?? clean(base, 60);
  if (relayReason && relayReason !== "exited") text += ` (${relayReason})`;
  const said = signal && signal.kind !== "none" ? SIGNAL_TEXT[signal.kind] : undefined;
  if (said && !text.toLowerCase().includes(said.toLowerCase())) {
    const match = signal!.match ? clean(signal!.match, 60) : "";
    text += `; log: ${match || said}`;
  }
  return clean(text, END_DETAIL_MAX) || "process exited";
}
