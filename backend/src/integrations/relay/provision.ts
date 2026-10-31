import { AgentRelay, createObserverToken, listObserverTokens, revokeObserverToken } from "@agent-relay/sdk";
import { APP_NAME } from "@morrow/contracts";
import { z } from "zod";
import { randomSlug } from "../../lib/ids.ts";
import type { Logger } from "../../lib/logger.ts";
import { adminClient } from "./clients.ts";
import type { RelayConfig } from "./config.ts";
import { RelayIntegrationError, isRelayNameConflict, isRelayNotFound } from "./errors.ts";
import { takeOverIdentity } from "./identities.ts";
import { DISPATCHER_NAME, OBSERVER_TOKEN_PREFIX, workspaceNameFor } from "./names.ts";

export const DEFAULT_OBSERVER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Renew this long before expiry so a slow reconcile cycle never lets the stream lapse. */
export const OBSERVER_RENEW_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;

export interface ObserverTokenSecret {
  id: string;
  token: string;
  /** Epoch ms, or null for a non-expiring token. */
  expiresAt: number | null;
}

/**
 * Everything the backend holds for one team's workspace. All of it is secret except `workspaceId` and
 * `baseUrl`. The caller encrypts the secret fields before they reach the Team actor; this module never
 * stores them.
 */
export interface TeamRelaySecrets {
  workspaceId: string;
  baseUrl: string;
  workspaceKey: string;
  dispatcherToken: string;
  observer: ObserverTokenSecret;
}

export type PartialTeamRelaySecrets = Pick<TeamRelaySecrets, "workspaceId" | "baseUrl" | "workspaceKey"> &
  Partial<Pick<TeamRelaySecrets, "dispatcherToken" | "observer">>;

export interface ProvisionStore {
  /**
   * Called after every step that minted a secret, before the next step runs. The workspace key is shown
   * exactly once, so if this throws, provisioning stops and the error propagates.
   */
  save(secrets: PartialTeamRelaySecrets): Promise<void>;
}

export interface ProvisionInput {
  config: RelayConfig;
  teamId: string;
  store: ProvisionStore;
  /** Secrets from an earlier, interrupted run. Provisioning resumes from the first missing piece. */
  existing?: PartialTeamRelaySecrets | null;
  observerTokenTtlMs?: number;
  now?: () => number;
  logger?: Logger;
}

/**
 * Workspace -> dispatcher identity -> observer token, persisted after each step so a crash at any point
 * resumes instead of orphaning a workspace whose key nobody kept. Workspace names are never relied on for
 * idempotency (hosted and self-hosted engines disagree); the stored key is the identity.
 */
export async function provisionTeamWorkspace(input: ProvisionInput): Promise<TeamRelaySecrets> {
  const { config, store, logger } = input;
  const now = input.now ?? Date.now;
  const name = workspaceNameFor(input.teamId);
  let secrets: PartialTeamRelaySecrets;

  if (input.existing) {
    if (input.existing.baseUrl !== config.baseUrl)
      throw new RelayIntegrationError("invalid_input", "existing workspace lives on a different Relay base URL", { field: "baseUrl" });
    secrets = { ...input.existing };
  } else {
    let relay: AgentRelay;
    try {
      relay = await AgentRelay.createWorkspace({ name, baseUrl: config.baseUrl });
    } catch (error) {
      throw new RelayIntegrationError("relay_unavailable", "workspace creation failed", {}, { cause: error });
    }
    const workspaceKey = relay.workspaceKey;
    if (!workspaceKey) throw new RelayIntegrationError("provision_failed", "Relay returned no workspace key");
    const info = await relay.workspace.info();
    if (typeof info.id !== "string" || !info.id) throw new RelayIntegrationError("provision_failed", "Relay returned no workspace id");
    secrets = { workspaceId: info.id, baseUrl: config.baseUrl, workspaceKey };
    await saveOrThrow(store, secrets, logger, "workspace");
  }

  if (!secrets.dispatcherToken) {
    secrets = { ...secrets, dispatcherToken: await registerDispatcher(config, secrets.workspaceKey, logger) };
    await saveOrThrow(store, secrets, logger, "dispatcher");
  }

  if (!secrets.observer) {
    const observer = await mintObserverToken({ config, workspaceKey: secrets.workspaceKey, ttlMs: input.observerTokenTtlMs, now });
    secrets = { ...secrets, observer };
    await saveOrThrow(store, secrets, logger, "observer");
    await revokeStaleObserverTokens(config, secrets.workspaceKey, observer.id, logger);
  }

  return secrets as TeamRelaySecrets;
}

async function saveOrThrow(store: ProvisionStore, secrets: PartialTeamRelaySecrets, logger: Logger | undefined, step: string) {
  try {
    await store.save(secrets);
  } catch (error) {
    logger?.error("relay.provision.persist_failed", { step, workspaceId: secrets.workspaceId, err: error });
    throw new RelayIntegrationError("provision_failed", `persisting Relay secrets failed after step ${step}`, { step }, { cause: error });
  }
}

/**
 * Strict registration. A name conflict here means an earlier run registered the dispatcher but never
 * persisted its token; we are the only party that ever holds that token, so revoking and taking it over is
 * the recovery.
 */
