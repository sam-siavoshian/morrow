import { LOOPBACK_HOSTS } from "../../lib/loopback.ts";

export const HOSTED_RELAY_BASE_URL = "https://cast.agentrelay.com";

/**
 * Environment every broker on our VMs must run with. The backend SDK sends no analytics of its own: it only
 * forwards `AGENT_RELAY_*` identity headers when those variables exist, and the backend never sets them.
 */
export const RELAY_NODE_TELEMETRY_ENV = Object.freeze({
  AGENT_RELAY_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
});

export interface RelayConfig {
  /** Engine origin (hosted Relaycast or a self-hosted engine), no trailing slash. */
  readonly baseUrl: string;
}

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayConfigError";
  }
}

/**
 * Validates a Relay base URL. https is required, except plain http on loopback (a local self-hosted engine).
 * Credentials, query strings and fragments are rejected: tokens travel in headers, never in the URL.
 */
export function parseRelayBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RelayConfigError("RELAY_BASE_URL is not a valid URL");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new RelayConfigError("RELAY_BASE_URL must use https (plain http is only allowed for localhost)");
  if (url.username || url.password) throw new RelayConfigError("RELAY_BASE_URL must not contain credentials");
  if (url.search || url.hash) throw new RelayConfigError("RELAY_BASE_URL must not contain a query or fragment");
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  return `${url.origin}${path}`;
}

/** Reads `RELAY_BASE_URL`, defaulting to hosted Relaycast. */
export function loadRelayConfig(source: Record<string, string | undefined> = process.env): RelayConfig {
  const raw = source.RELAY_BASE_URL?.trim();
  return Object.freeze({ baseUrl: parseRelayBaseUrl(raw ? raw : HOSTED_RELAY_BASE_URL) });
}
