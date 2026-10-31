import { z } from "zod";
import { adminClient, identityClient } from "./clients.ts";
import type { RelayConfig } from "./config.ts";
import { RelayIntegrationError, isRelayAuthError, isRelayNameConflict } from "./errors.ts";
import { assertAgentName, humanAgentName } from "./names.ts";

/** Where one user's Relay token for one team lives (encrypted by the caller, e.g. `User.relayHumanTokens`). */
export interface IdentityTokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
}

export interface HumanIdentity {
  name: string;
  token: string;
}

const inflight = new Map<string, Promise<HumanIdentity>>();

/**
 * Lazily creates `h-<login>` the first time a user acts in a team, then reuses the stored token forever.
 * Registration is strict: a non-strict register adopts the name and rotates its token, silently killing the
 * token we stored. Concurrent first calls for the same user are collapsed in-process.
 *
 * Errors (`RelayIntegrationError`):
 *  - `identity_conflict`: the name exists but we hold no token for it (registered elsewhere, or our token was
 *    lost). Recovery is an explicit, audited {@link rotateIdentityToken}.
 *  - `identity_token_invalid`: the stored token was rejected (rotated or deleted out of band).
 */
export function ensureHumanIdentity(input: {
  config: RelayConfig;
  teamId: string;
  workspaceKey: string;
  githubLogin: string;
  store: IdentityTokenStore;
}): Promise<HumanIdentity> {
  const name = humanAgentName(input.githubLogin);
  const key = `${input.teamId}\u0000${name}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = resolveHuman(input, name).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function resolveHuman(
  input: { config: RelayConfig; workspaceKey: string; store: IdentityTokenStore },
  name: string,
): Promise<HumanIdentity> {
  const stored = await input.store.get();
  if (stored) return { name, token: stored };
  try {
    const client = await adminClient(input.config, input.workspaceKey).workspace.register(
      { name, type: "human", metadata: { source: "morrow" } },
      { strict: true },
    );
    if (!client.token) throw new RelayIntegrationError("identity_conflict", "Relay returned no token for a new identity", { name });
    await input.store.set(client.token);
    return { name, token: client.token };
  } catch (error) {
    if (!isRelayNameConflict(error)) throw error;
    // Another process may have registered and stored it between our read and our register.
    const raced = await input.store.get();
    if (raced) return { name, token: raced };
    throw new RelayIntegrationError("identity_conflict", "identity exists but no token is stored for it", { name }, { cause: error });
  }
}

/** Confirms a stored token still authenticates as the expected identity. */
export async function verifyIdentityToken(config: RelayConfig, identity: HumanIdentity): Promise<void> {
  try {
    const me = await identityClient(config, identity.token).messaging.agents.me();
    if (me.name !== identity.name) throw new RelayIntegrationError("identity_token_invalid", "token belongs to a different identity", { name: identity.name });
  } catch (error) {
    if (isRelayAuthError(error)) throw new RelayIntegrationError("identity_token_invalid", "stored identity token was rejected", { name: identity.name }, { cause: error });
    throw error;
  }
}

/**
 * Recovery for `identity_conflict` / `identity_token_invalid`: revokes every token the identity holds, then
 * takes it over with a fresh one. Audited on the engine (actor + reason). Only humans go through here; the
 * dispatcher is recovered during provisioning.
 */
export async function rotateIdentityToken(input: {
  config: RelayConfig;
  workspaceKey: string;
  name: string;
  store: IdentityTokenStore;
  reason?: string;
}): Promise<HumanIdentity> {
  const name = assertAgentName(input.name);
  if (!name.startsWith("h-")) throw new RelayIntegrationError("invalid_input", "name: only human identities can be rotated here", { field: "name" });
  const token = await takeOverIdentity({ config: input.config, workspaceKey: input.workspaceKey, name, reason: input.reason ?? "token recovery" });
  await input.store.set(token);
  return { name, token };
}

const TakeoverResponse = z.object({ ok: z.literal(true), data: z.object({ token: z.string().min(1), name: z.string() }) });

/**
 * On engine 11.1 `register` never adopts an existing name (it is a 409 with or without `strict`), and the
 * token-rotate route needs the old agent token. With only the workspace key, the audited path is
 * `revoke-token` (kills every existing token) then `takeover` (mints one new token; it does not revoke).
 */
export async function takeOverIdentity(input: {
  config: RelayConfig;
  workspaceKey: string;
  name: string;
  reason: string;
  fetch?: typeof globalThis.fetch;
}): Promise<string> {
  const name = assertAgentName(input.name);
  const agent = await adminClient(input.config, input.workspaceKey).agents.get(name);
  const doFetch = input.fetch ?? fetch;
  const call = async (action: "revoke-token" | "takeover", body: Record<string, string>) => {
    const response = await doFetch(`${input.config.baseUrl}/v1/agents/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.workspaceKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new RelayIntegrationError("identity_conflict", `identity ${action} failed with HTTP ${response.status}`, { name, status: response.status });
    return response.json().catch(() => null);
  };
  const audit = { expected_agent_id: agent.id, actor: "morrow-backend", reason: input.reason.slice(0, 200) };
  await call("revoke-token", audit);
  const parsed = TakeoverResponse.safeParse(await call("takeover", { ...audit, session_ref: "morrow-backend", node_id: "morrow-backend" }));
  if (!parsed.success || parsed.data.data.name !== name)
    throw new RelayIntegrationError("identity_conflict", "identity takeover returned an unexpected body", { name });
  return parsed.data.data.token;
}
