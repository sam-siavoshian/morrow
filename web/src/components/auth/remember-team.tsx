"use client";

import { Id } from "@morrow/contracts";
import { useEffect } from "react";
import { LAST_TEAM_COOKIE } from "./return-to";

const ONE_YEAR_S = 60 * 60 * 24 * 365;

/** Remembers this team as the one `/` should open next time. Renders nothing. */
export function RememberTeam({ teamId }: { teamId: string }) {
  useEffect(() => {
    if (!Id.safeParse(teamId).success) return;
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${LAST_TEAM_COOKIE}=${encodeURIComponent(teamId)}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Lax${secure}`;
  }, [teamId]);
  return null;
}
