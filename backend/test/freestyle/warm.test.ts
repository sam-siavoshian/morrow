// Warm snapshots: the key that decides reuse, the capture step inside bootstrapping (after the clones, before
// the Relay node, never with a credential on disk), and the sweep that keeps one per owner.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  advanceEnvironment,
  deleteWarmSnapshots,
  findWarmSnapshot,
  newEnvironmentRecord,
  resolveSnapshotId,
  warmTarget,
  type EnvironmentRecord,
  type WarmTarget,
} from "../../src/integrations/freestyle/index.ts";
import { CRED_DIR } from "../../src/integrations/freestyle/repos.ts";
import { warmSnapshotLabel, warmSnapshotSlug, type WarmKey } from "../../src/integrations/freestyle/warm.ts";
import type { FreestyleMock } from "../fixtures/freestyle-mock/server.ts";
import { baseInput, RELAY_KEY, GITHUB_TOKEN, useMock } from "./helpers.ts";

const KEY: WarmKey = { teamId: "t-abc", ownerUserId: "u-1001", baseSnapshotId: "sh-golden1", repos: ["acme/web", "acme/api"] };
const NODE_ENV = "/etc/agent-relay/node.env";

describe("warm snapshot key", () => {
  test("one slug per team, owner, golden image and repo set; repo order and duplicates do not matter", () => {
    const slug = warmSnapshotSlug(KEY);
    expect(slug).toMatch(/^mw-[0-9a-f]{32}$/);
    expect(warmSnapshotSlug({ ...KEY })).toBe(slug);
    expect(warmSnapshotSlug({ ...KEY, repos: ["acme/api", "acme/web", "acme/api"] })).toBe(slug);
    const others = [
      { ...KEY, teamId: "t-other" },
      { ...KEY, ownerUserId: "u-1002" },
      { ...KEY, baseSnapshotId: "sh-golden2" },
      { ...KEY, repos: ["acme/web"] },
      { ...KEY, repos: ["acme/web", "acme/api", "acme/docs"] },
    ].map(warmSnapshotSlug);
    expect(new Set([slug, ...others]).size).toBe(6);
  });

  test("the label is shared by one owner's snapshots in a team, and by no one else's", () => {
    const label = warmSnapshotLabel(KEY.teamId, KEY.ownerUserId);
    expect(label).toMatch(/^morrow warm [0-9a-f]{16}$/);
    expect(warmTarget({ ...KEY, baseSnapshotId: "sh-golden2", repos: ["x/y"] }).label).toBe(label);
    expect(warmSnapshotLabel("t-other", KEY.ownerUserId)).not.toBe(label);
    expect(warmSnapshotLabel(KEY.teamId, "u-1002")).not.toBe(label);
    // Ids never appear in the clear (the label is visible in the Freestyle dashboard).
    expect(label).not.toContain(KEY.ownerUserId);
  });

  test("rejects malformed ids and repo names", () => {
    expect(() => warmSnapshotSlug({ ...KEY, teamId: "../x" })).toThrow("not a valid id");
    expect(() => warmSnapshotSlug({ ...KEY, ownerUserId: "" })).toThrow("not a valid id");
    expect(() => warmSnapshotSlug({ ...KEY, repos: ["acme/web; rm -rf /"] })).toThrow();
    expect(() => warmSnapshotLabel("t-abc", "u 1")).toThrow("not a valid id");
  });
});

