// The runtime's Relay wiring against a real self-hosted relaycast-engine: lazy single-flight provisioning,
// member identities, a real TeamRelayObserver feeding the bus, history pages, and member removal (observer
// token rotated + observer restarted, member identity revoked). Runs only with RELAY_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RelayMessageView } from "@morrow/contracts";
import { channelHistory, createSenderKindResolver, createRelayReader, postToChannel, type Speaker } from "../../src/integrations/relay/index.ts";
import type { RuntimeSignal } from "../../src/runtime/bus.ts";
import { RELAY_E2E, startEngine, stopAll, type Engine } from "../relay/harness.ts";
import { makeFixture, TEAM, waitFor, type Fixture } from "./helpers.ts";

let engine: Engine;
let f: Fixture;
const messages: RelayMessageView[] = [];

beforeAll(async () => {
  if (!RELAY_E2E) return;
  engine = await startEngine();
  f = await makeFixture({ relayUrl: engine.baseUrl, createObserver: null, people: [["u-owner", "owner"], ["u-member", "member"]] });
  f.t.deps.bus.subscribe((s: RuntimeSignal) => {
    if (s.kind === "message") messages.push(s.message);
  });
}, 60_000);

afterAll(async () => {
  if (!RELAY_E2E) return;
  await f.close();
  await stopAll();
});

const post = (speaker: Speaker, text: string) =>
  postToChannel({ config: { baseUrl: engine.baseUrl }, speaker, channel: "general", text, idempotencyKey: `k-${crypto.randomUUID()}` });

describe.skipIf(!RELAY_E2E)("runtime + real Relay engine", () => {
  test("concurrent first use provisions exactly one workspace; secrets are stored sealed", async () => {
    const runtime = f.t.deps.runtime;
    const all = await Promise.all(Array.from({ length: 5 }, () => runtime.relay(TEAM)));
    expect(new Set(all.map((a) => a!.workspaceId)).size).toBe(1);
    expect(f.actors.calls.filter((c) => c === "setRelay").length).toBe(1);
    const stored = JSON.stringify(f.actors.relays.get(TEAM));
    expect(stored).not.toContain(all[0]!.workspaceKey);
    expect(stored).not.toContain(all[0]!.dispatcherToken);
  }, 30_000);

  test("a member's identity is registered once and reused", async () => {
    const runtime = f.t.deps.runtime;
    const [a, b] = await Promise.all([runtime.speakerFor(TEAM, "u-member"), runtime.speakerFor(TEAM, "u-member")]);
    expect(a!.token).toBe(b!.token);
    expect(a!.kind).toBe("human");
    const enc = f.actors.users.get("u-member")!.relayHumanTokens[TEAM]!;
    expect(enc).toBeTruthy();
    expect(enc).not.toContain(a!.token);
    expect((await runtime.speakerFor(TEAM, "u-member"))!.token).toBe(a!.token);
  }, 30_000);

  test("the observer streams new messages to the bus; history pages come back", async () => {
    const runtime = f.t.deps.runtime;
    expect(await runtime.observers.ensure(TEAM)).toBe(true);
    const speaker = (await runtime.speakerFor(TEAM, "u-member"))!;
    await post(speaker, "hello from the member");
    await waitFor(() => messages.some((m) => m.text === "hello from the member"), 15_000, "live message");
    await waitFor(async () => (f.actors.relays.get(TEAM)!.cursor ?? null) !== null, 15_000, "cursor flush");

    const page = await runtime.observers.history(TEAM, null, null);
    expect(page?.kind).toBe("relay.history");
    expect(page?.channel).toBe("general");
    expect(page!.data.some((e) => e.type === "message" && e.text === "hello from the member")).toBe(true);
  }, 30_000);

  test("member removal rotates the observer token, restarts the observer, and revokes the member", async () => {
    const runtime = f.t.deps.runtime;
    const access = (await runtime.relay(TEAM))!;
    const oldObserver = (await runtime.workspaces.observerToken(TEAM))!.token;
    const oldSpeaker = (await runtime.speakerFor(TEAM, "u-member"))!;
    const tokenId = f.actors.relays.get(TEAM)!.observerTokenId;

    const restart = runtime.observers.restart.bind(runtime.observers);
    const restarted: string[] = [];
    runtime.observers.restart = (teamId) => (restarted.push(teamId), restart(teamId));

    await f.t.deps.teamEvents.emitMemberRemoved({ teamId: TEAM, userId: "u-member", removedBy: "u-owner" });
    // An open socket survives a rotation, so the observer must have been rebuilt on the new token.
    expect(restarted).toEqual([TEAM]);
    expect(runtime.observers.health(TEAM)?.running).toBe(true);

    const newObserver = (await runtime.workspaces.observerToken(TEAM))!.token;
    expect(newObserver).not.toBe(oldObserver);
    expect(f.actors.relays.get(TEAM)!.observerTokenId).toBe(tokenId);
    // The old observer token no longer reads.
    const senderKinds = createSenderKindResolver({ lookup: (name) => createRelayReader(access.config, newObserver).agentType(name) });
    await expect(channelHistory({ config: access.config, observerToken: oldObserver, senderKinds, channel: "general" })).rejects.toThrow();
    // The removed member's token no longer posts.
    await expect(post(oldSpeaker, "should not land")).rejects.toThrow();

    // The restarted observer runs on the new token: a new message still arrives.
    const owner = (await runtime.speakerFor(TEAM, "u-owner"))!;
    await post(owner, "after removal");
    await waitFor(() => messages.some((m) => m.text === "after removal"), 15_000, "message after restart");
    expect(messages.some((m) => m.text === "should not land")).toBe(false);
  }, 45_000);
});
