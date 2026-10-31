const VERSION = "v1";
const IV_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/** Decodes a standard or url-safe base64 key and requires exactly 32 bytes. */
export function decodeKeyMaterial(value: string): Uint8Array {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(normalized)) throw new Error("key must be base64");
  const bytes = new Uint8Array(Buffer.from(normalized.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  if (bytes.length !== 32) throw new Error(`key must decode to 32 bytes, got ${bytes.length}`);
  return bytes;
}

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("AES-256 key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * AES-256-GCM with a random 96-bit IV. Output: `v1.<iv>.<ciphertext+tag>` (base64url).
 * `context` is bound as additional authenticated data so a ciphertext minted for one purpose
 * (a session, one user's GitHub token) cannot be replayed as another.
 */
export async function encrypt(key: CryptoKey, plaintext: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(plaintext),
  );
  return `${VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ct))}`;
}

/** Returns null for anything malformed, tampered with, or encrypted under another key/context. */
export async function decrypt(key: CryptoKey, token: string, context: string): Promise<string | null> {
  if (typeof token !== "string" || token.length > 64 * 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  try {
    const iv = base64UrlDecode(parts[1]!);
    const ct = base64UrlDecode(parts[2]!);
    if (iv.length !== IV_BYTES || ct.length < 16) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, ct);
    return decoder.decode(pt);
  } catch {
    return null;
  }
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomToken(bytes = 32): string {
  return base64UrlEncode(randomBytes(bytes));
}

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * Constant-time string comparison. Both sides are hashed first, so the loop always runs over two
 * 64-char digests and neither the length nor the first differing byte of the inputs leaks.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = sha256Hex(a);
  const hb = sha256Hex(b);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}
