import { taskWorkerPrefix, type RelayEventView, type TaskView, type WorkforceView } from "@morrow/contracts";

/** Most relay events a team store keeps. Older ones fall off as new ones arrive. */
export const RELAY_EVENT_CAP = 2000;
/** Channel the server pages when a history request names none. */
export const DEFAULT_CHANNEL = "general";

/** Messages dedupe by their Relay id; status events by what happened to whom, when. */
export function relayEventKey(event: RelayEventView): string {
  switch (event.type) {
    case "message":
      return `m:${event.id}`;
    case "agent.status":
      return `a:${event.agentName}:${event.status}:${event.at}`;
    case "node.status":
      return `n:${event.nodeName}:${event.status}:${event.at}`;
  }
}

export const relayEventTime = (event: RelayEventView): number => (event.type === "message" ? event.createdAt : event.at);

function compare(a: RelayEventView, b: RelayEventView): number {
  const dt = relayEventTime(a) - relayEventTime(b);
  if (dt !== 0) return dt;
  const ka = relayEventKey(a);
  const kb = relayEventKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Oldest first, one entry per key (a re-sent event replaces the old copy), newest `cap` kept.
 * Returns `existing` itself when nothing changed, so subscribers do not re-render.
 */
export function mergeRelayEvents(
  existing: readonly RelayEventView[],
  incoming: readonly RelayEventView[],
  cap = RELAY_EVENT_CAP,
): RelayEventView[] {
  if (incoming.length === 0) return existing as RelayEventView[];
  const last = existing.at(-1);
  // Fast path: one live event newer than everything we hold.
  if (incoming.length === 1 && (!last || compare(last, incoming[0]!) < 0)) {
    const key = relayEventKey(incoming[0]!);
    if (!existing.some((e) => relayEventKey(e) === key)) {
      const next = [...existing, incoming[0]!];
      return next.length > cap ? next.slice(next.length - cap) : next;
    }
  }
  const byKey = new Map<string, RelayEventView>();
  for (const event of existing) byKey.set(relayEventKey(event), event);
  let changed = false;
  for (const event of incoming) {
    const key = relayEventKey(event);
    const prev = byKey.get(key);
    if (prev && JSON.stringify(prev) === JSON.stringify(event)) continue;
    byKey.set(key, event);
    changed = true;
  }
  // A reconnect resends a page we already hold.
  if (!changed) return existing as RelayEventView[];
  const merged = [...byKey.values()].sort(compare);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export type RelayFilter = {
  /** Traffic of one task's workers: their messages, mentions of them, their lifecycle, their nodes. */
  taskId?: string;
  /** One channel's messages (status events have no channel and are left out). */
  channel?: string;
  /** Messages from or mentioning one agent, and that agent's lifecycle. */
  agentName?: string;
  types?: readonly RelayEventView["type"][];
};

/** The task threads' root ids among `events`: the dispatcher's kickoff posts for the task. */
export function taskThreadRoots(events: readonly RelayEventView[], taskId: string): Set<string> {
  const roots = new Set<string>();
  for (const e of events) if (e.type === "message" && e.from.kind === "system" && e.notice?.kind === "kickoff" && e.notice.taskId === taskId) roots.add(e.id);
  return roots;
}

/**
 * Which Relay traffic belongs to a task. Worker names carry the task's short id, so ended leases still match.
 * `threads`: the task thread's root ids (TaskDetail.threadId, taskThreadRoots), so people's replies there match too.
 */
export function taskRelayMatcher(task: TaskView, workforce: WorkforceView | null, threads: ReadonlySet<string> = new Set()): (event: RelayEventView) => boolean {
  const prefix = taskWorkerPrefix(task.id);
  const leases = Object.values(workforce?.leases ?? {}).filter((l) => l.taskId === task.id);
  const names = new Set(leases.map((l) => l.agentName));
  const leaseIds = leases.map((l) => l.id);
  const nodes = new Set(leases.map((l) => l.nodeName));
  const isWorker = (name: string) => names.has(name) || name.startsWith(prefix);
  return (event) => {
    switch (event.type) {
      case "message":
        if (event.notice) return event.notice.taskId === task.id || event.notice.to.some(isWorker);
        if (event.threadId !== null && threads.has(event.threadId)) return true;
        return isWorker(event.from.name) || event.mentions.some(isWorker) || leaseIds.some((id) => event.text.includes(id));
      case "agent.status":
        return isWorker(event.agentName);
      case "node.status":
        return nodes.has(event.nodeName) && event.at >= task.createdAt;
    }
  };
}

export function filterRelayEvents(
  events: readonly RelayEventView[],
  filter: RelayFilter,
  workforce: WorkforceView | null,
): RelayEventView[] {
  const task = filter.taskId ? workforce?.tasks[filter.taskId] : undefined;
  if (filter.taskId && !task) return [];
  const inTask = task ? taskRelayMatcher(task, workforce, taskThreadRoots(events, task.id)) : null;
  const channel = filter.channel?.replace(/^#/, "");
  return events.filter((event) => {
    if (filter.types && !filter.types.includes(event.type)) return false;
    if (channel !== undefined && (event.type !== "message" || event.channel?.replace(/^#/, "") !== channel)) return false;
    if (filter.agentName) {
      const name = filter.agentName;
      if (event.type === "node.status") return false;
      if (event.type === "agent.status" && event.agentName !== name) return false;
      if (event.type === "message" && event.from.name !== name && !event.mentions.includes(name) && !event.notice?.to.includes(name)) return false;
    }
    return inTask ? inTask(event) : true;
  });
}
