import { createHash } from "node:crypto";
import type { Freestyle, Vm } from "freestyle";
import { isFreestyleStatus, toIntegrationError } from "./errors.ts";
import { assertId, assertRepoFullName } from "./names.ts";
import { CRED_DIR } from "./repos.ts";

// A warm snapshot is an environment's VM caught right after its owner's repos were cloned: the Linux user,
// the root-owned mirrors and the checkouts, nothing else. It is taken before the Relay node is configured
// (no workspace key, no node identity) and before anyone signs in to a CLI (no OAuth token: the CLIs rotate
// refresh tokens, so two VMs booted from one signed-in image would sign the owner out). The owner's next
// environment in the same team, on the same golden image and repos, boots from it and only fetches what
// changed since.

/** Unused this long, Freestyle deletes it. Every boot from it resets the clock. */
export const WARM_AUTO_DELETE_SECONDS = 7 * 24 * 60 * 60;
/** Bounds the sweep for an owner's older warm snapshots. */
const MAX_SWEEP = 2_000;
const PAGE = 100;

export interface WarmKey {
  teamId: string;
  ownerUserId: string;
  /** The golden image's snapshot id (not its slug: a rebuild keeps the slug and must not reuse old images). */
  baseSnapshotId: string;
  repos: readonly string[];
}

export interface WarmTarget {
  slug: string;
  label: string;
}

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/** The snapshot's slug: one per owner, team, golden image and repo set. */
export function warmSnapshotSlug(key: WarmKey): string {
  assertId(key.teamId, "teamId");
  assertId(key.ownerUserId, "ownerUserId");
  for (const repo of key.repos) assertRepoFullName(repo);
  const repos = [...new Set(key.repos)].sort();
  return `mw-${digest(JSON.stringify({ v: 1, team: key.teamId, owner: key.ownerUserId, base: key.baseSnapshotId, repos }), 32)}`;
}

/** Shared by every warm snapshot of one owner in one team, so a newer one can replace the rest. */
export function warmSnapshotLabel(teamId: string, ownerUserId: string): string {
  assertId(teamId, "teamId");
  assertId(ownerUserId, "ownerUserId");
  return `morrow warm ${digest(JSON.stringify({ team: teamId, owner: ownerUserId }), 16)}`;
}

export function warmTarget(key: WarmKey): WarmTarget {
  return { slug: warmSnapshotSlug(key), label: warmSnapshotLabel(key.teamId, key.ownerUserId) };
}

/** A snapshot slug or id -> its id. Public base images (`freestyle/...`) are not ours to read: they are their own id. */
export async function resolveSnapshotId(fs: Freestyle, idOrSlug: string): Promise<string> {
  if (idOrSlug.startsWith("freestyle/")) return idOrSlug;
  try {
    return (await fs.vms.snapshots.get(idOrSlug)).id;
  } catch (error) {
    throw toIntegrationError(error, "Read base snapshot");
  }
}

/** The warm snapshot's id, or null when there is none. */
export async function findWarmSnapshot(fs: Freestyle, slug: string): Promise<string | null> {
  try {
    return (await fs.vms.snapshots.get(slug)).id;
  } catch (error) {
    if (isFreestyleStatus(error, 404)) return null;
    throw toIntegrationError(error, "Read warm snapshot");
  }
}

export type CaptureOutcome = "created" | "exists" | "skipped";

/**
 * Snapshots the VM as the warm image for `target`. Skipped while a GitHub credential file is still on the
 * VM (a clone that was cut off): the image must hold no token. `exists` when another environment won the race.
 */
export async function captureWarmSnapshot(vm: Vm, target: WarmTarget): Promise<CaptureOutcome> {
  let leftover: number;
  try {
    leftover = (await vm.fs.readDir(CRED_DIR)).length;
  } catch (error) {
    if (!isFreestyleStatus(error, 404)) throw toIntegrationError(error, "Check credentials before snapshot");
    leftover = 0;
  }
  if (leftover > 0) return "skipped";
  try {
    await vm.snapshot({ slug: target.slug, displayName: target.label, autoDeleteSeconds: WARM_AUTO_DELETE_SECONDS });
    return "created";
  } catch (error) {
    if (isFreestyleStatus(error, 409)) return "exists";
    throw toIntegrationError(error, "Save warm snapshot");
  }
}

/** Deletes one owner's warm snapshots in a team, except `keepSlug`. Returns how many went. */
export async function deleteWarmSnapshots(fs: Freestyle, opts: { teamId: string; ownerUserId: string; keepSlug?: string }): Promise<number> {
  const label = warmSnapshotLabel(opts.teamId, opts.ownerUserId);
  const doomed: string[] = [];
  try {
    for (let offset = 0; offset < MAX_SWEEP; offset += PAGE) {
      const page = await fs.vms.snapshots.list({ limit: PAGE, offset });
      for (const snap of page.snapshots) {
        if (snap.displayName === label && snap.slug !== opts.keepSlug) doomed.push(snap.id);
      }
      if (page.snapshots.length < PAGE) break;
    }
  } catch (error) {
    throw toIntegrationError(error, "List warm snapshots");
  }
  let deleted = 0;
  for (const id of doomed) {
    try {
      await fs.vms.snapshots.delete(id);
      deleted++;
    } catch (error) {
      if (!isFreestyleStatus(error, 404)) throw toIntegrationError(error, "Delete warm snapshot");
    }
  }
  return deleted;
}
