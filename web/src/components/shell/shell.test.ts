import { describe, expect, test } from "bun:test";
import { shortcutRows } from "@/components/palette/shortcuts-sheet";
import { paletteTasks } from "@/components/palette/app-palette";
import type { TaskView } from "@morrow/contracts";
import { requestComposerFocus, takeComposerFocusRequest } from "./composer-focus";
import { bannerDelay, BANNER_GRACE_MS, FIRST_CONNECT_GRACE_MS } from "./connection-banner";
import { formatDocumentTitle, resolveDocumentTitle } from "./document-title";
import { badgeLabel, installBadge } from "./favicon-badge";
import { createSidebarStore, parseSidebarCookie } from "./sidebar-store";
import {
  clampSidebarWidth,
  initialSidebarWidth,
  parseStoredWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_SCRIPT,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "./sidebar-width";

describe("sidebar width", () => {
  test("clamps between 208px and what leaves the main pane 640px", () => {
    expect(clampSidebarWidth(100, 1440)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(300.4, 1440)).toBe(300);
    expect(clampSidebarWidth(2000, 1440)).toBe(800);
    // A window too small for both still gets the minimum sidebar.
    expect(clampSidebarWidth(400, 700)).toBe(SIDEBAR_MIN_WIDTH);
    expect(initialSidebarWidth(null, 1440)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  test("stored values parse only when sane", () => {
    expect(parseStoredWidth("312")).toBe(312);
    expect(parseStoredWidth("312.5")).toBe(312.5);
    for (const bad of [null, "", "abc", "-5", "1e3", "7", "999999", "300px"]) expect(parseStoredWidth(bad)).toBeNull();
  });

  // The pre-paint script repeats the rules in plain JS; run it and compare with the module.
  function runScript(stored: string | null, innerWidth: number): string | null {
    let applied: string | null = null;
    const env = {
      localStorage: { getItem: (key: string) => (key === SIDEBAR_WIDTH_STORAGE_KEY ? stored : null) },
      innerWidth,
      document: { documentElement: { style: { setProperty: (_: string, value: string) => (applied = value) } } },
    };
    new Function("localStorage", "innerWidth", "document", SIDEBAR_WIDTH_SCRIPT)(env.localStorage, env.innerWidth, env.document);
    return applied;
  }

  test("the head script agrees with the module", () => {
    for (const [stored, viewport] of [["300", 1440], ["100", 1440], ["5000", 1440], ["400", 700], ["260.6", 1200]] as const) {
      expect(runScript(stored, viewport)).toBe(`${initialSidebarWidth(parseStoredWidth(stored), viewport)}px`);
    }
    expect(runScript(null, 1440)).toBeNull();
    expect(runScript("junk", 1440)).toBeNull();
    expect(runScript("</script><script>alert(1)</script>", 1440)).toBeNull();
  });

  test("the head script cannot break out of its tag", () => {
    expect(SIDEBAR_WIDTH_SCRIPT).not.toContain("</");
  });
});

describe("sidebar open state", () => {
  test("the cookie is open unless it says false", () => {
    expect(parseSidebarCookie(undefined)).toBe(true);
    expect(parseSidebarCookie("true")).toBe(true);
    expect(parseSidebarCookie("false")).toBe(false);
    expect(parseSidebarCookie("junk")).toBe(true);
  });

  test("toggle flips the sheet on phones and the rail elsewhere", () => {
    let mobile = false;
    const store = createSidebarStore(true, () => mobile);
    let notified = 0;
    store.subscribe(() => notified++);
    store.toggle();
    expect(store.getSnapshot()).toEqual({ open: false, openMobile: false });
    mobile = true;
    store.toggle();
    expect(store.getSnapshot()).toEqual({ open: false, openMobile: true });
    store.setOpenMobile(true);
    expect(notified).toBe(2);
  });

  test("collapse listeners run before the sidebar closes, never on open", () => {
    const store = createSidebarStore(false, () => false);
    const seen: boolean[] = [];
    const off = store.onCollapse(() => seen.push(store.getSnapshot().open));
    store.setOpen(true);
    store.setOpen(false);
    off();
    store.setOpen(true);
    store.setOpen(false);
    expect(seen).toEqual([true]);
  });
});

describe("composer focus", () => {
  test("a request is taken once, and goes stale after 5s", () => {
    requestComposerFocus(1_000);
    expect(takeComposerFocusRequest(2_000)).toBe(true);
    expect(takeComposerFocusRequest(2_000)).toBe(false);
    requestComposerFocus(1_000);
    expect(takeComposerFocusRequest(6_001)).toBe(false);
  });
});

describe("document title", () => {
  test("formats like the metadata template", () => {
    expect(formatDocumentTitle("Workforce")).toBe("Workforce · Morrow");
    expect(formatDocumentTitle("  Fix\n the   login  ")).toBe("Fix the login · Morrow");
    expect(formatDocumentTitle("")).toBe("Morrow");
    expect(formatDocumentTitle("x".repeat(500))).toBe(`${"x".repeat(120)} · Morrow`);
  });

  test("highest priority wins, newest among equals, loading titles are skipped", () => {
    expect(resolveDocumentTitle([])).toBeNull();
    expect(resolveDocumentTitle([{ title: null, priority: 5 }])).toBeNull();
    expect(resolveDocumentTitle([{ title: "Page", priority: 1 }, { title: "Task", priority: 0 }])).toBe("Page · Morrow");
    expect(resolveDocumentTitle([{ title: "A", priority: 1 }, { title: "B", priority: 1 }])).toBe("B · Morrow");
    expect(resolveDocumentTitle([{ title: "Task", priority: 0 }, { title: null, priority: 1 }])).toBe("Task · Morrow");
  });
});

describe("attention favicon", () => {
  test("labels cap at 9+", () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(-1)).toBeNull();
    expect(badgeLabel(3)).toBe("3");
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(10)).toBe("9+");
  });

  function fakeHead(initial: Record<string, string>[]) {
    const links = initial.map((attrs) => {
      const values = new Map(Object.entries(attrs));
      return {
        values,
        getAttribute: (n: string) => values.get(n) ?? null,
        setAttribute: (n: string, v: string) => void values.set(n, v),
        removeAttribute: (n: string) => void values.delete(n),
        remove() {
          head.links.splice(head.links.indexOf(this), 1);
        },
      };
    });
    const head = {
      links,
      querySelectorAll: () => head.links,
      append: (link: (typeof links)[number]) => void head.links.push(link),
    };
    const doc = {
      head,
      createElement: () => {
        const values = new Map<string, string>();
        const link = {
          values,
          set rel(v: string) {
            values.set("rel", v);
          },
          getAttribute: (n: string) => values.get(n) ?? null,
          setAttribute: (n: string, v: string) => void values.set(n, v),
          removeAttribute: (n: string) => void values.delete(n),
          remove() {
            head.links.splice(head.links.indexOf(link as never), 1);
          },
        };
        return link;
      },
    };
    return { head, doc: doc as unknown as Document };
  }

  test("edits the page's icons in place and restores them exactly", () => {
    const { head, doc } = fakeHead([{ rel: "icon", href: "/favicon.ico", sizes: "48x48" }, { rel: "icon", href: "/icon.svg", type: "image/svg+xml" }]);
    const nodes = [...head.links];
    const restore = installBadge("data:image/png;base64,AA", doc);
    expect(head.links).toEqual(nodes);
    for (const link of head.links) expect(link.getAttribute("href")).toBe("data:image/png;base64,AA");
    restore();
    restore();
    expect(head.links[0]!.values).toEqual(new Map([["rel", "icon"], ["href", "/favicon.ico"], ["sizes", "48x48"]]));
    expect(head.links[1]!.values).toEqual(new Map([["rel", "icon"], ["href", "/icon.svg"], ["type", "image/svg+xml"]]));
  });

  test("adds its own icon when the page has none, and removes it after", () => {
    const { head, doc } = fakeHead([]);
    const restore = installBadge("data:x", doc);
    expect(head.links).toHaveLength(1);
    restore();
    expect(head.links).toHaveLength(0);
  });
});

describe("connection banner", () => {
  test("waits out short blips, longer on the first connect", () => {
    expect(bannerDelay("open")).toBeNull();
    expect(bannerDelay("reconnecting")).toBe(BANNER_GRACE_MS);
    expect(bannerDelay("offline")).toBe(BANNER_GRACE_MS);
    expect(bannerDelay("connecting")).toBe(FIRST_CONNECT_GRACE_MS);
  });
});

describe("palette and shortcuts", () => {
  test("tasks list newest first, capped", () => {
    const at = (id: string, updatedAt: number) => ({ id, updatedAt }) as TaskView;
    const tasks = { a: at("a", 1), b: at("b", 3), c: at("c", 2) };
    expect(paletteTasks(tasks).map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(paletteTasks(tasks, 2).map((t) => t.id)).toEqual(["b", "c"]);
  });

  test("the help sheet lists every binding once, jumps folded", () => {
    const rows = shortcutRows();
    expect(rows.map((r) => r.title)).toEqual([
      "Command palette",
      "Toggle sidebar",
      "New task",
      "Previous task",
      "Next task",
      "Keyboard shortcuts",
      "Go to task 1 to 9",
    ]);
    expect(rows.at(-1)!.keys).toBe("alt+1…9");
  });
});
