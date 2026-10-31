import { describe, expect, test } from "bun:test";
import { TASK_CRITERIA_MAX, TASK_CRITERION_MAX, TASK_PROMPT_MAX, type ProfileView } from "@morrow/contracts";
import { composerKeyIntent, type ComposerKeyEvent } from "./composer-keys";
import { createDraftStore, DRAFT_STORAGE_KEY, MAX_DRAFTS, sanitizeDraft, UI_MAX_CRITERIA } from "./drafts";
import { cliAvailability } from "@/components/workforce/status";
import { formatDuration, profileState } from "./profile-status";
import { repoNameParts } from "./repo-name";
import { detectSlashTrigger, filterSlashCommands, removeTrigger, SLASH_COMMANDS } from "./slash-commands";

const key = (k: string, extra: Partial<ComposerKeyEvent> = {}): ComposerKeyEvent => ({
  key: k,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  ...extra,
});

describe("composerKeyIntent", () => {
  const closed = { menuOpen: false };
  const open = { menuOpen: true };

  test("Enter sends; Shift+Enter and Alt+Enter are newlines", () => {
    expect(composerKeyIntent(key("Enter"), closed)).toBe("submit");
    expect(composerKeyIntent(key("Enter", { shiftKey: true }), closed)).toBeNull();
    expect(composerKeyIntent(key("Enter", { altKey: true }), closed)).toBeNull();
  });

  test("Cmd/Ctrl+Enter also sends", () => {
    expect(composerKeyIntent(key("Enter", { metaKey: true }), closed)).toBe("submit");
    expect(composerKeyIntent(key("Enter", { ctrlKey: true }), closed)).toBe("submit");
  });

  test("IME composition never sends (isComposing or keyCode 229)", () => {
    expect(composerKeyIntent(key("Enter", { isComposing: true }), closed)).toBeNull();
    expect(composerKeyIntent(key("Enter", { keyCode: 229 }), closed)).toBeNull();
    expect(composerKeyIntent(key("ArrowDown", { isComposing: true }), open)).toBeNull();
  });

  test("a held Enter does not send again", () => {
    expect(composerKeyIntent(key("Enter", { repeat: true }), closed)).toBeNull();
  });

  test("the open menu takes arrows, Enter, Tab and Escape", () => {
    expect(composerKeyIntent(key("ArrowDown"), open)).toBe("menu-next");
    expect(composerKeyIntent(key("ArrowUp"), open)).toBe("menu-prev");
    expect(composerKeyIntent(key("Enter"), open)).toBe("menu-select");
    expect(composerKeyIntent(key("Tab"), open)).toBe("menu-select");
    expect(composerKeyIntent(key("Escape"), open)).toBe("menu-close");
    expect(composerKeyIntent(key("Enter", { shiftKey: true }), open)).toBeNull();
  });

  test("with the menu closed, arrows, Tab and Escape stay with the textarea", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Tab", "Escape", "a"]) expect(composerKeyIntent(key(k), closed)).toBeNull();
  });
});

