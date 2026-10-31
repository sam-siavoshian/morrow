// The external effects orchestration performs, behind narrow interfaces. The defaults call the real
// integrations; tests swap in fakes. Nothing here decides anything: decisions live in the loops.
import type { RelayMessageView, RelayNotice } from "@morrow/contracts";
import type { AgentRelay } from "@agent-relay/sdk";
import type { GithubClient } from "../integrations/github/client.ts";
import {
  checkpointWorktree,
  ensureWorktree,
  freestyle,
  isFreestyleConfigured,
  readWorkerLogTail,
  runTestCommand,
  syncMirror,
  type CheckpointResult,
  type TestRunResult,
  type WorkerLogTail,
  type WorktreeResult,
} from "../integrations/freestyle/index.ts";
import { FreestyleIntegrationError } from "../integrations/freestyle/errors.ts";
import { lastJsonLine, requireSuccess, runScript } from "../integrations/freestyle/exec.ts";
import { worktreePath } from "../integrations/freestyle/names.ts";
import {
  adminClient,
  ensureProjectChannel,
  joinChannel,
  noticeMetadata,
  postToChannel,
  readMessage,
  readThread,
  reconcileWorker,
  releaseWorker,
  rememberNotice,
  replyInThread,
  sendDirectMessage,
  spawnWorker,
  type ExitLedger,
  type ReconcileMemo,
  type ReconcileResult,
  type RelayReader,
  type ReleaseResult,
  type SpawnOutcome,
  type Speaker,
} from "../integrations/relay/index.ts";
import { isRelayNotFound } from "../integrations/relay/errors.ts";
import { fleetInvocationId } from "../integrations/relay/spawn.ts";
import type { SpawnWorkerRequest } from "../integrations/relay/index.ts";
import type { TeamRelayAccess } from "../runtime/types.ts";
import { projectChannel, projectShort } from "./names.ts";

export interface VmTarget {
  vmId: string;
  linuxUser: string;
}

export interface PlannerRun {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  /** Tail of the CLI's stderr (for the classifier only). */
  stderr: string;
}

export interface VmPort {
  enabled(): boolean;
  ensureWorktree(input: VmTarget & { repoFullName: string; branch: string; baseBranch: string; githubToken: string | null }): Promise<WorktreeResult>;
  /** Writes `.morrow/{briefs,handoff}/<name>.md` in the branch's worktree. Commit with `checkpoint`. */
  writeNote(input: VmTarget & { repoFullName: string; branch: string; relPath: string; content: string }): Promise<void>;
  /** `checkConflicts` for a conflict resolver's tree: nothing is pushed while `unresolved` is non-empty. */
  checkpoint(input: VmTarget & { repoFullName: string; branch: string; message: string; githubToken: string; checkConflicts?: boolean }): Promise<CheckpointResult>;
  runTests(input: VmTarget & { repoFullName: string; branch: string; command: string; timeoutMs: number }): Promise<TestRunResult>;
  readLogTail(input: VmTarget & { agentName: string }): Promise<WorkerLogTail | null>;
  /** Refreshes the engineer's root-owned mirror from GitHub, so a worker's `git fetch origin` sees teammates' pushes. */
  syncMirror(input: VmTarget & { repoFullName: string; githubToken: string | null }): Promise<void>;
  runPlanner(input: VmTarget & { cli: "claude" | "codex"; prompt: string; timeoutMs: number }): Promise<PlannerRun>;
}

