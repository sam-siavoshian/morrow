import { RelayPlacementError, type RelayActionInvocation } from "@agent-relay/sdk";
import type { Logger } from "../../lib/logger.ts";
import { identityClient } from "./clients.ts";
import type { RelayConfig } from "./config.ts";
import { RelayIntegrationError, asRelayError } from "./errors.ts";
import {
  MAX_TASK_BRIEF_BYTES,
  assertChannelName,
  assertCli,
  assertNodeName,
  assertWorkerCwd,
  assertWorkerName,
  utf8Bytes,
} from "./names.ts";
import type { RelayReader } from "./reader.ts";

/** The broker holds a verified spawn open for up to 90 s after launch; the confirm budget must nest it. */
export const MIN_CONFIRM_TIMEOUT_MS = 95_000;
export const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;

export interface SpawnWorkerRequest {
  /** Lease-derived, workspace-unique name (`workerAgentName`). Doubles as our spawn idempotency key. */
  name: string;
  node: string;
  cli: string;
  task: string;
  /** 0 to 8. Subagents join none: they talk to their parent by direct message only. */
  channels: string[];
  /** Absolute, existing directory on the node (the worktree). */
  workerCwd: string;
  model?: string;
  /** Start the CLI unable to change files (review and research subagents): `READ_ONLY_ARGS`. */
  readOnly?: boolean;
}

/**
 * CLI flags that keep a subagent from changing files, enforced by the CLI rather than asked for in its brief. The
 * broker still adds its MCP config and its permission bypass to the first three:
 *  - Claude Code: `--tools` leaves the model only these built-in tools (no Edit, Write or Bash), whatever the
 *    permission mode. MCP tools (Relay, morrow-agent) are not built-in and stay.
 *  - Codex: a read-only sandbox, no approvals. Codex refuses this next to the bypass flag the broker injects, so it
 *    fails to start (closed) until the node's relay-worker bridge drops that flag for read-only runs.
 *  - opencode: the bridge's `agent-relay-readonly` agent, which denies edit and bash. An older bridge without that
 *    agent fails the start, closed.
 *  - Cursor Agent: ask mode, without `--force`, so nothing runs unapproved.
 *  - Gemini CLI: plan mode, whose policy denies every tool but the read-only ones. The workers' settings mark the
 *    Relay and morrow-agent servers trusted, which lets their tools through.
 *  - Grok: plan mode, without always-approve.
 */
export const READ_ONLY_ARGS: Readonly<Record<string, readonly string[]>> = {
  claude: ["--tools", "Read,Grep,Glob,WebFetch,WebSearch"],
  codex: ["--sandbox", "read-only", "--ask-for-approval", "never"],
  opencode: ["--agent", "agent-relay-readonly"],
  cursor: ["--mode", "ask", "--approve-mcps", "--trust", "--disable-auto-update"],
  gemini: ["--approval-mode", "plan"],
  grok: ["--permission-mode", "plan", "--trust"],
};

/**
 * Cursor Agent, Gemini CLI and Grok always start through the node's `morrow-<cli>` shims. Under its own name the
 * broker would set each up for Relay with the workspace key: in a `gemini mcp add` / `grok mcp add` command line, and
 * written into `<worktree>/.cursor/mcp.json` from inside its own process, out of the bridge's reach. Under another
 * name it adds no MCP config and no permission flags, so these args carry the ones a worker needs, and the bridge
 * (`vm/relay-worker.sh`) gives each CLI its Relay server with the agent token alone.
 */
export const BRIDGED_HARNESS: Readonly<Record<string, { command: string; args: readonly string[] }>> = {
  cursor: { command: "morrow-cursor", args: ["--force", "--approve-mcps", "--trust", "--disable-auto-update"] },
  gemini: { command: "morrow-gemini", args: ["--approval-mode", "yolo"] },
  grok: { command: "morrow-grok", args: ["--always-approve", "--trust"] },
};

export type SpawnCode =
  | "started"
  | "name_in_use"
  | "bad_cwd"
  | "name_is_node"
  | "capability_mismatch"
  | "node_not_found"
  | "node_unavailable"
  | "no_eligible_node"
  | "placement_queue_full"
  | "placement_ttl_expired"
  | "sandbox_policy_mismatch"
  | "unmapped_repo"
  | "spawn_failed"
  | "spawn_retryable"
  | "spawn_unconfirmed"
  | "relay_rejected"
  | "relay_quota"
  | "relay_unavailable"
  | "transport_unknown";

/**
 * What the outbox does next:
 *  - started: verified running (harness proved readiness). Record the invocation id.
 *  - failed: nothing is running because of this call; retrying the same request cannot succeed.
 *  - retryable: rejected before anything launched; retry with backoff.
 *  - unconfirmed: something may be running. Never retry blindly; hand the lease to reconcile.
 */
