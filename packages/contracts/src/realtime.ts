import { z } from "zod";
import { EnvironmentView, EpochMs, Id, TeamView, VmState, WorkforceView } from "./domain.ts";
import { GithubChangeView } from "./github.ts";

export const RELAY_SENDER_KINDS = ["agent", "human", "system"] as const;

/**
 * What Morrow tells workers over Relay (architecture 9.8). Each kind is one system update shown in mission control.
 * `kickoff` is the channel post a task thread hangs off; `contract` tells peers a worker published its interface;
 * `peer_joined` tells running workers a new peer started and asks them to greet it. `nudge` is a direct message to a
 * worker that went quiet while working (to: that worker). `activity` is a system line in the task thread about
 * something Morrow saw: a worker pushed work, ran tests, stopped, joined or took over, or verification finished (to: []).
 */
export const RELAY_NOTICE_KINDS = [
  "workstream_done",
  "handoff",
  "review_comment",
  "status",
  "subagent",
  "subagent_done",
  "kickoff",
  "contract",
  "peer_joined",
  "nudge",
  "activity",
] as const;
export type RelayNoticeKind = (typeof RELAY_NOTICE_KINDS)[number];

/**
 * The structured side of a Morrow system update, carried in the message's Relay metadata. Only messages from the
 * Morrow system identity get one; the text is what the workers read.
 */
export const RelayNotice = z.object({
  kind: z.enum(RELAY_NOTICE_KINDS),
  taskId: Id.nullable(),
  /** The workers it was sent to (agent names). */
  to: z.array(z.string().max(64)).max(20),
});
export type RelayNotice = z.infer<typeof RelayNotice>;

/** A file attached to a message: metadata only. The bytes stay in Relay; the UI never links to them. */
export const RelayAttachmentView = z.object({
  id: z.string().max(128),
  filename: z.string().max(255),
  contentType: z.string().max(255).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});
export type RelayAttachmentView = z.infer<typeof RelayAttachmentView>;

/** Who reacted to a message with one emoji, as history reports it. */
export const RelayReactionGroupView = z.object({
  emoji: z.string().min(1).max(64),
  count: z.number().int().nonnegative(),
  agents: z.array(z.string().max(64)).max(50),
});
export type RelayReactionGroupView = z.infer<typeof RelayReactionGroupView>;

/** A Relay message as the UI sees it. Ids are the true Relay ids. */
export const RelayMessageView = z.object({
  type: z.literal("message"),
  id: z.string(),
  channel: z.string().nullable(),
  conversationId: z.string().nullable(),
  threadId: z.string().nullable(),
  parentId: z.string().nullable(),
  from: z.object({ name: z.string(), kind: z.enum(RELAY_SENDER_KINDS) }),
  text: z.string(),
  mentions: z.array(z.string()),
  createdAt: EpochMs,
  /** Set on Morrow system updates to workers. Absent on everything else. */
  notice: RelayNotice.optional(),
  /** File metadata of a channel post or DM (thread replies carry none). Absent when there are none. */
  attachments: z.array(RelayAttachmentView).max(20).optional(),
  /** Reactions as history reports them; live changes arrive as `relay.mark` frames. Absent when unknown or none. */
  reactions: z.array(RelayReactionGroupView).max(20).optional(),
  /** How many agents marked it read, as history reports it. Absent when unknown. */
  readByCount: z.number().int().nonnegative().optional(),
});
export type RelayMessageView = z.infer<typeof RelayMessageView>;

export const RelayAgentStatusView = z.object({
  type: z.literal("agent.status"),
  agentName: z.string(),
  status: z.enum(["active", "offline", "exited"]),
  reason: z.string().nullable(),
  nodeName: z.string().nullable(),
  at: EpochMs,
});
export type RelayAgentStatusView = z.infer<typeof RelayAgentStatusView>;

export const RelayNodeStatusView = z.object({
  type: z.literal("node.status"),
  nodeName: z.string(),
  status: z.enum(["online", "offline"]),
  reason: z.string().nullable(),
  at: EpochMs,
});
export type RelayNodeStatusView = z.infer<typeof RelayNodeStatusView>;

export const RelayEventView = z.discriminatedUnion("type", [
  RelayMessageView,
  RelayAgentStatusView,
  RelayNodeStatusView,
]);
export type RelayEventView = z.infer<typeof RelayEventView>;

