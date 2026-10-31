import { describe, expect, test } from "bun:test";
import { flowKey, type KeyLike } from "./keys";

/** A stand-in element: `closest` answers for the selectors listed as matching. */
const element = (...matches: string[]) => ({
  closest: (selector: string) => (selector.split(",").some((part) => matches.includes(part.trim())) ? {} : null),
});

const press = (key: string, init: Partial<KeyLike> = {}): KeyLike => ({
  key,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  target: element(),
  ...init,
});

describe("flowKey", () => {
  test("Enter on the page moves on", () => {
    expect(flowKey(press("Enter"))).toBe("next");
    expect(flowKey(press("Enter", { target: null }))).toBe("next");
    expect(flowKey(press("Enter", { target: {} }))).toBe("next");
  });

  test("Escape and Backspace go back", () => {
    expect(flowKey(press("Escape"))).toBe("back");
    expect(flowKey(press("Backspace"))).toBe("back");
  });

  test("other keys do nothing", () => {
    expect(flowKey(press("a"))).toBeNull();
    expect(flowKey(press("ArrowRight"))).toBeNull();
    expect(flowKey(press(" "))).toBeNull();
  });

  test("controls keep their own Enter, as in Zephium", () => {
    for (const control of ["button", "a[href]", "input", "textarea", "select", "[role='checkbox']", "[role='radio']", "[contenteditable='true']"])
      expect(flowKey(press("Enter", { target: element(control) }))).toBeNull();
  });

  test("a focused button still lets Escape and Backspace go back", () => {
    expect(flowKey(press("Escape", { target: element("button") }))).toBe("back");
    expect(flowKey(press("Backspace", { target: element("button") }))).toBe("back");
  });

  test("text fields keep Escape and Backspace", () => {
    for (const field of ["input", "textarea", "select", "[contenteditable='true']"]) {
      expect(flowKey(press("Backspace", { target: element(field) }))).toBeNull();
      expect(flowKey(press("Escape", { target: element(field) }))).toBeNull();
    }
  });

  test("dialogs, menus and surfaces with their own keys are left alone", () => {
    for (const surface of ["[role='dialog']", "[role='alertdialog']", "[role='menu']", "[role='listbox']", "[data-own-keys]"]) {
      expect(flowKey(press("Enter", { target: element(surface) }))).toBeNull();
      expect(flowKey(press("Escape", { target: element(surface) }))).toBeNull();
    }
  });

  test("held, composing, handled and modified presses are ignored", () => {
    expect(flowKey(press("Enter", { repeat: true }))).toBeNull();
    expect(flowKey(press("Enter", { isComposing: true }))).toBeNull();
    expect(flowKey(press("Enter", { defaultPrevented: true }))).toBeNull();
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(flowKey(press("Enter", { [modifier]: true }))).toBeNull();
      expect(flowKey(press("Backspace", { [modifier]: true }))).toBeNull();
    }
  });
});
