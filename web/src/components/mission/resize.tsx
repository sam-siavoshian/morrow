"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

export type SizeRule = {
  /** localStorage key; the size is remembered per key. */
  storageKey: string;
  initial: number;
  min: number;
  /** The largest size for this viewport. */
  max: (viewport: { width: number; height: number }) => number;
};

const readStored = (key: string): number | null => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || !/^\d{2,5}$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
};

const clamp = (value: number, rule: SizeRule) => {
  const max = Math.max(rule.min, rule.max({ width: window.innerWidth, height: window.innerHeight }));
  return Math.round(Math.min(max, Math.max(rule.min, value)));
};

const sizeListeners = new Map<string, Set<() => void>>();
// The latest size per key this session, so resizing still works when storage is blocked.
const sizeMemory = new Map<string, number>();

/**
 * A panel size remembered in localStorage and kept inside its limits as the window changes.
 * `initial` on the server and during hydration, then the stored value.
 */
export function usePersistentSize(rule: SizeRule): { size: number; setSize: (next: number) => void; reset: () => void } {
  const { storageKey: key, initial, min, max } = rule;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const set = sizeListeners.get(key) ?? new Set();
      set.add(onChange);
      sizeListeners.set(key, set);
      window.addEventListener("resize", onChange);
      return () => {
        set.delete(onChange);
        window.removeEventListener("resize", onChange);
      };
    },
    [key],
  );
  const size = useSyncExternalStore(subscribe, () => clamp(sizeMemory.get(key) ?? readStored(key) ?? initial, { storageKey: key, initial, min, max }), () => initial);

  const notify = useCallback(() => {
    for (const listener of sizeListeners.get(key) ?? []) listener();
  }, [key]);

  const setSize = useCallback(
    (next: number) => {
      const value = clamp(next, { storageKey: key, initial, min, max });
      sizeMemory.set(key, value);
      try {
        localStorage.setItem(key, String(value));
      } catch {
        // Private mode: remembered for this page only.
      }
      notify();
    },
    [key, initial, min, max, notify],
  );

  const reset = useCallback(() => {
    sizeMemory.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {}
    notify();
  }, [key, notify]);

  return { size, setSize, reset };
}

const flagListeners = new Map<string, Set<() => void>>();

/**
 * An open/closed flag remembered in localStorage and shared by every hook on the same key.
 * `fallback` decides when nothing is stored; the server and hydration always read `serverValue`.
 */
export function usePersistentFlag(key: string, fallback: () => boolean, serverValue = false): [boolean, (next: boolean) => void] {
  const fallbackRef = useRef(fallback);
  useEffect(() => {
    fallbackRef.current = fallback;
  });
  const subscribe = useCallback(
    (onChange: () => void) => {
      const set = flagListeners.get(key) ?? new Set();
      set.add(onChange);
      flagListeners.set(key, set);
      return () => {
        set.delete(onChange);
      };
    },
    [key],
  );
  const read = useCallback(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch {
      // Storage blocked: use the fallback.
    }
    return fallbackRef.current();
  }, [key]);
  const value = useSyncExternalStore(subscribe, read, () => serverValue);
  const set = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Not remembered; the listeners below still repaint from the fallback.
      }
      for (const notify of flagListeners.get(key) ?? []) notify();
    },
    [key],
  );
  return [value, set];
}

type ResizeHandleProps = {
  /** "x" resizes a width (the handle sits on the panel's left edge), "y" a height (top edge). */
  axis: "x" | "y";
  size: number;
  min: number;
  max: number;
  onResize: (size: number) => void;
  onReset: () => void;
  label: string;
  className?: string;
};

/**
 * t3code's resize rail: drag it, double-click to reset, or focus it and use the arrow keys.
 * Dragging toward the panel's open side makes it bigger.
 */
export function ResizeHandle({ axis, size, min, max, onResize, onReset, label, className }: ResizeHandleProps) {
  const start = useRef<{ pointer: number; size: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { pointer: axis === "x" ? event.clientX : event.clientY, size };
    document.documentElement.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.documentElement.style.userSelect = "none";
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const now = axis === "x" ? event.clientX : event.clientY;
    onResize(start.current.size + (start.current.pointer - now));
  };
  const end = () => {
    start.current = null;
    document.documentElement.style.cursor = "";
    document.documentElement.style.userSelect = "";
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const grow = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const shrink = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (event.key === grow) onResize(size + step);
    else if (event.key === shrink) onResize(size - step);
    else if (event.key === "Home") onResize(min);
    else if (event.key === "End") onResize(max);
    else return;
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={cn(
        "group/resize absolute z-20 touch-none outline-none",
        axis === "x" ? "inset-y-0 -left-[3px] w-1.5 cursor-col-resize" : "inset-x-0 -top-[3px] h-1.5 cursor-row-resize",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute rounded-full bg-transparent transition-colors duration-150 group-hover/resize:bg-border-strong group-focus-visible/resize:bg-ring group-active/resize:bg-ring",
          axis === "x" ? "inset-y-0 left-[2px] w-[2px]" : "inset-x-0 top-[2px] h-[2px]",
        )}
      />
    </div>
  );
}
