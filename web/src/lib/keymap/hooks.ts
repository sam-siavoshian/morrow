"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_RESOLVED_KEYBINDINGS, TASK_JUMP_COMMANDS, type ShortcutCommand } from "./defaults";
import { currentPlatform, holdShortcutContext, readShortcutContext, registerCommands, type CommandHandler } from "./dispatcher";
import { effectiveShortcuts, formatShortcut, matchesModifiers, type ModifierState } from "./engine";

/** Hold-to-reveal waits this long, so a quick alt+1 never flashes the hints. */
const HINT_DELAY_MS = 200;

type ShortcutOptions = {
  /** Off: the shortcut does nothing here (the browser default runs). */
  enabled?: boolean;
  /** Run ahead of focused widgets that swallow keys (the terminal). */
  capture?: boolean;
};

/**
 * Binds `command` to `handler` while mounted. The newest binding of a command wins; return `false`
 * from the handler to pass the key on to the previous one.
 */
export function useShortcut(command: ShortcutCommand, handler: CommandHandler, options: ShortcutOptions = {}): void {
  const { enabled = true, capture = false } = options;
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    return registerCommands({ [command]: (event: KeyboardEvent) => handlerRef.current(event) }, { capture });
  }, [command, enabled, capture]);
}

/** Switches a `when` context name on while mounted and `active` (e.g. `paletteOpen`). */
export function useShortcutContext(name: string, active = true): void {
  useEffect(() => (active ? holdShortcutContext(name) : undefined), [name, active]);
}

const noopSubscribe = () => () => {};

/** `⇧⌘O` / `Ctrl+Shift+O` for the command, or null. Null during server render (the platform is unknown there). */
export function useShortcutLabel(command: ShortcutCommand): string | null {
  return useSyncExternalStore(noopSubscribe, () => shortcutLabel(command), () => null);
}

/** Label outside React, for menus built on the fly. */
export function shortcutLabel(command: ShortcutCommand): string | null {
  const platform = currentPlatform();
  const shortcut = effectiveShortcuts(DEFAULT_RESOLVED_KEYBINDINGS, command, { platform, context: readShortcutContext(null) })[0];
  return shortcut ? formatShortcut(shortcut, platform) : null;
}

const NO_MODIFIERS: ModifierState = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
const sameModifiers = (a: ModifierState, b: ModifierState) =>
  a.metaKey === b.metaKey && a.ctrlKey === b.ctrlKey && a.altKey === b.altKey && a.shiftKey === b.shiftKey;

/** The modifier flags after a key event, healed from the event's own flags in case a keyup was lost. */
export function modifiersAfter(current: ModifierState, event: Pick<KeyboardEvent, "type" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): ModifierState {
  const pressed = event.type === "keydown";
  const which =
    event.key === "Meta" || event.key === "OS" ? "metaKey" : event.key === "Control" ? "ctrlKey" : event.key === "Alt" ? "altKey" : event.key === "Shift" ? "shiftKey" : null;
  const flags = { metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey };
  if (!which) return { metaKey: current.metaKey && flags.metaKey, ctrlKey: current.ctrlKey && flags.ctrlKey, altKey: current.altKey && flags.altKey, shiftKey: current.shiftKey && flags.shiftKey };
  return { ...flags, [which]: pressed };
}

/** Which modifiers are physically held. Resets on blur and paste (dictation tools drop keyups). */
export function useModifierState(ignoreEditable = false): ModifierState {
  const [state, setState] = useState(NO_MODIFIERS);
  const ref = useRef(NO_MODIFIERS);
  useEffect(() => {
    const update = (next: ModifierState) => {
      if (sameModifiers(ref.current, next)) return;
      ref.current = next;
      setState(next);
    };
    const onKey = (event: KeyboardEvent) =>
      update(ignoreEditable && readShortcutContext(event.target).editableFocus ? NO_MODIFIERS : modifiersAfter(ref.current, event));
    const reset = () => update(NO_MODIFIERS);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("paste", reset, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("paste", reset, true);
      window.removeEventListener("blur", reset);
    };
  }, [ignoreEditable]);
  return state;
}

/** True while exactly the task-jump modifiers are held (alt on web), after a short delay. For the 1..9 row hints. */
export function useJumpHintsVisible(): boolean {
  const held = useModifierState(true);
  const [visible, setVisible] = useState(false);
  const wanted = (() => {
    if (typeof navigator === "undefined" || sameModifiers(held, NO_MODIFIERS)) return false;
    const platform = currentPlatform();
    const context = readShortcutContext();
    if (context.terminalFocus) return false;
    const shortcut = effectiveShortcuts(DEFAULT_RESOLVED_KEYBINDINGS, TASK_JUMP_COMMANDS[0], { platform, context })[0];
    return shortcut ? matchesModifiers(held, shortcut, platform) : false;
  })();
  useEffect(() => {
    if (!wanted) return;
    const timer = setTimeout(() => setVisible(true), HINT_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setVisible(false);
    };
  }, [wanted]);
  return wanted && visible;
}
