// What orchestration remembers between ticks, per team, in this process only. Nothing here is the source of
// truth (the TeamWorkforce actor is): losing it on restart costs a little latency or handoff context, never
// correctness. Every collection is bounded.
import type { RelayMessageView } from "@morrow/contracts";
import { ExitLedger, initialReconcileMemo, type AgentExitedInfo, type ReconcileMemo } from "../integrations/relay/index.ts";
import type { NudgeState } from "./activity.ts";
import type { Signal } from "./classifier.ts";
import type { WorkforceSnapshot } from "./workforce.ts";

const SAID_PER_AGENT = 12;
const SAID_CHARS = 1_500;
const SAID_AGENTS = 100;
const CONTROL_QUEUE = 200;
const TALK_KEPT = 300;
const TALK_CHARS = 1_500;
const CONTRACT_BODIES = 200;
const THREAD_STARTS = 500;
const POSTERS = 500;
const SEEDED_TASKS = 500;
const TESTS_SEEN = 20;

/** A message between people and workers that @mentions someone: what a replacement needs to pick up a conversation. */
export interface Talk {
  id: string;
  from: string;
  /** Who it @mentions (`w-` and `h-` names), never the sender. */
  to: string[];
  text: string;
  at: number;
  threadId: string | null;
}

/** Per running lease: reconcile streaks and the last thing its log said. */
export interface LeaseWatch {
  memo: ReconcileMemo;
  unknownReads: number;
  lastLogAt: number;
  lastSignal: Signal | null;
  /** The log line of the last usage reading reported, so one printed reading is reported once. */
  lastUsageLine: string | null;
  restartRequested: boolean;
  /** Nudges sent to this worker for going quiet (activity.ts). */
  nudge: NudgeState | null;
  /** Test summaries from its log already posted to the thread (newest last, bounded). */
  testsSeen: string[];
  /** Peer questions (Relay ids) it was reminded to answer, at most ANSWER_NUDGES_PER_LEASE. */
  answered: string[];
}

/** An `ACK <leaseId>` or `DONE <leaseId>` message waiting to be applied. */
export interface ControlMessage {
  verb: "ACK" | "DONE";
  leaseId: string;
  /** Text after the lease id (DONE summary). */
  rest: string;
  message: RelayMessageView;
  attempts: number;
}

export class TeamMemory {
  readonly exits = new ExitLedger(500);
  /** Recent messages per worker, for the "decisions" section of a handoff note. */
  readonly #said = new Map<string, string[]>();
  readonly nodeOfflineSince = new Map<string, number>();
  readonly watches = new Map<string, LeaseWatch>();
  /** Agent names whose DONE is being applied; their exit is deferred until it settles. */
  readonly finishing = new Set<string>();
  readonly deferredExits = new Map<string, AgentExitedInfo>();
  readonly controls: ControlMessage[] = [];
  /** Earliest next verification attempt per task, after a transient failure. */
  readonly verifyAfter = new Map<string, number>();
  readonly verifyAttempts = new Map<string, number>();
  /** Workers that missed a rate-limited update; their next update says so. */
  readonly skippedUpdates = new Set<string>();
  /** `<taskId>/<workstreamId>` pairs auto-scheduling gave up on (logged once). */
  readonly gaveUp = new Set<string>();
  /**
   * `<taskId>/<workstreamId>` -> what the last "waiting for a pinned profile" note was about, so a wait is sent to
   * the actor once, not on every pass. The actor dedupes too; this only saves the calls.
   */
  readonly waitNoted = new Map<string, string>();
  /** Recent messages that mention someone, oldest first (handoff notes: what peers asked a stopped worker). */
  readonly #talk: Talk[] = [];
  /** Full text of published contracts by Relay message id, so a brief does not read Relay for each spawn. */
  readonly contractBodies = new Map<string, string>();
  /** Task thread starts by task id, so spawns racing in this process post one kickoff (peers.ts). Failures are dropped. */
  readonly threadStarts = new Map<string, Promise<string | null>>();
  /** When each worker or person last posted in a channel or thread (not a DM), by Relay name: who went quiet. */
  readonly #posted = new Map<string, number>();
  /** Tasks whose thread this process has read once to learn who posted when (after a restart). */
  readonly seededTasks = new Set<string>();
  /** Until when the team stays tracked without live work (outbox cleanup after a task ends). */
  trackUntil = 0;
  view: WorkforceSnapshot | null = null;
  /** Dispatch polls fast until this time (recent activity), slow after. */
  hotUntil = 0;
  lastClaimAt = 0;
  /** With a pushed feed (feed.ts): the view revision the last scheduling and notify passes started from. */
  decidedRevision = -1;
  notifiedRevision = -1;
  /** When the last notify pass finished cleanly; a failed pass leaves it, so the next tick retries. */
  notifiedAt = 0;
  /** When the actor last swept its deadlines on our ask (`reconcile`); its own alarm does this too. */
  sweptAt = 0;