export type SpawnOutcome =
  | { outcome: "started"; code: "started"; invocationId: string; nodeId: string | null; warning: string | null }
  | { outcome: "failed" | "retryable" | "unconfirmed"; code: Exclude<SpawnCode, "started">; invocationId: string | null; message: string };

/**
 * Targeted, verified spawn with the dispatcher token (the call `agent-relay fleet spawn --node` makes).
 * Input problems throw `RelayIntegrationError` before any network call; `brief_too_large` means the caller
 * must write the brief to a file on the branch and send a short pointer instead.
 */
export async function spawnWorker(input: {
  config: RelayConfig;
  dispatcherToken: string;
  reader: RelayReader;
  request: SpawnWorkerRequest;
  confirmTimeoutMs?: number;
  logger?: Logger;
}): Promise<SpawnOutcome> {
  const req = validateSpawnRequest(input.request);
  const confirmTimeoutMs = Math.max(MIN_CONFIRM_TIMEOUT_MS, input.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS);

  // The name is unique per lease epoch, so an existing record means an earlier attempt for this same lease
  // got far enough to register. Dispatching again would only fail with name-in-use; reconcile instead.
  let existing;
  try {
    existing = await input.reader.getAgent(req.name);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "registry read failed";
    return { outcome: "retryable", code: "relay_unavailable", invocationId: null, message };
  }
  if (existing) {
    const invocationId = fleetInvocationId(existing.metadata);
    return { outcome: "unconfirmed", code: "name_in_use", invocationId, message: "agent name already registered" };
  }

  try {
    const ack = await identityClient(input.config, input.dispatcherToken).messaging.placement.spawn({
      capability: `spawn:${req.cli}`,
      node: req.node,
      failFast: true,
      confirm: true,
      verifyReady: true,
      confirmTimeoutMs,
      input: spawnPlacementInput(req),
    });
    if (!ack.placement.confirmed || ack.placement.state !== "ready")
      return { outcome: "unconfirmed", code: "spawn_unconfirmed", invocationId: ack.invocationId ?? null, message: "spawn was not confirmed ready" };
    return {
      outcome: "started",
      code: "started",
      invocationId: ack.invocationId,
      nodeId: ack.dispatchedNodeId ?? null,
      warning: spawnWarning(ack.confirmation),
    };
  } catch (error) {
    const outcome = classifySpawnError(error);
    input.logger?.warn("relay.spawn.not_started", { agent: req.name, node: req.node, outcome: outcome.outcome, code: outcome.code, invocationId: outcome.invocationId });
    return outcome;
  }
}

/**
 * The `spawn:<cli>` action input. opencode gets an explicit PTY harness with `--agent agent-relay`: without it
 * the broker writes an opencode.json holding the workspace key into the worktree (the engineer can write there,
 * so a planted file would have the key merged in). The node's relay-worker bridge supplies that agent through
 * OPENCODE_CONFIG_CONTENT with the worker's own token instead. Cursor Agent, Gemini CLI and Grok always get their
 * `morrow-<cli>` harness ({@link BRIDGED_HARNESS}).
 */
export function spawnPlacementInput(req: SpawnWorkerRequest): Record<string, unknown> {
  const readOnly = req.readOnly ? READ_ONLY_ARGS[req.cli] : undefined;
  const bridged = BRIDGED_HARNESS[req.cli];
  const harness = bridged
    ? { runtime: "pty", command: bridged.command, args: [...(readOnly ?? bridged.args)] }
    : readOnly
      ? { runtime: "pty", command: req.cli, args: [...readOnly] }
      : req.cli === "opencode"
        ? { runtime: "pty", command: "opencode", args: ["--agent", "agent-relay"] }
        : null;
  return {
    name: req.name,
    cli: req.cli,
    task: req.task,
    // Always sent, even empty: the broker joins its default channel only when the key is missing.
    channels: req.channels,
    worker_cwd: req.workerCwd,
    ...(req.model ? { model: req.model } : {}),
    ...(harness ? { harnessConfig: harness } : {}),
  };
}

