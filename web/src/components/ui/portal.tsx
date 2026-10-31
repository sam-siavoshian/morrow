"use client";

import { createContext, useContext } from "react";

const PortalContainerContext = createContext<HTMLElement | null>(null);

export const PortalContainerProvider = PortalContainerContext.Provider;

/**
 * Where popups portal to. Inside a ThemeScope it is the scope's element, so a
 * menu opened in a night panel on a day page is drawn with night tokens.
 */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
