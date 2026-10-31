import { AgentRelay, createWorkspaceClient, type RelayWorkspaceThinClient } from "@agent-relay/sdk";
import type { RelayConfig } from "./config.ts";

/**
 * Credential scopes, narrowest first:
 *  - observer token (ot_live_*): read-only. Event stream, history, registry and node reads.
 *  - agent token (at_live_*): acts as one identity. Sends, channel membership, spawn (dispatcher only).
 *  - workspace key (rk_live_*): admin. Registration, observer-token minting, release.
 * Clients are cheap to build (no network until used, no background timers), so they are per call.
 */
export function readerClient(config: RelayConfig, observerToken: string): AgentRelay {
  return new AgentRelay({ observerToken, baseUrl: config.baseUrl });
}

export function identityClient(config: RelayConfig, agentToken: string): AgentRelay {
  return new AgentRelay({ agentToken, baseUrl: config.baseUrl });
}

export function adminClient(config: RelayConfig, workspaceKey: string): AgentRelay {
  return new AgentRelay({ workspaceKey, baseUrl: config.baseUrl });
}

export function adminThinClient(config: RelayConfig, workspaceKey: string): RelayWorkspaceThinClient {
  return createWorkspaceClient({ workspaceKey, baseUrl: config.baseUrl });
}
