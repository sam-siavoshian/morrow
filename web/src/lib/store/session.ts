import type { ServerFrame, TeamView } from "@morrow/contracts";
import { toast } from "@/components/ui/toast";
import { RealtimeConnection, type RealtimeFatal, type RealtimeHandlers } from "../realtime";
import { createTeamStore, type TeamStore } from "./team-store";

/** Unmount-to-remount gap that keeps the socket (Strict Mode, layout swaps). */
const TEARDOWN_GRACE_MS = 1_000;

type Connector = (teamId: string, handlers: RealtimeHandlers) => Pick<RealtimeConnection, "start" | "stop" | "requestHistory" | "requestThread" | "retryNow">;

type Session = {
  store: TeamStore;
  connection: ReturnType<Connector> | null;
  refs: number;
  teardown: ReturnType<typeof setTimeout> | null;
  fatalListeners: Set<(fatal: RealtimeFatal) => void>;
};

/** One store and one socket per team per tab, shared by every TeamProvider for that team. */
const sessions = new Map<string, Session>();

const connector: Connector = (teamId, handlers) => new RealtimeConnection(teamId, handlers);

function showToast(frame: Extract<ServerFrame, { kind: "toast" }>): void {
  const { level, title, body } = frame.data;
  toast[level](title, body ? { description: body } : undefined);
}

/** The team's store, created on first use. Safe during render: it opens nothing. */
export function getTeamStore(teamId: string, initialTeam: TeamView | null = null): TeamStore {
  // On the server this module outlives the request: a cached store would hand one request's team view
  // (members, the viewer's role) to every later render, which then disagrees with the fresh store the
  // browser hydrates with. Each server render gets its own store; only the browser keeps sessions.
  if (typeof window === "undefined") return createTeamStore(teamId, initialTeam);
  let session = sessions.get(teamId);
  if (!session) {
    session = { store: createTeamStore(teamId, initialTeam), connection: null, refs: 0, teardown: null, fatalListeners: new Set() };
    sessions.set(teamId, session);
  }
  return session.store;
}

/** Keeps the team's socket open while held. Call from an effect; the returned function releases it. */
export function retainTeamConnection(teamId: string, onFatal: (fatal: RealtimeFatal) => void): () => void {
  getTeamStore(teamId);
  const session = sessions.get(teamId)!;
  if (session.teardown) clearTimeout(session.teardown);
  session.teardown = null;
  session.refs++;
  session.fatalListeners.add(onFatal);
  if (!session.connection) {
    const { store } = session;
    session.connection = connector(teamId, {
      onFrame: (frame) => (frame.kind === "toast" ? showToast(frame) : store.getState().applyFrame(frame)),
      onStatus: (status) => store.getState().setConnection(status),
      onFatal: (fatal) => {
        // A fatal connection is done; the next retain starts a fresh one.
        session.connection = null;
        for (const listener of [...session.fatalListeners]) listener(fatal);
      },
    });
    session.connection.start();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    session.fatalListeners.delete(onFatal);
    session.refs--;
    if (session.refs > 0) return;
    session.teardown = setTimeout(() => {
      session.teardown = null;
      if (session.refs > 0) return;
      session.connection?.stop();
      session.connection = null;
      sessions.delete(teamId);
    }, TEARDOWN_GRACE_MS);
  };
}

/** Sends a `relay.history` request on the team's socket. False when it is not open. */
export function requestTeamHistory(teamId: string, before: string | null, channel: string | null): boolean {
  return sessions.get(teamId)?.connection?.requestHistory(before, channel) ?? false;
}

/** Sends a `relay.thread` request on the team's socket. False when it is not open or the id is not a message id. */
export function requestTeamThread(teamId: string, messageId: string): boolean {
  return sessions.get(teamId)?.connection?.requestThread(messageId) ?? false;
}

/** Reconnects the team's socket now (a Retry button). False when there is no live connection to retry. */
export function retryTeamConnection(teamId: string): boolean {
  return sessions.get(teamId)?.connection?.retryNow() ?? false;
}
