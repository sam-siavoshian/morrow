import type { Freestyle } from "freestyle";
import { freestyle } from "./client.ts";
import { FreestyleIntegrationError, isFreestyleStatus, toIntegrationError } from "./errors.ts";
import { assertRecord, type EnvironmentRecord } from "./environment.ts";
import { assertId } from "./names.ts";
import { removeNodeConfig } from "./node.ts";
import { TERMINAL_SESSION } from "./terminal.ts";
import { ensureRunning, getVmData, toVmState } from "./vm.ts";

const PAUSABLE = new Set(["awaiting_login", "ready"]);

/**
 * Pause the environment's VM (memory and processes freeze; storage-only billing).
 * The caller must pass whether a live lease uses this VM: pausing would freeze a
 * working agent mid-task, so that is refused rather than left to the caller.
 */
export async function pauseEnvironment(
  record: EnvironmentRecord,
  opts: { hasLiveLease: boolean; client?: Freestyle; now?: number },
): Promise<EnvironmentRecord> {
  assertRecord(record);
  if (record.phase === "paused") return record;
  if (opts.hasLiveLease) {
    throw new FreestyleIntegrationError("conflict", "A worker is running on this environment. Release it before pausing.");
  }
  if (!PAUSABLE.has(record.phase) || !record.freestyleVmId) {
    throw new FreestyleIntegrationError("conflict", "This environment cannot be paused right now.");
  }
  const fs = opts.client ?? freestyle();
  const vm = fs.vms.ref(record.freestyleVmId);
  const data = await getVmData(fs, record.freestyleVmId);
  if (!data) throw new FreestyleIntegrationError("not_found", "The environment's VM no longer exists.");
  let state = data.state;
  if (state !== "paused" && state !== "pausing") {
    try {
      state = (await vm.pause()).state;
    } catch (error) {
      throw toIntegrationError(error, "Pause VM");
    }
  }
  return {
    ...record,
    phase: "paused",
    resumePhase: record.phase,
    vmState: toVmState(state),
    updatedAt: opts.now ?? Date.now(),
  };
}

/**
 * Resume a paused environment with `vm.start()`. The caller then waits for the
 * Relay node to come back online and runs a fresh probe before routing work.
 */
export async function resumeEnvironment(
  record: EnvironmentRecord,
  opts: { client?: Freestyle; now?: number; vmWait?: { timeoutMs?: number; intervalMs?: number } } = {},
): Promise<EnvironmentRecord> {
  assertRecord(record);
  if (record.phase !== "paused") return record;
  if (!record.freestyleVmId) throw new FreestyleIntegrationError("conflict", "This environment has no VM.");
  const fs = opts.client ?? freestyle();
  if (!(await getVmData(fs, record.freestyleVmId))) {
    throw new FreestyleIntegrationError("not_found", "The environment's VM no longer exists.");
  }
  const data = await ensureRunning(fs.vms.ref(record.freestyleVmId), opts.vmWait);
  return {
    ...record,
    phase: record.resumePhase && PAUSABLE.has(record.resumePhase) ? record.resumePhase : "awaiting_login",
    resumePhase: null,
    vmState: toVmState(data.state),
    updatedAt: opts.now ?? Date.now(),
  };
}

/**
 * Take the environment out of service. Revokes every terminal grant on the VM,
 * then either deletes the VM, or keeps it with the Relay node stopped, its key
 * file deleted and the shared terminal session killed. Idempotent; a VM that is
 * already gone counts as done.
 */
export async function disconnectEnvironment(
  record: EnvironmentRecord,
  opts: { deleteVm: boolean; identityIds: readonly string[]; client?: Freestyle; now?: number },
): Promise<EnvironmentRecord> {
  assertRecord(record);
  for (const id of opts.identityIds) assertId(id, "identityId");
  const fs = opts.client ?? freestyle();
  const vmId = record.freestyleVmId;

  if (vmId) {
    for (const identityId of opts.identityIds) {
      try {
        await fs.identities.ref(identityId).permissions.vm.revoke(vmId);
      } catch (error) {
        if (!isFreestyleStatus(error, 404)) throw toIntegrationError(error, "Revoke terminal access");
      }
    }
    const data = await getVmData(fs, vmId);
    if (data) {
      const vm = fs.vms.ref(vmId);
      if (opts.deleteVm) {
        try {
          await vm.delete();
        } catch (error) {
          if (!isFreestyleStatus(error, 404)) throw toIntegrationError(error, "Delete VM");
        }
      } else {
        await ensureRunning(vm);
        await removeNodeConfig(vm, record.linuxUser);
        try {
          await vm.linuxUser(record.linuxUser).pty.close(TERMINAL_SESSION);
        } catch (error) {
          if (!isFreestyleStatus(error, 404)) throw toIntegrationError(error, "Close terminal");
        }
      }
    }
  }
  return {
    ...record,
    phase: "disconnected",
    resumePhase: null,
    vmState: opts.deleteVm || !vmId ? "unknown" : record.vmState,
    nodeConfigHash: null,
    lastError: null,
    failures: 0,
    updatedAt: opts.now ?? Date.now(),
  };
}
