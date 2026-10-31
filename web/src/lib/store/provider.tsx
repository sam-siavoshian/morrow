"use client";

import type { EnvStatusView, RelayEventView, TaskView, TeamView, WorkforceView } from "@morrow/contracts";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { carryToast } from "@/components/ui/carried-toast";
import { toast } from "@/components/ui/toast";
import { loginPath } from "../api";
import type { ConnectionStatus, RealtimeFatal } from "../realtime";
import { DEFAULT_CHANNEL, filterRelayEvents, type RelayFilter } from "./relay";
import { selectAskedTaskIds, selectInbox, selectTaskWorkers, viewerRelayName, type Inbox, type TaskWorker } from "./selectors";
import { getTeamStore, requestTeamHistory, requestTeamThread, retainTeamConnection, retryTeamConnection } from "./session";
import { githubKey, optimisticTeamField, type RelayMarks, type TeamField, type TeamState, type TeamStore } from "./team-store";

type TeamContextValue = { teamId: string; store: TeamStore };

const TeamContext = createContext<TeamContextValue | null>(null);

type TeamProviderProps = {
  teamId: string;
  /** Server-loaded team, shown until the socket's first `team.view`. */
  initialTeam?: TeamView | null;
  /** Replaces the default handling (sign in again, or leave a team you lost access to). */
  onFatal?: (fatal: RealtimeFatal) => void;
  children: ReactNode;
};

/** Owns the team's live connection for everything below it. Mount once per team route. */
export function TeamProvider({ teamId, initialTeam = null, onFatal, children }: TeamProviderProps) {
  const store = getTeamStore(teamId, initialTeam);
  const pathname = usePathname();
  const fatalRef = useRef<(fatal: RealtimeFatal) => void>(() => {});

  useEffect(() => {
    fatalRef.current = (fatal) => {
      if (onFatal) return onFatal(fatal);
      // Full loads, not router moves: the browser keeps team pages (with this account's teams) for a few minutes, and
      // losing the session or the team has to drop every one of them along with the stores and sockets.
      if (fatal.reason === "unauthenticated") return window.location.replace(loginPath(pathname));
      if (fatal.reason === "not_member") {
        carryToast("error", fatal.message);
        return window.location.replace("/");
      }
      toast.error(fatal.message, { id: `realtime-fatal-${teamId}` });
    };
  }, [onFatal, pathname, teamId]);

  useEffect(() => retainTeamConnection(teamId, (fatal) => fatalRef.current(fatal)), [teamId]);

  const value = useMemo(() => ({ teamId, store }), [teamId, store]);
  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>;
}

function useTeamContext(): TeamContextValue {
  const ctx = useContext(TeamContext);
  if (!ctx) throw new Error("Team hooks must be used inside <TeamProvider>.");
  return ctx;
}

/** Escape hatch: any slice of the team state. The selector must return a stable value. */
export function useTeamStore<T>(selector: (state: TeamState) => T): T {
  return useStore(useTeamContext().store, selector);
}

export const useTeamId = (): string => useTeamContext().teamId;
/** The team's store itself, for optimistic writes that read and write it outside render. */
export const useTeamStoreApi = (): TeamStore => useTeamContext().store;

/** Optimistic team edits (settings): see `optimisticTeamField`. */
export function useOptimisticTeam(): <T>(field: TeamField<T>, next: T, commit: () => Promise<TeamView>) => Promise<TeamView> {
  const { store } = useTeamContext();
  return useCallback((field, next, commit) => optimisticTeamField(store, field, next, commit), [store]);
}
export const useTeam = (): TeamView | null => useTeamStore((s) => s.team);
export const useWorkforce = (): WorkforceView | null => useTeamStore((s) => s.workforce);
export const useTask = (taskId: string): TaskView | null => useTeamStore((s) => s.workforce?.tasks[taskId] ?? null);
export const useConnection = (): ConnectionStatus => useTeamStore((s) => s.connection);
/** Moves when GitHub sync reports a change to the project's pull request list (no `number`) or to one pull request. */
export const useGithubVersion = (projectId: string | null, number?: number | null): number =>
  useTeamStore((s) => (projectId && number !== null ? (s.github[githubKey(projectId, number ?? undefined)] ?? 0) : 0));

/** Reconnect the team's socket now. Returns false when there is no live connection to retry. */
export function useRetryConnection(): () => boolean {
  const { teamId } = useTeamContext();
  return useCallback(() => retryTeamConnection(teamId), [teamId]);
}

