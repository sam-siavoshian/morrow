// Reads what the planner CLI printed. Claude (`-p --output-format json`) prints one result object; Codex
// (`exec --json`) prints JSONL events. Either way we pull out the final agent text, find the JSON object in it
// and validate it. Failures say why in words the UI can show, and keep the text for the classifier.
import type { PlannerRun } from "../ports.ts";
import { PlannerOutput } from "./shape.ts";

export type ParsedPlan =
  | { ok: true; output: PlannerOutput }
  | { ok: false; reason: "timeout" | "cli_error" | "no_output" | "invalid"; detail: string; text: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The first balanced top-level `{...}` that parses, scanning past code fences and prose. */
export function extractJsonObject(text: string): unknown {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        const value = tryJson(text.slice(start, i + 1));
        if (value !== undefined) return value;
        break;
      }
    }
  }
  return undefined;
}

/** Final agent text and error text from Claude's result object. */
function claudeText(stdout: string): { text: string | null; error: string | null } {
  const result = asRecord(tryJson(stdout.trim())) ?? asRecord(extractJsonObject(stdout));
  if (!result) return { text: null, error: null };
  const body = typeof result.result === "string" ? result.result : null;
  if (result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success")) {
    return { text: null, error: body ?? (typeof result.subtype === "string" ? result.subtype : "error") };
  }
  return { text: body, error: null };
}

/** Last agent message and any error from Codex JSONL (current `item.completed` and older `msg` shapes). */
function codexText(stdout: string): { text: string | null; error: string | null } {
  let text: string | null = null;
  let error: string | null = null;
  for (const line of stdout.split("\n")) {
    const event = asRecord(tryJson(line.trim()));
    if (!event) continue;
    const item = asRecord(event.item);
    const msg = asRecord(event.msg);
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") text = item.text;
    else if (msg?.type === "agent_message" && typeof msg.message === "string") text = msg.message;
    else if (event.type === "error" && typeof event.message === "string") error = event.message;
    else if (event.type === "turn.failed") error = String(asRecord(event.error)?.message ?? "turn failed");
    else if (msg?.type === "error" && typeof msg.message === "string") error = msg.message;
  }
  return { text, error };
}

export function parsePlannerRun(cli: "claude" | "codex", run: PlannerRun): ParsedPlan {
  const all = `${run.stdout}\n${run.stderr}`;
  if (run.timedOut) return { ok: false, reason: "timeout", detail: "the planner call timed out", text: all };
  const { text, error } = cli === "claude" ? claudeText(run.stdout) : codexText(run.stdout);
  if (error !== null) return { ok: false, reason: "cli_error", detail: "the planner CLI reported an error", text: `${error}\n${all}` };
  if (text === null) {
    return run.exitCode === 0
      ? { ok: false, reason: "no_output", detail: "the planner printed no answer", text: all }
      : { ok: false, reason: "cli_error", detail: `the planner CLI exited with code ${run.exitCode}`, text: all };
  }
  const parsed = PlannerOutput.safeParse(extractJsonObject(text));
  if (!parsed.success) return { ok: false, reason: "invalid", detail: "the planner output was not a valid plan", text };
  return { ok: true, output: parsed.data };
}
