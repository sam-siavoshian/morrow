import { describe, expect, test } from "bun:test";
import type { RelayEventView } from "@morrow/contracts";
import { agentColor } from "./agent-color";
import { conversationIndex, mentionsOf, preview, readableText } from "./conversation";

type Message = Extract<RelayEventView, { type: "message" }>;

let seq = 0;
const m = (from: string, text: string, extra: Partial<Message> = {}): Message => ({
  type: "message",
  id: `m${++seq}`,
  channel: "proj-1",
  conversationId: null,
  threadId: null,
  parentId: null,
  from: { name: from, kind: from.startsWith("h-") ? "human" : from === "dispatcher" ? "system" : "agent" },
  text,
  mentions: [],
  createdAt: seq,
  ...extra,
});

const API = "w-ab12-api-e2";
const WEB = "w-ab12-web-e1";
const DB = "w-ab12-db-e1";

describe("mentions and previews", () => {
  test("reads @names like the backend: at the start or after a space, worker and person names only", () => {
    const e = m(API, `@${WEB} can you check? cc @h-ada, not mail@${DB}, not @dispatcher or @random`, { mentions: ["w-ab12-x-e1", "general"] });
    expect(mentionsOf(e).sort()).toEqual(["h-ada", WEB, "w-ab12-x-e1"].sort());
  });

  test("only the start of a huge message is scanned", () => {
    expect(mentionsOf(m(API, `${"x ".repeat(3_000)} @${WEB}`))).toEqual([]);
  });

  test("previews are one clipped line without hidden characters or the morrow tag; markup stays text", () => {
    expect(preview("line one\n\n  line\u202etwo\n[morrow task=t status=x]")).toBe("line one linetwo");
    const long = preview("a".repeat(300), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
    expect(preview("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("conversation index", () => {
  test("a question and its answer, addressed both ways", () => {
    const q = m(WEB, `@${API} what shape does PATCH take?`);
    const a = m(API, `@${WEB} a partial object.`);
    const again = m(API, `@${WEB} also, unknown keys are rejected.`);
    const idx = conversationIndex([q, a, again]);
    expect(idx.get(q.id)).toEqual({ to: [API], tags: ["question"] });
    expect(idx.get(a.id)).toEqual({ to: [WEB], tags: ["answer"] });
    // One answer per question.
    expect(idx.get(again.id)).toEqual({ to: [WEB], tags: [] });
  });

  test("an answer that asks back is both", () => {
    const q = m(WEB, `@${API} 404 or 403?`);
    const a = m(API, `@${WEB} 404. Do you need the body too?`);
    const b = m(WEB, `@${API} no, thanks.`);
    const idx = conversationIndex([q, a, b]);
    expect(idx.get(a.id)!.tags).toEqual(["answer", "question"]);
    expect(idx.get(b.id)!.tags).toEqual(["answer"]);
  });

  test("a plain post goes to everyone; a contract is tagged and never a question", () => {
    const post = m(DB, "Starting on the schema.");
    const contract = m(DB, "CONTRACT l-1 settings table: team_id, key, value?\nindex on (team_id, key)");
    const idx = conversationIndex([post, contract]);
    expect(idx.get(post.id)).toEqual({ to: [], tags: [] });
    expect(idx.get(contract.id)).toEqual({ to: [], tags: ["contract"] });
  });

  test("a DM goes to the others in the conversation; a thread reply to the author it answers, not Morrow", () => {
    const kickoff = m("dispatcher", "Task thread", { notice: { kind: "kickoff", taskId: "t", to: [] } });
    const dm1 = m(API, "hi", { channel: null, conversationId: "c1", mentions: [WEB] });
    const dm2 = m(WEB, "hey", { channel: null, conversationId: "c1" });
    const root = m(DB, "migration is up", { threadId: kickoff.id, parentId: kickoff.id });
    const reply = m(API, "thanks", { threadId: root.id, parentId: root.id });
    const idx = conversationIndex([kickoff, dm1, dm2, root, reply]);
    expect(idx.has(kickoff.id)).toBe(false);
    expect(idx.get(dm2.id)!.to).toEqual([API]);
    expect(idx.get(root.id)!.to).toEqual([]);
    expect(idx.get(reply.id)!.to).toEqual([DB]);
  });

  test("people address agents too, and BLOCKED is tagged; self mentions are dropped", () => {
    const steer = m("h-ada", `@${WEB} keep labels short`);
    const blocked = m(API, `BLOCKED waiting on @${DB} for the table @${API}`);
    const idx = conversationIndex([steer, blocked]);
    expect(idx.get(steer.id)).toEqual({ to: [WEB], tags: [] });
    expect(idx.get(blocked.id)).toEqual({ to: [DB], tags: ["blocked"] });
  });

  test("status events are skipped", () => {
    const idx = conversationIndex([{ type: "agent.status", agentName: API, status: "active", reason: null, nodeName: null, at: 1 }]);
    expect(idx.size).toBe(0);
  });
});

describe("agent colours", () => {
  test("stable per name and spread over the palette", () => {
    expect(agentColor(API)).toBe(agentColor(API));
    const names = Array.from({ length: 60 }, (_, i) => `w-ab12-role${i}-e1`);
    expect(new Set(names.map((n) => agentColor(n).name)).size).toBeGreaterThanOrEqual(5);
    expect(agentColor("").text.startsWith("text-soft-")).toBe(true);
  });
});

describe("readable text", () => {
  const names: Record<string, string> = { [API]: "api e2", [WEB]: "web e1", "h-ada": "Ada" };
  const display = (n: string) => names[n] ?? n;

  test("drops the opening @names the header already shows, and names the rest by display name", () => {
    expect(readableText(`@${WEB} partial object, ask @${API} or @h-ada`, [WEB], display)).toBe("partial object, ask @api e2 or @Ada");
    expect(readableText(`@${WEB}, @${API}: both of you`, [WEB, API], display)).toBe("both of you");
  });

  test("keeps opening names the header does not show, unknown names, and a message that is only a mention", () => {
    expect(readableText(`@${API} fyi`, [WEB], display)).toBe("@api e2 fyi");
    expect(readableText("@w-zz-x-e1 hi and mail@w-ab12-web-e1", [], display)).toBe("@w-zz-x-e1 hi and mail@w-ab12-web-e1");
    expect(readableText(`@${WEB}`, [WEB], display)).toBe("@web e1");
    expect(readableText(`@${WEB} <script>x</script>`, [WEB], display)).toBe("<script>x</script>");
  });
});
