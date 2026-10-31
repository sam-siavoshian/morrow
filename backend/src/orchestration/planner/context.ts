// Repo context for the planner prompt: a depth- and size-limited file list and a README excerpt, read
// through the GitHub API. Missing pieces are fine; the planner works with less.
import type { Logger } from "../../lib/logger.ts";
import type { GitHost } from "../ports.ts";

const MAX_DEPTH = 3;
const MAX_PATHS = 400;
const README_CHARS = 4_000;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "vendor",
  ".next",
  ".turbo",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);
const README_NAMES = ["README.md", "readme.md", "README", "README.rst", "README.txt"];

export interface RepoContext {
  paths: string[];
  /** True when the list was cut (GitHub truncation, depth or count). */
  partial: boolean;
  readme: string | null;
}

/** Paths at most MAX_DEPTH directories deep, skipping build output and dependencies, sorted, capped. */
export function selectPaths(entries: readonly { path: string; type: "blob" | "tree" }[]): { paths: string[]; partial: boolean } {
  let partial = false;
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const parts = entry.path.split("/");
    if (parts.slice(0, -1).some((dir) => SKIP_DIRS.has(dir))) continue;
    if (parts.length - 1 > MAX_DEPTH) {
      partial = true;
      continue;
    }
    paths.push(entry.path);
  }
  paths.sort();
  if (paths.length > MAX_PATHS) partial = true;
  return { paths: paths.slice(0, MAX_PATHS), partial };
}

export async function repoContext(git: GitHost, token: string | null, repoFullName: string, ref: string, log: Logger): Promise<RepoContext> {
  if (!token) return { paths: [], partial: true, readme: null };
  const [tree, readme] = await Promise.all([
    git.getTree(token, repoFullName, ref).catch((error: unknown) => {
      log.warn("planner: repo tree unavailable", { error });
      return null;
    }),
    (async () => {
      for (const name of README_NAMES) {
        const text = await git.readSmallFile(token, repoFullName, name, ref);
        if (text !== null) return text.slice(0, README_CHARS);
      }
      return null;
    })().catch((error: unknown) => {
      log.warn("planner: readme unavailable", { error });
      return null;
    }),
  ]);
  if (!tree) return { paths: [], partial: true, readme };
  const selected = selectPaths(tree.entries);
  return { paths: selected.paths, partial: selected.partial || tree.truncated, readme };
}
