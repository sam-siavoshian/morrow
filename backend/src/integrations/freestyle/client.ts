import { Freestyle } from "freestyle";
import { LOOPBACK_HOSTS } from "../../lib/loopback.ts";
import { FeatureDisabledError } from "./errors.ts";

export const DEFAULT_BASE_SNAPSHOT = "morrow-base";

let cached: { client: Freestyle; apiKey: string; baseUrl: string | undefined } | undefined;

/** Whether VM features can run at all. Cheap, never throws: for `/api/me` feature flags and `/readyz`. */
export function isFreestyleConfigured(): boolean {
  try {
    readConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * The shared SDK client, built on first use. The SDK constructor throws without
 * a key, so building it at import time would take the whole server down when
 * the key is absent; callers get a typed FeatureDisabledError instead.
 * Rebuilt when the env changes, so a rotated key takes effect without a restart.
 */
export function freestyle(): Freestyle {
  const { apiKey, baseUrl } = readConfig();
  if (!cached || cached.apiKey !== apiKey || cached.baseUrl !== baseUrl) {
    cached = { client: new Freestyle({ apiKey, baseUrl }), apiKey, baseUrl };
  }
  return cached.client;
}

/** The snapshot engineer VMs boot from. */
export function baseSnapshot(): string {
  return process.env.FREESTYLE_BASE_SNAPSHOT?.trim() || DEFAULT_BASE_SNAPSHOT;
}

function readConfig(): { apiKey: string; baseUrl: string | undefined } {
  const apiKey = process.env.FREESTYLE_API_KEY?.trim();
  if (!apiKey) throw new FeatureDisabledError();
  return { apiKey, baseUrl: parseBaseUrl(process.env.FREESTYLE_BASE_URL) };
}

/**
 * Optional API origin override (a gateway, or the local mock in tests). The API
 * key rides on every request, so plain http is only accepted for loopback.
 */
function parseBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FeatureDisabledError("FREESTYLE_BASE_URL is not a valid URL.");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new FeatureDisabledError("FREESTYLE_BASE_URL must use https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new FeatureDisabledError("FREESTYLE_BASE_URL must be a bare origin.");
  }
  return url.toString().replace(/\/+$/, "");
}
