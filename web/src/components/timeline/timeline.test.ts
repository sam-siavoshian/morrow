import { describe, expect, test } from "bun:test";
import { APP_NAME, type RelayEventView } from "@morrow/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ALL_MESSAGES, buildTimelineRows, parseContractLine, isFiltered, matchesFilter, messageLifecycle, noticeBody, statusLifecycle, stripMorrowTag, type MessageEvent, type StatusEvent } from "./classify";
import { buildDirectory, ownership, parseWorkerName } from "./directory";
import { linkify, safeHref } from "./linkify";
import { TimelineRowView } from "./rows";

const msg = (id: string, at: number, extra: Partial<MessageEvent> = {}): MessageEvent => ({
  type: "message",
  id,
  channel: "proj-abc",
  conversationId: null,
  threadId: null,
  parentId: null,
  from: { name: "w-abc12345-api-e1", kind: "agent" },
  text: `a longer message number ${id} that says something useful about the work in progress\nwith a second line`,
  mentions: [],
  createdAt: at,
  ...extra,
});
const update = (id: string, at: number, from = "w-abc12345-api-e1") =>
  msg(id, at, { text: `Ran tests (${id})`, from: { name: from, kind: "agent" } });
const status = (agentName: string, at: number, s: "active" | "offline" | "exited" = "active"): StatusEvent => ({
  type: "agent.status",
  agentName,
  status: s,
  reason: null,
  nodeName: null,
  at,
});

describe("linkify", () => {
  test("http and https become links, the rest stays text", () => {
    expect(linkify("see https://github.com/a/b/pull/3 and http://x.dev/p?q=1.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://github.com/a/b/pull/3", href: "https://github.com/a/b/pull/3" },
      { kind: "text", text: " and " },
      { kind: "link", text: "http://x.dev/p?q=1", href: "http://x.dev/p?q=1" },
      { kind: "text", text: "." },
    ]);
  });

  test("javascript:, data:, vbscript: and file: stay inert text", () => {
    for (const evil of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(document.cookie)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "<a href=\"javascript:alert(1)\">x</a>",
    ]) {
      const parts = linkify(`click ${evil} now`);
      expect(parts.every((p) => p.kind === "text")).toBe(true);
      expect(parts.map((p) => p.text).join("")).toBe(`click ${evil} now`);
    }
  });

  test("a scheme hidden after an http prefix does not sneak through", () => {
    const parts = linkify("https://javascript:alert(1)");
    for (const part of parts) if (part.kind === "link") expect(part.href.startsWith("https://")).toBe(true);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://user:pass@evil.com")).toBeNull();
    expect(safeHref(`https://x.dev/${"a".repeat(3000)}`)).toBeNull();
  });

  test("www. gets https, trailing punctuation and unmatched parens are trimmed", () => {
    expect(linkify("(www.example.com)")).toEqual([
      { kind: "text", text: "(" },
      { kind: "link", text: "www.example.com", href: "https://www.example.com/" },
      { kind: "text", text: ")" },
    ]);
    const wiki = linkify("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(wiki[0]).toEqual({ kind: "link", text: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_(bar)" });
  });

  test("text round-trips exactly", () => {
    const text = "a https://a.b/c, b\nhttps://d.e (f) https://g.h/i]";
    expect(linkify(text).map((p) => p.text).join("")).toBe(text);
    expect(linkify("")).toEqual([]);
  });
});

