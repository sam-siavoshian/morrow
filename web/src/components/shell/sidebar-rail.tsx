"use client";

import { useEffect, useRef, type PointerEvent } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useSidebarState } from "./shell-context";
import {
  clampSidebarWidth,
  parseStoredWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "./sidebar-width";

const root = () => document.documentElement;

function currentWidth(): number {
  const raw = getComputedStyle(root()).getPropertyValue("--sidebar-width").trim();
  const px = raw.endsWith("rem") ? Number.parseFloat(raw) * 16 : Number.parseFloat(raw);
  return Number.isFinite(px) ? px : SIDEBAR_DEFAULT_WIDTH;
}

function applyWidth(width: number | null): void {
  if (width === null) root().style.removeProperty("--sidebar-width");
  else root().style.setProperty("--sidebar-width", `${width}px`);
}

function storeWidth(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
    else localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Storage unavailable: the width lasts for this page.
  }
}

function storedWidth(): number | null {
  try {
    return parseStoredWidth(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * t3code SidebarRail: a 16px strip on the sidebar's edge. Drag to resize (the width writes straight
 * to `--sidebar-width`, no re-render per frame), double-click to reset. The main pane keeps 640px.
 */
export function SidebarRail() {
  const { store } = useSidebarState();
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);

  // The saved width, re-clamped whenever the window narrows so the main pane keeps 640px. The head
  // script already applied it before paint; this covers windows resized since.
  useEffect(() => {
    const onResize = () => {
      const saved = storedWidth();
      if (saved !== null) applyWidth(clampSidebarWidth(saved, window.innerWidth));
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Collapsing mid-drag drops the drag: there is nothing left to resize.
  useEffect(
    () =>
      store.onCollapse(() => {
        drag.current = null;
        root().removeAttribute("data-sidebar-resizing");
      }),
    [store],
  );

  const end = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    root().removeAttribute("data-sidebar-resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (commit && Math.abs(state.width - state.startWidth) >= 1) storeWidth(state.width);
    else if (!commit) applyWidth(state.startWidth);
  };

  return (
    <Tooltip content="Drag to resize. Double-click to reset." side="right" delay={600}>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Resize sidebar"
        data-slot="sidebar-rail"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const width = currentWidth();
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
          root().setAttribute("data-sidebar-resizing", "");
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (!state || state.pointerId !== event.pointerId) return;
          state.width = clampSidebarWidth(state.startWidth + event.clientX - state.startX, window.innerWidth);
          applyWidth(state.width);
        }}
        onPointerUp={(event) => end(event, true)}
        onPointerCancel={(event) => end(event, false)}
        onDoubleClick={() => {
          storeWidth(null);
          applyWidth(null);
        }}
        className={cn(
          "group/rail absolute inset-y-0 -right-2 z-20 hidden w-4 cursor-col-resize touch-none outline-none md:block",
          "after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150",
          "hover:after:bg-border-strong",
        )}
      />
    </Tooltip>
  );
}
