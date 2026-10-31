// Slash commands typed into the composer. Detection runs on the token before the caret, like
// t3code's detectComposerTrigger. `/budget` is left out on purpose: the backend has no budget field.

export type SlashCommandId = "workers" | "plan" | "criteria";

export type SlashCommand = {
  id: SlashCommandId;
  name: string;
  description: string;
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "workers", name: "workers", description: "Pick which CLI profiles may take this task" },
  { id: "plan", name: "plan", description: "Plan the task now, or plan it again" },
  { id: "criteria", name: "criteria", description: "Add acceptance criteria" },
];

export type SlashTrigger = { query: string; start: number; end: number };

/**
 * A `/word` token that ends at the caret and starts a line or follows whitespace. Paths
 * (`/usr/bin`, `src/x`) never match because a second slash or a leading character breaks the token.
 */
export function detectSlashTrigger(text: string, caret: number): SlashTrigger | null {
  const end = Math.max(0, Math.min(caret, text.length));
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const token = text.slice(start, end);
  if (!/^\/[a-z]{0,20}$/i.test(token)) return null;
  return { query: token.slice(1).toLowerCase(), start, end };
}

/** Name prefix first, then a name containing the query or a description word starting with it. */
export function filterSlashCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const prefix = commands.filter((c) => c.name.startsWith(q));
  const wordStarts = (text: string) => text.toLowerCase().split(/[^a-z]+/).some((w) => w.startsWith(q));
  const rest = commands.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || wordStarts(c.description)));
  return [...prefix, ...rest];
}

/** Cuts the trigger token out of the text and returns where the caret lands. */
export function removeTrigger(text: string, trigger: SlashTrigger): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  let after = text.slice(trigger.end);
  // Swallow one following space so "/plan foo" does not leave a double space behind.
  if (after.startsWith(" ") && (before === "" || /\s$/.test(before))) after = after.slice(1);
  return { text: before + after, caret: before.length };
}
