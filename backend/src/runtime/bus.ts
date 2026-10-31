import type { RelayMessageView } from "@morrow/contracts";
import type { AgentActiveInfo, AgentExitedInfo, NodeStatusInfo, ObserverCallbacks } from "../integrations/relay/index.ts";
import type { Logger } from "../lib/logger.ts";

/**
 * Relay signals for one team, in stream order. The team runtime feeds this from each team's
 * `TeamRelayObserver`; orchestration (monitor, handoff ACK) subscribes. Keeps the two modules
 * independent of each other's construction.
 */
export type RuntimeSignal =
  | { kind: "message"; teamId: string; message: RelayMessageView; seq: number | null }
  | { kind: "agent.active"; teamId: string; event: AgentActiveInfo }
  | { kind: "agent.exited"; teamId: string; event: AgentExitedInfo }
  | { kind: "node.status"; teamId: string; event: NodeStatusInfo };

export type SignalHandler = (signal: RuntimeSignal) => void | Promise<void>;

export class RuntimeBus {
  readonly #handlers = new Set<SignalHandler>();
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  /** Returns an unsubscribe function. */
  subscribe(handler: SignalHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Handlers run one at a time so stream order holds. A throwing handler is logged and skipped. */
  async emit(signal: RuntimeSignal): Promise<void> {
    for (const handler of this.#handlers) {
      try {
        await handler(signal);
      } catch (error) {
        this.#log.error("runtime signal handler failed", { kind: signal.kind, teamId: signal.teamId, error });
      }
    }
  }

  /** Observer callbacks for one team that forward into this bus. */
  callbacksFor(teamId: string): ObserverCallbacks {
    return {
      onMessage: (message, seq) => this.emit({ kind: "message", teamId, message, seq }),
      onAgentActive: (event) => this.emit({ kind: "agent.active", teamId, event }),
      onAgentExited: (event) => this.emit({ kind: "agent.exited", teamId, event }),
      onNodeStatus: (event) => this.emit({ kind: "node.status", teamId, event }),
    };
  }
}
