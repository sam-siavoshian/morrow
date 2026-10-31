import type { AgentRelay, RelayAgent, RelayAgentType, RelayNode } from "@agent-relay/sdk";
import { readerClient } from "./clients.ts";
import type { RelayConfig } from "./config.ts";
import { isRelayNotFound } from "./errors.ts";
import { assertNodeName } from "./names.ts";

export const LIVE_AGENTS_CAPABILITY = "relay:live-agents:v1";

/** Read-only view of a workspace, backed by the observer token. Everything the monitor needs to decide state. */
export interface RelayReader {
  getNode(name: string): Promise<RelayNode | null>;
  getAgent(name: string): Promise<RelayAgent | null>;
  agentType(name: string): Promise<RelayAgentType | null>;
  /** Node id -> name, for lifecycle frames that only carry the id. */
  nodeNameById(nodeId: string): Promise<string | null>;
}

export function createRelayReader(config: RelayConfig, observerToken: string, options: { nodeCacheTtlMs?: number; now?: () => number } = {}): RelayReader {
  const relay: AgentRelay = readerClient(config, observerToken);
  const now = options.now ?? Date.now;
  const nodeCacheTtlMs = options.nodeCacheTtlMs ?? 60_000;
  let nodeNames = new Map<string, string>();
  let nodeNamesAt = 0;

  const getAgent = async (name: string) => {
    try {
      return await relay.agents.get(name);
    } catch (error) {
      if (isRelayNotFound(error)) return null;
      throw error;
    }
  };

  return {
    async getNode(name) {
      try {
        return await relay.nodes.get(name);
      } catch (error) {
        if (isRelayNotFound(error)) return null;
        throw error;
      }
    },
    getAgent,
    async agentType(name) {
      return (await getAgent(name))?.type ?? null;
    },
    async nodeNameById(nodeId) {
      const cached = nodeNames.get(nodeId);
      if (cached) return cached;
      // Only refresh on a miss once per TTL so a stream of unknown ids cannot hammer the engine.
      if (now() - nodeNamesAt < nodeCacheTtlMs && nodeNamesAt !== 0) return null;
      const nodes = await relay.nodes.list();
      nodeNames = new Map(nodes.flatMap((n) => [n.id, n.nodeId].filter((id): id is string => !!id).map((id) => [id, n.name] as const)));
      nodeNamesAt = now();
      return nodeNames.get(nodeId) ?? null;
    },
  };
}

export function liveAgentNames(node: RelayNode | null): string[] {
  return publishedLiveAgents(node) ?? [];
}

/**
 * The node's live worker names, or null when its record carries no inventory at all. Not the same as an empty
 * list: observed live on hosted Relay under database pressure, a node record that is online, live, with
 * `activeAgents: 1` and a fresh heartbeat, but no `relay:live-agents:v1` capability, while its worker ran.
 */
export function publishedLiveAgents(node: RelayNode | null): string[] | null {
  const names = node?.capabilities.find((c) => c.name === LIVE_AGENTS_CAPABILITY)?.metadata?.names;
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : null;
}

export interface NodeHealth {
  name: string;
  exists: boolean;
  online: boolean;
  live: boolean;
  handlersLive: boolean;
  /** True only when every signal agrees the node can take a spawn now. */
  healthy: boolean;
  capabilities: string[];
  /** Harnesses from `spawn:<cli>` capabilities. */
  harnesses: string[];
  liveAgents: string[];
  activeAgents: number | null;
  maxAgents: number | null;
  lastHeartbeatAt: number | null;
  version: string | null;
}

export async function getNodeHealth(reader: RelayReader, nodeName: string): Promise<NodeHealth> {
  const name = assertNodeName(nodeName);
  return nodeHealthFrom(name, await reader.getNode(name));
}

export function nodeHealthFrom(name: string, node: RelayNode | null): NodeHealth {
  if (!node)
    return {
      name,
      exists: false,
      online: false,
      live: false,
      handlersLive: false,
      healthy: false,
      capabilities: [],
      harnesses: [],
      liveAgents: [],
      activeAgents: null,
      maxAgents: null,
      lastHeartbeatAt: null,
      version: null,
    };
  const capabilities = node.capabilities.map((c) => c.name);
  const online = node.status === "online";
  const live = node.live === true;
  const handlersLive = node.handlersLive === true;
  const heartbeat = node.lastHeartbeatAt ? Date.parse(node.lastHeartbeatAt) : NaN;
  return {
    name,
    exists: true,
    online,
    live,
    handlersLive,
    healthy: online && live && handlersLive,
    capabilities,
    harnesses: capabilities.filter((c) => c.startsWith("spawn:")).map((c) => c.slice("spawn:".length)),
    liveAgents: liveAgentNames(node),
    activeAgents: typeof node.activeAgents === "number" ? node.activeAgents : null,
    maxAgents: typeof node.maxAgents === "number" ? node.maxAgents : null,
    lastHeartbeatAt: Number.isFinite(heartbeat) ? heartbeat : null,
    version: node.version ?? null,
  };
}
