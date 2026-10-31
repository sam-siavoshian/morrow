"use client";

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SIDEBAR_MOBILE_QUERY, type SidebarOpenState, type SidebarStore } from "./sidebar-store";

export type ShellSlotName = "title" | "actions" | "rightPanel" | "drawer";
export type ShellSlots = Record<ShellSlotName, HTMLElement | null>;

type ShellContextValue = {
  store: SidebarStore;
  slots: ShellSlots;
  palette: { open: boolean; setOpen: (open: boolean) => void };
  shortcuts: { open: boolean; setOpen: (open: boolean) => void };
  /** A page filling the topbar holds it as a row while it is shown; returns the release. */
  claimTopbar: () => () => void;
};

const ShellContext = createContext<ShellContextValue | null>(null);

export function ShellContextProvider({ value, children }: { value: ShellContextValue; children: ReactNode }) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

function useShellContext(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("Shell hooks must be used inside the team layout.");
  return ctx;
}

function subscribeMedia(query: string) {
  return (onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  };
}

const subscribeMobile = subscribeMedia(SIDEBAR_MOBILE_QUERY);

/** Below 768px. False on the server and during hydration. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribeMobile, () => window.matchMedia(SIDEBAR_MOBILE_QUERY).matches, () => false);
}

export function useSidebarState(): SidebarOpenState & { store: SidebarStore } {
  const { store } = useShellContext();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...state, store };
}

/** For pages: whether the sidebar shows, and how to change that. */
export function useShell(): {
  sidebarOpen: boolean;
  isMobile: boolean;
  toggleSidebar: () => void;
  closeMobileSidebar: () => void;
} {
  const { open, openMobile, store } = useSidebarState();
  const isMobile = useIsMobile();
  const closeMobileSidebar = useCallback(() => store.setOpenMobile(false), [store]);
  return { sidebarOpen: isMobile ? openMobile : open, isMobile, toggleSidebar: store.toggle, closeMobileSidebar };
}

export function usePalette() {
  return useShellContext().palette;
}

export function useShortcutsSheet() {
  return useShellContext().shortcuts;
}

function SlotPortal({ name, children }: { name: ShellSlotName; children: ReactNode }) {
  const element = useShellContext().slots[name];
  return element ? createPortal(children, element) : null;
}

/**
 * Fills a topbar slot and keeps the bar a row while this page is on screen. Held with an effect, not
 * read from the DOM: a page left behind stays mounted but hidden (Next keeps it in an Activity), its
 * title still in the slot, and effects are what stop when it hides.
 */
function TopbarPortal({ name, children }: { name: "title" | "actions"; children: ReactNode }) {
  const { claimTopbar } = useShellContext();
  useEffect(() => claimTopbar(), [claimTopbar]);
  return <SlotPortal name={name}>{children}</SlotPortal>;
}

/** The page's title or breadcrumb, on the left of the topbar. One line; it truncates. */
export function ShellTitle({ children }: { children: ReactNode }) {
  return <TopbarPortal name="title">{children}</TopbarPortal>;
}

/** Page buttons on the right of the topbar. */
export function ShellActions({ children }: { children: ReactNode }) {
  return <TopbarPortal name="actions">{children}</TopbarPortal>;
}

/** A full-height column right of the main pane, under the topbar. Size it yourself. */
export function ShellRightPanel({ children }: { children: ReactNode }) {
  return <SlotPortal name="rightPanel">{children}</SlotPortal>;
}

/** A row along the bottom of the main column. Size it yourself. */
export function ShellDrawer({ children }: { children: ReactNode }) {
  return <SlotPortal name="drawer">{children}</SlotPortal>;
}
