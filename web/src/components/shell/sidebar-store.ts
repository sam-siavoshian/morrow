// t3code's sidebar open state: kept outside React so a shortcut can toggle it at event time, and
// saved to a cookie so the server renders the sidebar the way the user left it.

export const SIDEBAR_COOKIE = "sidebar_state";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7;

/** Below this the sidebar is a sheet (Tailwind `max-md`). Read at event time too. */
export const SIDEBAR_MOBILE_QUERY = "(max-width: 767px)";

export type SidebarOpenState = { readonly open: boolean; readonly openMobile: boolean };

export type SidebarStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => SidebarOpenState;
  setOpen: (open: boolean) => void;
  setOpenMobile: (open: boolean) => void;
  /** Flips the sheet on phones and the offcanvas sidebar elsewhere. */
  toggle: () => void;
  /** Runs just before the desktop sidebar collapses (a live resize drag cancels itself). */
  onCollapse: (listener: () => void) => () => void;
};

/** The cookie value the server reads: anything but "false" means open. */
export const parseSidebarCookie = (value: string | undefined): boolean => value !== "false";

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(SIDEBAR_MOBILE_QUERY).matches;
}

function persistOpen(open: boolean): void {
  if (typeof document === "undefined") return;
  document.cookie = `${SIDEBAR_COOKIE}=${open}; path=/; max-age=${COOKIE_MAX_AGE_S}; samesite=lax`;
}

/** A collapsed offcanvas sidebar turns inert, which would drop focus to <body>: hand it to the toggle. */
function moveFocusOutOfCollapsingSidebar(): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.closest('[data-slot="sidebar"]')) return;
  document.querySelector<HTMLElement>('[data-sidebar-trigger=""]')?.focus({ preventScroll: true });
}

export function createSidebarStore(defaultOpen: boolean, isMobile: () => boolean = isMobileViewport): SidebarStore {
  let state: SidebarOpenState = { open: defaultOpen, openMobile: false };
  const listeners = new Set<() => void>();
  const collapseListeners = new Set<() => void>();
  const publish = (next: SidebarOpenState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const setOpen = (open: boolean) => {
    if (open === state.open) return;
    if (!open) {
      for (const listener of collapseListeners) listener();
      if (typeof document !== "undefined") moveFocusOutOfCollapsingSidebar();
    }
    publish({ ...state, open });
    persistOpen(open);
  };
  const setOpenMobile = (openMobile: boolean) => {
    if (openMobile !== state.openMobile) publish({ ...state, openMobile });
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => state,
    setOpen,
    setOpenMobile,
    toggle: () => (isMobile() ? setOpenMobile(!state.openMobile) : setOpen(!state.open)),
    onCollapse: (listener) => {
      collapseListeners.add(listener);
      return () => void collapseListeners.delete(listener);
    },
  };
}