export function validateSpawnRequest(request: SpawnWorkerRequest): SpawnWorkerRequest {
  const name = assertWorkerName(request.name);
  const node = assertNodeName(request.node);
  if (name === node) throw new RelayIntegrationError("invalid_input", "name: must not equal the node name", { field: "name" });
  const cli = assertCli(request.cli);
  if (typeof request.task !== "string" || request.task.trim() === "")
    throw new RelayIntegrationError("invalid_input", "task: must be a non-empty string", { field: "task" });
  const bytes = utf8Bytes(request.task);
  if (bytes > MAX_TASK_BRIEF_BYTES)
    throw new RelayIntegrationError("brief_too_large", "task brief exceeds the PTY injection limit", { bytes, limit: MAX_TASK_BRIEF_BYTES });
  if (!Array.isArray(request.channels) || request.channels.length > 8)
    throw new RelayIntegrationError("invalid_input", "channels: must list 0-8 channels", { field: "channels" });
  if (request.readOnly !== undefined && typeof request.readOnly !== "boolean")
    throw new RelayIntegrationError("invalid_input", "readOnly: must be a boolean", { field: "readOnly" });
  if (request.readOnly && !READ_ONLY_ARGS[cli])
    throw new RelayIntegrationError("invalid_input", "readOnly: not supported for this CLI", { field: "readOnly" });
  const channels = [...new Set(request.channels.map((c) => assertChannelName(c)))];
  const workerCwd = assertWorkerCwd(request.workerCwd);
  if (request.model !== undefined && (typeof request.model !== "string" || !/^[A-Za-z0-9._:/-]{1,100}$/.test(request.model)))
    throw new RelayIntegrationError("invalid_input", "model: invalid", { field: "model" });
  return { name, node, cli, task: request.task, channels, workerCwd, ...(request.model ? { model: request.model } : {}), ...(request.readOnly ? { readOnly: true } : {}) };
}

/** Every SDK failure mapped to an outbox decision. Unknown failures are `unconfirmed`, never `failed`. */
export function classifySpawnError(error: unknown): Exclude<SpawnOutcome, { outcome: "started" }> {
  if (error instanceof RelayPlacementError) {
    const invocationId = error.invocationId ?? null;
    const message = error.message.slice(0, 500);
    switch (error.code) {
      case "spawn_unconfirmed":
        return { outcome: "unconfirmed", code: "spawn_unconfirmed", invocationId, message };
      case "spawn_retryable":
      case "node_unavailable":
      case "no_eligible_node":
      case "placement_queue_full":
      case "placement_ttl_expired":
        return { outcome: "retryable", code: error.code, invocationId, message };
      case "capability_mismatch":
      case "sandbox_policy_mismatch":
      case "unmapped_repo":
        return { outcome: "failed", code: error.code, invocationId, message };
      case "spawn_failed": {
        // The node's error string is the only discriminator the broker gives us.
        if (message.includes("spawn_agent_name_in_use"))
          // Our names are unique per lease, so "in use" most likely means an earlier attempt of this very
          // spawn is live (the broker has also reported this while the worker was still running).
          return { outcome: "unconfirmed", code: "name_in_use", invocationId, message };
        if (message.includes("worker_cwd")) return { outcome: "failed", code: "bad_cwd", invocationId, message };
        if (message.includes("is the broker self")) return { outcome: "failed", code: "name_is_node", invocationId, message };
        return { outcome: "failed", code: "spawn_failed", invocationId, message };
      }
      default:
        return { outcome: "unconfirmed", code: "transport_unknown", invocationId, message };
    }
  }
  const relay = asRelayError(error);
  if (relay) {
    const message = relay.message.slice(0, 500);
    if (relay.code === "not_found") return { outcome: "failed", code: "node_not_found", invocationId: null, message };
    // Hosted Relaycast caps a plan's messages and agents; the cap does not reset, so retrying cannot help.
    if (relay.rawCode === "plan_limit_exceeded") return { outcome: "failed", code: "relay_quota", invocationId: null, message };
    if (relay.code === "rate_limited" || relay.code === "backpressure") return { outcome: "retryable", code: "relay_unavailable", invocationId: null, message };
    // A transport error may have happened after the engine accepted the invocation.
    if (relay.code === "transport_error") return { outcome: "unconfirmed", code: "transport_unknown", invocationId: null, message };
    return { outcome: "failed", code: "relay_rejected", invocationId: null, message };
  }
  return { outcome: "unconfirmed", code: "transport_unknown", invocationId: null, message: error instanceof Error ? error.message.slice(0, 500) : "unknown error" };
}

/** Reads an earlier spawn back without launching anything (what `fleet spawn-status` does). */
export async function readSpawnInvocation(input: { config: RelayConfig; dispatcherToken: string; invocationId: string }): Promise<RelayActionInvocation> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(input.invocationId))
    throw new RelayIntegrationError("invalid_input", "invocationId: invalid", { field: "invocationId" });
  return identityClient(input.config, input.dispatcherToken).messaging.commands.getInvocation("spawn", input.invocationId);
}

export function fleetInvocationId(metadata: unknown): string | null {
  const fleet = metadata && typeof metadata === "object" ? (metadata as { fleet?: unknown }).fleet : undefined;
  const id = fleet && typeof fleet === "object" ? (fleet as { invocation_id?: unknown }).invocation_id : undefined;
  return typeof id === "string" && id ? id : null;
}

function spawnWarning(confirmation: RelayActionInvocation | undefined): string | null {
  const warning = confirmation?.output?.warning;
  if (warning && typeof warning === "object" && typeof (warning as { code?: unknown }).code === "string") return (warning as { code: string }).code;
  return null;
}