  remember(agentName: string, text: string): void {
    const list = this.#said.get(agentName) ?? [];
    list.push(text.length > SAID_CHARS ? `${text.slice(0, SAID_CHARS - 1)}…` : text);
    if (list.length > SAID_PER_AGENT) list.shift();
    this.#said.delete(agentName);
    this.#said.set(agentName, list);
    while (this.#said.size > SAID_AGENTS) this.#said.delete(this.#said.keys().next().value!);
  }

  said(agentName: string): readonly string[] {
    return this.#said.get(agentName) ?? [];
  }

  /** Keeps a message that mentions someone. A repeat (a replayed event) is ignored. */
  noteTalk(talk: Talk): void {
    if (talk.to.length === 0 || this.#talk.some((t) => t.id === talk.id)) return;
    this.#talk.push({ ...talk, text: talk.text.length > TALK_CHARS ? `${talk.text.slice(0, TALK_CHARS - 1)}…` : talk.text });
    if (this.#talk.length > TALK_KEPT) this.#talk.shift();
  }

  talk(): readonly Talk[] {
    return this.#talk;
  }

  /** Records a post in a channel or thread. Keeps the newest time, so an older message read back never moves it back. */
  notePost(name: string, at: number): void {
    const known = this.#posted.get(name);
    if (known !== undefined && known >= at) return;
    this.#posted.delete(name);
    this.#posted.set(name, at);
    while (this.#posted.size > POSTERS) this.#posted.delete(this.#posted.keys().next().value!);
  }

  lastPost(name: string): number | undefined {
    return this.#posted.get(name);
  }

  /** Marks a task's thread as read for posts. Returns false when it already was. */
  seedTask(taskId: string): boolean {
    if (this.seededTasks.has(taskId)) return false;
    this.seededTasks.add(taskId);
    while (this.seededTasks.size > SEEDED_TASKS) this.seededTasks.delete(this.seededTasks.keys().next().value!);
    return true;
  }

  /** Remembers a test summary posted for a lease. Returns false when it was already posted. */
  noteTests(watch: LeaseWatch, id: string): boolean {
    if (watch.testsSeen.includes(id)) return false;
    watch.testsSeen.push(id);
    if (watch.testsSeen.length > TESTS_SEEN) watch.testsSeen.shift();
    return true;
  }

  /** Keeps a task thread start, oldest dropped past the bound. */
  rememberThreadStart(taskId: string, start: Promise<string | null>): void {
    this.threadStarts.set(taskId, start);
    while (this.threadStarts.size > THREAD_STARTS) this.threadStarts.delete(this.threadStarts.keys().next().value!);
  }

  rememberContract(messageId: string, body: string): void {
    this.contractBodies.delete(messageId);
    this.contractBodies.set(messageId, body);
    while (this.contractBodies.size > CONTRACT_BODIES) this.contractBodies.delete(this.contractBodies.keys().next().value!);
  }

  watch(leaseId: string): LeaseWatch {
    let watch = this.watches.get(leaseId);
    if (!watch) {
      watch = { memo: initialReconcileMemo(), unknownReads: 0, lastLogAt: 0, lastSignal: null, lastUsageLine: null, restartRequested: false, nudge: null, testsSeen: [], answered: [] };
      this.watches.set(leaseId, watch);
    }
    return watch;
  }

  /** Returns false when the queue is full (the message is dropped and logged by the caller). */
  enqueueControl(control: ControlMessage): boolean {
    if (this.controls.some((c) => c.message.id === control.message.id)) return true;
    if (this.controls.length >= CONTROL_QUEUE) return false;
    this.controls.push(control);
    return true;
  }
}

export class Memory {
  readonly #teams = new Map<string, TeamMemory>();

  team(teamId: string): TeamMemory {
    let team = this.#teams.get(teamId);
    if (!team) {
      team = new TeamMemory();
      this.#teams.set(teamId, team);
    }
    return team;
  }

  /** Drops an idle team (it is rebuilt on its next activity). */
  forget(teamId: string): void {
    this.#teams.delete(teamId);
  }
}
