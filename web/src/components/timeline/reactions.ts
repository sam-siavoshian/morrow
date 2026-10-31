import type { RelayReactionGroupView } from "@morrow/contracts";

/** One reaction chip under a message: the emoji, how many reacted, and the agents we know by name (oldest first). */
export type ReactionChip = { emoji: string; count: number; agents: string[] };

/** Live reaction changes for one message: emoji, then agent, then added (true) or removed (false). See `RelayMarks`. */
export type ReactionMarks = Readonly<Record<string, Readonly<Record<string, boolean>>>>;

/**
 * The reactions a message shows now: what history reported when it loaded, with the live `relay.mark` changes laid
 * over it. A mark only moves the count when it changes something we know: an agent adding a reaction history already
 * lists, or removing one it never listed, is a repeat and changes nothing (history may already include the mark).
 * Groups whose count drops to 0 are hidden. History order first, then emojis that only arrived live, in arrival order.
 */
export function mergeReactions(base: readonly RelayReactionGroupView[] | undefined, marks: ReactionMarks | undefined): ReactionChip[] {
  const chips: ReactionChip[] = [];
  const byEmoji = new Map<string, ReactionChip>();
  for (const group of base ?? []) {
    const existing = byEmoji.get(group.emoji);
    if (existing) {
      // A repeated emoji in history: fold it into the first.
      for (const agent of group.agents) if (!existing.agents.includes(agent)) existing.agents.push(agent);
      existing.count = Math.max(existing.count + group.count, existing.agents.length);
      continue;
    }
    const chip = { emoji: group.emoji, count: Math.max(group.count, new Set(group.agents).size), agents: [...new Set(group.agents)] };
    byEmoji.set(group.emoji, chip);
    chips.push(chip);
  }
  for (const [emoji, byAgent] of Object.entries(marks ?? {})) {
    let chip = byEmoji.get(emoji);
    for (const [agent, added] of Object.entries(byAgent)) {
      const known = chip?.agents.includes(agent) ?? false;
      if (added && !known) {
        if (!chip) {
          chip = { emoji, count: 0, agents: [] };
          byEmoji.set(emoji, chip);
          chips.push(chip);
        }
        chip.agents.push(agent);
        chip.count += 1;
      } else if (!added && known && chip) {
        chip.agents = chip.agents.filter((a) => a !== agent);
        chip.count = Math.max(0, chip.count - 1);
      }
    }
  }
  return chips.filter((chip) => chip.count > 0);
}

/** "api e1, web e1 and 2 more": who reacted, by display name, for the chip's tooltip. */
export function reactedBy(chip: ReactionChip, displayName: (name: string) => string): string {
  const names = chip.agents.map(displayName);
  const others = Math.max(0, chip.count - names.length);
  if (names.length === 0) return `${chip.count} ${chip.count === 1 ? "agent" : "agents"}`;
  if (others === 0) return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.join(", ")} and ${others} more`;
}