describe("classification", () => {
  test("ACK and DONE control lines are lifecycle, in any sender", () => {
    expect(messageLifecycle(msg("1", 1, { text: "ACK l-2" }))).toMatchObject({ icon: "ack", label: "acknowledged the handoff", detail: null });
    expect(messageLifecycle(msg("2", 1, { text: "DONE l-2 shipped the webhook route\nmore" }))).toMatchObject({
      icon: "done",
      detail: "shipped the webhook route",
    });
    expect(messageLifecycle(msg("3", 1, { text: "ACKNOWLEDGED, thanks" }))).toBeNull();
  });

  test("keywords only make dividers for system senders", () => {
    const sys = { name: "dispatcher", kind: "system" } as const;
    expect(messageLifecycle(msg("1", 1, { from: sys, text: "Usage limit detected on ada's Claude" }))?.icon).toBe("limit");
    expect(messageLifecycle(msg("2", 1, { from: sys, text: "Handoff → linus's Codex" }))?.icon).toBe("handoff");
    expect(messageLifecycle(msg("3", 1, { from: sys, text: "Workers spawned" }))?.icon).toBe("system");
    expect(messageLifecycle(msg("4", 1, { text: "I added rate limit middleware to the API" }))).toBeNull();
  });

  test("status events", () => {
    expect(statusLifecycle(status("w-x-api-e1", 1, "exited"))).toMatchObject({ icon: "exit", actor: "w-x-api-e1" });
    expect(statusLifecycle({ type: "node.status", nodeName: "n-e1", status: "offline", reason: "paused", at: 1 })).toMatchObject({
      icon: "offline",
      tone: "warning",
      detail: "paused",
    });
  });

  test("rows: agent, human bubble, DM, lifecycle", () => {
    const rows = buildTimelineRows([
      msg("a", 1),
      msg("h", 2, { from: { name: "h-ada", kind: "human" }, text: "please add tests" }),
      msg("d", 3, { channel: null, conversationId: "c-1", text: "what is the webhook payload shape?" }),
      msg("k", 4, { text: "ACK l-2", from: { name: "w-abc12345-api-e2", kind: "agent" } }),
      status("w-abc12345-api-e2", 5),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["agent", "human", "dm", "lifecycle", "lifecycle"]);
  });

  test("a human DM is still a human bubble", () => {
    const rows = buildTimelineRows([msg("h", 2, { from: { name: "h-ada", kind: "human" }, channel: null, conversationId: "c-1" })]);
    expect(rows[0]!.kind).toBe("human");
  });
});

describe("grouping", () => {
  test("three or more short updates in a row fold into one work group", () => {
    const rows = buildTimelineRows([update("1", 1), update("2", 2), update("3", 3), update("4", 4), msg("long", 5)]);
    expect(rows.map((r) => r.kind)).toEqual(["work", "agent"]);
    const work = rows[0] as Extract<(typeof rows)[number], { kind: "work" }>;
    expect(work.events.map((e) => e.id)).toEqual(["1", "2", "3", "4"]);
    expect(work.key).toBe("w:m:1");
    expect(work.at).toBe(4);
    // The long message continues the same agent's turn, so it skips the header.
    expect((rows[1] as { showHeader: boolean }).showHeader).toBe(false);
  });

  test("two updates stay separate; another sender or a long gap breaks the run", () => {
    expect(buildTimelineRows([update("1", 1), update("2", 2)]).map((r) => r.kind)).toEqual(["agent", "agent"]);
    const mixed = buildTimelineRows([update("1", 1), update("2", 2), update("x", 3, "w-abc12345-web-e1"), update("3", 4)]);
    expect(mixed.map((r) => r.kind)).toEqual(["agent", "agent", "agent", "agent"]);
    const gap = buildTimelineRows([update("1", 1), update("2", 2), update("3", 10 * 60_000)]);
    expect(gap.map((r) => r.kind)).toEqual(["agent", "agent", "agent"]);
  });

  test("headers: shown on a new sender, hidden within a turn", () => {
    const rows = buildTimelineRows([msg("1", 1), msg("2", 2), msg("3", 3, { from: { name: "w-abc12345-web-e1", kind: "agent" } })]);
    expect(rows.map((r) => (r as { showHeader: boolean }).showHeader)).toEqual([true, false, true]);
  });

  test("runs of status changes fold; a lone one does not", () => {
    const rows = buildTimelineRows([status("a", 1), status("b", 2), status("c", 3, "exited"), msg("m", 4), status("d", 5)]);
    expect(rows.map((r) => r.kind)).toEqual(["status-run", "agent", "lifecycle"]);
    expect((rows[0] as { items: unknown[] }).items).toHaveLength(3);
  });
});

describe("filters", () => {
  const events: RelayEventView[] = [
    msg("c", 1),
    msg("t", 2, { threadId: "c", parentId: "c" }),
    msg("d", 3, { channel: null, conversationId: "c-1" }),
    msg("m", 4, { from: { name: "w-abc12345-web-e1", kind: "agent" }, mentions: ["w-abc12345-api-e1"] }),
    status("w-abc12345-api-e1", 5),
    { type: "node.status", nodeName: "n-1", status: "online", reason: null, at: 6 },
  ];
  const keep = (scope: "all" | "channel" | "dms" | "threads", agent: string | null = null) =>
    events.filter((e) => matchesFilter(e, { scope, agent })).map((e) => (e.type === "message" ? e.id : e.type));

  test("scopes", () => {
    expect(keep("all")).toEqual(["c", "t", "d", "m", "agent.status", "node.status"]);
    expect(keep("channel")).toEqual(["c", "m"]);
    expect(keep("dms")).toEqual(["d"]);
    expect(keep("threads")).toEqual(["t"]);
  });

  test("by agent: from or mentioning it, and its own status", () => {
    expect(keep("all", "w-abc12345-api-e1")).toEqual(["c", "t", "d", "m", "agent.status"]);
    expect(keep("channel", "w-abc12345-web-e1")).toEqual(["m"]);
  });
});

describe("directory", () => {
  test("worker names, ownership and fallbacks", () => {
    expect(parseWorkerName("w-abc12345-api-e2")).toEqual({ role: "api", epoch: 2, subagent: false });
    expect(parseWorkerName("w-abc12345-web-ui-e10")).toEqual({ role: "web-ui", epoch: 10, subagent: false });
    expect(parseWorkerName("w-abc12345-api-sub-e7")).toEqual({ role: "api", epoch: 7, subagent: true });
    expect(buildDirectory(null, null).displayName("w-abc12345-api-sub-e7")).toBe("API helper #7");
    expect(buildDirectory(null, null).displayName("w-abc12345-api-e2")).toBe("API #2");
    expect(buildDirectory(null, null).displayName("w-abc12345-core-e1")).toBe("Core");
    expect(buildDirectory(null, null).displayName("w-abc12345-web-ui-e1")).toBe("Web UI");
    expect(buildDirectory(null, null).displayName("w-abc12345-test-runner-e3")).toBe("Test runner #3");
    expect(parseWorkerName("h-ada")).toBeNull();
    expect(ownership({ login: "ada" }, "claude")).toBe("ada's Claude Code");
    expect(ownership(null, "codex")).toBe("Codex");

    const dir = buildDirectory(
      {
        profiles: {
          "pr-1": {
            id: "pr-1",
            envId: "e-1",
            ownerUserId: "u-1",
            cli: "codex",
            label: "Linus Codex",
            auth: "ok",
            availability: "busy",
            cooldownUntil: null,
            limitedReason: null,
            limitedSource: null,
            maxConcurrent: 1,
            activeLeases: 1,
            scopes: "all",
            lastSeenAt: null,
          },
        },
        tasks: {},
        leases: {
          "l-1": { id: "l-1", taskId: "t", workstreamId: "ws", profileId: "pr-1", epoch: 2, agentName: "w-abc12345-api-e2", nodeName: "n-1", state: "running", createdAt: 1 },
        },
      },
      {
        id: "t-1",
        name: "Core",
        slug: "core",
        viewerRole: "owner",
        members: [{ userId: "u-1", login: "linus", name: "Linus", avatarUrl: null, role: "member" }],
        projects: [],
        environments: [{ id: "e-1", ownerUserId: "u-1", name: "linus-box", linuxUser: null, nodeName: "n-1", phase: "ready", vmState: "running", nodeOnline: true, lastError: null, createdAt: 1 }],
        policy: { allowInspect: true, maxParallelPerTask: 3 },
        relayReady: true,
      },
    );
    const info = dir.agent("w-abc12345-api-e2")!;
    expect(info).toMatchObject({ role: "api", epoch: 2, cli: "codex", vm: "linus-box" });
    expect(info.owner?.login).toBe("linus");
    expect(dir.displayName("w-abc12345-api-e2")).toBe("API #2");
    expect(dir.displayName("h-linus")).toBe("Linus");
    expect(dir.displayName("dispatcher")).toBe("dispatcher");
    expect(dir.agent("w-zzz99999-web-e1")).toMatchObject({ role: "web", cli: null, lease: null });
  });
});

describe("filter state", () => {
  test("only a filter that hides something counts; picking All again is not a filter", () => {
    expect(isFiltered(ALL_MESSAGES)).toBe(false);
    expect(isFiltered({ scope: "all", agent: null })).toBe(false);
    expect(isFiltered({ scope: "dms", agent: null })).toBe(true);
    expect(isFiltered({ scope: "all", agent: "w-abc-ui-e1" })).toBe(true);
  });

  test("Clear filter (ALL_MESSAGES) matches every event", () => {
    const events = [msg("a", 1), msg("b", 2, { conversationId: "dm-1" }), msg("c", 3, { threadId: "th-1" })];
    expect(events.every((e) => matchesFilter(e, ALL_MESSAGES))).toBe(true);
  });
});

describe("Morrow updates to workers", () => {
  const web = "w-abc12345-web-e1";
  const notice = (id: string, text: string, kind: "workstream_done" | "handoff" | "review_comment" | "status" = "workstream_done") =>
    msg(id, 1_000, { from: { name: "dispatcher", kind: "system" }, channel: null, conversationId: "dm-1", text, notice: { kind, taskId: "tk-abc12345", to: [web] } });

  test("a system message with a notice is its own row; the same metadata from anyone else is not", () => {
    const rows = buildTimelineRows([notice("n1", `@${web} "API" (api) is done on branch morrow/abc/api.`)]);
    expect(rows.map((r) => r.kind)).toEqual(["notice"]);
    const spoof = msg("n2", 1_000, { from: { name: "w-abc12345-api-e1", kind: "agent" }, notice: { kind: "status", taskId: null, to: [web] } });
    expect(buildTimelineRows([spoof]).map((r) => r.kind)).not.toContain("notice");
  });

  test("the body drops the @worker address; other text is kept", () => {
    const n = { kind: "status" as const, taskId: null, to: [web] };
    expect(noticeBody(`@${web} Morrow status of "T": running.`, n)).toBe('Morrow status of "T": running.');
    expect(noticeBody("@someone-else hi", n)).toBe("@someone-else hi");
  });

  test("a worker's STATUS request reads as a status line, not a raw protocol message", () => {
    const ask = msg("s1", 1, { from: { name: web, kind: "agent" }, text: "STATUS" });
    expect(messageLifecycle(ask)).toEqual({ icon: "system", tone: "neutral", actor: web, label: "asked for the task status", detail: null });
    expect(messageLifecycle({ ...ask, from: { name: "h-sam", kind: "human" } })).toBeNull();
    expect(messageLifecycle({ ...ask, text: "STATUS of the build is green" })).toBeNull();
  });

  test("filtering by a worker keeps the updates it was sent", () => {
    expect(matchesFilter(notice("n3", "no mention"), { scope: "all", agent: web })).toBe(true);
    expect(matchesFilter(notice("n4", "no mention"), { scope: "all", agent: "w-other-e1" })).toBe(false);
  });

  test("renders a readable label, the recipient and escaped text; long replies fold", () => {
    const directory = buildDirectory(null, null);
    const render = (event: MessageEvent, expanded = false) => {
      const [row] = buildTimelineRows([event]);
      return renderToStaticMarkup(createElement(TimelineRowView, { row: row!, directory, expanded, onToggle: () => {} }));
    };
    const html = render(notice("r1", `@${web} Review comment from octo: "<img src=x onerror=alert(1)>" https://github.com/acme/app/pull/1`, "review_comment"));
    expect(html).toContain("Review comment");
    expect(html).toContain(`${APP_NAME} told`);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('href="https://github.com/acme/app/pull/1"');
    expect(html).not.toContain(`@${web} Review`);

    const long = notice("r2", `@${web} Morrow status of "T": running.\nWorkstreams:\n- api\n- web\n- docs\nPeople: h-sam.`, "status");
    const folded = render(long);
    expect(folded).toContain("Status reply");
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain("Show all 6 lines");
    expect(folded).not.toContain("People: h-sam.");
    const open = render(long, true);
    expect(open).toContain("People: h-sam.");
    expect(open).toContain("Show less");
  });
});

describe("subagents on the timeline", () => {
  const api = "w-abc12345-api-e1";
  const child = "w-abc12345-api-sub-e7";
  const from = (name: string, text: string) => msg(`s-${text.length}`, 1, { from: { name, kind: "agent" }, conversationId: "dm-9", text });

  test("protocol lines to the dispatcher read as lifecycle lines", () => {
    expect(messageLifecycle(from(api, "SUBAGENT_OPTIONS r1"))).toMatchObject({ icon: "subagent", actor: api, label: "asked which subagents it can start" });
    expect(messageLifecycle(from(api, "@dispatcher DELEGATE r2 codex review\nReview the auth diff.\nFocus on sessions."))).toEqual({
      icon: "subagent",
      tone: "neutral",
      actor: api,
      label: "asked Codex for a review",
      detail: "Review the auth diff. Focus on sessions.",
    });
    expect(messageLifecycle(from(api, "DELEGATE r3 opencode test"))).toMatchObject({ label: "asked opencode for a test pass", detail: null });
    expect(messageLifecycle(from(api, "DELEGATE r3 cursor review"))).toMatchObject({ label: "asked Cursor Agent for a review" });
    expect(messageLifecycle(from(api, "DELEGATE r3 gemini research"))).toMatchObject({ label: "asked Gemini CLI for research" });
    expect(messageLifecycle(from(api, "DELEGATE r3 grok general"))).toMatchObject({ label: "asked Grok for a task" });
    expect(messageLifecycle(from(api, "TASK_STATUS r4 ls-7"))).toMatchObject({ label: "checked on a subagent", detail: "ls-7" });
    expect(messageLifecycle(from(api, "TASK_CANCEL r5 ls-7\nnot needed"))).toMatchObject({ label: "stopped a subagent", detail: "ls-7: not needed" });
    expect(messageLifecycle(from(child, "RESULT r6 completed\nNo bugs found."))).toEqual({ icon: "done", tone: "success", actor: child, label: "reported its result", detail: "No bugs found." });
    expect(messageLifecycle(from(child, "RESULT r7 failed\nCould not run tests."))).toMatchObject({ icon: "subagent", tone: "warning", label: "reported it could not finish" });
  });

  test("only agents, and only exact verbs, become lifecycle lines", () => {
    expect(messageLifecycle({ ...from(api, "DELEGATE r1 codex review"), from: { name: "h-sam", kind: "human" } })).toBeNull();
    expect(messageLifecycle(from(api, "I will DELEGATE r1 codex review"))).toBeNull();
    expect(messageLifecycle(from(api, "RESULT"))).toBeNull();
    expect(messageLifecycle(from(api, "DELEGATE bad/ref codex review"))).toBeNull();
    expect(messageLifecycle(from(api, "RESULT: done for today"))).toBeNull();
    expect(messageLifecycle(from(api, "@w-abc12345-web-e2 DELEGATE r1 codex review"))).toBeNull();
  });

  test("a result counts only from a subagent, and protocol lines from a subagent other than RESULT are chat", () => {
    // A worker cannot make the timeline say it "reported its result".
    expect(messageLifecycle(from(api, "RESULT r1 completed\nAll done, ship it."))).toBeNull();
    expect(messageLifecycle(from("w-abc12345-api-e1-sub", "RESULT r1 completed\nx"))).toBeNull();
    expect(messageLifecycle(from(child, "DELEGATE r1 codex review\nmore"))).toBeNull();
    expect(messageLifecycle(from(child, "TASK_CANCEL r1 ls-3"))).toBeNull();
    expect(messageLifecycle(from(child, "RESULT r1 completed\nok"))).toMatchObject({ label: "reported its result" });
  });

  test("hidden and direction-override characters never reach a lifecycle line", () => {
    const hidden = "‮⁦​\u{E0049}\u{E0047}؜­ ";
    const delegate = messageLifecycle(from(api, `DELEGATE r1 codex review\nReview ${hidden}the diff.`))!;
    expect(delegate.detail).toBe("Review the diff.");
    const result = messageLifecycle(from(child, `RESULT r1 completed\n‮No bugs  found.`))!;
    expect(result.detail).toBe("No bugs found.");
    expect(messageLifecycle(from(api, `TASK_STATUS r1 ls-7‮`))).toMatchObject({ detail: "ls-7" });
    // An override in the verb line itself does not dodge the classifier.
    expect(messageLifecycle(from(api, `​DELEGATE r1 codex review\nx`))).toMatchObject({ label: "asked Codex for a review" });
  });

  test("the [morrow ...] tag line is for tools: stripped from what people read", () => {
    const tag = "[morrow ref=r2 task=ls-7 status=completed target=codex role=review]";
    expect(stripMorrowTag(`Codex finished the review.\nNo bugs.\n${tag}`)).toBe("Codex finished the review.\nNo bugs.");
    expect(stripMorrowTag("plain text")).toBe("plain text");
    // A tag in the middle is not the trailer, and is kept.
    expect(stripMorrowTag(`a ${tag} b`)).toBe(`a ${tag} b`);
    const n = { kind: "subagent_done" as const, taskId: "tk-1", to: [api] };
    expect(noticeBody(`@${api} Codex finished the review.\n${tag}`, n)).toBe("Codex finished the review.");
  });

  test("subagent notices render with plain labels and no tag", () => {
    const directory = buildDirectory(null, null);
    for (const [kind, label] of [
      ["subagent", "Subagent update"],
      ["subagent_done", "Subagent finished"],
    ] as const) {
      const event = msg(`n-${kind}`, 1, {
        from: { name: "dispatcher", kind: "system" },
        conversationId: "dm-9",
        text: `@${api} Codex (api subagent e7) finished the review: "<b>ok</b>"\n[morrow task=ls-7 status=completed]`,
        notice: { kind, taskId: "tk-1", to: [api] },
      });
      const [row] = buildTimelineRows([event]);
      expect(row!.kind).toBe("notice");
      const html = renderToStaticMarkup(createElement(TimelineRowView, { row: row!, directory, expanded: false, onToggle: () => {} }));
      expect(html).toContain(label);
      expect(html).not.toContain("[morrow");
      expect(html).not.toContain("<b>");
    }
  });
});

describe("contracts and peer notices", () => {
  test("a worker's CONTRACT is a contract row; the same words from a person or the system are not", () => {
    const text = "CONTRACT ls-9 GET /api/members returns Member[]\ntype Member = { id: string }";
    const rows = buildTimelineRows([msg("c-1", 1, { text, threadId: "k-1" })]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("contract");
    if (row.kind !== "contract") return;
    expect(row.contract).toEqual({ leaseId: "ls-9", summary: "GET /api/members returns Member[]", body: "type Member = { id: string }" });
    expect(parseContractLine(msg("c-2", 1, { text, from: { name: "h-sam", kind: "human" } }))).toBeNull();
    expect(parseContractLine(msg("c-3", 1, { text: "contract ls-9 x" }))).toBeNull();
    expect(parseContractLine(msg("c-4", 1, { text: "CONTRACT ls-9 a\u202eb" }))!.summary).toBe("ab");
  });

  test("contract rows and peer notices render as text, never markup", () => {
    const directory = buildDirectory(null, null);
    const evil = msg("c-1", 1, { text: "CONTRACT ls-9 <img src=x onerror=alert(1)>\n<script>alert(2)</script>" });
    const [row] = buildTimelineRows([evil]);
    const html = renderToStaticMarkup(createElement(TimelineRowView, { row: row!, directory, expanded: false, onToggle: () => {} }));
    expect(html).toContain("Interface contract");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    for (const kind of ["kickoff", "contract", "peer_joined"] as const) {
      const notice = msg(`n-${kind}`, 1, { from: { name: "dispatcher", kind: "system" }, text: "@w-abc12345-web-e1 hello", notice: { kind, taskId: "tk-1", to: kind === "kickoff" ? [] : ["w-abc12345-web-e1"] } });
      const [noticeRow] = buildTimelineRows([notice]);
      expect(noticeRow!.kind).toBe("notice");
      expect(renderToStaticMarkup(createElement(TimelineRowView, { row: noticeRow!, directory, expanded: false, onToggle: () => {} }))).toContain(
        { kickoff: "Task thread", contract: "Contract shared", peer_joined: "Peer joined" }[kind],
      );
    }
  });
});