async function registerDispatcher(config: RelayConfig, workspaceKey: string, logger?: Logger): Promise<string> {
  const relay = adminClient(config, workspaceKey);
  try {
    const client = await relay.workspace.register({ name: DISPATCHER_NAME, type: "system" }, { strict: true });
    if (!client.token) throw new RelayIntegrationError("provision_failed", "Relay returned no dispatcher token");
    return client.token;
  } catch (error) {
    if (!isRelayNameConflict(error)) throw error;
    logger?.warn("relay.provision.dispatcher_token_recovered", {});
    return takeOverIdentity({ config, workspaceKey, name: DISPATCHER_NAME, reason: "dispatcher token lost during provisioning" });
  }
}

export async function mintObserverToken(input: {
  config: RelayConfig;
  workspaceKey: string;
  ttlMs?: number;
  now?: () => number;
}): Promise<ObserverTokenSecret> {
  const ttlMs = input.ttlMs ?? DEFAULT_OBSERVER_TOKEN_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 60_000) throw new RelayIntegrationError("invalid_input", "ttlMs must be at least one minute", { field: "ttlMs" });
  const expiresAt = (input.now ?? Date.now)() + ttlMs;
  const minted = await createObserverToken({
    workspaceKey: input.workspaceKey,
    baseUrl: input.config.baseUrl,
    name: `${OBSERVER_TOKEN_PREFIX}${randomSlug(10)}`,
    description: `${APP_NAME} backend event fan-out`,
    filters: { includeDms: true },
    expiresAt: new Date(expiresAt).toISOString(),
  });
  if (!minted.token) throw new RelayIntegrationError("provision_failed", "Relay returned no observer token material");
  return { id: minted.id, token: minted.token, expiresAt: parseExpiry(minted.expiresAt) };
}

const RotateResponse = z.object({
  ok: z.literal(true),
  data: z.object({ id: z.string().min(1), token: z.string().min(1), expires_at: z.string().nullable().optional() }),
});

/**
 * New token material under the same id; the old material stops working for new connections at once (an
 * already-open stream stays up until it reconnects, so restart the observer with the new token). Expiry is
 * unchanged: use {@link renewObserverToken} to push it out.
 */
export async function rotateObserverToken(input: {
  config: RelayConfig;
  workspaceKey: string;
  tokenId: string;
  fetch?: typeof globalThis.fetch;
}): Promise<ObserverTokenSecret> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.tokenId)) throw new RelayIntegrationError("invalid_input", "tokenId is invalid", { field: "tokenId" });
  const response = await (input.fetch ?? fetch)(`${input.config.baseUrl}/v1/observer-tokens/${input.tokenId}/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.workspaceKey}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new RelayIntegrationError("relay_unavailable", `observer token rotation failed with HTTP ${response.status}`, { status: response.status });
  const parsed = RotateResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new RelayIntegrationError("provision_failed", "observer token rotation returned an unexpected body");
  return { id: parsed.data.data.id, token: parsed.data.data.token, expiresAt: parseExpiry(parsed.data.data.expires_at ?? null) };
}

/** Mint a fresh token (new expiry), then revoke the old one. Returns the new token even if the revoke failed. */
export async function renewObserverToken(input: {
  config: RelayConfig;
  workspaceKey: string;
  oldTokenId: string;
  ttlMs?: number;
  now?: () => number;
  logger?: Logger;
}): Promise<{ observer: ObserverTokenSecret; revokedOld: boolean }> {
  const observer = await mintObserverToken(input);
  try {
    await revokeObserverTokenById({ config: input.config, workspaceKey: input.workspaceKey, tokenId: input.oldTokenId });
    return { observer, revokedOld: true };
  } catch (error) {
    input.logger?.warn("relay.observer_token.revoke_failed", { tokenId: input.oldTokenId, err: error });
    return { observer, revokedOld: false };
  }
}

/** Idempotent: an already-revoked or unknown id is not an error. */
export async function revokeObserverTokenById(input: { config: RelayConfig; workspaceKey: string; tokenId: string }): Promise<void> {
  try {
    await revokeObserverToken({ workspaceKey: input.workspaceKey, id: input.tokenId, baseUrl: input.config.baseUrl });
  } catch (error) {
    if (!isRelayNotFound(error)) throw error;
  }
}

export function observerTokenNeedsRenewal(observer: Pick<ObserverTokenSecret, "expiresAt">, now = Date.now()): boolean {
  return observer.expiresAt !== null && observer.expiresAt - now <= OBSERVER_RENEW_BEFORE_MS;
}

/** Tokens from interrupted provisioning runs would otherwise stay valid forever. Best effort. */
async function revokeStaleObserverTokens(config: RelayConfig, workspaceKey: string, keepId: string, logger?: Logger) {
  try {
    const tokens = await listObserverTokens({ workspaceKey, baseUrl: config.baseUrl });
    for (const token of tokens) {
      if (token.id === keepId || !token.name.startsWith(OBSERVER_TOKEN_PREFIX) || token.status !== "active") continue;
      await revokeObserverTokenById({ config, workspaceKey, tokenId: token.id });
    }
  } catch (error) {
    logger?.warn("relay.observer_token.cleanup_failed", { err: error });
  }
}

function parseExpiry(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
