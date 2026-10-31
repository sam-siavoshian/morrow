"use client";

import type { MeView } from "@morrow/contracts";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { DeleteTaskProvider } from "@/components/sidebar/delete-task";
import { SidebarModelProvider, useSidebarModel } from "@/components/sidebar/sidebar-model";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { AttentionFavicon } from "./attention-favicon";
import { ConnectionBanner } from "./connection-banner";
import { MeProvider } from "./me-context";
import { RouteTitle } from "./route-title";
import { ShellCommands, useNewTask } from "./shell-commands";
import { ShellContextProvider, useIsMobile, usePalette, useShortcutsSheet, useSidebarState, type ShellSlots } from "./shell-context";
import { SidebarRail } from "./sidebar-rail";
import { createSidebarStore } from "./sidebar-store";

type AppShellProps = { me: MeView; teamId: string; defaultOpen: boolean; children: ReactNode };

const NO_SLOTS: ShellSlots = { title: null, actions: null, rightPanel: null, drawer: null };

// Closed on almost every visit: their code stays out of the first load, and the palette is not rebuilt on every
// live update until someone opens it. ShellDialogs warms both chunks once the page is idle.
const AppPalette = dynamic(() => import("@/components/palette/app-palette").then((m) => m.AppPalette), { ssr: false });
const ShortcutsSheet = dynamic(() => import("@/components/palette/shortcuts-sheet").then((m) => m.ShortcutsSheet), { ssr: false });

/** The team app frame: sidebar, topbar, main pane, page slots, and the global chrome. */
export function AppShell({ me, teamId, defaultOpen, children }: AppShellProps) {
  const [store] = useState(() => createSidebarStore(defaultOpen));
  const [slots, setSlots] = useState<ShellSlots>(NO_SLOTS);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Pages on screen that fill the topbar; with none, it floats away and leaves only the sidebar toggle.
  const [topbarClaims, setTopbarClaims] = useState(0);
  const claimTopbar = useCallback(() => {
    setTopbarClaims((count) => count + 1);
    return () => setTopbarClaims((count) => count - 1);
  }, []);
  const slotMounts = useMemo(() => {
    const slot = (name: keyof ShellSlots) => (element: HTMLElement | null) =>
      setSlots((current) => (current[name] === element ? current : { ...current, [name]: element }));
    return { title: slot("title"), actions: slot("actions"), rightPanel: slot("rightPanel"), drawer: slot("drawer") };
  }, []);

  const value = useMemo(
    () => ({
      store,
      slots,
      palette: { open: paletteOpen, setOpen: setPaletteOpen },
      shortcuts: { open: shortcutsOpen, setOpen: setShortcutsOpen },
      claimTopbar,
    }),
    [store, slots, paletteOpen, shortcutsOpen, claimTopbar],
  );

  return (
    <ShellContextProvider value={value}>
      <SidebarModelProvider teamId={teamId}>
        <DeleteTaskProvider teamId={teamId}>
          <Frame me={me} teamId={teamId} slotMounts={slotMounts} topbarFloats={topbarClaims === 0}>
            <MeProvider me={me}>{children}</MeProvider>
          </Frame>
          <ShellCommands teamId={teamId} />
          <RouteTitle />
          <ShellBadge />
          <ShellDialogs me={me} teamId={teamId} />
        </DeleteTaskProvider>
      </SidebarModelProvider>
    </ShellContextProvider>
  );
}

type SlotMounts = Record<keyof ShellSlots, (element: HTMLElement | null) => void>;

type FrameProps = { me: MeView; teamId: string; slotMounts: SlotMounts; topbarFloats: boolean; children: ReactNode };

