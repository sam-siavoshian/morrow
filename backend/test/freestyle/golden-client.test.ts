import { afterEach, describe, expect, test } from "bun:test";
import { FeatureDisabledError, freestyle, isFreestyleConfigured } from "../../src/integrations/freestyle/index.ts";
import { buildGoldenSnapshot } from "../../vm/build-golden.ts";
import { useMock } from "./helpers.ts";

describe("lazy client factory", () => {
  const saved = { key: process.env.FREESTYLE_API_KEY, url: process.env.FREESTYLE_BASE_URL };
  afterEach(() => {
    process.env.FREESTYLE_API_KEY = saved.key ?? "";
    process.env.FREESTYLE_BASE_URL = saved.url ?? "";
  });

  test("missing key is a typed FeatureDisabledError, not a crash at import", () => {
    process.env.FREESTYLE_API_KEY = "";
    expect(isFreestyleConfigured()).toBe(false);
    expect(() => freestyle()).toThrow(FeatureDisabledError);
    try {
      freestyle();
    } catch (error) {
      expect((error as FeatureDisabledError).apiCode).toBe("feature_disabled");
    }
  });

  test("base URL must be https, except loopback", () => {
    process.env.FREESTYLE_API_KEY = "k";
    process.env.FREESTYLE_BASE_URL = "http://evil.example.com";
    expect(() => freestyle()).toThrow("https");
    process.env.FREESTYLE_BASE_URL = "https://user:pw@api.example.com";
    expect(() => freestyle()).toThrow("bare origin");
    process.env.FREESTYLE_BASE_URL = "http://127.0.0.1:9999";
    expect(isFreestyleConfigured()).toBe(true);
  });

  test("rebuilds the client when the key rotates", () => {
    process.env.FREESTYLE_BASE_URL = "";
    process.env.FREESTYLE_API_KEY = "one";
    const a = freestyle();
    expect(freestyle()).toBe(a);
    process.env.FREESTYLE_API_KEY = "two";
    expect(freestyle()).not.toBe(a);
  });
});

describe("buildGoldenSnapshot", () => {
  let ctx: ReturnType<typeof useMock> | undefined;
  afterEach(async () => {
    await ctx?.restore();
    ctx = undefined;
  });

  test("builds once, runs every step as root, deletes the builder, reports plan retention", async () => {
    ctx = useMock();
    ctx.mock.plan.snapshotAutoDeleteSeconds = 604_800;
    const result = await buildGoldenSnapshot({});
    expect(result).toMatchObject({ slug: "morrow-base", created: true, autoDeleteSeconds: 604_800, autoDeleteFromPlan: true });
    const steps = ctx.mock.execLog.filter((e) => e.script === "golden-setup");
    expect(steps.map((e) => e.body.env?.MORROW_GOLDEN_STEP)).toEqual(["gh", "relay", "bun", "morrow", "gemini", "cursor", "grok", "verify", "scrub"]);
    // Only the morrow step carries morrow-agent, base64 and pinned by its sha256 (docs/subagents.md).
    const script = new Uint8Array(await Bun.file(new URL("../../vm/morrow-agent.js", import.meta.url)).arrayBuffer());
    expect(steps.filter((e) => e.body.env?.MORROW_AGENT_B64).map((e) => e.body.env?.MORROW_GOLDEN_STEP)).toEqual(["morrow"]);
    const morrow = steps.find((e) => e.body.env?.MORROW_GOLDEN_STEP === "morrow")!.body.env!;
    expect(morrow.MORROW_AGENT_SHA256).toBe(new Bun.CryptoHasher("sha256").update(script).digest("hex"));
    expect(new Uint8Array(Buffer.from(morrow.MORROW_AGENT_B64!, "base64"))).toEqual(script);
    expect(morrow.MORROW_AGENT_B64!.length).toBeLessThan(64 * 1024);
    expect(steps.every((e) => e.body.linuxUser === "root" && e.body.timeoutMs === 300_000)).toBe(true);
    expect(ctx.mock.vms.size).toBe(0);

    const again = await buildGoldenSnapshot({});
    expect(again).toMatchObject({ snapshotId: result.snapshotId, created: false });
    expect(ctx.mock.requestLog.filter((r) => r.method === "POST" && r.path === "/v5/vms").length).toBe(1);
  });

  test("a failed step takes no snapshot and still deletes the builder", async () => {
    ctx = useMock();
    ctx.mock.faults.push({ method: "POST", script: "golden-setup", mode: "before", status: 500 });
    await expect(buildGoldenSnapshot({})).rejects.toBeDefined();
    expect(ctx.mock.snapshots.size).toBe(0);
    expect(ctx.mock.vms.size).toBe(0);
  });

  test("--rebuild frees the slug and keeps the old snapshot by id", async () => {
    ctx = useMock();
    const first = await buildGoldenSnapshot({});
    const second = await buildGoldenSnapshot({ rebuild: true });
    expect(second.created).toBe(true);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(ctx.mock.snapshots.get(first.snapshotId)!.slug).toBeNull();
  });
});
