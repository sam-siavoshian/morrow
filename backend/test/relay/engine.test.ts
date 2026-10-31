/**
 * Against a real self-hosted relaycast-engine: provisioning, identities, messaging idempotency, history,
 * the observer pipeline (backfill, live, cursor resume) and ACK spoofing. No broker needed here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AgentRelay, listObserverTokens } from "@agent-relay/sdk";
import { RelayEventView, ServerFrame, type RelayMessageView } from "@morrow/contracts";
import {
  DISPATCHER_NAME,
  RelayIntegrationError,
  TeamRelayObserver,
  channelHistory,
  createRelayReader,
  createSenderKindResolver,
  ensureHumanIdentity,
  ensureProjectChannel,
  isHandoffAck,
  observerTokenNeedsRenewal,
  postToChannel,
  provisionTeamWorkspace,
  renewObserverToken,
  replyInThread,
  revokeObserverTokenById,
  rotateIdentityToken,
  rotateObserverToken,
  sendDirectMessage,
  threadHistory,
  verifyIdentityToken,
  type IdentityTokenStore,
  type PartialTeamRelaySecrets,
  type RelayConfig,
  type TeamRelaySecrets,
} from "../../src/integrations/relay/index.ts";
import { noticeMetadata } from "../../src/integrations/relay/index.ts";
import { dispatcherSpeaker, liveRelayPort } from "../../src/orchestration/ports.ts";
import { RELAY_E2E, runTag, startEngine, stopAll, waitFor, type Engine } from "./harness.ts";

let engine: Engine;
let config: RelayConfig;
let team: TeamRelaySecrets;

const memoryStore = (): IdentityTokenStore & { value: string | null; sets: number } => {
  const s = {
    value: null as string | null,
    sets: 0,
    get: async () => s.value,
    set: async (token: string) => {
      s.sets++;
      s.value = token;
    },
  };
  return s;
};

beforeAll(async () => {
  if (!RELAY_E2E) return;
  engine = await startEngine();
  config = { baseUrl: engine.baseUrl };
  team = await provisionTeamWorkspace({ config, teamId: `t-${runTag}main`, store: { save: async () => {} } });
}, 60_000);

afterAll(async () => {
  await stopAll();
}, 30_000);

describe.skipIf(!RELAY_E2E)("provisioning", () => {
  test("creates workspace, dispatcher and observer token, persisting after every step", async () => {
    const saves: PartialTeamRelaySecrets[] = [];
    const secrets = await provisionTeamWorkspace({ config, teamId: `t-${runTag}p1`, store: { save: async (s) => void saves.push({ ...s }) } });
    expect(saves.length).toBe(3);
    expect(saves[0]).toMatchObject({ workspaceKey: expect.stringMatching(/^rk_live_/), baseUrl: engine.baseUrl });
    expect(saves[0]!.dispatcherToken).toBeUndefined();
    expect(saves[1]!.dispatcherToken).toMatch(/^at_live_/);
    expect(secrets.observer.token).toMatch(/^ot_live_/);
    expect(secrets.observer.expiresAt! - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(observerTokenNeedsRenewal(secrets.observer)).toBe(false);
    expect(observerTokenNeedsRenewal(secrets.observer, secrets.observer.expiresAt! - 1000)).toBe(true);

    const admin = new AgentRelay({ workspaceKey: secrets.workspaceKey, baseUrl: engine.baseUrl });
    expect((await admin.agents.get(DISPATCHER_NAME)).type).toBe("system");
    const tokens = await listObserverTokens({ workspaceKey: secrets.workspaceKey, baseUrl: engine.baseUrl });
    expect(tokens.map((t) => t.id)).toEqual([secrets.observer.id]);
    // The engine echoes filters in its token metadata.
    expect(JSON.stringify(tokens[0])).toContain("includeDms");
    expect(String((await admin.workspace.info()).name)).toBe(`morrow-t-${runTag}p1`);
  });

  test("resumes after a crash at each step without orphaning secrets", async () => {
    let failAt = 2;
    let n = 0;
    let latest: PartialTeamRelaySecrets | null = null;
    const store = {
      save: async (s: PartialTeamRelaySecrets) => {
        n++;
        if (n === failAt) throw new Error("terse unavailable");
        latest = { ...s };
      },
    };
    // Crash persisting the dispatcher token: it was registered, but we never kept it.
    const err1 = await provisionTeamWorkspace({ config, teamId: `t-${runTag}p2`, store }).catch((e) => e);
    expect(err1).toBeInstanceOf(RelayIntegrationError);
    expect((err1 as RelayIntegrationError).code).toBe("provision_failed");
    expect(latest!.dispatcherToken).toBeUndefined();

    // Resume: dispatcher name conflict -> token recovered by rotation; then crash persisting the observer token.
    failAt = 4;
    const err2 = await provisionTeamWorkspace({ config, teamId: `t-${runTag}p2`, store, existing: latest }).catch((e) => e);
    expect((err2 as RelayIntegrationError).code).toBe("provision_failed");
    expect(latest!.dispatcherToken).toMatch(/^at_live_/);
    expect(latest!.observer).toBeUndefined();

    failAt = 0;
    const done = await provisionTeamWorkspace({ config, teamId: `t-${runTag}p2`, store, existing: latest });
    expect(done.workspaceKey).toBe(latest!.workspaceKey);
    const dispatcher = new AgentRelay({ agentToken: done.dispatcherToken, baseUrl: engine.baseUrl });
    expect((await dispatcher.messaging.agents.me()).name).toBe(DISPATCHER_NAME);
    // The token minted by the crashed run was revoked; only the persisted one is active.
    const active = (await listObserverTokens({ workspaceKey: done.workspaceKey, baseUrl: engine.baseUrl })).filter((t) => t.status === "active");
    expect(active.map((t) => t.id)).toEqual([done.observer.id]);
  });

  test("rejects resuming against a different engine", async () => {
    const err = await provisionTeamWorkspace({
      config,
      teamId: `t-${runTag}p3`,
      store: { save: async () => {} },
      existing: { workspaceId: "1", baseUrl: "https://elsewhere.example.com", workspaceKey: "rk_live_x" },
    }).catch((e) => e);
    expect((err as RelayIntegrationError).code).toBe("invalid_input");
  });

  test("observer token rotate, renew and revoke", async () => {
    const secrets = await provisionTeamWorkspace({ config, teamId: `t-${runTag}p4`, store: { save: async () => {} } });
    const reader = (token: string) => createRelayReader(config, token);
    expect(await reader(secrets.observer.token).agentType(DISPATCHER_NAME)).toBe("system");

    const rotated = await rotateObserverToken({ config, workspaceKey: secrets.workspaceKey, tokenId: secrets.observer.id });
    expect(rotated.id).toBe(secrets.observer.id);
    expect(rotated.token).not.toBe(secrets.observer.token);
    await expect(reader(secrets.observer.token).agentType(DISPATCHER_NAME)).rejects.toThrow();
    expect(await reader(rotated.token).agentType(DISPATCHER_NAME)).toBe("system");

    const renewed = await renewObserverToken({ config, workspaceKey: secrets.workspaceKey, oldTokenId: rotated.id });
    expect(renewed.revokedOld).toBe(true);
    await expect(reader(rotated.token).agentType(DISPATCHER_NAME)).rejects.toThrow();
    expect(await reader(renewed.observer.token).agentType(DISPATCHER_NAME)).toBe("system");

    await revokeObserverTokenById({ config, workspaceKey: secrets.workspaceKey, tokenId: renewed.observer.id });
    await revokeObserverTokenById({ config, workspaceKey: secrets.workspaceKey, tokenId: renewed.observer.id });
    await expect(reader(renewed.observer.token).agentType(DISPATCHER_NAME)).rejects.toThrow();
  });
});

describe.skipIf(!RELAY_E2E)("human identities", () => {
  test("register once, reuse forever, never rotate implicitly", async () => {
    const store = memoryStore();
    const first = await ensureHumanIdentity({ config, teamId: "t-main", workspaceKey: team.workspaceKey, githubLogin: "Alice-Dev", store });
    expect(first.name).toBe("h-alice-dev");
    expect(store.sets).toBe(1);
    const again = await ensureHumanIdentity({ config, teamId: "t-main", workspaceKey: team.workspaceKey, githubLogin: "alice-dev", store });
    expect(again.token).toBe(first.token);
    expect(store.sets).toBe(1);
    await verifyIdentityToken(config, first);
    const admin = new AgentRelay({ workspaceKey: team.workspaceKey, baseUrl: engine.baseUrl });
    expect((await admin.agents.get("h-alice-dev")).type).toBe("human");
  });

  test("concurrent first use registers exactly once", async () => {
    const store = memoryStore();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensureHumanIdentity({ config, teamId: "t-main", workspaceKey: team.workspaceKey, githubLogin: "bob", store })),
    );
    expect(new Set(results.map((r) => r.token)).size).toBe(1);
    expect(store.sets).toBe(1);
    await verifyIdentityToken(config, results[0]!);
  });

  test("an existing name without a stored token is a conflict; rotation is explicit and kills the old token", async () => {
    const owner = memoryStore();
    const original = await ensureHumanIdentity({ config, teamId: "t-main", workspaceKey: team.workspaceKey, githubLogin: "carol", store: owner });
    const lost = memoryStore();
    const err = await ensureHumanIdentity({ config, teamId: "t-main", workspaceKey: team.workspaceKey, githubLogin: "carol", store: lost }).catch((e) => e);
    expect((err as RelayIntegrationError).code).toBe("identity_conflict");
    await verifyIdentityToken(config, original);

    const rotated = await rotateIdentityToken({ config, workspaceKey: team.workspaceKey, name: "h-carol", store: lost });
    expect(rotated.token).not.toBe(original.token);
    const stale = await verifyIdentityToken(config, original).catch((e) => e);
    expect((stale as RelayIntegrationError).code).toBe("identity_token_invalid");
    await verifyIdentityToken(config, rotated);
    await expect(rotateIdentityToken({ config, workspaceKey: team.workspaceKey, name: "dispatcher", store: lost })).rejects.toThrow(RelayIntegrationError);
  });
});

describe.skipIf(!RELAY_E2E)("channels, messaging, history", () => {
  test("project channel create is idempotent; sends are idempotent by key", async () => {
    const a = await ensureProjectChannel({ config, dispatcherToken: team.dispatcherToken, projectShort: "msg1", topic: "Project msg1" });
    const b = await ensureProjectChannel({ config, dispatcherToken: team.dispatcherToken, projectShort: "msg1" });
    expect([a, b]).toEqual([
      { channel: "proj-msg1", created: true },
      { channel: "proj-msg1", created: false },
    ]);
    const human = await ensureHumanIdentity({ config, teamId: "t-main", workspaceKey: team.workspaceKey, githubLogin: "dave", store: memoryStore() });
    const speaker = { token: human.token, kind: "human" as const };
    const text = "<script>alert(1)</script> $(rm -rf /) `id`";

    const p1 = await postToChannel({ config, speaker, channel: "proj-msg1", text, idempotencyKey: "row-1" });
    const p1again = await postToChannel({ config, speaker, channel: "proj-msg1", text, idempotencyKey: "row-1" });
    const p2 = await postToChannel({ config, speaker, channel: "#proj-msg1", text: "second", idempotencyKey: "row-2" });
    expect(p1again.id).toBe(p1.id);
    expect(p2.id).not.toBe(p1.id);
    expect(RelayEventView.parse(p1)).toMatchObject({ channel: "proj-msg1", from: { name: "h-dave", kind: "human" }, text });

    const dispatcher = { token: team.dispatcherToken, kind: "system" as const };
    const r1 = await replyInThread({ config, speaker: dispatcher, messageId: p1.id, text: "reply", idempotencyKey: "reply-1", channel: "proj-msg1" });
    const r1again = await replyInThread({ config, speaker: dispatcher, messageId: p1.id, text: "reply", idempotencyKey: "reply-1", channel: "proj-msg1" });
    expect(r1again.id).toBe(r1.id);
    expect(RelayEventView.parse(r1)).toMatchObject({ threadId: p1.id, parentId: p1.id, channel: "proj-msg1", from: { kind: "system" } });

    const d1 = await sendDirectMessage({ config, speaker, to: "@dispatcher", text: "dm", idempotencyKey: "dm-1" });
    const d1again = await sendDirectMessage({ config, speaker, to: DISPATCHER_NAME, text: "dm", idempotencyKey: "dm-1" });
    expect(d1again.id).toBe(d1.id);
    expect(RelayEventView.parse(d1)).toMatchObject({ channel: null, conversationId: expect.stringMatching(/^dm_/) });

    for (const bad of [
      () => postToChannel({ config, speaker, channel: "proj-msg1", text: "x", idempotencyKey: "has space" }),
      () => postToChannel({ config, speaker, channel: "proj-msg1", text: "   ", idempotencyKey: "k" }),
      () => postToChannel({ config, speaker, channel: "proj-msg1", text: "x".repeat(40_000), idempotencyKey: "k" }),
      () => sendDirectMessage({ config, speaker, to: "../admin", text: "x", idempotencyKey: "k" }),
      () => replyInThread({ config, speaker, messageId: "1/../2", text: "x", idempotencyKey: "k" }),
    ])
      await expect(bad()).rejects.toThrow(RelayIntegrationError);

    const kinds = createSenderKindResolver({ lookup: (name) => createRelayReader(config, team.observer.token).agentType(name) });
    const thread = await threadHistory({ config, observerToken: team.observer.token, senderKinds: kinds, channel: "proj-msg1", messageId: p1.id });
    expect(thread.map((m) => [m.id, m.from.kind])).toEqual([
      [p1.id, "human"],
      [r1.id, "system"],
    ]);
    expect(thread[1]).toMatchObject({ threadId: p1.id, parentId: p1.id });
  });

  test("channel history pages oldest-first with a working cursor", async () => {
    const { channel } = await ensureProjectChannel({ config, dispatcherToken: team.dispatcherToken, projectShort: "hist" });
    const dispatcher = { token: team.dispatcherToken, kind: "system" as const };
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await postToChannel({ config, speaker: dispatcher, channel, text: `h${i}`, idempotencyKey: `hist-${i}` })).id);
    const kinds = createSenderKindResolver({ lookup: (name) => createRelayReader(config, team.observer.token).agentType(name) });
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const page = await channelHistory({ config, observerToken: team.observer.token, senderKinds: kinds, channel, before, limit: 3 });
      for (const e of page.events) RelayEventView.parse(e);
      seen.unshift(...page.events.map((e) => e.id));
      before = page.nextBefore;
      pages++;
    } while (before && pages < 10);
    expect(seen).toEqual(ids);
    expect(pages).toBe(3);
  });
});

describe.skipIf(!RELAY_E2E)("observer pipeline (real engine)", () => {
  test("backfill + live + resume across a restart: no gaps, no duplicates, contract-valid frames", async () => {
    const secrets = await provisionTeamWorkspace({ config, teamId: `t-${runTag}obs`, store: { save: async () => {} } });
    const { channel } = await ensureProjectChannel({ config, dispatcherToken: secrets.dispatcherToken, projectShort: "obs" });
    const human = await ensureHumanIdentity({ config, teamId: "t-obs", workspaceKey: secrets.workspaceKey, githubLogin: "erin", store: memoryStore() });
    const admin = new AgentRelay({ workspaceKey: secrets.workspaceKey, baseUrl: engine.baseUrl });
    const worker = await admin.workspace.register({ name: "w-tobs-be-e1", type: "agent" }, { strict: true });
    const hs = { token: human.token, kind: "human" as const };
    const ds = { token: secrets.dispatcherToken, kind: "system" as const };

    // Before the observer exists: must arrive through backfill.
    const root = await postToChannel({ config, speaker: hs, channel, text: "pre-1", idempotencyKey: "pre-1" });
    await postToChannel({ config, speaker: ds, channel, text: "pre-2", idempotencyKey: "pre-2" });

    let stored: number | null = null;
    const saves: number[] = [];
    const cursorStore = {
      load: async () => stored,
      save: async (seq: number) => {
        saves.push(seq);
        stored = seq;
      },
    };
    const frames: ServerFrame[] = [];
    const publish = (_t: string, f: ServerFrame) => void frames.push(ServerFrame.parse(f));
    const messages = () => frames.flatMap((f) => (f.kind === "relay.event" && f.data.type === "message" ? [f.data] : []));

    const first = new TeamRelayObserver({ teamId: "t-obs", config, observerToken: secrets.observer.token, cursorStore, publish, flushIntervalMs: 1000 });
    await first.start();
    await waitFor("backfill", async () => messages().length >= 2, 10_000);

    // Live: channel, thread reply, DM, agent message.
    await replyInThread({ config, speaker: ds, messageId: root.id, text: "live-reply", idempotencyKey: "live-reply", channel });
    await sendDirectMessage({ config, speaker: hs, to: DISPATCHER_NAME, text: "live-dm", idempotencyKey: "live-dm" });
    await new AgentRelay({ agentToken: worker.token, baseUrl: engine.baseUrl }).messaging.messages.send({ channel, text: "live-agent", idempotencyKey: "live-agent" });
    await waitFor("live", async () => messages().some((m) => m.text === "live-agent"), 10_000);
    await first.stop();
    const firstRun = messages();
    const cursorAfterFirst = stored!;
    expect(cursorAfterFirst).toBe(first.cursor);

    // While stopped.
    for (let i = 0; i < 3; i++) await postToChannel({ config, speaker: hs, channel, text: `gap-${i}`, idempotencyKey: `gap-${i}` });

    frames.length = 0;
    const second = new TeamRelayObserver({ teamId: "t-obs", config, observerToken: secrets.observer.token, cursorStore, publish, flushIntervalMs: 1000 });
    await second.start();
    await waitFor("resume", async () => messages().some((m) => m.text === "gap-2"), 10_000);
    await postToChannel({ config, speaker: hs, channel, text: "after-restart", idempotencyKey: "after-restart" });
    await waitFor("live after restart", async () => messages().some((m) => m.text === "after-restart"), 10_000);
    await second.stop();
    const secondRun = messages();

    expect(firstRun.map((m) => m.text)).toEqual(["pre-1", "pre-2", "live-reply", "live-dm", "live-agent"]);
    expect(secondRun.map((m) => m.text)).toEqual(["gap-0", "gap-1", "gap-2", "after-restart"]);
    const allIds = [...firstRun, ...secondRun].map((m) => m.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    const seqs = frames.flatMap((f) => (f.kind === "relay.event" && f.seq !== null ? [f.seq] : []));
    expect(seqs.every((s) => s > cursorAfterFirst)).toBe(true);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    const byText = new Map(firstRun.map((m) => [m.text, m]));
    expect(byText.get("pre-1")!.from).toEqual({ name: "h-erin", kind: "human" });
    expect(byText.get("pre-2")!.from).toEqual({ name: DISPATCHER_NAME, kind: "system" });
    expect(byText.get("live-agent")!.from).toEqual({ name: "w-tobs-be-e1", kind: "agent" });
    expect(byText.get("live-reply")).toMatchObject({ threadId: root.id, parentId: root.id, channel });
    expect(byText.get("live-dm")).toMatchObject({ channel: null, conversationId: expect.stringMatching(/^dm_/) });
    // Throttled cursor writes: at most one per second plus the final one on each stop.
    expect(saves.length).toBeLessThanOrEqual(12);
    console.log(`[observer] run1=${firstRun.length} msgs run2=${secondRun.length} msgs cursor ${cursorAfterFirst} -> ${stored} saves=${saves.length}`);
  }, 60_000);

  test("ACK spoofing is rejected on the real stream; only the lease's agent counts", async () => {
    const secrets = await provisionTeamWorkspace({ config, teamId: `t-${runTag}ack`, store: { save: async () => {} } });
    const { channel } = await ensureProjectChannel({ config, dispatcherToken: secrets.dispatcherToken, projectShort: "ack" });
    const admin = new AgentRelay({ workspaceKey: secrets.workspaceKey, baseUrl: engine.baseUrl });
    const replacement = await admin.workspace.register({ name: "w-tack-be-e2", type: "agent" }, { strict: true });
    const evil = await admin.workspace.register({ name: "w-tack-fe-e1", type: "agent" }, { strict: true });
    const human = await ensureHumanIdentity({ config, teamId: "t-ack", workspaceKey: secrets.workspaceKey, githubLogin: "frank", store: memoryStore() });
    const lease = { leaseId: "l-handoff.7", agentName: "w-tack-be-e2" };
    const root = await postToChannel({ config, speaker: { token: secrets.dispatcherToken, kind: "system" }, channel, text: "task thread", idempotencyKey: "root" });

    const acks: RelayMessageView[] = [];
    const seen: RelayMessageView[] = [];
    const observer = new TeamRelayObserver({
      teamId: "t-ack",
      config,
      observerToken: secrets.observer.token,
      cursorStore: { load: async () => null, save: async () => {} },
      publish: () => {},
      callbacks: {
        onMessage: (m) => {
          seen.push(m);
          if (isHandoffAck(m, lease)) acks.push(m);
        },
      },
    });
    await observer.start();
    const reply = (token: string, text: string, key: string) =>
      new AgentRelay({ agentToken: token, baseUrl: engine.baseUrl }).messaging.messages.reply({ messageId: root.id, text, idempotencyKey: key });
    await reply(evil.token!, `ACK ${lease.leaseId}`, "spoof-agent");
    await reply(human.token, `ACK ${lease.leaseId}`, "spoof-human");
    await reply(replacement.token!, `ACK ${lease.leaseId}0`, "wrong-lease");
    await reply(replacement.token!, `ACK ${lease.leaseId}`, "real");
    await waitFor("acks", async () => seen.length >= 5, 10_000);
    await observer.stop();
    expect(acks.length).toBe(1);
    expect(acks[0]!.from.name).toBe("w-tack-be-e2");
    expect(seen.filter((m) => m.text.startsWith("ACK")).length).toBe(4);
  }, 30_000);

  test("replaceToken resumes the stream on rotated material", async () => {
    const secrets = await provisionTeamWorkspace({ config, teamId: `t-${runTag}rot`, store: { save: async () => {} } });
    const { channel } = await ensureProjectChannel({ config, dispatcherToken: secrets.dispatcherToken, projectShort: "rot" });
    const ds = { token: secrets.dispatcherToken, kind: "system" as const };
    const texts: string[] = [];
    const observer = new TeamRelayObserver({
      teamId: "t-rot",
      config,
      observerToken: secrets.observer.token,
      cursorStore: { load: async () => null, save: async () => {} },
      publish: (_t, f) => void (f.kind === "relay.event" && f.data.type === "message" && texts.push(f.data.text)),
    });
    await observer.start();
    await postToChannel({ config, speaker: ds, channel, text: "before", idempotencyKey: "before" });
    await waitFor("before", async () => texts.includes("before"), 10_000);
    const rotated = await rotateObserverToken({ config, workspaceKey: secrets.workspaceKey, tokenId: secrets.observer.id });
    await observer.replaceToken(rotated.token);
    await postToChannel({ config, speaker: ds, channel, text: "after", idempotencyKey: "after" });
    await waitFor("after", async () => texts.includes("after"), 10_000);
    await observer.stop();
    expect(texts).toEqual(["before", "after"]);
  }, 30_000);
});

describe.skipIf(!RELAY_E2E)("worker updates (real engine)", () => {
  test("a dispatcher DM reaches the worker once per key and shows as a notice on the observer stream; channel metadata survives history", async () => {
    const secrets = await provisionTeamWorkspace({ config, teamId: `t-${runTag}note`, store: { save: async () => {} } });
    const admin = new AgentRelay({ workspaceKey: secrets.workspaceKey, baseUrl: engine.baseUrl });
    const worker = await admin.workspace.register({ name: "w-tnote-web-e1", type: "agent" }, { strict: true });
    const seen: RelayMessageView[] = [];
    const observer = new TeamRelayObserver({
      teamId: "t-note",
      config,
      observerToken: secrets.observer.token,
      cursorStore: { load: async () => null, save: async () => {} },
      publish: () => {},
      callbacks: { onMessage: (m) => void seen.push(m) },
    });
    await observer.start();
    const access = { config, workspaceId: secrets.workspaceId, workspaceKey: secrets.workspaceKey, dispatcherToken: secrets.dispatcherToken };
    const port = liveRelayPort();
    const notice = { kind: "workstream_done" as const, taskId: "tk-note", to: ["w-tnote-web-e1"] };
    const text = `@w-tnote-web-e1 "API" (api) is done on branch morrow/note/api at abc123.`;
    const sent = await port.direct(access, dispatcherSpeaker(access), "w-tnote-web-e1", text, "nt-note-7-abc", notice);
    const again = await port.direct(access, dispatcherSpeaker(access), "w-tnote-web-e1", text, "nt-note-7-abc", notice);
    expect(again.id).toBe(sent.id);

    await waitFor("notice on the stream", async () => seen.some((m) => m.id === sent.id), 10_000);
    await Bun.sleep(300);
    const onStream = seen.filter((m) => m.id === sent.id);
    expect(onStream).toHaveLength(1);
    expect(onStream[0]).toMatchObject({ from: { name: DISPATCHER_NAME, kind: "system" }, channel: null, text, notice });
    expect(RelayEventView.parse(onStream[0])).toMatchObject({ notice });

    // The worker has it: the engine delivered the DM to the agent's inbox.
    const inbox = await new AgentRelay({ agentToken: worker.token!, baseUrl: engine.baseUrl }).inbox.get();
    expect(JSON.stringify(inbox.unreadDms)).toContain(DISPATCHER_NAME);

    // A channel post keeps its metadata in history, so a notice survives a backend restart there.
    const { channel } = await ensureProjectChannel({ config, dispatcherToken: secrets.dispatcherToken, projectShort: "note" });
    const posted = await postToChannel({ config, speaker: dispatcherSpeaker(access), channel, text: "team-wide update", idempotencyKey: "note-post", metadata: noticeMetadata({ kind: "handoff", taskId: "tk-note", to: [] }) });
    const kinds = createSenderKindResolver({ lookup: (name) => createRelayReader(config, secrets.observer.token).agentType(name) });
    const page = await channelHistory({ config, observerToken: secrets.observer.token, senderKinds: kinds, channel });
    expect(page.events.find((m) => m.id === posted.id)).toMatchObject({ notice: { kind: "handoff", taskId: "tk-note", to: [] } });
    await observer.stop();
  }, 30_000);
});
