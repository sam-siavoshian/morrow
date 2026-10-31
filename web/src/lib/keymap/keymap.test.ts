import { describe, expect, test } from "bun:test";
import { DEFAULT_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS, TASK_JUMP_COMMANDS } from "./defaults";
import { holdShortcutContext, readShortcutContext } from "./dispatcher";
import {
  compileKeybindings,
  effectiveShortcuts,
  evaluateWhen,
  formatShortcut,
  matchesShortcut,
  parseShortcut,
  parseWhen,
  resolveCommand,
  type ShortcutEventLike,
} from "./engine";
import { modifiersAfter } from "./hooks";

const MAC = "MacIntel";
const WIN = "Win32";
const key = (k: string, mods: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({
  key: k,
  code: undefined,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const web = { isWeb: true, isDesktop: false };

describe("parseShortcut", () => {
  test("modifiers, aliases, special keys", () => {
    expect(parseShortcut("mod+shift+K")).toEqual({ key: "k", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, modKey: true });
    expect(parseShortcut("cmd+option+space")?.key).toBe(" ");
    expect(parseShortcut("ctrl+esc")?.key).toBe("escape");
    expect(parseShortcut("mod++")?.key).toBe("+");
    expect(parseShortcut("mod+shift+[")?.key).toBe("[");
    expect(parseShortcut("shift+")).toMatchObject({ key: "+", shiftKey: true });
  });

  test("invalid strings are null", () => {
    for (const bad of ["", "mod", "mod+a+b", "mod++a", "mod+ +a"]) expect(parseShortcut(bad)).toBeNull();
  });
});

describe("when clauses", () => {
  test("precedence ! > && > ||, parens, unknown names are false", () => {
    const ctx = { a: true, b: false, c: true };
    expect(evaluateWhen(parseWhen("a && b || c")!, ctx)).toBe(true);
    expect(evaluateWhen(parseWhen("a && (b || !c)")!, ctx)).toBe(false);
    expect(evaluateWhen(parseWhen("!!a")!, ctx)).toBe(true);
    expect(evaluateWhen(parseWhen("missing")!, ctx)).toBe(false);
    expect(evaluateWhen(parseWhen("true && !false")!, {})).toBe(true);
    expect(evaluateWhen(undefined, {})).toBe(true);
  });

  test("malformed expressions are null and drop their rule", () => {
    for (const bad of ["", "a &&", "(a", "a b", "a & b", "a)", "1a"]) expect(parseWhen(bad)).toBeNull();
    expect(compileKeybindings([{ key: "mod+k", command: "x", when: "a &&" }, { key: "nope+nope", command: "y" }])).toEqual([]);
  });
});

describe("matching", () => {
  const modK = parseShortcut("mod+k")!;

  test("mod is ⌘ on macOS and Ctrl elsewhere; modifiers match exactly", () => {
    expect(matchesShortcut(key("k", { metaKey: true }), modK, MAC)).toBe(true);
    expect(matchesShortcut(key("k", { ctrlKey: true }), modK, MAC)).toBe(false);
    expect(matchesShortcut(key("k", { ctrlKey: true }), modK, WIN)).toBe(true);
    expect(matchesShortcut(key("k", { metaKey: true, shiftKey: true }), modK, MAC)).toBe(false);
    expect(matchesShortcut(key("K", { metaKey: true }), modK, MAC)).toBe(true);
  });

  test("physical keys: shifted brackets, alt digits on macOS, non-latin layouts", () => {
    const prev = parseShortcut("mod+shift+[")!;
    expect(matchesShortcut(key("{", { code: "BracketLeft", metaKey: true, shiftKey: true }), prev, MAC)).toBe(true);
    const jump = parseShortcut("alt+1")!;
    expect(matchesShortcut(key("¡", { code: "Digit1", altKey: true }), jump, MAC)).toBe(true);
    expect(matchesShortcut(key("л", { code: "KeyK", metaKey: true }), modK, MAC)).toBe(true);
  });

  test("AltGr characters are never stolen off macOS", () => {
    const altGr = key("@", { code: "Digit2", ctrlKey: true, altKey: true, getModifierState: () => true });
    expect(matchesShortcut(altGr, parseShortcut("ctrl+alt+2")!, WIN)).toBe(false);
  });

  test("last matching rule wins, subject to when", () => {
    const bindings = compileKeybindings([
      { key: "mod+w", command: "panel.close" },
      { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
    ]);
    const ev = key("w", { metaKey: true });
    expect(resolveCommand(ev, bindings, { platform: MAC, context: { terminalFocus: true } })).toBe("terminal.close");
    expect(resolveCommand(ev, bindings, { platform: MAC, context: {} })).toBe("panel.close");
    expect(resolveCommand(key("q", { metaKey: true }), bindings, { platform: MAC, context: {} })).toBeNull();
  });

  test("labels skip chords a later rule shadows", () => {
    const bindings = compileKeybindings([
      { key: "mod+p", command: "a" },
      { key: "mod+shift+p", command: "a" },
      { key: "mod+p", command: "b" },
    ]);
    expect(effectiveShortcuts(bindings, "a", { platform: MAC, context: {} }).map((s) => formatShortcut(s, MAC))).toEqual(["⇧⌘P"]);
  });
});

describe("defaults", () => {
  test("every default compiles", () => {
    expect(DEFAULT_RESOLVED_KEYBINDINGS).toHaveLength(DEFAULT_KEYBINDINGS.length);
  });

  test("the documented chords reach their commands on web", () => {
    const run = (ev: ShortcutEventLike, platform = MAC, extra = {}) =>
      resolveCommand(ev, DEFAULT_RESOLVED_KEYBINDINGS, { platform, context: { ...web, ...extra } });
    expect(run(key("k", { metaKey: true }))).toBe("palette.toggle");
    expect(run(key("b", { ctrlKey: true }), WIN)).toBe("sidebar.toggle");
    expect(run(key("O", { code: "KeyO", metaKey: true, shiftKey: true }))).toBe("task.new");
    expect(run(key("}", { code: "BracketRight", metaKey: true, shiftKey: true }))).toBe("task.next");
    expect(run(key("{", { code: "BracketLeft", ctrlKey: true, shiftKey: true }), WIN)).toBe("task.previous");
    expect(run(key("/", { code: "Slash", metaKey: true }))).toBe("shortcuts.help");
    expect(run(key("™", { code: "Digit2", altKey: true }))).toBe(TASK_JUMP_COMMANDS[1]);
    expect(run(key("9", { code: "Digit9", altKey: true }), WIN)).toBe("task.jump.9");
  });

  test("the terminal keeps its keys", () => {
    const ctx = { platform: MAC, context: { ...web, terminalFocus: true } };
    expect(resolveCommand(key("k", { metaKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, ctx)).toBeNull();
    expect(resolveCommand(key("1", { code: "Digit1", altKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, ctx)).toBeNull();
  });

  test("labels per platform", () => {
    const newTask = DEFAULT_RESOLVED_KEYBINDINGS.find((b) => b.command === "task.new")!.shortcut;
    expect(formatShortcut(newTask, MAC)).toBe("⇧⌘O");
    expect(formatShortcut(newTask, WIN)).toBe("Ctrl+Shift+O");
    expect(formatShortcut(parseShortcut("alt+arrowup")!, WIN)).toBe("Alt+Up");
  });
});

describe("context and modifier tracking", () => {
  test("held context names are counted", () => {
    const a = holdShortcutContext("paletteOpen");
    const b = holdShortcutContext("paletteOpen");
    a();
    a();
    expect(readShortcutContext(null).paletteOpen).toBe(true);
    b();
    expect(readShortcutContext(null).paletteOpen).toBeUndefined();
    expect(readShortcutContext(null)).toMatchObject({ isWeb: true, editableFocus: false, terminalFocus: false });
  });

  test("modifier state follows presses and heals a lost keyup", () => {
    const none = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    const down = modifiersAfter(none, { type: "keydown", key: "Alt", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false });
    expect(down.altKey).toBe(true);
    const up = modifiersAfter(down, { type: "keyup", key: "Alt", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
    expect(up.altKey).toBe(false);
    const healed = modifiersAfter(down, { type: "keydown", key: "x", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
    expect(healed.altKey).toBe(false);
  });
});
