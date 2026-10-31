// Builds the `morrow-base` golden snapshot that every engineer VM boots from.
//   bun vm/build-golden.ts [--slug morrow-base] [--base freestyle/ubuntu] [--rebuild]
// Idempotent: an existing snapshot with the slug is reported and kept unless
// --rebuild. BILLABLE: boots one builder VM for a few minutes, always deleted.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Freestyle, SnapshotData, Vm } from "freestyle";
import { freestyle } from "../src/integrations/freestyle/client.ts";
import { FreestyleIntegrationError, isFreestyleStatus, toIntegrationError } from "../src/integrations/freestyle/errors.ts";
import { requireSuccess, runScript } from "../src/integrations/freestyle/exec.ts";
import { assertVmSlug } from "../src/integrations/freestyle/names.ts";
import { APP_METADATA_KEY, APP_METADATA_VALUE, ensureRunning, WORKER_FIREWALL } from "../src/integrations/freestyle/vm.ts";

const STEPS = ["gh", "relay", "bun", "morrow", "gemini", "cursor", "grok", "verify", "scrub"] as const;

/** The morrow-agent MCP server (docs/subagents.md), sent to the builder as env and checked there by sha256. */
export async function morrowAgentEnv(): Promise<{ MORROW_AGENT_B64: string; MORROW_AGENT_SHA256: string }> {
  const bytes = new Uint8Array(await Bun.file(join(import.meta.dir, "morrow-agent.js")).arrayBuffer());
  return { MORROW_AGENT_B64: Buffer.from(bytes).toString("base64"), MORROW_AGENT_SHA256: createHash("sha256").update(bytes).digest("hex") };
}

export interface GoldenBuildResult {
  snapshotId: string;
  slug: string;
  created: boolean;
  /** Plans can cap how long an unused snapshot is kept; check this before relying on it. */
  autoDeleteSeconds: number | null;
  autoDeleteFromPlan: boolean;
}

export async function buildGoldenSnapshot(opts: {
  slug?: string;
  base?: string;
  rebuild?: boolean;
  client?: Freestyle;
  log?: (line: string) => void;
}): Promise<GoldenBuildResult> {
  const slug = opts.slug ?? "morrow-base";
  assertVmSlug(slug);
  const fs = opts.client ?? freestyle();
  const log = opts.log ?? (() => {});

  const existing = await getSnapshot(fs, slug);
  if (existing && !opts.rebuild) {
    log(`snapshot ${slug} already exists (${existing.id})`);
    return report(existing, false);
  }

  log(`booting builder from ${opts.base ?? "freestyle/ubuntu"}`);
  let builder: Vm;
  try {
    ({ vm: builder } = await fs.vms.create({
      snapshotId: opts.base ?? "freestyle/ubuntu",
      firewall: WORKER_FIREWALL,
      metadata: { [APP_METADATA_KEY]: APP_METADATA_VALUE, role: "golden-builder" },
      // Self-destruct if this process dies before the finally block runs.
      ttlSeconds: 3_600,
    }));
  } catch (error) {
    throw toIntegrationError(error, "Create builder VM");
  }

  try {
    await ensureRunning(builder);
    const morrow = await morrowAgentEnv();
    for (const step of STEPS) {
      log(`golden step: ${step}`);
      requireSuccess(
        await runScript(builder, {
          user: "root",
          script: "golden-setup",
          timeoutMs: 300_000,
          step: `golden ${step}`,
          env: { MORROW_GOLDEN_STEP: step, ...(step === "morrow" ? morrow : {}) },
        }),
        `golden ${step}`,
      );
    }
    if (existing) {
      // --rebuild: free the slug; the old snapshot stays addressable by id.
      await fs.vms.snapshots.update(existing.id, { slug: "" });
    }
    log("snapshotting");
    let created;
    try {
      created = await builder.snapshot({ slug, displayName: "Morrow base" });
    } catch (error) {
      if (!isFreestyleStatus(error, 409)) throw toIntegrationError(error, "Snapshot builder");
      // A concurrent build won the slug. Use the winner.
      const winner = await getSnapshot(fs, slug);
      if (!winner) throw new FreestyleIntegrationError("conflict", "Snapshot slug is busy, retry.", { retryable: true });
      return report(winner, false);
    }
    return report(created.snapshot, true);
  } finally {
    await builder.delete().catch((error) => log(`could not delete builder ${builder.id}: ${String(error)}`));
  }
}

async function getSnapshot(fs: Freestyle, slug: string): Promise<SnapshotData | null> {
  try {
    return await fs.vms.snapshots.get(slug);
  } catch (error) {
    if (isFreestyleStatus(error, 404)) return null;
    throw toIntegrationError(error, "Read snapshot");
  }
}

function report(snapshot: SnapshotData, created: boolean): GoldenBuildResult {
  return {
    snapshotId: snapshot.id,
    slug: snapshot.slug ?? "",
    created,
    autoDeleteSeconds: snapshot.autoDeleteSeconds ?? null,
    autoDeleteFromPlan: snapshot.autoDeleteFromPlan ?? false,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const result = await buildGoldenSnapshot({
      slug: value("--slug"),
      base: value("--base"),
      rebuild: args.includes("--rebuild"),
      log: (line) => console.error(line),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.autoDeleteFromPlan) {
      console.error(`warning: your plan deletes this snapshot after ${result.autoDeleteSeconds}s without use`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`golden build failed: ${message}`);
    process.exit(1);
  }
}
