import type { EnvironmentPhase, VmState } from "@morrow/contracts";
import type { Freestyle, Vm } from "freestyle";
import { baseSnapshot, freestyle } from "./client.ts";
import { FeatureDisabledError, FreestyleIntegrationError, invalidInput, toIntegrationError } from "./errors.ts";
import { requireSuccess, runScript } from "./exec.ts";
import {
  assertId,
  assertLinuxUser,
  assertNodeName,
  assertRepoFullName,
  linuxUserFor,
  metadataValue,
  nodeNameFor,
  vmSlugFor,
} from "./names.ts";
import { applyNodeConfig, assertRelaySecrets, desiredNodeConfig, nodeConfigHash, type NodeProfileInput, type RelayNodeSecrets } from "./node.ts";
import { probeEnvironment, type ProbeReport } from "./probe.ts";
import { cloneRepo } from "./repos.ts";
import { APP_METADATA_KEY, APP_METADATA_VALUE, ensureRunning, ensureVm, getVmData, toVmState } from "./vm.ts";
import { captureWarmSnapshot, deleteWarmSnapshots, type WarmTarget } from "./warm.ts";

/** Consecutive failures of one step before the environment parks in `error`. */
export const MAX_STEP_FAILURES = 5;

/**
 * The persisted shape this module reads and returns. The orchestrator stores it
 * in `Team.environments` and calls {@link advanceEnvironment} until `more` is false.
 * Holds no secret.
 */
