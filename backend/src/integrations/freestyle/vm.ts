import type { VmState } from "@morrow/contracts";
import type { FirewallSpec, Freestyle, Vm, VmData } from "freestyle";
import { freestyle } from "./client.ts";
import { FreestyleIntegrationError, isFreestyleStatus, toIntegrationError } from "./errors.ts";
import { assertVmSlug } from "./names.ts";

/** Outbound to any public address; no inbound (PTY, SSH and domains need none). */
export const WORKER_FIREWALL: FirewallSpec = {
  rules: [{ action: "allow", source: {}, destination: { public: true } }],
};

export const APP_METADATA_KEY = "app";
export const APP_METADATA_VALUE = "morrow";

const KNOWN_STATES = new Set<VmState>(["starting", "running", "pausing", "paused", "stopped"]);

export function toVmState(state: string | undefined | null): VmState {
  return state && KNOWN_STATES.has(state as VmState) ? (state as VmState) : "unknown";
}

export interface EnsureVmResult {
  vm: Vm;
  data: VmData;
  created: boolean;
}

/**
 * Get-or-create a persistent VM by slug. A concurrent create for the same slug
 * answers 409; the loser re-reads and returns the winner. A VM holding our slug
 * but not our metadata is refused instead of adopted.
 */
export async function ensureVm(opts: {
  slug: string;
  snapshotId: string;
  metadata: Record<string, string>;
  client?: Freestyle;
}): Promise<EnsureVmResult> {
  assertVmSlug(opts.slug);
  const fs = opts.client ?? freestyle();
  const existing = await getVmData(fs, opts.slug);
  if (existing) return { vm: fs.vms.ref(existing.id), data: assertOwned(existing, opts.metadata), created: false };
  try {
    const { vm, data } = await fs.vms.create({
      snapshotId: opts.snapshotId,
      slug: opts.slug,
      metadata: opts.metadata,
      firewall: WORKER_FIREWALL,
      // Never idle-pause: it is unknown whether Relay's outbound socket counts
      // as activity, and pausing mid-task freezes the workers. The backend pauses.
      idleTimeoutSeconds: -1,
    });
    return { vm, data, created: true };
  } catch (error) {
    if (!isFreestyleStatus(error, 409)) throw toIntegrationError(error, "Create VM");
    const winner = await getVmData(fs, opts.slug);
    if (!winner) {
      throw new FreestyleIntegrationError("conflict", "Create VM: slug is busy, retrying.", { retryable: true });
    }
    return { vm: fs.vms.ref(winner.id), data: assertOwned(winner, opts.metadata), created: false };
  }
}

function assertOwned(data: VmData, metadata: Record<string, string>): VmData {
  for (const [key, value] of Object.entries(metadata)) {
    if (data.metadata?.[key] !== value) {
      throw new FreestyleIntegrationError("conflict", "A VM with this environment's name belongs to something else.", {
        detail: { vmId: data.id, key },
      });
    }
  }
  return data;
}

/** The VM record, or null when it does not exist (deleted VMs are a 404, not a state). */
export async function getVmData(fs: Freestyle, idOrSlug: string): Promise<VmData | null> {
  try {
    return await fs.vms.get(idOrSlug);
  } catch (error) {
    if (isFreestyleStatus(error, 404)) return null;
    throw toIntegrationError(error, "Read VM");
  }
}

export interface VmStatus {
  exists: boolean;
  state: VmState;
}

/** Status polling for one VM. There are no lifecycle webhooks, so the hub polls this. */
export async function getVmStatus(vmId: string, client?: Freestyle): Promise<VmStatus> {
  const data = await getVmData(client ?? freestyle(), vmId);
  return data ? { exists: true, state: toVmState(data.state) } : { exists: false, state: "unknown" };
}

/** All Morrow VMs in one paged sweep, keyed by VM id. Bounded at `maxVms`. */
export async function listVmStatuses(opts: { client?: Freestyle; maxVms?: number } = {}): Promise<Map<string, VmState>> {
  const fs = opts.client ?? freestyle();
  const max = opts.maxVms ?? 2_000;
  const pageSize = 100;
  const states = new Map<string, VmState>();
  try {
    for (let offset = 0; offset < max; offset += pageSize) {
      const page = await fs.vms.list({ metadata: `${APP_METADATA_KEY}:${APP_METADATA_VALUE}`, limit: pageSize, offset });
      for (const vm of page.vms) states.set(vm.id, toVmState(vm.state));
      if (page.vms.length < pageSize) break;
    }
  } catch (error) {
    throw toIntegrationError(error, "List VMs");
  }
  return states;
}

/** Poll until the VM reports `target`. */
export async function waitForVmState(
  vm: Vm,
  target: VmState,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<VmData> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  for (;;) {
    let data: VmData;
    try {
      data = await vm.data();
    } catch (error) {
      throw toIntegrationError(error, "Read VM");
    }
    if (data.state === target) return data;
    if (Date.now() >= deadline) {
      throw new FreestyleIntegrationError("dependency_unavailable", `VM did not reach ${target} in time.`, {
        retryable: true,
        detail: { vmId: vm.id, state: data.state },
      });
    }
    await Bun.sleep(opts.intervalMs ?? 1_000);
  }
}

/** Make sure the VM is running before exec: boots a stopped VM, resumes a paused one. */
export async function ensureRunning(vm: Vm, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<VmData> {
  let data: VmData;
  try {
    data = await vm.data();
  } catch (error) {
    throw toIntegrationError(error, "Read VM");
  }
  if (data.state === "running") return data;
  if (data.state === "pausing") data = await waitForVmState(vm, "paused", opts);
  if (data.state === "paused" || data.state === "stopped") {
    try {
      data = await vm.start();
    } catch (error) {
      throw toIntegrationError(error, "Start VM");
    }
    if (data.state === "running") return data;
  }
  return waitForVmState(vm, "running", opts);
}