/**
 * A reaction or read receipt on a message, live from the observer stream. Not a message: the UI hangs it on the
 * message it names (reaction chips, "seen by") and never shows it as a row.
 */
export const RelayMarkView = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reaction"),
    messageId: z.string().max(64),
    emoji: z.string().min(1).max(64),
    agentName: z.string().max(64),
    removed: z.boolean(),
    at: EpochMs,
  }),
  z.object({ type: z.literal("read"), messageId: z.string().max(64), agentName: z.string().max(64), at: EpochMs }),
]);
export type RelayMarkView = z.infer<typeof RelayMarkView>;

export const EnvStatusView = z.object({
  envId: Id,
  vmState: VmState,
  nodeOnline: z.boolean(),
  at: EpochMs,
});
export type EnvStatusView = z.infer<typeof EnvStatusView>;

export const ToastView = z.object({
  level: z.enum(["info", "success", "warning", "error"]),
  title: z.string(),
  body: z.string().nullable(),
});
export type ToastView = z.infer<typeof ToastView>;

/** Server -> browser frames on /realtime. */
export const ServerFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hello"), teamId: Id, userId: Id }),
  z.object({ kind: z.literal("workforce.view"), teamId: Id, data: WorkforceView }),
  z.object({ kind: z.literal("team.view"), teamId: Id, data: TeamView }),
  z.object({
    kind: z.literal("relay.history"),
    teamId: Id,
    data: z.array(RelayEventView),
    /** Which channel this page belongs to (`general` when the request named none). */
    channel: z.string().nullable().optional(),
    /** Pass as `before` for the next older page; null at the start of the channel. */
    nextBefore: z.string().nullable().optional(),
    /** Set when this is a thread (its root and newest replies), not a channel page: no paging cursor moves. */
    thread: z.string().nullable().optional(),
  }),
  z.object({ kind: z.literal("relay.event"), teamId: Id, seq: z.number().int().nullable(), data: RelayEventView }),
  z.object({ kind: z.literal("relay.mark"), teamId: Id, seq: z.number().int().nullable(), data: RelayMarkView }),
  z.object({ kind: z.literal("env.status"), teamId: Id, data: EnvStatusView }),
  z.object({ kind: z.literal("env.view"), teamId: Id, data: EnvironmentView }),
  z.object({ kind: z.literal("toast"), teamId: Id, data: ToastView }),
  z.object({ kind: z.literal("github.changed"), teamId: Id, data: GithubChangeView }),
  z.object({ kind: z.literal("error"), teamId: Id.nullable(), code: z.string(), message: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Browser -> server frames on /realtime. Kept tiny on purpose. */
export const ClientFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ping") }),
  z.object({ kind: z.literal("relay.history"), before: z.string().nullable(), channel: z.string().max(80).nullable() }),
  /** A thread's root and newest replies (a task thread), answered with a `relay.history` frame carrying `thread`. */
  z.object({ kind: z.literal("relay.thread"), messageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/**
 * The PTY size every worker runs in: configure-node.sh pins it on the node (the Relay broker sizes each worker's PTY
 * from it), and inspect renders at exactly this size, because a TUI's cursor moves only land right in a terminal of
 * the size it drew for. A finished log is shown at this size too. 80 columns: what every coding CLI is built for (and
 * the broker's own default), and what the mission panel fits at a readable size; 40 rows to show more of the work.
 */
export const WORKER_TERMINAL = { cols: 80, rows: 40 } as const;

/**
 * Server -> browser frames on `/realtime/inspect/:leaseId`: a read-only view of one worker's terminal.
 * The browser sends nothing; anything it sends is dropped.
 */
export const InspectFrame = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inspect.hello"),
    leaseId: Id,
    agentName: z.string(),
    /** The worker's PTY size: render at exactly this. Absent from servers older than the size pin, whose PTYs are 80x24. */
    cols: z.number().int().min(20).max(500).optional(),
    rows: z.number().int().min(5).max(300).optional(),
  }),
  /**
   * Terminal output to write as is (escape sequences included). `reset`: start from a blank terminal first. The first
   * frame after the hello is a reset carrying the current screen (and recent scrollback); later frames are new output.
   */
  z.object({ kind: z.literal("inspect.output"), data: z.string(), reset: z.boolean() }),
  z.object({ kind: z.literal("inspect.end"), reason: z.enum(["lease_ended", "not_authorized", "unavailable", "server_shutdown"]) }),
]);
export type InspectFrame = z.infer<typeof InspectFrame>;
