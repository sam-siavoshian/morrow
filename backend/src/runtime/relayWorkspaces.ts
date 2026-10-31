import {
  RelayIntegrationError,
  ensureHumanIdentity,
  humanAgentName,
  asRelayError,
  observerTokenNeedsRenewal,
  provisionTeamWorkspace,
  renewObserverToken,
  rotateIdentityToken,
  rotateObserverToken,
  takeOverIdentity,
  type IdentityTokenStore,
  type ObserverTokenSecret,
  type PartialTeamRelaySecrets,
  type RelayConfig,
  type Speaker,
  type TeamRelaySecrets,
} from "../integrations/relay/index.ts";
import { decrypt, encrypt } from "../lib/crypto.ts";
import { AppError, dependencyUnavailable, internalError, notFound } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import type { RelayConfigInput, RuntimeActors, StoredRelay } from "./actors.ts";
import { KeyedMutex, SingleFlight } from "./keyed.ts";
import type { TeamRelayAccess } from "./types.ts";

/** AAD per secret and team: a blob copied to another field or team does not decrypt. */
const context = {
  workspaceKey: (teamId: string) => `morrow:relay:workspace-key:v1:${teamId}`,
  dispatcher: (teamId: string) => `morrow:relay:dispatcher-token:v1:${teamId}`,
  observer: (teamId: string) => `morrow:relay:observer-token:v1:${teamId}`,
  human: (teamId: string, userId: string) => `morrow:relay:human-token:v1:${teamId}:${userId}`,
};

export interface RelayWorkspacesOptions {
  /** Null when RELAY_BASE_URL=disabled. */
  config: RelayConfig | null;
  actors: RuntimeActors;
  key: CryptoKey;
  /** Guards provisioning: never create a workspace for a team that does not exist. */
  teamExists(teamId: string): Promise<boolean>;
  log: Logger;
  now: () => number;
  observerTokenTtlMs?: number;
}

type Full = TeamRelaySecrets;

/**
 * One Relay workspace per team. Provisioned on team creation, or lazily on first use when that failed:
 * one in-flight provisioning per team, so concurrent callers never create two workspaces. Every secret
 * is encrypted with DATA_ENCRYPTION_KEY before it reaches the Team actor and decrypted only per call.
 *
 * An interrupted run resumes from the pieces already minted (kept in memory until `Team.setRelay`
 * accepts the full set). A process crash in that window loses only an unused workspace.
 */
export class RelayWorkspaces {
  readonly #o: RelayWorkspacesOptions;
  readonly #partial = new Map<string, PartialTeamRelaySecrets>();
  readonly #provisions = new SingleFlight<Full>();
  readonly #observerFlights = new SingleFlight<ObserverTokenSecret>();
  /** Per member: concurrent first posts and a removal never race each other into two takeovers. */
  readonly #identityLocks = new KeyedMutex();
  /** `Team.setRelay` replaces the whole record, so writes per team are serialized. */
  readonly #writes = new KeyedMutex();

  constructor(options: RelayWorkspacesOptions) {
    this.#o = options;
  }

  get enabled(): boolean {
    return this.#o.config !== null;
  }

  /** Decrypted access, provisioning first if the team has no workspace. Null when Relay is disabled. */
  async access(teamId: string): Promise<TeamRelayAccess | null> {
    const secrets = await this.#secrets(teamId);
    if (!secrets) return null;
    return {
      config: { baseUrl: secrets.baseUrl },
      workspaceId: secrets.workspaceId,
      workspaceKey: secrets.workspaceKey,
      dispatcherToken: secrets.dispatcherToken,
    };
  }

  /** Stored access only; never provisions. For cleanup paths (member removal). */
  async existingAccess(teamId: string): Promise<TeamRelayAccess | null> {
    if (!this.enabled) return null;
    const stored = await this.#o.actors.getRelay(teamId);
    if (!stored) return null;
    const secrets = await this.#open(teamId, stored);
    return { config: { baseUrl: secrets.baseUrl }, workspaceId: secrets.workspaceId, workspaceKey: secrets.workspaceKey, dispatcherToken: secrets.dispatcherToken };
  }