function Frame({ me, teamId, slotMounts, topbarFloats, children }: FrameProps) {
  const { open, openMobile, store } = useSidebarState();
  const { title: titleSlot, actions: actionsSlot, drawer: drawerSlot, rightPanel: rightPanelSlot } = slotMounts;
  const isMobile = useIsMobile();
  const newTask = useNewTask(teamId);
  // Stable, so the memoized sidebar rows that receive it do not re-render with the shell.
  const closeSheet = useCallback(() => store.setOpenMobile(false), [store]);
  // Transitions only after the first paint, so a collapsed sidebar does not slide shut on load.
  const ready = useSyncExternalStore(noopSubscribe, () => true, () => false);
  // Growing past the phone breakpoint with the sheet open would leave it stranded.
  useEffect(() => {
    if (!isMobile) store.setOpenMobile(false);
  }, [isMobile, store]);

  const sidebar = <AppSidebar me={me} teamId={teamId} onNewTask={newTask} onNavigate={isMobile ? closeSheet : noop} />;

  return (
    <div
      data-slot="shell"
      data-state={open ? "expanded" : "collapsed"}
      className="group/shell flex h-dvh w-full overflow-hidden bg-canvas [:root[data-sidebar-resizing]_&]:cursor-col-resize [:root[data-sidebar-resizing]_&]:select-none"
    >
      {/* t3code offcanvas: a gap holds the sidebar's room in the row while the fixed panel slides. */}
      <div aria-hidden className={cn("hidden shrink-0 md:block", ready && "transition-[width] duration-200 ease-drawer", "w-(--sidebar-width) group-data-[state=collapsed]/shell:w-0", "[:root[data-sidebar-resizing]_&]:transition-none")} />
      <aside
        data-slot="sidebar"
        aria-label="Sidebar"
        inert={!open}
        className={cn(
          "fixed inset-y-0 left-0 z-20 hidden h-dvh w-(--sidebar-width) border-r border-border bg-canvas md:flex",
          ready && "transition-[translate] duration-200 ease-drawer",
          "group-data-[state=collapsed]/shell:-translate-x-full [:root[data-sidebar-resizing]_&]:transition-none",
        )}
      >
        {isMobile ? null : sidebar}
        <SidebarRail />
      </aside>
      <Sheet open={isMobile && openMobile} onOpenChange={(next) => store.setOpenMobile(next)} title="Sidebar" className="bg-canvas">
        {isMobile ? sidebar : null}
      </Sheet>

      <div data-slot="main-column" data-topbar-floats={topbarFloats ? "" : undefined} className="relative flex min-w-0 flex-1 flex-col bg-ground">
        {/* Takes a row only when the page on screen fills the title or actions; otherwise just the toggle floats (globals.css). */}
        <header data-slot="topbar" className="flex h-13 shrink-0 items-center gap-1.5 border-b border-border px-2.5 sm:px-3">
          <SidebarToggle open={isMobile ? openMobile : open} onToggle={store.toggle} />
          <div ref={titleSlot} data-topbar-slot="" className="flex min-w-0 flex-1 items-center gap-2 truncate text-[13.5px] font-[550] text-text" />
          <div ref={actionsSlot} data-topbar-slot="" className="flex shrink-0 items-center gap-1 empty:hidden" />
        </header>
        <div data-slot="topbar-banner">
          <ConnectionBanner />
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <MainPane>{children}</MainPane>
            <div ref={drawerSlot} className="shrink-0 empty:hidden" />
          </div>
          <div ref={rightPanelSlot} className="flex min-h-0 shrink-0 empty:hidden" />
        </div>
      </div>
    </div>
  );
}

const noop = () => {};
const noopSubscribe = () => noop;

function SidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <IconButton
      label={open ? "Hide sidebar" : "Show sidebar"}
      shortcut="mod+b"
      size="sm"
      tooltipSide="bottom"
      data-sidebar-trigger=""
      aria-expanded={open}
      onClick={onToggle}
      className="shrink-0 text-muted hover:text-text pointer-coarse:size-11"
    >
      {open ? <PanelLeftClose /> : <PanelLeft />}
    </IconButton>
  );
}

/** The page's scroller. A hairline fades in under the topbar once content passes beneath it. */
function MainPane({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const pathname = usePathname();
  // Keyed by path: a new page starts unscrolled without a reset render.
  const [scrolledOn, setScrolledOn] = useState<string | null>(null);
  const scrolled = scrolledOn === pathname;
  // A new page starts at its top; the pane outlives navigations, so it would keep the old offset.
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [pathname]);
  return (
    <main
      ref={ref}
      id="main"
      tabIndex={-1}
      onScroll={(event) => setScrolledOn(event.currentTarget.scrollTop > 0 ? pathname : null)}
      className={cn(
        "relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none",
        "before:pointer-events-none before:sticky before:top-0 before:z-10 before:-mb-3 before:block before:h-3 before:bg-linear-to-b before:from-ground before:to-transparent before:opacity-0 before:transition-opacity before:duration-150",
        scrolled && "before:opacity-100",
      )}
    >
      {children}
    </main>
  );
}

function ShellBadge() {
  return <AttentionFavicon count={useSidebarModel().needsYouCount} />;
}

function ShellDialogs({ me, teamId }: { me: MeView; teamId: string }) {
  const { store } = useSidebarState();
  const newTask = useNewTask(teamId);
  const palette = usePalette();
  const shortcuts = useShortcutsSheet();
  const paletteMounted = useOpenedOnce(palette.open);
  const shortcutsMounted = useOpenedOnce(shortcuts.open);

  // Fetch both chunks once the page is idle, so the first mod+k or mod+/ still opens at once.
  useEffect(() => {
    const warm = () => {
      import("@/components/palette/app-palette").catch(noop);
      import("@/components/palette/shortcuts-sheet").catch(noop);
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 4000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 1500);
    return () => clearTimeout(id);
  }, []);

  return (
    <>
      {paletteMounted ? (
        <AppPalette
          me={me}
          teamId={teamId}
          open={palette.open}
          onOpenChange={palette.setOpen}
          onNewTask={newTask}
          onToggleSidebar={store.toggle}
          onShowShortcuts={() => shortcuts.setOpen(true)}
        />
      ) : null}
      {shortcutsMounted ? <ShortcutsSheet open={shortcuts.open} onOpenChange={shortcuts.setOpen} /> : null}
    </>
  );
}

/** True from the first time `open` is true. Stays mounted after that, so closing still animates. */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
