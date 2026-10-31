import {
  humanRelayName,
  taskShort,
  type LeaseView,
  type ProfileView,
  type RelayEventView,
  type RelayMessageView,
  type TaskView,
  type TeamView,
  type TraceKind,
  type WorkforceView,
  type WorkstreamView,
} from "@morrow/contracts";

/**
 * A task row's status, highest precedence first (t3code-ux 12.1): approval > worker question >
 * recovering > running > failed > done.
 */
export type TaskRowStatus =
  | "approval"
  | "choosing"
  | "input"
  | "recovering"
  | "planning"
  | "running"
  | "verifying"
  | "resolving"
  | "failed"
  | "done"
  | "cancelled";

export type InboxGroup = "needs-you" | "running" | "recovering" | "done";
export const INBOX_GROUPS: readonly InboxGroup[] = ["needs-you", "running", "recovering", "done"];

export type Inbox = Record<InboxGroup, TaskView[]>;

const RECOVERY_TRACE: ReadonlySet<TraceKind> = new Set(["worker.quota_limited", "worker.offline", "task.handoff_requested"]);

/** `asked`: one of the task's workers asked the viewer something they have not answered (see `selectAskedTaskIds`). */
export function taskRowStatus(task: TaskView, asked = false): TaskRowStatus {
  if (task.status === "completed") return "done";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "failed") return "failed";
  // The plan waits for a human to press Start.
  if (task.status === "planned") return "approval";
  // Compare attempts finished: someone picks one to ship, or finishes without shipping.
  if (task.status === "choosing") return "choosing";
  const last = task.trace.at(-1)?.kind;
  // A worker asked the viewer, could not start, or the planner never reported back: someone has to act.
  if (asked || last === "worker.blocked") return "input";
  // A merge conflict being resolved by a worker (its own handoffs included): a recovery with a specific name.
  if (task.status === "resolving") return "resolving";
  if (task.status === "handoff" || task.workstreams.some((w) => w.status === "handoff") || (last && RECOVERY_TRACE.has(last)))
    return "recovering";
  if (task.status === "verifying") return "verifying";
  if (task.status === "draft" || task.status === "planning") return "planning";
  return "running";
}

const GROUP_OF: Record<TaskRowStatus, InboxGroup> = {
  approval: "needs-you",
  choosing: "needs-you",
  input: "needs-you",
  recovering: "recovering",
  planning: "running",
  running: "running",
  verifying: "running",
  resolving: "recovering",
  failed: "done",
  done: "done",
  cancelled: "done",
};

export const inboxGroupOf = (status: TaskRowStatus): InboxGroup => GROUP_OF[status];

const PRECEDENCE: Record<TaskRowStatus, number> = {
  approval: 0,
  choosing: 0,
  input: 1,
  recovering: 2,
  resolving: 2,
  verifying: 3,
  running: 3,
  planning: 3,
  failed: 4,
  done: 5,
  cancelled: 5,
};

/** Sidebar inbox: grouped, then by precedence, then most recently updated first. */
export function selectInbox(
  workforce: WorkforceView | null,
  options: { projectId?: string | null; asked?: ReadonlySet<string> } = {},
): Inbox {
  const inbox: Inbox = { "needs-you": [], running: [], recovering: [], done: [] };
  const rows = Object.values(workforce?.tasks ?? {})
    .filter((t) => !options.projectId || t.projectId === options.projectId)
    .map((task) => ({ task, status: taskRowStatus(task, options.asked?.has(task.id) ?? false) }))
    .sort((a, b) => PRECEDENCE[a.status] - PRECEDENCE[b.status] || b.task.updatedAt - a.task.updatedAt || (a.task.id < b.task.id ? -1 : 1));
  for (const row of rows) inbox[GROUP_OF[row.status]].push(row.task);
  return inbox;
}

export type TaskWorker = {
  lease: LeaseView;
  profile: ProfileView | null;
  workstream: WorkstreamView | null;
  /** Holds a lease right now (reserved, spawning or running). */
  live: boolean;
};

const LIVE_LEASE: ReadonlySet<LeaseView["state"]> = new Set(["reserved", "spawning", "running"]);

