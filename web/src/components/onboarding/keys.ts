/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Adapted from github.com/zephium-browser/Zephium (frame/src/features/onboarding/components/Onboarding.svelte, keydown). */

/** What a key press asks of the setup flow: the step's primary action, the step before, or nothing. */
export type FlowKey = "next" | "back" | null;

/** The parts of a KeyboardEvent the flow reads, so tests can build one without a DOM. */
export type KeyLike = Pick<KeyboardEvent, "key" | "repeat" | "isComposing" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
  /** Usually an Element; anything without `closest` (the window, a text node) counts as "nothing focused". */
  target: unknown;
};

/** A control that already answers Enter itself. Zephium leaves buttons, links and fields their own Enter. */
const ANSWERS_ENTER = "button, a[href], input, textarea, select, [role='checkbox'], [role='radio'], [role='option'], [contenteditable='true']";
/** Where Backspace and Escape edit text rather than leave. */
const EDITS_TEXT = "input, textarea, select, [contenteditable='true']";
/** Surfaces with keys of their own: a dialog's Escape closes it, a menu's Enter picks. */
const OWNS_KEYS = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], [data-own-keys]";

function within(target: unknown, selector: string): boolean {
  const closest = (target as Partial<Pick<Element, "closest">> | null)?.closest;
  return typeof closest === "function" && Boolean(closest.call(target, selector));
}

/**
 * Enter moves on, Escape or Backspace goes back. Held keys, IME composition, modifiers and anything a
 * focused control or an open dialog already handles are left alone.
 */
export function flowKey(event: KeyLike): FlowKey {
  if (event.defaultPrevented || event.repeat || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (within(event.target, OWNS_KEYS)) return null;
  if (event.key === "Enter") return within(event.target, ANSWERS_ENTER) ? null : "next";
  if (event.key === "Escape" || event.key === "Backspace") return within(event.target, EDITS_TEXT) ? null : "back";
  return null;
}