export interface RelayPort {
  /** The worker's registry record, or null. Used to never spawn the same lease twice. */
  findAgent(access: TeamRelayAccess, name: string): Promise<{ invocationId: string | null } | null>;
  /** Creates (once) and joins the project channel as the dispatcher. Returns the channel name. */
  ensureChannel(access: TeamRelayAccess, projectId: string): Promise<string>;
  spawn(access: TeamRelayAccess, request: SpawnWorkerRequest): Promise<SpawnOutcome>;
  release(access: TeamRelayAccess, input: { agentName: string; nodeName: string; reason: string }, exits: ExitLedger): Promise<ReleaseResult>;
  /** `startedAt`: when the lease last changed state, so absence right after a spawn is not counted. */
  reconcile(
    access: TeamRelayAccess,
    input: { agentName: string; nodeName: string; expectedInvocationId: string | null; memo: ReconcileMemo; startedAt: number },
    exits: ExitLedger,
  ): Promise<ReconcileResult>;
  /** `notice` marks a Morrow system update (Relay metadata), so mission control can show what workers were told. */
  post(access: TeamRelayAccess, speaker: Speaker, channel: string, text: string, idempotencyKey: string, notice?: RelayNotice): Promise<RelayMessageView>;
  direct(access: TeamRelayAccess, speaker: Speaker, to: string, text: string, idempotencyKey: string, notice?: RelayNotice): Promise<RelayMessageView>;
  /** Replies in the thread rooted at `rootId` (a task's kickoff post). Every unmuted channel member gets it. */
  reply(access: TeamRelayAccess, speaker: Speaker, rootId: string, text: string, idempotencyKey: string, notice?: RelayNotice): Promise<RelayMessageView>;
  /** A thread's root and newest replies (at most 100), oldest first, read as the dispatcher. */
  thread(access: TeamRelayAccess, rootId: string): Promise<RelayMessageView[]>;
  /** One message, read as the dispatcher. Throws a not-found Relay error when it is gone. */
  message(access: TeamRelayAccess, messageId: string): Promise<RelayMessageView>;
}

/** The GitHub calls orchestration makes. `GithubClient` satisfies it. */
export type GitHost = Pick<
  GithubClient,
  | "getTree"
  | "readSmallFile"
  | "commitExists"
  | "compare"
  | "getBranchHead"
  | "createBranch"
  | "mergeInto"
  | "ensurePullRequest"
  | "findPullRequest"
  | "getPullRequest"
>;

export interface Ports {
  vm: VmPort;
  relay: RelayPort;
  git: GitHost;
  /** A member's GitHub token, decrypted in memory for one call. Throws when it is missing or expired. */
  githubToken(userId: string): Promise<string>;
}

// ---------- Freestyle ----------

const PLAN_OUTPUT_BYTES = 256 * 1024;

export function freestyleVmPort(): VmPort {
  return {
    enabled: isFreestyleConfigured,
    ensureWorktree: (input) => ensureWorktree(input),
    checkpoint: (input) => checkpointWorktree(input),
    runTests: (input) => runTestCommand(input),
    readLogTail: (input) => readWorkerLogTail(input),
    syncMirror: (input) => syncMirror(freestyle().vms.ref(input.vmId), input),

    async writeNote(input) {
      const outcome = requireSuccess(
        await runScript(freestyle().vms.ref(input.vmId), {
          user: input.linuxUser,
          script: "workfile",
          timeoutMs: 30_000,
          step: "write note",
          env: {
            WT_PATH: worktreePath(input.linuxUser, input.repoFullName, input.branch),
            REL_PATH: input.relPath,
            CONTENT_B64: Buffer.from(input.content, "utf8").toString("base64"),
          },
        }),
        "write note",
      );
      lastJsonLine(outcome.stdout, "write note");
    },

    async runPlanner(input) {
      const secs = Math.ceil(input.timeoutMs / 1000);
      const outcome = await runScript(freestyle().vms.ref(input.vmId), {
        user: input.linuxUser,
        script: "plan",
        // The inner `timeout` fires first; the slack covers login-shell start and output.
        timeoutMs: input.timeoutMs + 20_000,
        step: "planner call",
        env: {
          PLAN_CLI: input.cli,
          PLAN_PROMPT_B64: Buffer.from(input.prompt, "utf8").toString("base64"),
          PLAN_TIMEOUT_SECS: String(secs),
          MAX_OUTPUT_BYTES: String(PLAN_OUTPUT_BYTES),
        },
      });
      if (outcome.statusCode === null) return { exitCode: 124, timedOut: true, stdout: outcome.stdout, stderr: "" };
      const meta = parseMeta(outcome.stderr);
      if (outcome.statusCode !== 0 || !meta) {
        throw new FreestyleIntegrationError("exec_failed", "Could not run the planner on the VM.", { retryable: true, detail: { statusCode: outcome.statusCode } });
      }
      return { exitCode: meta.exitCode, timedOut: meta.timedOut, stdout: outcome.stdout, stderr: meta.stderr };
    },
  };
}

