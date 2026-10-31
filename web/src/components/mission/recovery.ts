/** `[detected] ada's Claude (claude) hit a usage limit: …` → the readable part, without the source tag. */
export function stripSourceTag(message: string): { text: string; source: string | null } {
  const match = /^\[(detected|manual)\]\s*/.exec(message);
  return match ? { text: message.slice(match[0].length), source: match[1]! } : { text: message, source: null };
}
