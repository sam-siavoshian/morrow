// Adding a worker to a running task from the task's @ menu. The person's message becomes the new workstream's brief
// (the dispatcher wraps it in the task context like any planned workstream); the actor places it with the same rules
// as Start. These are the pure parts: the new workstream's title and brief.
import { cleanLine, cleanText } from "./planner/shape.ts";

/** The actor's brief budget for a workstream. */
const MAX_BRIEF_CHARS = 12_000;
const MAX_TITLE_CHARS = 120;

/** The workstream's title: the message's first line, or who added it when that line is empty. */
export function addedTitle(text: string, login: string): string {
  const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  return cleanLine(first, MAX_TITLE_CHARS) || cleanLine(`Added by ${login}`, MAX_TITLE_CHARS);
}

/**
 * The new worker's part of the task. `relayName` is the person's Relay name (`h-<login>`) so the worker knows whom to
 * answer. The added worker owns the whole tree, so it is told to agree on files other workstreams own before editing.
 */
export function addedBrief(login: string, relayName: string, text: string): string {
  return cleanText(
    [
      `${login} (${relayName}) added you to this task while it was running, with this message:`,
      "",
      text,
      "",
      `Other workers may already own parts of this task (see "Who is who"). Before you edit files another workstream owns, say what you plan in the channel and agree on it with that worker. Ask ${relayName} when the message leaves something open.`,
    ].join("\n"),
    MAX_BRIEF_CHARS,
  );
}
