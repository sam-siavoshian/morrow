import type { EnvironmentView, EnvStatusView, ProfileView, RelayEventView, RelayMarkView, ServerFrame, TeamView, WorkforceView } from "@morrow/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ConnectionStatus } from "../realtime";
import { DEFAULT_CHANNEL, mergeRelayEvents } from "./relay";
import { replaceEqualDeep } from "./share";

/** Paging state per channel. `nextBefore` null: the start of the channel is loaded. */
export type HistoryCursor = { nextBefore: string | null; loading: boolean };

/**
 * Live reactions and read receipts on one message, from `relay.mark` frames. They change what the message's own
 * `reactions` and `readByCount` (from when it was loaded) show. `reactions`: emoji, then agent, then added (true) or
 * removed (false). `readBy`: who read it, oldest first.
 */
export type RelayMarks = { reactions: Record<string, Record<string, boolean>>; readBy: string[] };

/** Most messages a team store keeps marks for; the oldest drop first. */
export const RELAY_MARKS_CAP = 1000;
const MARK_EMOJIS = 20;
const MARK_AGENTS = 50;

export type TeamData = {
  teamId: string;
  viewerId: string | null;
  team: TeamView | null;
  workforce: WorkforceView | null;
  /** Oldest first, deduped, capped (see relay.ts). */
  relayEvents: RelayEventView[];
  history: Record<string, HistoryCursor>;
  /** By message id, at most RELAY_MARKS_CAP. */
  relayMarks: Record<string, RelayMarks>;
  /** Thread root ids whose replies arrived (`relay.history` with `thread`). */
  threads: Record<string, true>;
  /** Live VM/node status pings since the last `env.view` for that environment. */
  envStatus: Record<string, EnvStatusView>;
  connection: ConnectionStatus;
  /** The last `error` frame (a refused client request). Safe to show. */
  lastError: { code: string; message: string } | null;
  /**
   * When GitHub last changed, per `githubKey(projectId, number)` (a pull request) or `githubKey(projectId)` (the
   * project's list), from `github.changed` frames. Views refetch when theirs moves. Capped at GITHUB_KEYS_CAP keys.
   */
  github: Record<string, number>;
};

export const GITHUB_KEYS_CAP = 200;

/** The `github` version key for a project's pull request list, or for one pull request. */
export const githubKey = (projectId: string, number?: number) => (number === undefined ? `${projectId}#list` : `${projectId}#${number}`);

export type TeamActions = {
  applyFrame: (frame: ServerFrame) => void;
  /**
   * How many frames of these kinds arrived, changed or not. Snapshots keep their identity when equal (share.ts),
   * so this, not identity, tells an optimistic write whether the server spoke since its guess.
   */
  frameCount: (...kinds: ServerFrame["kind"][]) => number;
  setConnection: (status: ConnectionStatus) => void;
  /**
   * Marks the next older page of `channel` as requested and returns the `before` cursor to send.
   * Null when a page is already in flight or the start of the channel is loaded.
   */
  beginHistory: (channel: string) => { before: string | null } | null;
  /** Undo `beginHistory` when the request could not be sent. */
  cancelHistory: (channel: string) => void;
};

export type TeamState = TeamData & TeamActions;
export type TeamStore = StoreApi<TeamState>;

export function initialTeamData(teamId: string, team: TeamView | null = null): TeamData {
  return {
    teamId,
    viewerId: null,
    team,
    workforce: null,
    relayEvents: [],
    history: {},
    relayMarks: {},
    threads: {},
    envStatus: {},
    connection: "connecting",
    lastError: null,
    github: {},
  };
}