describe("slash commands", () => {
  test("detects a /token that ends at the caret", () => {
    expect(detectSlashTrigger("/", 1)).toEqual({ query: "", start: 0, end: 1 });
    expect(detectSlashTrigger("fix it /wor", 11)).toEqual({ query: "wor", start: 7, end: 11 });
    expect(detectSlashTrigger("line\n/pl", 8)).toEqual({ query: "pl", start: 5, end: 8 });
  });

  test("ignores paths, mid-word slashes and a caret elsewhere", () => {
    expect(detectSlashTrigger("/usr/bin", 8)).toBeNull();
    expect(detectSlashTrigger("src/app", 7)).toBeNull();
    expect(detectSlashTrigger("and/or", 6)).toBeNull();
    expect(detectSlashTrigger("/plan now", 9)).toBeNull();
    expect(detectSlashTrigger("/plan now", 3)).toEqual({ query: "pl", start: 0, end: 3 });
  });

  test("filters by prefix first, then substring, case-insensitive", () => {
    expect(filterSlashCommands(SLASH_COMMANDS, "").map((c) => c.id)).toEqual(["workers", "plan", "criteria"]);
    expect(filterSlashCommands(SLASH_COMMANDS, "W").map((c) => c.id)).toEqual(["workers"]);
    expect(filterSlashCommands(SLASH_COMMANDS, "cr").map((c) => c.id)).toEqual(["criteria"]);
    // "acceptance" only appears in criteria's description.
    expect(filterSlashCommands(SLASH_COMMANDS, "accept").map((c) => c.id)).toEqual(["criteria"]);
    expect(filterSlashCommands(SLASH_COMMANDS, "zzz")).toEqual([]);
  });

  test("never offers /budget: the backend has no budget field", () => {
    expect(SLASH_COMMANDS.some((c) => c.name === "budget")).toBe(false);
  });

  test("removing the token leaves clean text and a caret where it was", () => {
    expect(removeTrigger("/plan", { query: "plan", start: 0, end: 5 })).toEqual({ text: "", caret: 0 });
    expect(removeTrigger("fix /wo bug", { query: "wo", start: 4, end: 7 })).toEqual({ text: "fix bug", caret: 4 });
    expect(removeTrigger("/plan fix it", { query: "plan", start: 0, end: 5 })).toEqual({ text: "fix it", caret: 0 });
  });
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function fakeTimers() {
  let pending: (() => void) | null = null;
  return {
    setTimer: (fn: () => void) => {
      pending = fn;
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
    fire: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get pending() {
      return pending !== null;
    },
  };
}

describe("draft store", () => {
  test("persists per team + project after the debounce, not before", () => {
    const storage = memoryStorage();
    const timers = fakeTimers();
    const store = createDraftStore(storage, timers);
    store.write("t1:p1", { text: "add dark mode", criteria: ["tests pass"] });
    expect(storage.data.has(DRAFT_STORAGE_KEY)).toBe(false);
    expect(timers.pending).toBe(true);
    timers.fire();
    const fresh = createDraftStore(storage);
    expect(fresh.read("t1:p1")).toEqual({ text: "add dark mode", criteria: ["tests pass"] });
    expect(fresh.read("t1:p2")).toEqual({ text: "", criteria: [] });
  });

  test("flush writes at once (beforeunload)", () => {
    const storage = memoryStorage();
    const store = createDraftStore(storage, fakeTimers());
    store.write("t1:p1", { text: "x", criteria: [] });
    store.flush();
    expect(JSON.parse(storage.data.get(DRAFT_STORAGE_KEY)!)["t1:p1"].text).toBe("x");
  });

  test("debounces many keystrokes into one write", () => {
    const storage = memoryStorage();
    let writes = 0;
    const counting = { ...storage, setItem: (k: string, v: string) => (writes++, storage.setItem(k, v)) };
    const timers = fakeTimers();
    const store = createDraftStore(counting, timers);
    for (const text of ["a", "ab", "abc"]) store.write("t:p", { text, criteria: [] });
    timers.fire();
    expect(writes).toBe(1);
    expect(store.read("t:p").text).toBe("abc");
  });

  test("empty drafts are dropped, and the key goes once nothing is left", () => {
    const storage = memoryStorage();
    const store = createDraftStore(storage, fakeTimers());
    store.write("t:p", { text: "x", criteria: [] });
    store.flush();
    store.write("t:p", { text: "  ", criteria: [""] });
    store.flush();
    expect(storage.data.has(DRAFT_STORAGE_KEY)).toBe(false);
  });

  test("survives corrupt or hostile storage", () => {
    const storage = memoryStorage();
    storage.data.set(DRAFT_STORAGE_KEY, "{not json");
    expect(createDraftStore(storage).read("t:p")).toEqual({ text: "", criteria: [] });
    storage.data.set(DRAFT_STORAGE_KEY, JSON.stringify({ "t:p": { text: 42, criteria: "nope" }, "t:q": { text: "ok", criteria: [1, "c"] } }));
    const store = createDraftStore(storage);
    expect(store.read("t:p")).toEqual({ text: "", criteria: [] });
    expect(store.read("t:q")).toEqual({ text: "ok", criteria: ["c"] });
  });

  test("clamps to the API limits", () => {
    const draft = sanitizeDraft({ text: "x".repeat(TASK_PROMPT_MAX + 50), criteria: Array.from({ length: 30 }, () => "y".repeat(400)) })!;
    expect(draft.text.length).toBe(TASK_PROMPT_MAX);
    expect(draft.criteria.length).toBe(UI_MAX_CRITERIA);
    expect(draft.criteria[0]!.length).toBe(TASK_CRITERION_MAX);
  });

  test("the UI criteria cap never exceeds what the API accepts", () => {
    expect(UI_MAX_CRITERIA).toBeLessThanOrEqual(TASK_CRITERIA_MAX);
  });

  test("keeps only the newest drafts", () => {
    const storage = memoryStorage();
    let clock = 0;
    const store = createDraftStore(storage, { ...fakeTimers(), now: () => ++clock });
    for (let i = 0; i < MAX_DRAFTS + 5; i++) store.write(`t:p${i}`, { text: `d${i}`, criteria: [] });
    store.flush();
    const saved = Object.keys(JSON.parse(storage.data.get(DRAFT_STORAGE_KEY)!));
    expect(saved.length).toBe(MAX_DRAFTS);
    expect(saved).not.toContain("t:p0");
    expect(saved).toContain(`t:p${MAX_DRAFTS + 4}`);
  });

  test("a throwing storage (quota, private mode) keeps the draft in memory", () => {
    const store = createDraftStore(
      {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("quota");
        },
        removeItem: () => {},
      },
      fakeTimers(),
    );
    store.write("t:p", { text: "kept", criteria: [] });
    expect(() => store.flush()).not.toThrow();
    expect(store.read("t:p").text).toBe("kept");
  });
});

const profile = (over: Partial<ProfileView> = {}): ProfileView => ({
  id: "pf-1",
  envId: "e-1",
  ownerUserId: "u-1",
  cli: "claude",
  label: "Claude Code",
  auth: "ok",
  availability: "ready",
  cooldownUntil: null,
  limitedReason: null,
  limitedSource: null,
  maxConcurrent: 2,
  activeLeases: 0,
  scopes: "all",
  lastSeenAt: null,
  ...over,
});

describe("profileState", () => {
  const env = { phase: "ready" as const };
  const now = 1_000_000;

  test("only profiles that can take work are pickable", () => {
    expect(profileState(profile(), env, now)).toMatchObject({ kind: "ready", label: "Ready", pickable: true });
    expect(profileState(profile({ auth: "unknown" }), env, now)).toMatchObject({ kind: "unchecked", label: "Not checked", pickable: true });
    expect(profileState(profile({ activeLeases: 2 }), env, now)).toMatchObject({ kind: "busy", pickable: false });
    // Busy with a free slot still takes work, like the backend's eligibility rule.
    expect(profileState(profile({ availability: "busy", activeLeases: 1 }), env, now)).toMatchObject({ kind: "ready", pickable: true });
    expect(profileState(profile({ auth: "auth_required" }), env, now)).toMatchObject({ kind: "auth", label: "Auth needed", pickable: false });
    expect(profileState(profile({ availability: "offline" }), env, now)).toMatchObject({ kind: "offline", pickable: false });
    expect(profileState(profile(), { phase: "awaiting_login" }, now)).toMatchObject({ kind: "offline" });
    expect(profileState(profile(), undefined, now)).toMatchObject({ kind: "offline" });
  });

  test("limited shows the reset time when known", () => {
    const limited = profileState(profile({ availability: "limited", cooldownUntil: now + 12 * 60_000, limitedSource: "detected" }), env, now);
    expect(limited).toMatchObject({ kind: "limited", label: "Limited (resets in 12m)", pickable: false });
    expect(profileState(profile({ availability: "limited" }), env, now).label).toBe("Limited");
  });

  test("a profile scoped to other projects is not pickable here", () => {
    expect(profileState(profile({ scopes: ["p-other"] }), env, now, "p-1")).toMatchObject({ kind: "scope", pickable: false });
    expect(profileState(profile({ scopes: ["p-1"] }), env, now, "p-1").pickable).toBe(true);
  });

  test("says the same as the Workforce page for a VM that is up", () => {
    const up = { phase: "ready" as const };
    const cases: Partial<ProfileView>[] = [
      {},
      { auth: "unknown" },
      { auth: "auth_required" },
      { availability: "offline" },
      { availability: "limited", cooldownUntil: now + 60_000, limitedSource: "detected" },
      { activeLeases: 2 },
      { activeLeases: 3, auth: "unknown" },
      // The view's "busy" with a free slot: both screens follow the backend and call it ready.
      { availability: "busy", activeLeases: 1 },
      { availability: "busy", activeLeases: 2 },
    ];
    for (const over of cases) {
      const p = profile(over);
      const workforce = cliAvailability(p, { now, vmRunning: true, nodeOnline: true });
      const composer = profileState(p, up, now);
      expect(composer.kind).toBe(workforce.kind);
    }
  });

  test("a VM that is not set up reads as offline on both screens", () => {
    expect(profileState(profile(), { phase: "paused" }, now).kind).toBe("offline");
    expect(cliAvailability(profile(), { now, vmRunning: false, nodeOnline: false }).kind).toBe("offline");
  });

  test("formatDuration", () => {
    expect(formatDuration(10_000)).toBe("1m");
    expect(formatDuration(0)).toBe("<1m");
    expect(formatDuration(65 * 60_000)).toBe("1h 05m");
  });
});

describe("repoNameParts", () => {
  test("splits at camelCase, acronym, underscore and dot edges", () => {
    expect(repoNameParts("HuntedHackYcMorrowTemplates")).toEqual(["Hunted", "Hack", "Yc", "Morrow", "Templates"]);
    expect(repoNameParts("APIServer")).toEqual(["API", "Server"]);
    expect(repoNameParts("my_repo.v2")).toEqual(["my_", "repo.", "v2"]);
    expect(repoNameParts("v8Engine")).toEqual(["v8", "Engine"]);
  });

  test("leaves names with no inner edge whole, and never loses a character", () => {
    for (const name of ["web", "hunted-hack-yc", "ABC", "repo2go", "x.", "_", ""]) expect(repoNameParts(name)).toEqual([name]);
    for (const name of ["HuntedHackYc", "_x", "a.b_c", "XMLHttpRequest"]) expect(repoNameParts(name).join("")).toBe(name);
  });
});
