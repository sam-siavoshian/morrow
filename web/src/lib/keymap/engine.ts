/**
 * Keybinding engine ported from t3code (MIT, see THIRD_PARTY_NOTICES.md): `mod+shift+k` style
 * shortcuts, VS Code style `when` clauses, last matching rule wins. Pure: no DOM access here.
 */

export type Shortcut = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** ⌘ on macOS, Ctrl elsewhere. */
  modKey: boolean;
};

export type WhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: WhenNode }
  | { type: "and"; left: WhenNode; right: WhenNode }
  | { type: "or"; left: WhenNode; right: WhenNode };

export type KeybindingRule<C extends string = string> = { key: string; command: C; when?: string };
export type ResolvedKeybinding<C extends string = string> = { command: C; shortcut: Shortcut; when?: WhenNode };

/** Booleans the `when` clauses read. Unknown names are false. */
export type ShortcutContext = Record<string, boolean>;

export type ShortcutEventLike = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  getModifierState?: (key: "AltGraph") => boolean;
};

export type ModifierState = Pick<ShortcutEventLike, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

const MAX_WHEN_DEPTH = 64;
const MAX_KEYBINDINGS = 256;

/** US punctuation and digits by physical key, so `mod+shift+[` matches although the layout key is `{`. */
const EVENT_CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

export const isMacPlatform = (platform: string): boolean => /mac|iphone|ipad|ipod/i.test(platform);

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

/** `mod+shift+k` -> Shortcut. Exactly one non-modifier key; a trailing `+` is the plus key. Null if invalid. */
export function parseShortcut(value: string): Shortcut | null {
  if (value.trim() === "") return null;
  const tokens = value
    .toLowerCase()
    .split("+")
    .map((t) => t.trim());
  let trailing = 0;
  while (tokens.at(-1) === "") {
    trailing++;
    tokens.pop();
  }
  if (trailing > 0) tokens.push("+");
  if (tokens.length === 0 || tokens.some((t) => t.length === 0)) return null;

  const shortcut: Shortcut = { key: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: false };
  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        shortcut.metaKey = true;
        break;
      case "ctrl":
      case "control":
        shortcut.ctrlKey = true;
        break;
      case "shift":
        shortcut.shiftKey = true;
        break;
      case "alt":
      case "option":
        shortcut.altKey = true;
        break;
      case "mod":
        shortcut.modKey = true;
        break;
      default:
        if (shortcut.key) return null;
        shortcut.key = normalizeKeyToken(token);
    }
  }
  return shortcut.key ? shortcut : null;
}

type WhenToken = { type: "identifier"; value: string } | { type: "and" | "or" | "not" | "lparen" | "rparen" };

function tokenizeWhen(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let i = 0;
  const symbols: [string, WhenToken["type"]][] = [["&&", "and"], ["||", "or"], ["!", "not"], ["(", "lparen"], [")", "rparen"]];
  while (i < expression.length) {
    if (/\s/.test(expression[i]!)) {
      i++;
      continue;
    }
    const symbol = symbols.find(([text]) => expression.startsWith(text, i));
    if (symbol) {
      tokens.push({ type: symbol[1] } as WhenToken);
      i += symbol[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(i));
    if (!id) return null;
    tokens.push({ type: "identifier", value: id[0] });
    i += id[0].length;
  }
  return tokens;
}

/** `!a && (b || c)` -> AST. Precedence `!` > `&&` > `||`. Null if invalid. */
export function parseWhen(expression: string): WhenNode | null {
  const tokens = tokenizeWhen(expression);
  if (!tokens || tokens.length === 0) return null;
  let i = 0;

  const primary = (depth: number): WhenNode | null => {
    if (depth > MAX_WHEN_DEPTH) return null;
    const token = tokens[i];
    if (token?.type === "identifier") {
      i++;
      return { type: "identifier", name: token.value };
    }
    if (token?.type === "lparen") {
      i++;
      const node = or(depth + 1);
      if (!node || tokens[i]?.type !== "rparen") return null;
      i++;
      return node;
    }
    return null;
  };
  const unary = (depth: number): WhenNode | null => {
    let nots = 0;
    while (tokens[i]?.type === "not") {
      i++;
      if (++nots > MAX_WHEN_DEPTH) return null;
    }
    let node = primary(depth);
    if (!node) return null;
    while (nots-- > 0) node = { type: "not", node };
    return node;
  };
  const and = (depth: number): WhenNode | null => {
    let left = unary(depth);
    while (left && tokens[i]?.type === "and") {
      i++;
      const right = unary(depth);
      left = right ? { type: "and", left, right } : null;
    }
    return left;
  };
  const or = (depth: number): WhenNode | null => {
    let left = and(depth);
    while (left && tokens[i]?.type === "or") {
      i++;
      const right = and(depth);
      left = right ? { type: "or", left, right } : null;
    }
    return left;
  };

  const ast = or(0);
  return ast && i === tokens.length ? ast : null;
}

export function evaluateWhen(node: WhenNode | undefined, context: ShortcutContext): boolean {
  if (!node) return true;
  switch (node.type) {
    case "identifier":
      return node.name === "true" ? true : node.name === "false" ? false : Boolean(context[node.name]);
    case "not":
      return !evaluateWhen(node.node, context);
    case "and":
      return evaluateWhen(node.left, context) && evaluateWhen(node.right, context);
    case "or":
      return evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
  }
}

/** Invalid rules are dropped, not thrown: one typo must not take every shortcut down. */
export function compileKeybindings<C extends string>(rules: readonly KeybindingRule<C>[]): ResolvedKeybinding<C>[] {
  const out: ResolvedKeybinding<C>[] = [];
  for (const rule of rules) {
    const shortcut = parseShortcut(rule.key);
    if (!shortcut) continue;
    if (rule.when === undefined) {
      out.push({ command: rule.command, shortcut });
      continue;
    }
    const when = parseWhen(rule.when);
    if (when) out.push({ command: rule.command, shortcut, when });
  }
  return out.slice(-MAX_KEYBINDINGS);
}

/** Every key name the event could mean: layout key, physical latin letter, US punctuation by code. */
export function eventKeys(event: Pick<ShortcutEventLike, "key" | "code">): Set<string> {
  const layout = event.key.toLowerCase() === "esc" ? "escape" : event.key.toLowerCase();
  const keys = new Set([layout]);
  if (/^[a-z]$/.test(layout)) return keys;
  const letter = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letter) keys.add(letter.toLowerCase());
  const physical = event.code ? EVENT_CODE_KEYS[event.code] : undefined;
  if (physical) keys.add(physical);
  return keys;
}

