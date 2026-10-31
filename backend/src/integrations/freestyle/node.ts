import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliKind, PROFILE_MAX_CONCURRENT } from "@morrow/contracts";
import type { Vm } from "freestyle";
import { invalidInput } from "./errors.ts";
import { lastJsonLine, loadVmScript, requireSuccess, runScript, VM_SCRIPT_DIR } from "./exec.ts";
import { assertLinuxUser, assertNodeName, assertRelayBaseUrl, assertRelayKey } from "./names.ts";

const MAX_NODE_AGENTS = 16;

/**
 * Digest of the scripts that lay the node out on the VM (broker user, CLI bridge, sudo rule, unit). Part of
 * {@link nodeConfigHash}, so a new layout reaches every node on its next sync instead of only new ones.
 */
export const NODE_LAYOUT_DIGEST = createHash("sha256")
  .update(readFileSync(join(VM_SCRIPT_DIR, "configure-node.sh"), "utf8"))
  .update(readFileSync(join(VM_SCRIPT_DIR, "relay-worker.sh"), "utf8"))
  .digest("hex");

export interface NodeProfileInput {
  cli: CliKind;
  /** Only ready (logged-in, not limited out) profiles are advertised to Relay. */
  ready: boolean;
}

export interface RelayNodeSecrets {
  /** Decrypted workspace key. Travels only as exec env into a root-only file. */
  workspaceKey: string;
  /** Engine origin; null for hosted Relaycast. */
  baseUrl: string | null;
}

export interface NodeConfig {
  harnesses: CliKind[];
  maxAgents: number;
}

/**
 * What the node should advertise. No ready profile means no harness, and the
 * unit stays stopped: an empty AGENT_RELAY_NODE_HARNESSES makes the broker
 * advertise every harness it knows, installed or not.
 *
 * Capacity is the ceiling for the ready logins (`PROFILE_MAX_CONCURRENT` each, at
 * most {@link MAX_NODE_AGENTS}), not their current "workers at once". The actor
 * holds every lease, subagents included, to that setting, so the broker is only a
 * backstop. Tying it to the setting would restart the broker (killing its workers)
 * on every change, or leave a raise waiting behind a broker too small for it.
 */
export function desiredNodeConfig(profiles: readonly NodeProfileInput[]): NodeConfig {
  const ready = profiles.filter((p) => p.ready);
  if (ready.some((p) => !CliKind.options.includes(p.cli))) throw invalidInput("Invalid profile for node config.");
  const harnesses = CliKind.options.filter((cli) => ready.some((p) => p.cli === cli));
  const maxAgents = Math.min(MAX_NODE_AGENTS, harnesses.length * PROFILE_MAX_CONCURRENT);
  return { harnesses, maxAgents };
}

/**
 * Fingerprint of everything written to the VM. Stored on the environment record
 * so unchanged config is never rewritten (a rewrite restarts the node and kills
 * its workers). The key enters only as a one-way digest.
 */
export function nodeConfigHash(opts: {
  linuxUser: string;
  nodeName: string;
  config: NodeConfig;
  relay: RelayNodeSecrets;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        u: opts.linuxUser,
        n: opts.nodeName,
        h: opts.config.harnesses,
        m: opts.config.maxAgents,
        b: opts.relay.baseUrl,
        l: NODE_LAYOUT_DIGEST,
        k: createHash("sha256").update(opts.relay.workspaceKey).digest("hex"),
      }),
    )
    .digest("hex");
}

export function assertRelaySecrets(relay: RelayNodeSecrets): void {
  assertRelayKey(relay.workspaceKey);
  if (relay.baseUrl !== null) assertRelayBaseUrl(relay.baseUrl);
}

/**
 * Write node.env + the systemd unit and bring the node to the desired state. Also lays the node out so the
 * workspace key stays with the broker: its own Linux user, the CLI bridge (`vm/relay-worker.sh`, sent as env)
 * and the sudo rule. `procHidden` is false when the VM's /proc could not be mounted with hidepid: workers still
 * cannot see the broker (the unit has its own hidden /proc), but processes started outside it could read the
 * broker's PTY command lines.
 */
export async function applyNodeConfig(
  vm: Vm,
  opts: { linuxUser: string; nodeName: string; config: NodeConfig; relay: RelayNodeSecrets },
): Promise<{ changed: boolean; active: boolean; procHidden: boolean }> {
  assertLinuxUser(opts.linuxUser);
  assertNodeName(opts.nodeName);
  assertRelaySecrets(opts.relay);
  const outcome = requireSuccess(
    await runScript(vm, {
      user: "root",
      script: "configure-node",
      timeoutMs: 60_000,
      step: "configure Relay node",
      env: {
        ACTION: "apply",
        MORROW_USER: opts.linuxUser,
        NODE_NAME: opts.nodeName,
        HARNESSES: opts.config.harnesses.join(","),
        MAX_AGENTS: String(opts.config.maxAgents),
        RELAY_WORKSPACE_KEY: opts.relay.workspaceKey,
        RELAY_BASE_URL: opts.relay.baseUrl ?? "",
        RELAY_WORKER_SCRIPT: Buffer.from(await loadVmScript("relay-worker"), "utf8").toString("base64"),
      },
    }),
    "configure Relay node",
  );
  const result = lastJsonLine(outcome.stdout, "configure Relay node") as { changed?: unknown; active?: unknown; procHidden?: unknown };
  return { changed: result.changed === true, active: result.active === true, procHidden: result.procHidden === true };
}

/** Stop and disable the node, and delete the env file that holds the workspace key. */
export async function removeNodeConfig(vm: Vm, linuxUser: string): Promise<void> {
  assertLinuxUser(linuxUser);
  requireSuccess(
    await runScript(vm, {
      user: "root",
      script: "configure-node",
      timeoutMs: 60_000,
      step: "remove Relay node",
      env: { ACTION: "remove", MORROW_USER: linuxUser },
    }),
    "remove Relay node",
  );
}

/**
 * Restart the node's broker unit without touching its config. Recovery for a
 * broker whose engine control link is stuck after a worker crash; it kills the
 * node's remaining workers, so callers rate-limit it. A unit that apply left
 * disabled (no ready harness) is not started.
 */
export async function restartNodeService(vm: Vm, linuxUser: string): Promise<{ restarted: boolean; active: boolean }> {
  assertLinuxUser(linuxUser);
  const outcome = requireSuccess(
    await runScript(vm, {
      user: "root",
      script: "configure-node",
      timeoutMs: 60_000,
      step: "restart Relay node",
      env: { ACTION: "restart", MORROW_USER: linuxUser },
    }),
    "restart Relay node",
  );
  const result = lastJsonLine(outcome.stdout, "restart Relay node") as { restarted?: unknown; active?: unknown };
  return { restarted: result.restarted === true, active: result.active === true };
}
