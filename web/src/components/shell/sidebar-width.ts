// t3code threadSidebarWidth: 256px by default, never under 208px, and never so wide that the main
// pane drops under 640px. The width lives in localStorage; a double-click on the rail clears it.

export const SIDEBAR_WIDTH_STORAGE_KEY = "morrow:sidebar-width";
export const SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const SIDEBAR_MIN_WIDTH = 13 * 16;
export const MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function sidebarMaxWidth(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.floor(viewportWidth) - MAIN_CONTENT_MIN_WIDTH);
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  return Math.min(sidebarMaxWidth(viewportWidth), Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/** A stored value, or null when it is missing or not a sane number. */
export function parseStoredWidth(raw: string | null): number | null {
  if (raw === null || !/^\d{2,5}(\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function initialSidebarWidth(stored: number | null, viewportWidth: number): number {
  return clampSidebarWidth(stored ?? SIDEBAR_DEFAULT_WIDTH, viewportWidth);
}

/**
 * Runs before first paint (inline in the team layout): applies the saved width to <html> so the
 * server-rendered shell opens at the right size. Same rules as above, kept in sync by a test.
 */
export const SIDEBAR_WIDTH_SCRIPT = `(function(){try{var r=localStorage.getItem(${JSON.stringify(SIDEBAR_WIDTH_STORAGE_KEY)});if(!r||!/^\\d{2,5}(\\.\\d+)?$/.test(r))return;var w=Math.round(Number(r)),max=Math.max(${SIDEBAR_MIN_WIDTH},Math.floor(innerWidth)-${MAIN_CONTENT_MIN_WIDTH});w=Math.min(max,Math.max(${SIDEBAR_MIN_WIDTH},w));document.documentElement.style.setProperty("--sidebar-width",w+"px")}catch(e){}})()`;
