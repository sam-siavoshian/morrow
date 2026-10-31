// What a key press in the composer means. Pure, so the rules are tested without a DOM.
// Mirrors t3code's composer-logic: Enter sends, Shift/Alt+Enter is a newline, IME composition
// and key repeat never send, and an open slash menu takes the arrows, Enter, Tab and Escape.

export type ComposerKeyEvent = {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
};

export type ComposerKeyIntent = "submit" | "menu-next" | "menu-prev" | "menu-select" | "menu-close" | null;

/** `null` means "let the textarea handle it" (type, newline, move the caret). */
export function composerKeyIntent(event: ComposerKeyEvent, options: { menuOpen: boolean }): ComposerKeyIntent {
  // keyCode 229 is the IME "process" key some browsers send instead of isComposing.
  if (event.isComposing || event.keyCode === 229) return null;
  const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;

  if (options.menuOpen) {
    if (event.key === "ArrowDown" && plain) return "menu-next";
    if (event.key === "ArrowUp" && plain) return "menu-prev";
    if ((event.key === "Enter" || event.key === "Tab") && plain) return "menu-select";
    if (event.key === "Escape") return "menu-close";
  }

  if (event.key !== "Enter" || event.repeat) return null;
  if (event.shiftKey || event.altKey) return null;
  return "submit";
}
