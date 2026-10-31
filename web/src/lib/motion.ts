/** Zephium easings, mirrored from globals.css for JS-driven motion (WAAPI, rAF). */
export const ease = {
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  emphasized: "cubic-bezier(0.16, 1, 0.3, 1)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  smooth: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  press: "cubic-bezier(0.2, 0, 0, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  drawer: "cubic-bezier(0.32, 0.72, 0, 1)",
} as const;

/** Zephium durations in ms. Leaving is always quicker than arriving. */
export const duration = {
  instant: 70,
  fast: 120,
  base: 200,
  slow: 300,
  page: 400,
} as const;

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** Frame-rate independent follow: the share of the gap to close this frame. */
export const follow = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

export type MotionPreference = "system" | "reduce";

export const MOTION_STORAGE_KEY = "morrow:motion";

/**
 * `data-motion="reduce"` on <html> is the one switch every animation reads.
 * ThemeScript sets it before paint from the OS setting or the in-app choice,
 * and keeps it in sync when the OS setting changes.
 */
export function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.motion === "reduce";
}

/** Stores the in-app motion choice and applies it at once. The OS setting still wins when it asks for less. */
export function setMotionPreference(preference: MotionPreference) {
  try {
    if (preference === "system") localStorage.removeItem(MOTION_STORAGE_KEY);
    else localStorage.setItem(MOTION_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); the choice then lasts for this page only.
  }
  const osReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reduce = osReduce || preference === "reduce";
  document.documentElement.dataset.motion = reduce ? "reduce" : "full";
}

export function readMotionPreference(): MotionPreference {
  try {
    return localStorage.getItem(MOTION_STORAGE_KEY) === "reduce" ? "reduce" : "system";
  } catch {
    return "system";
  }
}

type Watcher = (visible: boolean) => void;

const watchers = new Map<Element, Watcher>();
let sight: IntersectionObserver | undefined;
const onScreen = new WeakMap<Element, boolean>();

function notifyAll() {
  for (const [element, watcher] of watchers) watcher(Boolean(onScreen.get(element)) && !document.hidden);
}

/**
 * Calls back with whether `element` is on screen and the tab is visible.
 * One shared IntersectionObserver serves every looping indicator on the page.
 */
export function watchVisibility(element: Element, watcher: Watcher) {
  if (!sight) {
    sight = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        onScreen.set(entry.target, entry.isIntersecting);
        watchers.get(entry.target)?.(entry.isIntersecting && !document.hidden);
      }
    });
    document.addEventListener("visibilitychange", notifyAll);
  }
  watchers.set(element, watcher);
  sight.observe(element);
  return () => {
    watchers.delete(element);
    sight?.unobserve(element);
  };
}
