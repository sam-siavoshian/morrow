import type { Logger } from "../lib/logger.ts";

export interface TeamCreatedEvent {
  teamId: string;
  ownerUserId: string;
}

export interface MemberRemovedEvent {
  teamId: string;
  userId: string;
  removedBy: string;
}

type Handler<E> = (event: E) => void | Promise<void>;

/**
 * Seam for modules that react to team lifecycle (Relay workspace setup on create, observer token
 * rotation on removal). Handlers run after the core change has committed; a failing handler is logged
 * and never undoes or fails the request.
 */
export class TeamEvents {
  readonly #created: Handler<TeamCreatedEvent>[] = [];
  readonly #removed: Handler<MemberRemovedEvent>[] = [];
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  onTeamCreated(handler: Handler<TeamCreatedEvent>): void {
    this.#created.push(handler);
  }

  onMemberRemoved(handler: Handler<MemberRemovedEvent>): void {
    this.#removed.push(handler);
  }

  emitTeamCreated(event: TeamCreatedEvent): Promise<void> {
    return this.#run("team.created", this.#created, event, event.teamId);
  }

  emitMemberRemoved(event: MemberRemovedEvent): Promise<void> {
    return this.#run("member.removed", this.#removed, event, event.teamId);
  }

  async #run<E>(name: string, handlers: Handler<E>[], event: E, teamId: string): Promise<void> {
    await Promise.all(
      handlers.map((h) =>
        Promise.resolve()
          .then(() => h(event))
          .catch((error) => this.#log.error("team event handler failed", { event: name, teamId, error })),
      ),
    );
  }
}