const channelKey = (channel: string | null | undefined) => channel?.replace(/^#/, "") || DEFAULT_CHANNEL;

/** One mark applied to the marks we hold. Returns `marks` itself when nothing changed. */
export function applyMark(marks: Record<string, RelayMarks>, mark: RelayMarkView, cap = RELAY_MARKS_CAP): Record<string, RelayMarks> {
  const prev = marks[mark.messageId] ?? { reactions: {}, readBy: [] };
  let next: RelayMarks;
  if (mark.type === "read") {
    if (prev.readBy.includes(mark.agentName) || prev.readBy.length >= MARK_AGENTS) return marks;
    next = { ...prev, readBy: [...prev.readBy, mark.agentName] };
  } else {
    const byAgent = prev.reactions[mark.emoji];
    const added = !mark.removed;
    if (byAgent?.[mark.agentName] === added) return marks;
    if (!byAgent && Object.keys(prev.reactions).length >= MARK_EMOJIS) return marks;
    if (byAgent && !(mark.agentName in byAgent) && Object.keys(byAgent).length >= MARK_AGENTS) return marks;
    next = { ...prev, reactions: { ...prev.reactions, [mark.emoji]: { ...byAgent, [mark.agentName]: added } } };
  }
  // Newest last, so the oldest messages are the ones dropped at the cap.
  const out = { ...marks };
  delete out[mark.messageId];
  out[mark.messageId] = next;
  const ids = Object.keys(out);
  for (const id of ids.slice(0, Math.max(0, ids.length - cap))) delete out[id];
  return out;
}

/** Pure reducer: what one server frame changes. Toast frames change nothing here (the session shows them). */
export function reduceFrame(state: TeamData, frame: ServerFrame): Partial<TeamData> {
  switch (frame.kind) {
    case "hello":
      return { viewerId: frame.userId };
    // Full snapshots: keep the identity of every part that did not change (see share.ts), and skip a frame
    // that changed nothing, so only what moved re-renders.
    case "team.view": {
      const team = replaceEqualDeep(state.team, frame.data);
      return team === state.team ? {} : { team };
    }
    case "workforce.view": {
      const workforce = replaceEqualDeep(state.workforce, frame.data);
      return workforce === state.workforce ? {} : { workforce };
    }
    case "relay.event": {
      const relayEvents = mergeRelayEvents(state.relayEvents, [frame.data]);
      return relayEvents === state.relayEvents ? {} : { relayEvents };
    }
    case "relay.history": {
      // A thread's replies: merged in, no channel cursor moves.
      if (frame.thread) {
        const relayEvents = mergeRelayEvents(state.relayEvents, frame.data);
        return { ...(relayEvents === state.relayEvents ? {} : { relayEvents }), ...(state.threads[frame.thread] ? {} : { threads: { ...state.threads, [frame.thread]: true } }) };
      }
      const key = channelKey(frame.channel);
      const cursor = state.history[key];
      // A connect snapshot must not rewind a cursor the user already paged past.
      const take = !cursor || cursor.loading;
      return {
        relayEvents: mergeRelayEvents(state.relayEvents, frame.data),
        ...(take ? { history: { ...state.history, [key]: { nextBefore: frame.nextBefore ?? null, loading: false } } } : {}),
      };
    }
    case "relay.mark": {
      const relayMarks = applyMark(state.relayMarks, frame.data);
      return relayMarks === state.relayMarks ? {} : { relayMarks };
    }
    case "env.status":
      return { envStatus: { ...state.envStatus, [frame.data.envId]: frame.data } };
    case "env.view": {
      const env = frame.data;
      const envStatus = { ...state.envStatus };
      delete envStatus[env.id];
      if (!state.team) return { envStatus };
      const exists = state.team.environments.some((e) => e.id === env.id);
      const environments = exists ? state.team.environments.map((e) => (e.id === env.id ? env : e)) : [...state.team.environments, env];
      return { envStatus, team: { ...state.team, environments } };
    }
    case "error": {
      // The server does not say which request failed, so no page stays stuck loading.
      const history = Object.fromEntries(Object.entries(state.history).map(([k, c]) => [k, c.loading ? { ...c, loading: false } : c]));
      return { lastError: { code: frame.code, message: frame.message }, history };
    }
    case "github.changed": {
      const { projectId, pulls, list, at } = frame.data;
      const keys = [...(list ? [githubKey(projectId)] : []), ...pulls.map((n) => githubKey(projectId, n))];
      if (keys.length === 0) return {};
      // Newest last, so the oldest keys are the ones dropped at the cap.
      const github = { ...state.github };
      for (const key of keys) {
        delete github[key];
        github[key] = at;
      }
      const names = Object.keys(github);
      for (const key of names.slice(0, Math.max(0, names.length - GITHUB_KEYS_CAP))) delete github[key];
      return { github };
    }
    case "toast":
      return {};
  }
}

export function createTeamStore(teamId: string, team: TeamView | null = null): TeamStore {
  const counts = new Map<ServerFrame["kind"], number>();
  return createStore<TeamState>()((set, get) => ({
    ...initialTeamData(teamId, team),
    frameCount: (...kinds) => kinds.reduce((sum, kind) => sum + (counts.get(kind) ?? 0), 0),
    applyFrame: (frame) => {
      counts.set(frame.kind, (counts.get(frame.kind) ?? 0) + 1);
      const patch = reduceFrame(get(), frame);
      if (Object.keys(patch).length > 0) set(patch);
    },
    setConnection: (connection) => set({ connection }),
    beginHistory: (channel) => {
      const key = channelKey(channel);
      const cursor = get().history[key];
      if (cursor?.loading || (cursor && cursor.nextBefore === null)) return null;
      const before = cursor?.nextBefore ?? null;
      set({ history: { ...get().history, [key]: { nextBefore: before, loading: true } } });
      return { before };
    },
    cancelHistory: (channel) => {
      const key = channelKey(channel);
      const cursor = get().history[key];
      if (!cursor?.loading) return;
      const rest = { ...get().history };
      delete rest[key];
      // A cursor that was only created by this request goes away again.
      set({ history: cursor.nextBefore === null ? rest : { ...rest, [key]: { ...cursor, loading: false } } });
    },
  }));
}

/** One field of the team view, so an optimistic write can be applied and undone on its own. */
export type TeamField<T> = { read: (team: TeamView) => T; write: (team: TeamView, value: T) => TeamView };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Shows `next` at once, then runs `commit`. On success the server's view replaces the guess (it may have trimmed
 * or normalized the value). On failure only this field goes back, and only while it still shows our guess: a
 * newer value from the socket, or another write to a different field, is left alone. Rethrows the error.
 */
