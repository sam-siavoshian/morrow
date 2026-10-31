"use client";

import { useEffect } from "react";
import { getTeam } from "@/lib/api";
import { useTeamId, useTeamStore } from "@/lib/store";

/**
 * Fills the team store from REST if the socket has not delivered `team.view` yet, so setup never
 * waits on the realtime connection to show the team. The socket's frames still win afterwards.
 */
export function TeamSeed() {
  const teamId = useTeamId();
  const loaded = useTeamStore((s) => s.team !== null);
  const applyFrame = useTeamStore((s) => s.applyFrame);

  useEffect(() => {
    if (loaded) return;
    const abort = new AbortController();
    getTeam(teamId, { signal: abort.signal })
      .then((team) => applyFrame({ kind: "team.view", teamId, data: team }))
      .catch(() => {
        // The socket, or the "Still connecting" guard, takes it from here.
      });
    return () => abort.abort();
  }, [teamId, loaded, applyFrame]);

  return null;
}
