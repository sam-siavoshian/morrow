// Per-account caps that bound what one GitHub sign-in can cost us: teams it owns and live environments (VMs) it
// runs across every team. Counted from the actors (no counter to drift) while holding a per-user lock, so two
// requests at once cannot both pass the check. The backend runs as a single instance (architecture section 13),
// which is what makes an in-process lock enough.
import type { ActorGateway } from "../actors/types.ts";
import { conflict, unauthenticated } from "../lib/errors.ts";
import { KeyedMutex } from "../runtime/keyed.ts";

export const USER_LIMITS = { teamsOwned: 5, environments: 3 } as const;

const locks = new KeyedMutex();

type Actors = Pick<ActorGateway, "getUser" | "getTeam">;

async function teamsOf(actors: Actors, userId: string) {
  const user = await actors.getUser(userId);
  if (!user) throw unauthenticated();
  return (await Promise.all(user.teamIds.map((id) => actors.getTeam(id)))).flatMap((team) => (team ? [team] : []));
}

/** Runs `create` only if the user owns fewer than the cap of teams; one team creation per user at a time. */
export function withTeamQuota<T>(actors: Actors, userId: string, create: () => Promise<T>): Promise<T> {
  return locks.run(`team:${userId}`, async () => {
    const owned = (await teamsOf(actors, userId)).filter((team) => team.members.some((m) => m.userId === userId && m.role === "owner")).length;
    if (owned >= USER_LIMITS.teamsOwned) throw conflict(`You can own at most ${USER_LIMITS.teamsOwned} teams.`);
    return create();
  });
}

/** Runs `create` only if the user has fewer than the cap of live environments across all their teams. */
export function withEnvironmentQuota<T>(actors: Actors, userId: string, create: () => Promise<T>): Promise<T> {
  return locks.run(`env:${userId}`, async () => {
    const live = (await teamsOf(actors, userId))
      .flatMap((team) => team.environments)
      .filter((env) => env.ownerUserId === userId && env.phase !== "disconnected").length;
    if (live >= USER_LIMITS.environments)
      throw conflict(`You can run at most ${USER_LIMITS.environments} environments across all your teams. Disconnect one first.`);
    return create();
  });
}
