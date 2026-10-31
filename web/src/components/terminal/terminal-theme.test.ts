import { describe, expect, test } from "bun:test";
import { terminalTheme } from "./terminal-theme";

describe("terminalTheme", () => {
  test("maps every xterm key to its --terminal-* token, trimmed", () => {
    const seen: string[] = [];
    const theme = terminalTheme((property) => {
      seen.push(property);
      return ` value-of${property} `;
    });
    expect(theme.background).toBe("value-of--terminal-background");
    expect(theme.cursorAccent).toBe("value-of--terminal-background");
    expect(theme.selectionBackground).toBe("value-of--terminal-selection");
    expect(theme.brightMagenta).toBe("value-of--terminal-bright-magenta");
    expect(Object.keys(theme)).toHaveLength(21);
    expect(seen.every((property) => property.startsWith("--terminal-"))).toBe(true);
  });

  test("leaves out tokens that do not resolve so xterm keeps its default", () => {
    const theme = terminalTheme((property) => (property === "--terminal-foreground" ? "#fff" : ""));
    expect(theme).toEqual({ foreground: "#fff" });
  });
});
