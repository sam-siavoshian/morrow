/** One soft tone per agent, the same on every screen and every reload, so a speaker is easy to follow in the chat. */
export type AgentColor = { name: string; text: string; wash: string; dot: string };

const COLORS: readonly AgentColor[] = [
  { name: "sky", text: "text-soft-sky-ink", wash: "bg-soft-sky-wash", dot: "bg-soft-sky" },
  { name: "lilac", text: "text-soft-lilac-ink", wash: "bg-soft-lilac-wash", dot: "bg-soft-lilac" },
  { name: "mint", text: "text-soft-mint-ink", wash: "bg-soft-mint-wash", dot: "bg-soft-mint" },
  { name: "peach", text: "text-soft-peach-ink", wash: "bg-soft-peach-wash", dot: "bg-soft-peach" },
  { name: "rose", text: "text-soft-rose-ink", wash: "bg-soft-rose-wash", dot: "bg-soft-rose" },
  { name: "lemon", text: "text-soft-lemon-ink", wash: "bg-soft-lemon-wash", dot: "bg-soft-lemon" },
];

/** FNV-1a over the name: stable across sessions and machines. */
export function agentColor(name: string): AgentColor {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return COLORS[(hash >>> 0) % COLORS.length]!;
}