  /** The observer token, renewed first when it is close to expiry. */
  async observerToken(teamId: string): Promise<{ config: RelayConfig; token: string } | null> {
    const secrets = await this.#secrets(teamId);
    if (!secrets) return null;
    let observer = secrets.observer;
    if (observerTokenNeedsRenewal(observer, this.#o.now())) observer = await this.renewObserver(teamId);
    return { config: { baseUrl: secrets.baseUrl }, token: observer.token };
  }

  /** Fresh token with a new expiry (the old one is revoked). For expiry and auth failures. */
  renewObserver(teamId: string): Promise<ObserverTokenSecret> {
    return this.#observerFlights.run(teamId, () =>
      this.#writes.run(teamId, async () => {
        const secrets = await this.#requireStored(teamId);
        const { observer, revokedOld } = await this.#relayCall("renew observer token", () =>
          renewObserverToken({
            config: { baseUrl: secrets.baseUrl },
            workspaceKey: secrets.workspaceKey,
            oldTokenId: secrets.observer.id,
            ttlMs: this.#o.observerTokenTtlMs,
            now: this.#o.now,
            logger: this.#o.log,
          }),
        );
        await this.#persist(teamId, { ...secrets, observer });
        this.#o.log.info("relay observer token renewed", { teamId, revokedOld });
        return observer;
      }),
    );
  }

  /** New material under the same id; the old material stops working. For member removal. */
  rotateObserver(teamId: string): Promise<ObserverTokenSecret | null> {
    return this.#writes.run(teamId, async () => {
      const stored = this.enabled ? await this.#o.actors.getRelay(teamId) : null;
      if (!stored) return null;
      const secrets = await this.#open(teamId, stored);
      const rotated = await this.#relayCall("rotate observer token", () =>
        rotateObserverToken({ config: { baseUrl: secrets.baseUrl }, workspaceKey: secrets.workspaceKey, tokenId: secrets.observer.id }),
      );
      const observer = { ...rotated, expiresAt: rotated.expiresAt ?? secrets.observer.expiresAt };
      await this.#persist(teamId, { ...secrets, observer });
      this.#o.log.info("relay observer token rotated", { teamId });
      return observer;
    });
  }

  /**
   * The `h-<login>` identity a member posts as. Registered strictly the first time; a name that exists
   * without a stored token (a lost token, or a member who left and came back) is taken over through the
   * audited revoke + takeover path, never re-registered.
   */
  speakerFor(teamId: string, userId: string): Promise<Speaker | null> {
    return this.#identityLocks.run(`${teamId}\u0000${userId}`, async (): Promise<Speaker | null> => {
      const access = await this.access(teamId);
      if (!access) return null;
      const user = await this.#o.actors.getUserSecrets(userId);
      if (!user || !user.teamIds.includes(teamId)) return null;
      const store: IdentityTokenStore = {
        get: async () => {
          const fresh = await this.#o.actors.getUserSecrets(userId);
          const enc = fresh?.relayHumanTokens[teamId];
          return enc ? decrypt(this.#o.key, enc, context.human(teamId, userId)) : null;
        },
        set: async (token) => {
          const enc = await encrypt(this.#o.key, token, context.human(teamId, userId));
          if (!(await this.#o.actors.setRelayHumanToken(userId, teamId, enc))) throw notFound("You are not a member of this team.");
        },
      };
      const input = { config: access.config, workspaceKey: access.workspaceKey, store };
      const identity = await this.#relayCall("resolve member identity", async () => {
        try {
          return await ensureHumanIdentity({ ...input, teamId, githubLogin: user.login });
        } catch (error) {
          if (!(error instanceof RelayIntegrationError) || (error.code !== "identity_conflict" && error.code !== "identity_token_invalid")) throw error;
          this.#o.log.warn("relay member identity taken over", { teamId, userId, code: error.code });
          return rotateIdentityToken({ ...input, name: humanAgentName(user.login), reason: "member token missing or invalid" });
        }
      });
      return { token: identity.token, kind: "human" };
    });
  }

  /**
   * A removed member's identity loses every token it holds (revoke + takeover; the new token is
   * discarded). Rejoining later goes through the takeover path in `speakerFor`.
   */
  revokeMember(teamId: string, userId: string): Promise<boolean> {
    return this.#identityLocks.run(`${teamId}\u0000${userId}`, async () => {
      const access = await this.existingAccess(teamId);
      const user = await this.#o.actors.getUserSecrets(userId);
      if (!access || !user) return false;
      try {
        await takeOverIdentity({
          config: access.config,
          workspaceKey: access.workspaceKey,
          name: humanAgentName(user.login),
          reason: "member removed from team",
        });
      } catch (error) {
        // Never registered (the member never spoke): nothing to revoke.
        if (asRelayError(error)?.code === "not_found") return false;
        throw error;
      }
      this.#o.log.info("relay member identity revoked", { teamId, userId });
      return true;
    });
  }

  async #secrets(teamId: string): Promise<Full | null> {
    if (!this.enabled) return null;
    const stored = await this.#o.actors.getRelay(teamId);
    if (stored) return this.#open(teamId, stored);
    return this.#provisions.run(teamId, () => this.#provision(teamId));
  }

  async #provision(teamId: string): Promise<Full> {
    const config = this.#o.config!;
    const stored = await this.#o.actors.getRelay(teamId);
    if (stored) return this.#open(teamId, stored);
    if (!(await this.#o.teamExists(teamId))) throw notFound("Team not found.");
    const secrets = await this.#relayCall("provision workspace", () =>
      provisionTeamWorkspace({
        config,
        teamId,
        existing: this.#partial.get(teamId) ?? null,
        store: { save: async (partial) => void this.#partial.set(teamId, partial) },
        observerTokenTtlMs: this.#o.observerTokenTtlMs,
        now: this.#o.now,
        logger: this.#o.log,
      }),
    );
    await this.#writes.run(teamId, () => this.#persist(teamId, secrets));
    this.#partial.delete(teamId);
    this.#o.log.info("relay workspace ready", { teamId, workspaceId: secrets.workspaceId });
    return secrets;
  }

  async #requireStored(teamId: string): Promise<Full> {
    const stored = await this.#o.actors.getRelay(teamId);
    if (!stored) throw dependencyUnavailable("Agent Relay is not set up for this team yet.");
    return this.#open(teamId, stored);
  }

  async #persist(teamId: string, secrets: Full): Promise<void> {
    const ok = await this.#o.actors.setRelay(teamId, await sealRelaySecrets(this.#o.key, teamId, secrets));
    if (!ok) throw notFound("Team not found.");
  }

  async #open(teamId: string, stored: StoredRelay): Promise<Full> {
    const key = this.#o.key;
    const [workspaceKey, dispatcherToken, observerRaw] = await Promise.all([
      decrypt(key, stored.workspaceKeyEnc, context.workspaceKey(teamId)),
      decrypt(key, stored.dispatcherTokenEnc, context.dispatcher(teamId)),
      decrypt(key, stored.observerTokenEnc, context.observer(teamId)),
    ]);
    const observer = parseObserver(observerRaw, stored.observerTokenId);
    if (!workspaceKey || !dispatcherToken || !observer) {
      // Wrong DATA_ENCRYPTION_KEY or a tampered record. Never guess; an operator must look.
      this.#o.log.error("relay secrets do not decrypt", { teamId });
      throw internalError(new Error("relay secrets do not decrypt"));
    }
    return { workspaceId: stored.workspaceId, baseUrl: stored.baseUrl, workspaceKey, dispatcherToken, observer };
  }

  async #relayCall<T>(action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.#o.log.warn("relay call failed", { action, error });
      throw dependencyUnavailable("Agent Relay is unavailable. Try again shortly.", error);
    }
  }
}

/** The encrypted record `Team.setRelay` stores. Exported so tests can seed a provisioned team. */
export async function sealRelaySecrets(key: CryptoKey, teamId: string, secrets: TeamRelaySecrets): Promise<RelayConfigInput> {
  return {
    workspaceId: secrets.workspaceId,
    baseUrl: secrets.baseUrl,
    workspaceKeyEnc: await encrypt(key, secrets.workspaceKey, context.workspaceKey(teamId)),
    dispatcherTokenEnc: await encrypt(key, secrets.dispatcherToken, context.dispatcher(teamId)),
    // The actor has no expiry field; the expiry rides inside the sealed blob.
    observerTokenEnc: await encrypt(key, JSON.stringify({ token: secrets.observer.token, expiresAt: secrets.observer.expiresAt }), context.observer(teamId)),
    observerTokenId: secrets.observer.id,
  };
}

function parseObserver(raw: string | null, id: string): ObserverTokenSecret | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
    if (typeof value.token !== "string" || !value.token) return null;
    const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : null;
    return { id, token: value.token, expiresAt };
  } catch {
    return null;
  }
}