/** Modifiers must match exactly: an extra Shift is a different shortcut. */
export function matchesModifiers(event: ModifierState, shortcut: Shortcut, platform: string): boolean {
  const mac = isMacPlatform(platform);
  return (
    event.metaKey === (shortcut.metaKey || (shortcut.modKey && mac)) &&
    event.ctrlKey === (shortcut.ctrlKey || (shortcut.modKey && !mac)) &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

export function matchesShortcut(event: ShortcutEventLike, shortcut: Shortcut, platform: string): boolean {
  // AltGr types characters on non-mac layouts; never steal those.
  if (!isMacPlatform(platform) && event.getModifierState?.("AltGraph") && !/^[a-z0-9]$/i.test(event.key)) return false;
  return matchesModifiers(event, shortcut, platform) && eventKeys(event).has(shortcut.key);
}

export type MatchOptions = { platform: string; context: ShortcutContext };

/** The command the event triggers, walking from the last rule back. */
export function resolveCommand<C extends string>(
  event: ShortcutEventLike,
  bindings: readonly ResolvedKeybinding<C>[],
  { platform, context }: MatchOptions,
): C | null {
  for (let i = bindings.length - 1; i >= 0; i--) {
    const binding = bindings[i]!;
    if (evaluateWhen(binding.when, context) && matchesShortcut(event, binding.shortcut, platform)) return binding.command;
  }
  return null;
}

function conflictKey(shortcut: Shortcut, platform: string): string {
  const mac = isMacPlatform(platform);
  const meta = shortcut.metaKey || (shortcut.modKey && mac);
  const ctrl = shortcut.ctrlKey || (shortcut.modKey && !mac);
  return [shortcut.key, meta && "meta", ctrl && "ctrl", shortcut.shiftKey && "shift", shortcut.altKey && "alt"].join("|");
}

/** Shortcuts that would actually reach `command` in this context (a later rule can shadow a chord). */
export function effectiveShortcuts<C extends string>(bindings: readonly ResolvedKeybinding<C>[], command: C, { platform, context }: MatchOptions): Shortcut[] {
  const claimed = new Set<string>();
  const out: Shortcut[] = [];
  for (let i = bindings.length - 1; i >= 0; i--) {
    const binding = bindings[i]!;
    if (!evaluateWhen(binding.when, context)) continue;
    const key = conflictKey(binding.shortcut, platform);
    if (claimed.has(key)) continue;
    claimed.add(key);
    if (binding.command === command) out.push(binding.shortcut);
  }
  return out;
}

export function formatKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key.startsWith("arrow")) return key.slice(5, 6).toUpperCase() + key.slice(6);
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

/** `⇧⌘K` on macOS, `Ctrl+Shift+K` elsewhere. */
export function formatShortcut(shortcut: Shortcut, platform: string): string {
  const mac = isMacPlatform(platform);
  const meta = shortcut.metaKey || (shortcut.modKey && mac);
  const ctrl = shortcut.ctrlKey || (shortcut.modKey && !mac);
  const key = formatKeyLabel(shortcut.key);
  if (mac) return `${ctrl ? "⌃" : ""}${shortcut.altKey ? "⌥" : ""}${shortcut.shiftKey ? "⇧" : ""}${meta ? "⌘" : ""}${key}`;
  return [ctrl && "Ctrl", shortcut.altKey && "Alt", shortcut.shiftKey && "Shift", meta && "Meta", key].filter(Boolean).join("+");
}