/** Live VM/node status for one environment, falling back to the last `team.view`. */
export function useEnvStatus(envId: string): Pick<EnvStatusView, "vmState" | "nodeOnline"> | null {
  const live = useTeamStore((s) => s.envStatus[envId]);
  const env = useTeamStore((s) => s.team?.environments.find((e) => e.id === envId));
  return useMemo(() => (live ?? (env ? { vmState: env.vmState, nodeOnline: env.nodeOnline } : null)), [live, env]);
}

/** Relay events, oldest first. Filter by task, channel, agent or event type. */
export function useRelayEvents(filter: RelayFilter = {}): RelayEventView[] {
  const events = useTeamStore((s) => s.relayEvents);
  const workforce = useTeamStore((s) => (filter.taskId ? s.workforce : null));
  const { taskId, channel, agentName, types } = filter;
  const typesKey = types?.join(",");
  return useMemo(
    () => filterRelayEvents(events, { taskId, channel, agentName, types: typesKey ? (typesKey.split(",") as RelayFilter["types"]) : undefined }, workforce),
    [events, workforce, taskId, channel, agentName, typesKey],
  );
}

/** Sidebar groups: needs-you, running, recovering, done. `asked`: tasks whose workers asked the viewer (useAskedTaskIds). */
export function useInbox(projectId?: string | null, asked?: ReadonlySet<string>): Inbox {
  const workforce = useWorkforce();
  return useMemo(() => selectInbox(workforce, { projectId, asked }), [workforce, projectId, asked]);
}

/** Tasks where a worker asked the viewer something still open. `seenAt`: when the viewer last opened each task. */
export function useAskedTaskIds(seenAt: Readonly<Record<string, number>>): ReadonlySet<string> {
  const events = useTeamStore((s) => s.relayEvents);
  const workforce = useWorkforce();
  const viewer = useTeamStore((s) => viewerRelayName(s.team, s.viewerId));
  const next = useMemo(() => selectAskedTaskIds(events, workforce, viewer, seenAt), [events, workforce, viewer, seenAt]);
  // Same members, same Set: the whole inbox depends on it.
  return useShared(next, sameSet);
}

/** Every lease the task has had, joined to profile and workstream. Stable while none of them changed. */
export function useTaskWorkers(taskId: string): TaskWorker[] {
  const workforce = useWorkforce();
  const next = useMemo(() => selectTaskWorkers(workforce, taskId), [workforce, taskId]);
  return useShared(next, sameWorkers);
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((v) => b.has(v));
const sameWorkers = (a: TaskWorker[], b: TaskWorker[]) =>
  a.length === b.length &&
  a.every((w, i) => {
    const o = b[i]!;
    return w.lease === o.lease && w.profile === o.profile && w.workstream === o.workstream && w.live === o.live;
  });

/** The previous value while `same` says nothing changed, so consumers keep a stable reference. */
function useShared<T>(next: T, same: (a: T, b: T) => boolean): T {
  // React's "storing information from previous renders" pattern: state, not a ref, so it is render-safe.
  const [kept, setKept] = useState(next);
  if (kept === next || same(kept, next)) return kept;
  setKept(next);
  return next;
}

/**
 * Loads a thread's replies (a task's thread, `TaskDetail.threadId`) into the relay events, again after each
 * reconnect. Returns whether they arrived. Null: nothing to load.
 */
export function useRelayThread(messageId: string | null | undefined): boolean {
  const { teamId } = useTeamContext();
  const open = useTeamStore((s) => s.connection === "open");
  const loaded = useTeamStore((s) => (messageId ? s.threads[messageId] === true : false));
  useEffect(() => {
    if (messageId && open) requestTeamThread(teamId, messageId);
  }, [teamId, messageId, open]);
  return loaded;
}

/** Live reactions and read receipts on one message (see `RelayMarks`), or null when none arrived. */
export function useRelayMarks(messageId: string): RelayMarks | null {
  return useTeamStore((s) => s.relayMarks[messageId] ?? null);
}

/** Older pages of a channel. `loadOlder()` returns false when nothing was sent. */
export function useRelayHistory(channel: string = DEFAULT_CHANNEL): { loadOlder: () => boolean; loading: boolean; hasMore: boolean } {
  const { teamId, store } = useTeamContext();
  const key = channel.replace(/^#/, "") || DEFAULT_CHANNEL;
  const cursor = useTeamStore((s) => s.history[key]);
  const loadOlder = useCallback(() => {
    const begun = store.getState().beginHistory(key);
    if (!begun) return false;
    if (requestTeamHistory(teamId, begun.before, key)) return true;
    store.getState().cancelHistory(key);
    return false;
  }, [store, teamId, key]);
  return { loadOlder, loading: cursor?.loading ?? false, hasMore: !cursor || cursor.nextBefore !== null };
}
