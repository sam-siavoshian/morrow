import type { ITheme } from "@xterm/xterm";

/** xterm theme keys and the `--terminal-*` token each one reads from globals.css. */
const TOKENS = {
  background: "background",
  foreground: "foreground",
  cursor: "cursor",
  cursorAccent: "background",
  selectionBackground: "selection",
  black: "black",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  magenta: "magenta",
  cyan: "cyan",
  white: "white",
  brightBlack: "bright-black",
  brightRed: "bright-red",
  brightGreen: "bright-green",
  brightYellow: "bright-yellow",
  brightBlue: "bright-blue",
  brightMagenta: "bright-magenta",
  brightCyan: "bright-cyan",
  brightWhite: "bright-white",
} as const satisfies Partial<Record<keyof ITheme, string>>;

/**
 * xterm paints to a canvas and cannot read CSS variables, so the palette is resolved once from the
 * design tokens. A token that does not resolve is left out and xterm keeps its own default.
 */
export function terminalTheme(read: (property: string) => string): ITheme {
  const theme: ITheme = {};
  for (const [key, token] of Object.entries(TOKENS) as [keyof typeof TOKENS, string][]) {
    const value = read(`--terminal-${token}`).trim();
    if (value) theme[key] = value;
  }
  return theme;
}
