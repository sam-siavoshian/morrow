import { compileKeybindings, type KeybindingRule } from "./engine";

export const TASK_JUMP_COMMANDS = [
  "task.jump.1",
  "task.jump.2",
  "task.jump.3",
  "task.jump.4",
  "task.jump.5",
  "task.jump.6",
  "task.jump.7",
  "task.jump.8",
  "task.jump.9",
] as const;

/** Every action a shortcut can trigger. Screens bind handlers to these with `useShortcut`. */
export type ShortcutCommand =
  | "palette.toggle"
  | "sidebar.toggle"
  | "task.new"
  | "task.previous"
  | "task.next"
  | "shortcuts.help"
  | (typeof TASK_JUMP_COMMANDS)[number];

/**
 * Defaults as data. Context names: `isWeb`, `isDesktop`, `terminalFocus`, `editableFocus`, plus
 * anything a screen sets with `useShortcutContext`. `alt+1..9` instead of `mod+1..9`: browsers keep
 * mod+digit for switching tabs.
 */
export const DEFAULT_KEYBINDINGS: readonly KeybindingRule<ShortcutCommand>[] = [
  { key: "mod+k", command: "palette.toggle", when: "!terminalFocus" },
  { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "task.new", when: "!terminalFocus" },
  { key: "mod+shift+[", command: "task.previous", when: "!terminalFocus" },
  { key: "mod+shift+]", command: "task.next", when: "!terminalFocus" },
  { key: "mod+/", command: "shortcuts.help", when: "!terminalFocus" },
  ...TASK_JUMP_COMMANDS.map((command, index) => ({ key: `alt+${index + 1}`, command, when: "isWeb && !terminalFocus" })),
];

export const DEFAULT_RESOLVED_KEYBINDINGS = compileKeybindings(DEFAULT_KEYBINDINGS);

/** Human names for the shortcuts help sheet. */
export const SHORTCUT_TITLES: Record<ShortcutCommand, string> = {
  "palette.toggle": "Command palette",
  "sidebar.toggle": "Toggle sidebar",
  "task.new": "New task",
  "task.previous": "Previous task",
  "task.next": "Next task",
  "shortcuts.help": "Keyboard shortcuts",
  ...(Object.fromEntries(TASK_JUMP_COMMANDS.map((c, i) => [c, `Go to task ${i + 1}`])) as Record<(typeof TASK_JUMP_COMMANDS)[number], string>),
};
