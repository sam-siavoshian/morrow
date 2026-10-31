"use client";

import type { MeView } from "@morrow/contracts";
import { createContext, useContext, type ReactNode } from "react";

const MeContext = createContext<MeView | null>(null);

/**
 * The signed-in member, read once by the team layout after its membership check. Pages read it from here instead of
 * asking the backend again on every navigation; every data path still checks membership on the server.
 */
export function MeProvider({ me, children }: { me: MeView; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): MeView {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe must be used inside the team shell");
  return me;
}