describe("warm snapshots on Freestyle", () => {
  let ctx: ReturnType<typeof useMock>;
  let mock: FreestyleMock;
  beforeEach(() => {
    ctx = useMock();
    mock = ctx.mock;
  });
  afterEach(() => ctx.restore());

  const target: WarmTarget = warmTarget(KEY);
  const record = (id = "env-1", ownerUserId = "u-1001") => newEnvironmentRecord({ id, teamId: "t-abc", ownerUserId });
  const warmInput = (overrides: Parameters<typeof baseInput>[0] = {}) => baseInput({ warm: target, ...overrides });

  /** Advances until bootstrapping is done; returns every step name and the record. */
  async function bootstrap(start: EnvironmentRecord, input = warmInput()) {
    let r = start;
    const steps: string[] = [];
    const warnings: string[] = [];
    for (let i = 0; i < 20 && (r.phase === "provisioning" || r.phase === "bootstrapping"); i++) {
      const result = await advanceEnvironment(r, input);
      if (result.step) steps.push(result.step);
      if (result.warning) warnings.push(result.warning);
      r = result.record;
    }
    return { record: r, steps, warnings };
  }

  const warmSnapshots = () => [...mock.snapshots.values()].filter((s) => typeof s.slug === "string" && s.slug.startsWith("mw-"));

  test("is taken after the clones and before the Relay node, so it never holds the workspace key", async () => {
    let r = record();
    const steps: string[] = [];
    let nodeEnvAtCapture: string | undefined = "unset";
    while (r.phase === "provisioning" || r.phase === "bootstrapping") {
      const result = await advanceEnvironment(r, warmInput());
      steps.push(result.step!);
      r = result.record;
      if (result.step?.startsWith("warm snapshot")) nodeEnvAtCapture = mock.vms.get(r.freestyleVmId!)!.guest.readText(NODE_ENV);
    }
    expect(steps).toEqual(["create vm", "create user", "clone acme/web", "clone acme/api", "warm snapshot created", "configure node", "bootstrap complete"]);
    expect(nodeEnvAtCapture).toBeUndefined();
    expect(mock.vms.get(r.freestyleVmId!)!.guest.readText(NODE_ENV)).toContain(RELAY_KEY);
    expect(r.phase).toBe("awaiting_login");
    expect(r.progress.warm).toBe(true);
    const [snap, ...rest] = warmSnapshots();
    expect(rest).toEqual([]);
    expect(snap).toMatchObject({ slug: target.slug, displayName: target.label, sourceVmId: r.freestyleVmId });
    // Nothing secret went to Freestyle with the snapshot request.
    for (const e of mock.execLog) expect(JSON.stringify(e.body)).not.toContain(GITHUB_TOKEN);
  });

  test("without a warm target nothing is captured", async () => {
    const { record: r, steps } = await bootstrap(record(), baseInput({ warm: null }));
    expect(steps.some((s) => s.startsWith("warm snapshot"))).toBe(false);
    expect(r.progress.warm).toBe(false);
    expect(warmSnapshots()).toEqual([]);
  });

  test("an environment with no repos takes none", async () => {
    const { steps } = await bootstrap(record(), warmInput({ repos: [] }));
    expect(steps.some((s) => s.startsWith("warm snapshot"))).toBe(false);
    expect(warmSnapshots()).toEqual([]);
  });

  test("is skipped while a GitHub credential file is on the VM", async () => {
    let r = record();
    for (let i = 0; i < 4; i++) r = (await advanceEnvironment(r, warmInput())).record; // vm, user, 2 clones
    mock.vms.get(r.freestyleVmId!)!.guest.writeFile(`${CRED_DIR}/leftover`, "gho_leftover");
    const result = await advanceEnvironment(r, warmInput());
    expect(result.step).toBe("warm snapshot skipped");
    expect(result.record.progress.warm).toBe(true);
    expect(warmSnapshots()).toEqual([]);
  });

  test("a failed capture is a warning, not a failure: setup goes on", async () => {
    mock.faults.push({ method: "POST", path: /\/snapshot$/, mode: "before", status: 503 });
    const { record: r, steps, warnings } = await bootstrap(record());
    expect(steps).toContain("warm snapshot");
    expect(warnings).toEqual(["warm_snapshot_failed"]);
    expect(r.phase).toBe("awaiting_login");
    expect(r.failures).toBe(0);
    expect(r.progress.warm).toBe(true);
    expect(warmSnapshots()).toEqual([]);
  });

  test("a second environment for the same key finds the slug taken and keeps the first", async () => {
    await bootstrap(record("env-1"));
    const second = await bootstrap(record("env-2"));
    expect(second.steps).toContain("warm snapshot exists");
    expect(second.record.phase).toBe("awaiting_login");
    expect(warmSnapshots().map((s) => s.slug)).toEqual([target.slug]);
  });

  test("a new snapshot replaces the owner's older ones and leaves everyone else's", async () => {
    const vm = (await ctx.client.vms.create({ firewall: { rules: [] } })).vm;
    const older = await vm.snapshot({ slug: "mw-older", displayName: target.label });
    const otherOwner = await vm.snapshot({ slug: "mw-other-owner", displayName: warmSnapshotLabel("t-abc", "u-1002") });
    const golden = await vm.snapshot({ slug: "morrow-base", displayName: "morrow base" });
    await bootstrap(record());
    const ids = new Set(mock.snapshots.keys());
    expect(ids.has(older.snapshotId)).toBe(false);
    expect(ids.has(otherOwner.snapshotId)).toBe(true);
    expect(ids.has(golden.snapshotId)).toBe(true);
    expect([...mock.snapshots.values()].some((s) => s.slug === target.slug)).toBe(true);
  });

  test("deleteWarmSnapshots removes one owner's, tolerates ones already gone, and keeps `keepSlug`", async () => {
    const vm = (await ctx.client.vms.create({ firewall: { rules: [] } })).vm;
    await vm.snapshot({ slug: "mw-a", displayName: target.label });
    await vm.snapshot({ slug: "mw-b", displayName: target.label });
    await vm.snapshot({ slug: "mw-c", displayName: warmSnapshotLabel("t-other", "u-1001") });
    expect(await deleteWarmSnapshots(ctx.client, { teamId: "t-abc", ownerUserId: "u-1001", keepSlug: "mw-b" })).toBe(1);
    expect([...mock.snapshots.values()].map((s) => s.slug).sort()).toEqual(["mw-b", "mw-c"]);
    expect(await deleteWarmSnapshots(ctx.client, { teamId: "t-abc", ownerUserId: "u-1001" })).toBe(1);
    expect([...mock.snapshots.values()].map((s) => s.slug)).toEqual(["mw-c"]);
    expect(await deleteWarmSnapshots(ctx.client, { teamId: "t-abc", ownerUserId: "u-1001" })).toBe(0);
  });

  test("findWarmSnapshot and resolveSnapshotId", async () => {
    expect(await findWarmSnapshot(ctx.client, target.slug)).toBeNull();
    const vm = (await ctx.client.vms.create({ firewall: { rules: [] } })).vm;
    const snap = await vm.snapshot({ slug: target.slug, displayName: target.label });
    expect(await findWarmSnapshot(ctx.client, target.slug)).toBe(snap.snapshotId);
    expect(await resolveSnapshotId(ctx.client, "freestyle/ubuntu")).toBe("freestyle/ubuntu");
    expect(await resolveSnapshotId(ctx.client, target.slug)).toBe(snap.snapshotId);
    await expect(resolveSnapshotId(ctx.client, "no-such-image")).rejects.toThrow();
    mock.faults.push({ method: "GET", path: /^\/v5\/snapshots\//, mode: "before", status: 503 });
    await expect(findWarmSnapshot(ctx.client, target.slug)).rejects.toThrow();
  });
});
