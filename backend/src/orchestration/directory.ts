// The TeamDirectory actor (actors/src/lib/directory.ts): one durable list of teams that may have unfinished work.
// It is how a restarted backend finds TeamWorkforce actors to resume. The control plane's actor inventory is only a
// hint (a per-process, in-memory list that a Terse restart empties), so it is read too but never trusted alone.
//
// A team is active from `noteWork` (a task was created or retried) until `noteIdle` with the generation this process
// last saw. Work noted in between (by any backend replica) bumps the generation, so a stale idle report cannot hide it.

import { createTerseTransport, generated, type ActorRpcTransport } from "../actors/client.ts";
import { invoke } from "../actors/invoke.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../lib/logger.ts";

export const DIRECTORY_ID = "teams";
export const DIRECTORY_PAGE = 500;
/** 200 pages of 500: far past any real team count, and a hard stop if the actor ever answered with a cursor loop. */
const MAX_PAGES = 200;

export interface TeamDirectoryApi {
  noteTeam(teamId: string): Promise<{ ok: true; created: boolean }>;
  noteWork(teamId: string): Promise<{ ok: true; gen: number }>;
  noteIdle(teamId: string, gen: number): Promise<{ ok: true; cleared: boolean }>;
  listActive(after: string | null, limit: number): Promise<{ teams: { teamId: string; gen: number }[]; next: string | null }>;
}

/** Every active team with the generation it was listed at. */
export async function listActiveTeams(directory: Pick<TeamDirectoryApi, "listActive">): Promise<Map<string, number>> {
  const teams = new Map<string, number>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await directory.listActive(after, DIRECTORY_PAGE);
    for (const { teamId, gen } of result.teams) teams.set(teamId, gen);
    if (!result.next || result.next === after) return teams;
    after = result.next;
  }
  throw new Error(`team directory: more than ${MAX_PAGES} pages`);
}

/** Every directory method is safe to retry: a replayed noteWork only bumps the generation again, the rest are idempotent. */
const RETRYABLE: Record<keyof TeamDirectoryApi, boolean> = { noteTeam: true, noteWork: true, noteIdle: true, listActive: true };

export function createTeamDirectoryClient(config: Env["terse"], log: Logger, transport?: ActorRpcTransport): TeamDirectoryApi {
  const t = transport ?? createTerseTransport(config);
  const call = <K extends keyof TeamDirectoryApi>(name: K) =>
    ((...args: unknown[]) =>
      invoke(
        () => {
          const stub = generated.actors.TeamDirectory.get(DIRECTORY_ID, t) as unknown as Record<K, (...a: unknown[]) => Promise<unknown>>;
          return stub[name](...args);
        },
        { op: `TeamDirectory.${name}`, idempotent: RETRYABLE[name] },
        { log },
      )) as TeamDirectoryApi[K];
  return { noteTeam: call("noteTeam"), noteWork: call("noteWork"), noteIdle: call("noteIdle"), listActive: call("listActive") };
}
