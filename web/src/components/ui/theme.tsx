"use client";

import { useState, useSyncExternalStore, type ComponentProps, type RefObject } from "react";
import {
  isScene,
  SCENE_STORAGE_KEY,
  type Scene,
  type ScenePreference,
} from "@/components/sky/scenes";
import { cn } from "@/lib/cn";
import { prefersReducedMotion } from "@/lib/motion";
import { PortalContainerProvider } from "./portal";

function subscribeRoot(onChange: () => void) {
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-theme-pref"],
  });
  return () => watch.disconnect();
}

const rootScene = (): Scene => {
  const value = document.documentElement.dataset.theme;
  return isScene(value) ? value : "day";
};

const rootPreference = (): ScenePreference => {
  const value = document.documentElement.dataset.themePref;
  return isScene(value) ? value : "system";
};

/** The page's scene, as ThemeScript resolved it onto <html>. */
export function useScene(): Scene {
  return useSyncExternalStore(subscribeRoot, rootScene, () => "day");
}

export function useScenePreference(): ScenePreference {
  return useSyncExternalStore(subscribeRoot, rootPreference, () => "system");
}

/** Saves the choice and repaints at once, with transitions held for a frame so nothing smears. */
export function setScenePreference(preference: ScenePreference) {
  try {
    if (preference === "system") localStorage.removeItem(SCENE_STORAGE_KEY);
    else localStorage.setItem(SCENE_STORAGE_KEY, preference);
  } catch {
    // Storage unavailable: the choice lasts for this page.
  }
  const root = document.documentElement;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.classList.add("no-transitions");
  root.dataset.theme = preference === "system" ? (dark ? "night" : "day") : preference;
  root.dataset.themePref = preference;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-transitions")));
}

/**
 * The scene an element sits in: its nearest `[data-theme]` ancestor, followed
 * live. Used by the sky so it matches a ThemeScope, not only the page.
 */
export function useSceneOf(ref: RefObject<Element | null>, override?: Scene): Scene {
  const scene = useSyncExternalStore(
    subscribeAnyScene,
    () => {
      const value = ref.current?.closest("[data-theme]")?.getAttribute("data-theme");
      return isScene(value) ? value : rootScene();
    },
    () => "day" as Scene,
  );
  return override ?? scene;
}

function subscribeAnyScene(onChange: () => void) {
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"], subtree: true });
  return () => watch.disconnect();
}

function subscribeMotion(onChange: () => void) {
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  return () => watch.disconnect();
}

/** Whether motion is reduced (OS setting or in-app choice), followed live. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, prefersReducedMotion, () => false);
}

type ThemeScopeProps = ComponentProps<"div"> & { scene: Scene };

/** Renders its children in another scene; popups opened inside stay in it. */
export function ThemeScope({ scene, className, children, ...props }: ThemeScopeProps) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  return (
    <div
      {...props}
      ref={setElement}
      data-theme={scene}
      className={cn("bg-ground text-text", className)}
    >
      <PortalContainerProvider value={element}>{children}</PortalContainerProvider>
    </div>
  );
}
