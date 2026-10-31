/** GitHub logins: 1-39 characters, alphanumeric or single hyphens, not starting with a hyphen. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const AVATAR_HOST = "avatars.githubusercontent.com";

/** Twice the drawn size for sharp pixels on dense screens, in a few steps so the browser cache is shared. */
function pixels(size: number): number {
  const wanted = Math.round(size * 2);
  return [40, 64, 96, 128, 256, 460].find((step) => step >= wanted) ?? 460;
}

/**
 * The avatar GitHub serves for a login. Built from a validated login only, so a name can never point the
 * image anywhere else. Null for anything that is not a plain GitHub login.
 */
export function githubAvatarByLogin(login: string | null | undefined, size: number): string | null {
  if (!login || !GITHUB_LOGIN.test(login)) return null;
  return `https://${AVATAR_HOST}/${encodeURIComponent(login)}?s=${pixels(size)}`;
}

/**
 * A stored avatar URL, accepted only when GitHub's avatar host serves it (the CSP allows nothing else), and
 * resized for where it is drawn. Null for any other URL.
 */
export function githubAvatarFromUrl(url: string | null | undefined, size: number): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== AVATAR_HOST || parsed.username || parsed.password || parsed.port) return null;
  parsed.searchParams.set("s", String(pixels(size)));
  return parsed.href;
}

/** The person's GitHub picture: their stored avatar, else the one GitHub serves for their login. */
export function githubAvatar(person: { avatarUrl?: string | null; login?: string | null }, size: number): string | null {
  return githubAvatarFromUrl(person.avatarUrl, size) ?? githubAvatarByLogin(person.login, size);
}
