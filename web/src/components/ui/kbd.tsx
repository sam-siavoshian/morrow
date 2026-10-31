"use client";

import { useSyncExternalStore, type ComponentProps } from "react";
import { cn } from "@/lib/cn";

const noop = () => () => {};

const detectMac = () => {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform);
};

/** True on Apple platforms. False during server render, then corrects itself. */
function useIsMac() {
  return useSyncExternalStore(noop, detectMac, () => false);
}

const GLYPH: Record<string, { mac: string; other: string; label: string }> = {
  mod: { mac: "⌘", other: "Ctrl", label: "Command" },
  meta: { mac: "⌘", other: "Win", label: "Command" },
  ctrl: { mac: "⌃", other: "Ctrl", label: "Control" },
  alt: { mac: "⌥", other: "Alt", label: "Option" },
  shift: { mac: "⇧", other: "Shift", label: "Shift" },
  enter: { mac: "↵", other: "Enter", label: "Enter" },
  escape: { mac: "Esc", other: "Esc", label: "Escape" },
  backspace: { mac: "⌫", other: "Backspace", label: "Backspace" },
  tab: { mac: "⇥", other: "Tab", label: "Tab" },
  up: { mac: "↑", other: "↑", label: "Up" },
  down: { mac: "↓", other: "↓", label: "Down" },
  left: { mac: "←", other: "←", label: "Left" },
  right: { mac: "→", other: "→", label: "Right" },
  space: { mac: "Space", other: "Space", label: "Space" },
};

/** Splits "mod+shift+k" or ["mod", "k"] into display glyphs and a spoken label. */
export function formatKeys(keys: string | readonly string[], mac: boolean) {
  const list = typeof keys === "string" ? keys.split("+") : keys;
  return list.map((raw) => {
    const key = raw.trim().toLowerCase();
    const known = GLYPH[key];
    if (known) return { glyph: mac ? known.mac : known.other, label: known.label };
    const glyph = raw.length === 1 ? raw.toUpperCase() : raw;
    return { glyph, label: glyph };
  });
}

type KbdProps = Omit<ComponentProps<"kbd">, "children"> & {
  /** "mod+k", or a list. `mod` is ⌘ on Apple platforms and Ctrl elsewhere. */
  keys: string | readonly string[];
  /** sm is the 14px chip that sits in tooltips and menus; md the 20px one for prose. */
  size?: "sm" | "md";
  variant?: "neutral" | "ghost";
};

/** One chip per key (opencode keybind), so ⌘ and K never read as one blob. */
export function Kbd({ keys, size = "sm", variant = "neutral", className, ...props }: KbdProps) {
  const parts = formatKeys(keys, useIsMac());
  return (
    <kbd
      className={cn("inline-flex shrink-0 items-center gap-0.5 font-sans tabular-nums", className)}
      {...props}
    >
      <span className="sr-only">{parts.map((part) => part.label).join(" ")}</span>
      {parts.map((part, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            "flex items-center justify-center font-[530] leading-none uppercase select-none",
            size === "sm"
              ? "h-3.5 min-w-3.5 rounded-[3px] px-1 text-[11px] tracking-[0.05px]"
              : "h-5 min-w-5 rounded-[5px] px-1.5 text-[12px]",
            variant === "neutral" ? "bg-fill-hover text-muted" : "text-faint",
          )}
        >
          {part.glyph}
        </span>
      ))}
    </kbd>
  );
}
