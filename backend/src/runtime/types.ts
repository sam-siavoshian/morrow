import type { ServerFrame } from "@morrow/contracts";
import type { EnvironmentRecord, WorkerLogTail } from "../integrations/freestyle/index.ts";
import type { RelayConfig, Speaker } from "../integrations/relay/index.ts";

/** Decrypted Relay material for one team. Held in memory only for the duration of a call. */
export interface TeamRelayAccess {
  config: RelayConfig;
  workspaceId: string;
  workspaceKey: string;
  dispatcherToken: string;
}

/**
 * What the team runtime (Relay workspaces, observers, environments, probes) offers to
 * orchestration. Implemented in `runtime/teamRuntime.ts`; orchestration depends only on this.
 */
export interface TeamRuntimeApi {
  /** Relay access for a team, provisioning the workspace first if it is missing. Null when Relay is disabled. */
  relay(teamId: string): Promise<TeamRelayAccess | null>;
  /** The `h-<login>` identity a member posts as. Created lazily, token cached encrypted on the User actor. */
  speakerFor(teamId: string, userId: string): Promise<Speaker | null>;
  /** The full environment record (VM id, Linux user, node name, phase). Null when missing. */
  environment(teamId: string, envId: string): Promise<EnvironmentRecord | null>;
  /** Fan a frame out to every viewer of the team. */
  publish(teamId: string, frame: ServerFrame): void;
  /** Teams with live work or viewers; loops iterate these. */
  activeTeamIds(): string[];
  /** Mark a team active (a task started) so observers and pollers run even with no viewers. */
  touchTeam(teamId: string): void;
  /**
   * Restart the Relay broker unit on an environment's VM: recovery when the node keeps reporting offline
   * or spawns keep failing after a worker crash (engine control link stuck). Kills the node's workers.
   * At most once per 2 min per environment; returns false when skipped (rate limit, not ready, no VM).
   */
  restartNode(teamId: string, envId: string, reason?: string): Promise<boolean>;
  /**
   * Keep the latest (redacted) tail of a worker's log the monitor read, so an ended worker's log can be shown after its
   * VM is paused or deleted. Bounded and in memory. Optional: test doubles may leave it out.
   */
  rememberWorkerLog?(teamId: string, agentName: string, tail: WorkerLogTail): void;
}
