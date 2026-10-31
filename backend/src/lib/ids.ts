const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Lowercase alphanumeric random string. Rejection sampling keeps the distribution uniform. */
export function randomSlug(length: number): string {
  let out = "";
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** `<prefix>-<12 random chars>`: about 62 bits, matches the contracts `Id` charset. */
export function newId(prefix: "t" | "p" | "e" | "cp" | "inv" | "req" | "sock"): string {
  return `${prefix}-${randomSlug(12)}`;
}

export function userIdFromGithub(githubId: number): string {
  return `u-${githubId}`;
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "team";
}
