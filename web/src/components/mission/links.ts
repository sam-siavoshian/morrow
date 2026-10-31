import { DEFAULT_GITHUB_WEB_URL, GithubWebUrl, RepoFullName } from "@morrow/contracts";

/** Git ref names may hold slashes; each segment is encoded, nothing else gets through. */
const REF = /^(?!.*\.\.)(?!\/)(?!.*\/\/)[A-Za-z0-9._\/-]{1,200}(?<!\/)(?<!\.lock)$/;

const encodeRef = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

/** The configured GitHub (`me.features.githubWebUrl`). Anything that is not a plain http(s) URL falls back to github.com. */
function githubBase(githubWebUrl: string): string {
  const parsed = GithubWebUrl.safeParse(githubWebUrl);
  return parsed.success ? parsed.data : DEFAULT_GITHUB_WEB_URL;
}

/**
 * `<github>/<repo>/compare/<base>...<branch>`, built only from validated parts.
 * Null when the repo or either ref is not a plain name.
 */
export function compareUrl(githubWebUrl: string, repoFullName: string, base: string, branch: string): string | null {
  if (!RepoFullName.safeParse(repoFullName).success || !REF.test(base) || !REF.test(branch)) return null;
  return `${githubBase(githubWebUrl)}/${repoFullName}/compare/${encodeRef(base)}...${encodeRef(branch)}`;
}

/** A link to one commit on the configured GitHub. */
export function commitUrl(githubWebUrl: string, repoFullName: string, sha: string): string | null {
  if (!RepoFullName.safeParse(repoFullName).success || !/^[0-9a-f]{7,64}$/.test(sha)) return null;
  return `${githubBase(githubWebUrl)}/${repoFullName}/commit/${sha}`;
}

/** The repository's pull requests on the configured GitHub, filtered like the web app's list. */
export function pullsUrl(githubWebUrl: string, repoFullName: string, state: "open" | "closed" | "all"): string | null {
  if (!RepoFullName.safeParse(repoFullName).success) return null;
  const query = state === "all" ? "is%3Apr" : `is%3Apr+is%3A${state}`;
  return `${githubBase(githubWebUrl)}/${repoFullName}/pulls?q=${query}`;
}
