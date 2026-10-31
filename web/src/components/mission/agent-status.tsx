import { Check, Hourglass, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { WorkerState } from "./workers";

/**
 * One look for an agent's state everywhere it is drawn (graph node, worker row, crew chain), so a finished or
 * failed agent never looks like a live one in one place and grey in another.
 * - live: starting, working, waiting, cooldown. Full colour.
 * - done: finished its work. Full colour with a green check.
 * - failed: dimmed with a red cross.
 * - ended: handed off, stopped or cancelled. Dimmed and grey.
 */
export type AgentTone = "live" | "done" | "failed" | "ended";

export function agentTone(kind: WorkerState["kind"]): AgentTone {
  switch (kind) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "ended";
    default:
      return "live";
  }
}

/** Classes for the harness tile of an agent in this tone. */
export const TONE_TILE: Record<AgentTone, string> = {
  live: "",
  done: "",
  failed: "opacity-60 saturate-[0.35]",
  ended: "opacity-50 grayscale",
};

/** Classes for its name and details. */
export const TONE_TEXT: Record<AgentTone, string> = {
  live: "",
  done: "",
  failed: "opacity-80",
  ended: "opacity-60",
};

/** A small mark on the corner of a harness tile: check, cross, hourglass, or a grey dot for ended. Live shows nothing. */
export function StatusPip({ kind, size = 14, className }: { kind: WorkerState["kind"]; size?: number; className?: string }) {
  const tone = agentTone(kind);
  const icon = Math.round(size * 0.64);
  let body = null;
  if (kind === "cooldown") body = <Hourglass style={{ width: icon, height: icon }} strokeWidth={2.4} className="text-warning" />;
  else if (tone === "done") body = <Check style={{ width: icon, height: icon }} strokeWidth={3} className="text-success" />;
  else if (tone === "failed") body = <X style={{ width: icon, height: icon }} strokeWidth={3} className="text-danger" />;
  else if (tone === "ended") body = <span className="rounded-full bg-faint" style={{ width: size * 0.36, height: size * 0.36 }} />;
  if (!body) return null;
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute -right-1 -bottom-1 grid place-items-center rounded-full bg-surface shadow-raised", className)}
      style={{ width: size, height: size }}
    >
      {body}
    </span>
  );
}