function parseMeta(stderr: string): { exitCode: number; timedOut: boolean; stderr: string } | null {
  try {
    const meta = JSON.parse(stderr.trimEnd().split("\n").at(-1) ?? "") as { exitCode?: unknown; timedOut?: unknown; stderr?: unknown };
    if (typeof meta.exitCode !== "number" || typeof meta.timedOut !== "boolean") return null;
    const tail = typeof meta.stderr === "string" ? Buffer.from(meta.stderr, "base64").toString("utf8") : "";
    return { exitCode: meta.exitCode, timedOut: meta.timedOut, stderr: tail };
  } catch {
    return null;
  }
}

// ---------- Relay ----------

/**
 * A registry reader on the workspace key. The observer token lives with the team runtime; the workspace key
 * can read the same agent and node records, and never leaves the backend.
 */
function adminReader(access: TeamRelayAccess): RelayReader {
  const relay: AgentRelay = adminClient(access.config, access.workspaceKey);
  const orNull = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (error) {
      if (isRelayNotFound(error)) return null;
      throw error;
    }
  };
  return {
    getNode: (name) => orNull(() => relay.nodes.get(name)),
    getAgent: (name) => orNull(() => relay.agents.get(name)),
    agentType: async (name) => (await orNull(() => relay.agents.get(name)))?.type ?? null,
    nodeNameById: async () => null,
  };
}

export function liveRelayPort(): RelayPort {
  // Channels and memberships are permanent once made; remember them for the life of the process.
  const channels = new Set<string>();
  const joined = new Set<string>();
  return {
    async findAgent(access, name) {
      const agent = await adminReader(access).getAgent(name);
      return agent ? { invocationId: fleetInvocationId(agent.metadata) } : null;
    },
    async ensureChannel(access, projectId) {
      const channel = projectChannel(projectId);
      const key = `${access.workspaceId}/${channel}`;
      if (!channels.has(key)) {
        await ensureProjectChannel({ config: access.config, dispatcherToken: access.dispatcherToken, projectShort: projectShort(projectId) });
        channels.add(key);
      }
      return channel;
    },
    spawn: (access, request) => spawnWorker({ config: access.config, dispatcherToken: access.dispatcherToken, reader: adminReader(access), request }),
    release: (access, input, exits) =>
      releaseWorker({ config: access.config, workspaceKey: access.workspaceKey, reader: adminReader(access), exits, ...input }),
    reconcile: (access, input, exits) => reconcileWorker({ reader: adminReader(access), exits, ...input }),
    async post(access, speaker, channel, text, idempotencyKey, notice) {
      const key = `${access.workspaceId}/${channel}/${speaker.token.slice(-12)}`;
      if (speaker.kind === "human" && !joined.has(key)) {
        await joinChannel({ config: access.config, token: speaker.token, channel });
        joined.add(key);
      }
      if (notice) rememberNotice(text, notice);
      return postToChannel({ config: access.config, speaker, channel, text, idempotencyKey, ...(notice ? { metadata: noticeMetadata(notice) } : {}) });
    },
    direct(access, speaker, to, text, idempotencyKey, notice) {
      if (notice) rememberNotice(text, notice);
      return sendDirectMessage({ config: access.config, speaker, to, text, idempotencyKey, ...(notice ? { metadata: noticeMetadata(notice) } : {}) });
    },
    reply(access, speaker, rootId, text, idempotencyKey, notice) {
      if (notice) rememberNotice(text, notice);
      return replyInThread({ config: access.config, speaker, messageId: rootId, text, idempotencyKey, ...(notice ? { metadata: noticeMetadata(notice) } : {}) });
    },
    thread: (access, rootId) => readThread({ config: access.config, token: access.dispatcherToken, messageId: rootId }),
    message: (access, messageId) => readMessage({ config: access.config, token: access.dispatcherToken, messageId }),
  };
}

export function dispatcherSpeaker(access: TeamRelayAccess): Speaker {
  return { token: access.dispatcherToken, kind: "system" };
}
