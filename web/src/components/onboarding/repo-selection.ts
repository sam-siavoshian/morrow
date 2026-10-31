import type { RepoSummary } from "@morrow/contracts";

/** GitHub repo names are case-insensitive; every comparison here goes through this. */
export const repoKey = (fullName: string) => fullName.toLowerCase();

export const linkedKeys = (linked: readonly string[]): ReadonlySet<string> => new Set(linked.map(repoKey));

/** Ticks or unticks one repo. A repo the team already has is never selectable. */
export function toggleRepo(selected: ReadonlySet<string>, fullName: string, linked: ReadonlySet<string>): ReadonlySet<string> {
  if (linked.has(repoKey(fullName))) return selected;
  const next = new Set(selected);
  if (next.has(fullName)) next.delete(fullName);
  else next.add(fullName);
  return next;
}

/** Drops anything that got linked meanwhile (by a teammate, or by us a moment ago). */
export function pruneSelection(selected: ReadonlySet<string>, linked: ReadonlySet<string>): ReadonlySet<string> {
  const kept = [...selected].filter((name) => !linked.has(repoKey(name)));
  return kept.length === selected.size ? selected : new Set(kept);
}

/** The next page appended to what is shown, without repeating a repo GitHub moved between pages. */
export function mergeRepoPages(shown: readonly RepoSummary[], page: readonly RepoSummary[]): RepoSummary[] {
  const seen = new Set(shown.map((repo) => repo.id));
  return [...shown, ...page.filter((repo) => !seen.has(repo.id))];
}

/** The label on the one primary action. */
export function linkLabel(count: number): string {
  if (count === 0) return "Link repos";
  return count === 1 ? "Link 1 repo" : `Link ${count} repos`;
}

/**
 * Keyboard movement over the rows: arrows step one, Home and End jump. Returns the index to focus,
 * -1 for "back to the search field" (ArrowUp from the first row), or null when the key is not ours.
 */
export function moveFocus(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(count - 1, index + 1);
    case "ArrowUp":
      return index <= 0 ? -1 : index - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
