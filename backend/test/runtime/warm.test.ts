// The runner's side of warm snapshots: an owner's next environment boots from their warm snapshot only while
// GitHub says they can still read every repo in it; any doubt boots the golden image. Removing a member
// deletes their warm snapshots.
import { afterEach, describe, expect, test } from "bun:test";
import { warmSnapshotLabel } from "../../src/integrations/freestyle/warm.ts";
import { startFakeGithub, type FakeGithub } from "../support/fakeGithub.ts";
import { githubTokenOf, logLines, makeFixture, TEAM, waitFor, type Fixture } from "./helpers.ts";

const open: Fixture[] = [];
const servers: FakeGithub[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
  for (const gh of servers.splice(0)) gh.stop();
});

/** A fake GitHub where `u-owner` can read `acme/web` unless told otherwise. */
function github(ownerRepos: string[] = ["acme/web"]): FakeGithub {
  const gh = startFakeGithub();
  servers.push(gh);
  gh.addUser({ id: 1, login: "owner", token: githubTokenOf("u-owner"), repos: ownerRepos.map((fullName, i) => ({ id: 10 + i, fullName, permissions: { pull: true } })) });
  return gh;
}

async function fixture(gh?: FakeGithub): Promise<Fixture> {
  const f = await makeFixture({ github: gh });
  open.push(f);
  return f;
}

async function newEnvironment(f: Fixture, name: string) {
  const env = await f.t.deps.runtime.environments.create(TEAM, "u-owner", name);
  await f.settle(env.id);
  const stored = (await f.actors.getEnvironment(TEAM, env.id))!;
  return { stored, vm: f.fs.mock.vms.get(stored.freestyleVmId!)! };
}

const warmSnapshots = (f: Fixture) => [...f.fs.mock.snapshots.values()].filter((s) => typeof s.slug === "string" && s.slug.startsWith("mw-"));
const bootedWarm = () => logLines.filter((l) => l.includes("environment booting from warm snapshot")).length;

describe("warm snapshots in the runner", () => {
  test("the owner's second environment boots from the first one's warm snapshot", async () => {
    const f = await fixture(github());
    const before = bootedWarm();
    const first = await newEnvironment(f, "One");
    expect(first.stored.phase).toBe("awaiting_login");
    expect(first.vm.data.snapshotId).toBe("freestyle/ubuntu");
    const [warm, ...rest] = warmSnapshots(f);
    expect(rest).toEqual([]);
    expect(warm!.displayName).toBe(warmSnapshotLabel(TEAM, "u-owner"));

    const second = await newEnvironment(f, "Two");
    expect(second.stored.phase).toBe("awaiting_login");
    expect(second.vm.data.snapshotId).toBe(warm!.id);
    expect(bootedWarm()).toBe(before + 1);
    // It still fetched each repo (an incremental fetch on a warm VM) and kept the one snapshot.
    expect(second.vm.guest.clones.get("acme/web")).toBe(1);
    expect(warmSnapshots(f).map((s) => s.id)).toEqual([warm!.id]);
  });

  test("an owner who lost access to a repo gets the golden image", async () => {
    const gh = github();
    const f = await fixture(gh);
    await newEnvironment(f, "One");
    expect(warmSnapshots(f)).toHaveLength(1);
    gh.addUser({ id: 1, login: "owner", token: githubTokenOf("u-owner"), repos: [] });
    const second = await newEnvironment(f, "Two");
    expect(second.vm.data.snapshotId).toBe("freestyle/ubuntu");
  });

  test("GitHub down: golden image, and the environment still comes up", async () => {
    const gh = github();
    const f = await fixture(gh);
    await newEnvironment(f, "One");
    gh.failWith(503);
    const second = await newEnvironment(f, "Two");
    gh.failWith(null);
    expect(second.vm.data.snapshotId).toBe("freestyle/ubuntu");
    expect(second.stored.phase).toBe("awaiting_login");
  });

  test("no GitHub token for the owner: golden image", async () => {
    const f = await fixture();
    await newEnvironment(f, "One");
    expect(warmSnapshots(f)).toHaveLength(1);
    const second = await newEnvironment(f, "Two");
    expect(second.vm.data.snapshotId).toBe("freestyle/ubuntu");
  });

  test("Freestyle failing to look the snapshot up: golden image", async () => {
    const f = await fixture(github());
    await newEnvironment(f, "One");
    f.fs.mock.faults.push({ method: "GET", path: /^\/v5\/snapshots\/mw-/, mode: "before", status: 503 });
    const second = await newEnvironment(f, "Two");
    expect(second.vm.data.snapshotId).toBe("freestyle/ubuntu");
    expect(second.stored.phase).toBe("awaiting_login");
  });

  test("a removed member's warm snapshots are deleted; other members' stay", async () => {
    const f = await fixture(github());
    await newEnvironment(f, "One");
    const vm = (await f.fs.client.vms.create({ firewall: { rules: [] } })).vm;
    await vm.snapshot({ slug: "mw-admin", displayName: warmSnapshotLabel(TEAM, "u-admin") });
    expect(warmSnapshots(f)).toHaveLength(2);
    // Fired and not awaited, as the members route does: the Relay steps after it fail slowly against relay.invalid.
    const cleanup = f.t.deps.teamEvents.emitMemberRemoved({ teamId: TEAM, userId: "u-owner", removedBy: "u-admin" });
    await waitFor(() => warmSnapshots(f).length === 1, 5_000, "warm snapshots deleted");
    expect(warmSnapshots(f).map((s) => s.slug)).toEqual(["mw-admin"]);
    await cleanup;
  }, 30_000);
});