export async function optimisticTeamField<T>(store: TeamStore, field: TeamField<T>, next: T, commit: () => Promise<TeamView>): Promise<TeamView> {
  const current = store.getState().team;
  const before = current ? field.read(current) : undefined;
  if (current) store.setState({ team: field.write(current, next) });
  try {
    const view = await commit();
    store.setState({ team: view });
    return view;
  } catch (error) {
    const now = store.getState().team;
    if (now && current && same(field.read(now), next)) store.setState({ team: field.write(now, before as T) });
    throw error;
  }
}

const environmentOf = (store: TeamStore, envId: string) => store.getState().team?.environments.find((e) => e.id === envId);
const showEnvironment = (store: TeamStore, env: EnvironmentView) =>
  store.getState().applyFrame({ kind: "env.view", teamId: store.getState().teamId, data: env });

/**
 * Shows `guess` for one environment at once (Pausing, Starting), then runs `commit`. The server's answer replaces
 * the guess, and a failure puts the old view back, but only while the guess is still what is shown: a newer
 * view from the socket always wins. Rethrows the error.
 */
export async function optimisticEnvironment(store: TeamStore, guess: EnvironmentView, commit: () => Promise<EnvironmentView>): Promise<EnvironmentView> {
  const before = environmentOf(store, guess.id);
  showEnvironment(store, guess);
  const frames = () => store.getState().frameCount("env.view", "team.view");
  const seen = frames();
  try {
    const view = await commit();
    if (frames() === seen) showEnvironment(store, view);
    return view;
  } catch (error) {
    if (before && frames() === seen) showEnvironment(store, before);
    throw error;
  }
}

/**
 * Shows `guess` for one CLI profile at once (a new "workers at once"), then runs `commit`. The server's profile
 * replaces the guess and a failure puts the old one back, but only while no newer workforce view arrived: the
 * socket's view always wins. Rethrows the error.
 */
export async function optimisticProfile(store: TeamStore, guess: ProfileView, commit: () => Promise<ProfileView>): Promise<ProfileView> {
  const show = (profile: ProfileView) => {
    const workforce = store.getState().workforce;
    if (workforce?.profiles[profile.id]) store.setState({ workforce: { ...workforce, profiles: { ...workforce.profiles, [profile.id]: profile } } });
  };
  const before = store.getState().workforce?.profiles[guess.id];
  show(guess);
  const seen = store.getState().frameCount("workforce.view");
  const settled = () => store.getState().frameCount("workforce.view") !== seen;
  try {
    const profile = await commit();
    if (!settled()) show(profile);
    return profile;
  } catch (error) {
    if (before && !settled()) show(before);
    throw error;
  }
}

/** Drops a task the server confirmed deleted, without waiting for the next workforce view (which drops it too). */
export function removeTask(store: TeamStore, taskId: string): void {
  const workforce = store.getState().workforce;
  if (!workforce?.tasks[taskId]) return;
  const tasks = { ...workforce.tasks };
  delete tasks[taskId];
  store.setState({ workforce: { ...workforce, tasks } });
}

/**
 * Takes a CLI off the workforce view at once, then runs `commit`. On failure it comes back, unless a newer
 * workforce view already settled the question. Rethrows the error.
 */
export async function optimisticRemoveProfile(store: TeamStore, profileId: string, commit: () => Promise<unknown>): Promise<void> {
  const workforce = store.getState().workforce;
  const profile = workforce?.profiles[profileId];
  if (!workforce || !profile) return void (await commit());
  const profiles = { ...workforce.profiles };
  delete profiles[profileId];
  store.setState({ workforce: { ...workforce, profiles } });
  const seen = store.getState().frameCount("workforce.view");
  try {
    await commit();
  } catch (error) {
    const now = store.getState().workforce;
    if (now && store.getState().frameCount("workforce.view") === seen) store.setState({ workforce: { ...now, profiles: { ...now.profiles, [profileId]: profile } } });
    throw error;
  }
}