/** Every lease a task has had, oldest first, joined to its profile and workstream. */
export function selectTaskWorkers(workforce: WorkforceView | null, taskId: string): TaskWorker[] {
  const task = workforce?.tasks[taskId];
  if (!workforce || !task) return [];
  return Object.values(workforce.leases)
    .filter((lease) => lease.taskId === taskId)
    .sort((a, b) => a.createdAt - b.createdAt || a.epoch - b.epoch)
    .map((lease) => ({
      lease,
      profile: workforce.profiles[lease.profileId] ?? null,
      workstream: task.workstreams.find((w) => w.id === lease.workstreamId) ?? null,
      live: LIVE_LEASE.has(lease.state),
    }));
}

/** The viewer's Relay name (`h-<login>`), or null until the team view says who they are. */
export function viewerRelayName(team: TeamView | null, viewerId: string | null): string | null {
  const login = viewerId ? team?.members.find((m) => m.userId === viewerId)?.login : undefined;
  return login ? humanRelayName(login) : null;
}

const WORKER_NAME = /^w-([a-z0-9]{1,8})-/;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a message sits, for matching a reply to the question it answers. */
function answers(reply: RelayMessageView, question: RelayMessageView): boolean {
  if (question.conversationId) return reply.conversationId === question.conversationId;
  if (reply.threadId && (reply.threadId === question.id || reply.threadId === question.threadId)) return true;
  return question.channel !== null && reply.channel === question.channel;
}

/**
 * Tasks whose workers asked the viewer something still open: a message from one of the task's workers that
 * @mentions the viewer's Relay name, or a direct message in a conversation the viewer takes part in (Relay events
 * do not name a DM's recipient, so a DM counts once the viewer has written in that conversation). A question
 * clears when the viewer later posts in the same place (the conversation, the thread, or the channel), or when
 * the viewer opened the task after it was asked (`seenAt`, epoch ms per task). Finished tasks never ask.
 */
export function selectAskedTaskIds(
  events: readonly RelayEventView[],
  workforce: WorkforceView | null,
  viewerName: string | null,
  seenAt: Readonly<Record<string, number>> = {},
): Set<string> {
  const asked = new Set<string>();
  if (!workforce || !viewerName) return asked;
  const viewer = viewerName.toLowerCase();
  const byAgent = new Map<string, string>();
  for (const lease of Object.values(workforce.leases)) byAgent.set(lease.agentName, lease.taskId);
  const byShort = new Map<string, string>();
  for (const task of Object.values(workforce.tasks)) byShort.set(taskShort(task.id), task.id);
  const taskOf = (name: string) => byAgent.get(name) ?? byShort.get(WORKER_NAME.exec(name)?.[1] ?? "") ?? null;

  const mention = new RegExp(`(^|[^A-Za-z0-9_-])@${escapeRegExp(viewer)}(?![A-Za-z0-9_-])`, "i");
  const isViewer = (message: RelayMessageView) => message.from.name.toLowerCase() === viewer;
  const viewerConversations = new Set<string>();
  for (const event of events) if (event.type === "message" && event.conversationId && isViewer(event)) viewerConversations.add(event.conversationId);

  // Oldest first: a later reply clears the questions it answers; a later question opens again.
  const open = new Map<string, RelayMessageView[]>();
  for (const event of events) {
    if (event.type !== "message") continue;
    if (isViewer(event)) {
      for (const [taskId, questions] of open) {
        const left = questions.filter((q) => !(event.createdAt >= q.createdAt && answers(event, q)));
        if (left.length === 0) open.delete(taskId);
        else if (left.length !== questions.length) open.set(taskId, left);
      }
      continue;
    }
    if (!event.from.name.startsWith("w-")) continue;
    const taskId = taskOf(event.from.name);
    if (!taskId) continue;
    const toViewer =
      event.mentions.some((m) => m.replace(/^@/, "").toLowerCase() === viewer) ||
      mention.test(event.text) ||
      (event.conversationId !== null && viewerConversations.has(event.conversationId));
    if (toViewer) open.set(taskId, [...(open.get(taskId) ?? []), event]);
  }

  const FINISHED: ReadonlySet<TaskView["status"]> = new Set(["completed", "failed", "cancelled"]);
  for (const [taskId, questions] of open) {
    const task = workforce.tasks[taskId];
    if (!task || FINISHED.has(task.status)) continue;
    const seen = seenAt[taskId];
    if (seen === undefined || questions.some((q) => q.createdAt > seen)) asked.add(taskId);
  }
  return asked;
}
