import { githubAvatarByLogin } from "@/lib/github-avatar";
// Port of t3code's projectIdentity + projectIconColors (MIT): a two-letter monogram and one of 18
// hues, both derived from the project name so the same repo always looks the same.

/** Glyph colour per hue (600 on light scenes, 400 on night). The tile is a 14% tint of it. Order matters: the hash indexes it. */
export const PROJECT_ICON_COLORS = [
  { value: "gray", className: "text-gray-600 dark:text-gray-400" },
  { value: "red", className: "text-red-600 dark:text-red-400" },
  { value: "orange", className: "text-orange-600 dark:text-orange-400" },
  { value: "amber", className: "text-amber-600 dark:text-amber-400" },
  { value: "yellow", className: "text-yellow-600 dark:text-yellow-400" },
  { value: "lime", className: "text-lime-600 dark:text-lime-400" },
  { value: "green", className: "text-green-600 dark:text-green-400" },
  { value: "emerald", className: "text-emerald-600 dark:text-emerald-400" },
  { value: "teal", className: "text-teal-600 dark:text-teal-400" },
  { value: "cyan", className: "text-cyan-600 dark:text-cyan-400" },
  { value: "sky", className: "text-sky-600 dark:text-sky-400" },
  { value: "blue", className: "text-blue-600 dark:text-blue-400" },
  { value: "indigo", className: "text-indigo-600 dark:text-indigo-400" },
  { value: "violet", className: "text-violet-600 dark:text-violet-400" },
  { value: "purple", className: "text-purple-600 dark:text-purple-400" },
  { value: "fuchsia", className: "text-fuchsia-600 dark:text-fuchsia-400" },
  { value: "pink", className: "text-pink-600 dark:text-pink-400" },
  { value: "rose", className: "text-rose-600 dark:text-rose-400" },
] as const;

export type ProjectIconColor = (typeof PROJECT_ICON_COLORS)[number]["value"];

export type ProjectIdentity = { monogram: string; color: ProjectIconColor; colorClassName: string };

const normalize = (name: string) => name.normalize("NFKC").trim();

/**
 * First glyph of the first word, then the first digit later in that word, else the first glyph of
 * the last word, else the last glyph of the first word. "PR" when there is nothing to read.
 */
export function projectMonogram(name: string): string {
  const words = normalize(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";
  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

export function projectColorIndex(name: string): number {
  const seed = normalize(name).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_ICON_COLORS.length;
  return index;
}

export function deriveProjectIdentity(name: string): ProjectIdentity {
  const color = PROJECT_ICON_COLORS[projectColorIndex(name)]!;
  return { monogram: projectMonogram(name), color: color.value, colorClassName: color.className };
}

/** `owner/repo` split; the repo name is what people call the project. */
export function parseRepoFullName(fullName: string): { owner: string | null; repo: string } {
  const slash = fullName.indexOf("/");
  if (slash <= 0) return { owner: null, repo: fullName };
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) || fullName };
}

/**
 * The repo owner's GitHub avatar, or null when the owner is not a plain GitHub login. Built from a
 * validated login only, so a project name can never point the image anywhere else. `size` is the drawn size.
 */
export function githubOwnerAvatarUrl(repoFullName: string, size = 32): string | null {
  return githubAvatarByLogin(parseRepoFullName(repoFullName).owner, size);
}