export interface EnvironmentRecord {
  id: string;
  teamId: string;
  ownerUserId: string;
  phase: EnvironmentPhase;
  vmState: VmState;
  freestyleVmId: string | null;
  vmSlug: string;
  linuxUser: string;
  nodeName: string;
  /** Completed bootstrap steps. Every step is idempotent; these only skip work. */
  progress: { user: boolean; node: boolean; repos: string[]; warm: boolean };
  /** Digest of the node config last written to the VM. */
  nodeConfigHash: string | null;
  /** Phase to return to from `error` (on retry) or `paused` (on resume). */
  resumePhase: EnvironmentPhase | null;
  failures: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AdvanceInput {
  relay: RelayNodeSecrets;
  /** CLI profiles registered on this environment (from TeamWorkforce). */
  profiles: readonly NodeProfileInput[];
  /** Linked repos to clone (`owner/name`). */
  repos: readonly string[];
  /** Decrypted GitHub token of the owner, or null for public repos only. */
  githubToken: string | null;
  /** Set to leave `error` and retry the failed phase. */
  retry?: boolean;
  /** What a new VM boots from: the golden image, or the owner's warm snapshot (warm.ts). */
  snapshot?: string;
  /** Where to save the warm snapshot once the repos are cloned. Null: none is taken. */
  warm?: WarmTarget | null;
  client?: Freestyle;
  now?: () => number;
  vmWait?: { timeoutMs?: number; intervalMs?: number };
}

export interface AdvanceResult {
  record: EnvironmentRecord;
  /** The step that ran, or null when there was nothing to do. */
  step: string | null;
  /** Call again (after persisting `record`). False when settled, waiting on a human, or in `error`. */
  more: boolean;
  /** Present when the step ran the health probe. */
  probe?: ProbeReport;
  /**
   * `proc_not_hidden`: the node is configured, but the VM's /proc could not be mounted with hidepid, so
   * processes started outside the broker's unit could read the broker's command lines (applyNodeConfig).
   * `warm_snapshot_failed`: the warm snapshot could not be saved; setup went on without it.
   */
  warning?: "proc_not_hidden" | "warm_snapshot_failed";
}

export function newEnvironmentRecord(opts: { id: string; teamId: string; ownerUserId: string; now?: number }): EnvironmentRecord {
  assertId(opts.id, "envId");
  assertId(opts.teamId, "teamId");
  assertId(opts.ownerUserId, "ownerUserId");
  const now = opts.now ?? Date.now();
  return {
    id: opts.id,
    teamId: opts.teamId,
    ownerUserId: opts.ownerUserId,
    phase: "provisioning",
    vmState: "unknown",
    freestyleVmId: null,
    vmSlug: vmSlugFor(opts.teamId, opts.id),
    linuxUser: linuxUserFor(opts.ownerUserId),
    nodeName: nodeNameFor(opts.teamId, opts.id),
    progress: { user: false, node: false, repos: [], warm: false },
    nodeConfigHash: null,
    resumePhase: null,
    failures: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Names are derived, never trusted from storage: a tampered or stale record
 * cannot point exec at another account or user.
 */
export function assertRecord(record: EnvironmentRecord): void {
  assertId(record.id, "envId");
  assertId(record.teamId, "teamId");
  assertId(record.ownerUserId, "ownerUserId");
  assertLinuxUser(record.linuxUser);
  assertNodeName(record.nodeName);
  if (
    record.vmSlug !== vmSlugFor(record.teamId, record.id) ||
    record.linuxUser !== linuxUserFor(record.ownerUserId) ||
    record.nodeName !== nodeNameFor(record.teamId, record.id)
  ) {
    throw invalidInput("Environment record names do not match its ids.");
  }
  if (record.freestyleVmId !== null && (typeof record.freestyleVmId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.freestyleVmId))) {
    throw invalidInput("Invalid VM id on environment record.");
  }
}

export function vmMetadata(record: Pick<EnvironmentRecord, "teamId" | "id">): Record<string, string> {
  return { [APP_METADATA_KEY]: APP_METADATA_VALUE, team: metadataValue(record.teamId), env: metadataValue(record.id) };
}

/**
 * Run the next provisioning step and return the next record. Safe to call
 * repeatedly, concurrently, and after a crash at any point: every step is
 * idempotent on the VM, and the VM itself is found again by its derived slug.
 *
 * provisioning -> bootstrapping -> awaiting_login -> ready
 * Bootstrapping: Linux user, repos, warm snapshot (when asked for), then the Relay node. The snapshot comes
 * before the node so it never holds the workspace key or the node's identity.
 * Any step failure: retried (failures++), parked in `error` after
 * MAX_STEP_FAILURES or on a non-retryable error. `paused`/`disconnected` are
 * entered through lifecycle.ts, never here.
 */
export async function advanceEnvironment(record: EnvironmentRecord, input: AdvanceInput): Promise<AdvanceResult> {
  assertRecord(record);
  for (const repo of input.repos) assertRepoFullName(repo);
  const now = input.now ?? Date.now;
  const fs = input.client ?? freestyle();

  if (record.phase === "error") {
    if (!input.retry || !record.resumePhase) return { record, step: null, more: false };
    return { record: touch({ ...record, phase: record.resumePhase, resumePhase: null, failures: 0, lastError: null }, now), step: "retry", more: true };
  }
  if (record.phase === "paused" || record.phase === "disconnected") return { record, step: null, more: false };

  try {
    return await runStep(record, input, fs, now);
  } catch (error) {
    if (error instanceof FeatureDisabledError) throw error;
    const failure = toIntegrationError(error, "Environment setup");
    if (failure.kind === "invalid_input" && !(failure.detail && "status" in failure.detail)) throw failure;
    return { record: recordFailure(record, failure, now), step: "failed", more: false };
  }
}

async function runStep(record: EnvironmentRecord, input: AdvanceInput, fs: Freestyle, now: () => number): Promise<AdvanceResult> {
  if (record.phase === "provisioning") {
    const { data } = await ensureVm({
      client: fs,
      slug: record.vmSlug,
      snapshotId: input.snapshot ?? baseSnapshot(),
      metadata: vmMetadata(record),
    });
    const vm = fs.vms.ref(data.id);
    const running = await ensureRunning(vm, input.vmWait);
    return advanced(
      { ...record, freestyleVmId: data.id, vmState: toVmState(running.state), phase: "bootstrapping" },
      "create vm",
      true,
      now,
    );
  }

  const vm = await requireVm(record, fs);
  if (!vm) {
    // The VM vanished. Before login nothing of value lived on it, so start over;
    // after login the engineer's CLI sessions are gone and a human must decide.
    if (record.phase === "bootstrapping") {
      return advanced(
        { ...record, phase: "provisioning", freestyleVmId: null, vmState: "unknown", progress: { user: false, node: false, repos: [], warm: false }, nodeConfigHash: null },
        "vm missing, reprovision",
        true,
        now,
      );
    }
    throw new FreestyleIntegrationError("not_found", "The environment's VM no longer exists.");
  }

  if (record.phase === "bootstrapping") {
    const running = await ensureRunning(vm, input.vmWait);
    const base = { ...record, vmState: toVmState(running.state) };
    if (!record.progress.user) {
      requireSuccess(
        await runScript(vm, {
          user: "root",
          script: "bootstrap-user",
          timeoutMs: 60_000,
          step: "create Linux user",
          env: { MORROW_USER: record.linuxUser },
        }),
        "create Linux user",
      );
      return advanced({ ...base, progress: { ...record.progress, user: true } }, "create user", true, now);
    }
    // On a VM booted from a warm snapshot the checkouts are already there: this only fetches what changed,
    // and checks the owner can still read each repo.
    const pending = input.repos.find((repo) => !record.progress.repos.includes(repo));
    if (pending) {
      await cloneRepo(vm, { linuxUser: record.linuxUser, repoFullName: pending, githubToken: input.githubToken });
      return advanced({ ...base, progress: { ...record.progress, repos: [...record.progress.repos, pending] } }, `clone ${pending}`, true, now);
    }
    if (input.warm && input.repos.length > 0 && !record.progress.warm) {
      const done = { ...base, progress: { ...record.progress, warm: true } };
      try {
        const outcome = await captureWarmSnapshot(vm, input.warm);
        if (outcome === "created") await deleteWarmSnapshots(fs, { teamId: record.teamId, ownerUserId: record.ownerUserId, keepSlug: input.warm.slug });
        return advanced(done, `warm snapshot ${outcome}`, true, now);
      } catch {
        // Only speeds up the next environment: never worth failing this one.
        return { ...advanced(done, "warm snapshot", true, now), warning: "warm_snapshot_failed" };
      }
    }
    if (!record.progress.node) {
      const { hash, procHidden } = await syncNode(vm, record, input);
      return advanced({ ...base, progress: { ...record.progress, node: true }, nodeConfigHash: hash }, "configure node", true, now, procHidden);
    }
    return advanced({ ...base, phase: "awaiting_login" }, "bootstrap complete", true, now);
  }

  if (record.phase === "awaiting_login") {
    const probe = await probeEnvironment({ client: fs, vmId: vm.id, linuxUser: record.linuxUser });
    const loggedIn = Object.values(probe.clis).some((cli) => cli.auth === "ok");
    if (!loggedIn) return { record: settle(record, now), step: "probe", more: false, probe };
    // `more`: the orchestrator marks profiles ready from `probe`, then the next
    // call advertises them on the node.
    return { record: advanced({ ...record, phase: "ready" }, "login detected", true, now).record, step: "login detected", more: true, probe };
  }

  // ready: keep the node's advertised harnesses in step with ready profiles.
  const config = desiredNodeConfig(input.profiles);
  assertRelaySecrets(input.relay);
  const hash = nodeConfigHash({ linuxUser: record.linuxUser, nodeName: record.nodeName, config, relay: input.relay });
  if (hash === record.nodeConfigHash) return { record: settle(record, now), step: null, more: false };
  const running = await ensureRunning(vm, input.vmWait);
  const applied = await applyNodeConfig(vm, { linuxUser: record.linuxUser, nodeName: record.nodeName, config, relay: input.relay });
  return advanced({ ...record, vmState: toVmState(running.state), nodeConfigHash: hash }, "sync node", false, now, applied.procHidden);
}

async function syncNode(vm: Vm, record: EnvironmentRecord, input: AdvanceInput): Promise<{ hash: string; procHidden: boolean }> {
  const config = desiredNodeConfig(input.profiles);
  const applied = await applyNodeConfig(vm, { linuxUser: record.linuxUser, nodeName: record.nodeName, config, relay: input.relay });
  return { hash: nodeConfigHash({ linuxUser: record.linuxUser, nodeName: record.nodeName, config, relay: input.relay }), procHidden: applied.procHidden };
}

async function requireVm(record: EnvironmentRecord, fs: Freestyle): Promise<Vm | null> {
  const data = await getVmData(fs, record.freestyleVmId ?? record.vmSlug);
  return data ? fs.vms.ref(data.id) : null;
}

/** `procHidden` false (see applyNodeConfig) adds a warning to the step, which the runtime logs. */
function advanced(record: EnvironmentRecord, step: string, more: boolean, now: () => number, procHidden = true): AdvanceResult {
  const result: AdvanceResult = { record: touch({ ...record, failures: 0, lastError: null }, now), step, more };
  return procHidden ? result : { ...result, warning: "proc_not_hidden" };
}

function settle(record: EnvironmentRecord, now: () => number): EnvironmentRecord {
  return record.failures === 0 && record.lastError === null ? record : touch({ ...record, failures: 0, lastError: null }, now);
}

function touch(record: EnvironmentRecord, now: () => number): EnvironmentRecord {
  return { ...record, updatedAt: now() };
}

function recordFailure(record: EnvironmentRecord, failure: FreestyleIntegrationError, now: () => number): EnvironmentRecord {
  const failures = record.failures + 1;
  const park = !failure.retryable || failures >= MAX_STEP_FAILURES;
  return touch(
    {
      ...record,
      failures,
      lastError: failure.message,
      ...(park ? { phase: "error" as const, resumePhase: record.phase } : {}),
    },
    now,
  );
}

/**
 * Drive {@link advanceEnvironment} until it settles, persisting after every step
 * so a crash loses at most the step in flight. Backs off between failed attempts.
 */
export async function driveEnvironment(
  record: EnvironmentRecord,
  input: AdvanceInput,
  opts: { persist: (record: EnvironmentRecord) => Promise<void>; maxSteps?: number; backoffMs?: (failures: number) => number },
): Promise<AdvanceResult> {
  const maxSteps = opts.maxSteps ?? 32;
  const backoff = opts.backoffMs ?? ((n: number) => Math.min(1_000 * 2 ** (n - 1), 30_000));
  let current = record;
  let last: AdvanceResult = { record, step: null, more: false };
  for (let i = 0; i < maxSteps; i++) {
    last = await advanceEnvironment(current, { ...input, retry: false });
    if (last.record !== current) await opts.persist(last.record);
    current = last.record;
    if (last.step === "failed" && current.phase !== "error") {
      await Bun.sleep(backoff(current.failures));
      continue;
    }
    if (!last.more) break;
  }
  return last;
}
