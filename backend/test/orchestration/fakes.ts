// In-memory stand-ins for the vendors orchestration drives (Relay, the VMs, GitHub, the team runtime). The
// TeamWorkforce actor is never faked: flow tests run it on a real local Terse.
import type { EnvironmentView, ProjectView, RelayMessageView, RelayNotice, TeamPolicy } from "@morrow/contracts";
import type { ActorGateway, TeamRecord } from "../../src/actors/types.ts";
import type { EnvironmentRecord } from "../../src/integrations/freestyle/index.ts";
import type { CompareResult, PullRequestInfo, TreeEntry } from "../../src/integrations/github/client.ts";
import type { ReconcileResult, RelayConfig, SpawnOutcome, SpawnWorkerRequest, Speaker } from "../../src/integrations/relay/index.ts";
import type { GitHost, PlannerRun, RelayPort, VmPort } from "../../src/orchestration/ports.ts";
import { projectChannel } from "../../src/orchestration/names.ts";
import type { TeamRelayAccess, TeamRuntimeApi } from "../../src/runtime/types.ts";

export const PROJECT: ProjectView = { id: "p-proj0000demo", repoFullName: "acme/app", defaultBranch: "main", testCommand: "bun test" };

export function envView(id: string, ownerUserId: string): EnvironmentView {
  return { id, ownerUserId, name: id, linuxUser: `u${Buffer.from(id).toString("hex").padStart(12, "0").slice(-12)}`, nodeName: `n-${id}`, phase: "ready", vmState: "running", nodeOnline: true, lastError: null, createdAt: 0 };
}

export const ENVS = [envView("e-alpha", "u-owner"), envView("e-beta", "u-mate")];

export function teamRecord(teamId: string, policy: TeamPolicy = { allowInspect: true, maxParallelPerTask: 3 }): TeamRecord {
  return {
    id: teamId,
    name: "Flow",
    slug: "flow",
    members: [
      { userId: "u-owner", role: "owner", login: "owner", name: null, avatarUrl: null },
      { userId: "u-mate", role: "member", login: "mate", name: null, avatarUrl: null },
      { userId: "u-third", role: "member", login: "third", name: null, avatarUrl: null },
      { userId: "u-admin", role: "admin", login: "admin", name: null, avatarUrl: null },
    ],
    projects: [PROJECT],
    environments: ENVS,
    policy: { ...policy },
    relayReady: true,
  };
}

/** Only `getTeam` is real; anything else is a test bug. `policy` is read on every call, so a test can change it. */
export function teamGateway(policy?: TeamPolicy): ActorGateway {
  return new Proxy({ getTeam: async (id: string) => teamRecord(id, policy) } as unknown as ActorGateway, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof ActorGateway];
      if (prop === "then") return undefined;
      return () => {
        throw new Error(`gateway.${String(prop)} must not be called by orchestration`);
      };
    },
  });
}

export class FakeRuntime implements TeamRuntimeApi {
  readonly access: TeamRelayAccess = { config: {} as RelayConfig, workspaceId: "ws-test", workspaceKey: "wk", dispatcherToken: "dt" };
  readonly touched: string[] = [];
  readonly restarts: Array<{ teamId: string; envId: string; reason?: string }> = [];
  relayEnabled = true;

  async relay() {
    return this.relayEnabled ? this.access : null;
  }
  async speakerFor(_teamId: string, userId: string): Promise<Speaker> {
    return { token: `human-${userId}`, kind: "human" };
  }
  async environment(teamId: string, envId: string): Promise<EnvironmentRecord | null> {
    const view = ENVS.find((e) => e.id === envId);
    if (!view) return null;
    return {
      id: envId,
      teamId,
      ownerUserId: view.ownerUserId,
      phase: "ready",
      vmState: "running",
      freestyleVmId: `vm-${envId}`,
      vmSlug: `slug-${envId}`,
      linuxUser: view.linuxUser!,
      nodeName: view.nodeName!,
      progress: { user: true, node: true, repos: [PROJECT.repoFullName], warm: false },
      nodeConfigHash: null,
      resumePhase: null,
      failures: 0,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    };
  }
  publish(): void {}
  activeTeamIds(): string[] {
    return [];
  }
  touchTeam(teamId: string): void {
    this.touched.push(teamId);
  }
  async restartNode(teamId: string, envId: string, reason?: string): Promise<boolean> {
    this.restarts.push({ teamId, envId, reason });
    return true;
  }
}

/** One shared agent registry, like a real Relay workspace: several orchestrators can point at it. */
export class FakeRelay implements RelayPort {
  readonly agents = new Map<string, { invocationId: string; node: string; task: string; cwd: string }>();
  readonly spawns: SpawnWorkerRequest[] = [];
  readonly releases: string[] = [];
  readonly posts: Array<{ to: string; text: string; speaker: Speaker; key?: string; notice?: RelayNotice }> = [];
  /** Throws on a direct message to these agents, like Relay does for an agent it no longer knows. */
  readonly unknownAgents = new Set<string>();
  /** Agents whose release does not take yet (the process is still stopping): the release is retried later. */
  readonly stuck = new Set<string>();
  mode: "started" | "unconfirmed" | "retryable" | "failed" = "started";
  spawnDelayMs = 0;
  /** Forced reconcile answers per agent (otherwise: registered = running, missing = gone). */
  readonly reconcileAs = new Map<string, ReconcileResult["state"]>();
  #seq = 0;

  async findAgent(_access: TeamRelayAccess, name: string) {
    const agent = this.agents.get(name);
    return agent ? { invocationId: agent.invocationId } : null;
  }
  async ensureChannel(_access: TeamRelayAccess, projectId: string) {
    return projectChannel(projectId);
  }
  async spawn(_access: TeamRelayAccess, request: SpawnWorkerRequest): Promise<SpawnOutcome> {
    this.spawns.push(request);
    if (this.spawnDelayMs > 0) await Bun.sleep(this.spawnDelayMs);
    const invocationId = `inv-${++this.#seq}`;
    if (this.mode === "started" || this.mode === "unconfirmed") {
      this.agents.set(request.name, { invocationId, node: request.node, task: request.task, cwd: request.workerCwd });
    }
    if (this.mode === "started") return { outcome: "started", code: "started", invocationId, nodeId: null, warning: null };
    if (this.mode === "unconfirmed") return { outcome: "unconfirmed", code: "spawn_unconfirmed", invocationId, message: "timeout" };
    if (this.mode === "retryable") return { outcome: "retryable", code: "node_unavailable", invocationId: null, message: "busy" };
    return { outcome: "failed", code: "capability_mismatch", invocationId: null, message: "no" };
  }
  async release(_access: TeamRelayAccess, input: { agentName: string }) {
    if (this.stuck.has(input.agentName)) return { gone: false, deleted: false };
    this.releases.push(input.agentName);
    this.agents.delete(input.agentName);
    return { gone: true, deleted: true };
  }
  async reconcile(_access: TeamRelayAccess, input: { agentName: string; memo: ReconcileResult["memo"]; startedAt?: number }): Promise<ReconcileResult> {
    const forced = this.reconcileAs.get(input.agentName);
    const agent = this.agents.get(input.agentName);
    const state = forced ?? (agent ? "running" : "gone");
    const reason = state === "running" ? "live" : state === "gone" ? "absent" : "read_failed";
    return { state, reason, invocationId: agent?.invocationId ?? null, memo: input.memo };
  }
  async post(_access: TeamRelayAccess, speaker: Speaker, channel: string, text: string, key?: string, notice?: RelayNotice): Promise<RelayMessageView> {
    this.posts.push({ to: channel, text, speaker, key, notice });
    return this.keep(message(`h-${speaker.token}`, text, channel));
  }
  async direct(_access: TeamRelayAccess, speaker: Speaker, to: string, text: string, key?: string, notice?: RelayNotice): Promise<RelayMessageView> {
    if (this.unknownAgents.has(to)) throw Object.assign(new Error("agent not found"), { name: "RelayError", code: "not_found", status: 404 });
    this.posts.push({ to, text, speaker, key, notice });
    return message(`h-${speaker.token}`, text, null);
  }
  async reply(_access: TeamRelayAccess, speaker: Speaker, rootId: string, text: string, key: string, notice?: RelayNotice): Promise<RelayMessageView> {
    this.posts.push({ to: `thread:${rootId}`, text, speaker, key, notice });
    return this.keep({ ...message(`h-${speaker.token}`, text), threadId: rootId, parentId: rootId });
  }
  async thread(_access: TeamRelayAccess, rootId: string): Promise<RelayMessageView[]> {
    if (this.threadFails) throw Object.assign(new Error("relay down"), { name: "RelayError", code: "unavailable", status: 503 });
    return [...this.messages.values()].filter((m) => m.threadId === rootId).sort((a, b) => a.createdAt - b.createdAt);
  }
  async message(_access: TeamRelayAccess, messageId: string): Promise<RelayMessageView> {
    const found = this.messages.get(messageId);
    if (!found) throw Object.assign(new Error("message not found"), { name: "RelayError", code: "not_found", status: 404 });
    return found;
  }
  /** Messages Relay holds by id (channel posts, thread replies, and ones a test seeds), for thread and message reads. */
  readonly messages = new Map<string, RelayMessageView>();
  /** Thread reads fail while set, like Relay being down. */
  threadFails = false;
  keep(m: RelayMessageView): RelayMessageView {
    this.messages.set(m.id, m);
    return m;
  }
}

let messageSeq = 0;
export function message(from: string, text: string, channel: string | null = "proj-proj0000demo"): RelayMessageView {
  return {
    type: "message",
    id: `msg-${++messageSeq}`,
    channel,
    conversationId: null,
    threadId: null,
    parentId: null,
    from: { name: from, kind: from.startsWith("w-") ? "agent" : "human" },
    text,
    mentions: [],
    createdAt: Date.now(),
  };
}

/** VMs: worktrees, notes, commits (shared with FakeGit), log tails and the planner CLI. */
export class FakeVm implements VmPort {
  readonly shas: Set<string>;
  readonly notes: Array<{ vmId: string; branch: string; relPath: string; content: string }> = [];
  readonly checkpoints: Array<{ vmId: string; branch: string; message: string; sha: string }> = [];
  readonly worktrees: Array<{ vmId: string; branch: string }> = [];
  /** Every GitHub token handed to a VM git step, by VM. */
  readonly tokens: Array<{ vmId: string; token: string | null }> = [];
  readonly logs = new Map<string, string>();
  readonly delayByVm = new Map<string, number>();
  testsPass = true;
  testOutput: string | null = null;
  /** What a conflict-checked checkpoint reports as still unresolved (a resolver's half-done merge). */
  unresolved: string[] = [];
  readonly runs: Array<{ vmId: string; branch: string }> = [];
  /** Mirror refreshes, so dependents can fetch a finished branch. */
  readonly mirrorSyncs: Array<{ vmId: string; repoFullName: string; githubToken: string | null }> = [];
  planner: (input: { cli: string; prompt: string }) => PlannerRun = () => ({ exitCode: 1, timedOut: false, stdout: "", stderr: "" });
  #n = 0;

  constructor(shas: Set<string>) {
    this.shas = shas;
  }
  enabled() {
    return true;
  }
  async ensureWorktree(input: { vmId: string; linuxUser: string; branch: string; githubToken: string | null }) {
    this.tokens.push({ vmId: input.vmId, token: input.githubToken });
    const delay = this.delayByVm.get(input.vmId) ?? 0;
    if (delay > 0) await Bun.sleep(delay);
    this.worktrees.push({ vmId: input.vmId, branch: input.branch });
    return { path: `/home/${input.linuxUser}/work/.worktrees/acme__app/${input.branch.replaceAll("/", "-")}`, head: "0".repeat(40), created: true, state: "ok" as const };
  }
  async syncMirror(input: { vmId: string; repoFullName: string; githubToken: string | null }) {
    this.mirrorSyncs.push({ vmId: input.vmId, repoFullName: input.repoFullName, githubToken: input.githubToken });
  }
  async writeNote(input: { vmId: string; branch: string; relPath: string; content: string }) {
    this.notes.push({ vmId: input.vmId, branch: input.branch, relPath: input.relPath, content: input.content });
  }
  async checkpoint(input: { vmId: string; branch: string; message: string; githubToken: string; checkConflicts?: boolean }) {
    this.tokens.push({ vmId: input.vmId, token: input.githubToken });
    const sha = new Bun.CryptoHasher("sha1").update(`${input.branch}:${++this.#n}`).digest("hex");
    if (input.checkConflicts && this.unresolved.length > 0) return { sha, committed: false, unresolved: [...this.unresolved] };
    this.shas.add(sha);
    this.checkpoints.push({ vmId: input.vmId, branch: input.branch, message: input.message, sha });
    return { sha, committed: true, unresolved: [] };
  }
  async runTests(input: { vmId: string; branch: string }) {
    this.runs.push({ vmId: input.vmId, branch: input.branch });
    const output = this.testOutput ?? (this.testsPass ? "12 pass" : "1 fail");
    return { exitCode: this.testsPass ? 0 : 1, passed: this.testsPass, timedOut: false, output, truncated: false };
  }
  async readLogTail(input: { agentName: string }) {
    const text = this.logs.get(input.agentName);
    return text === undefined ? null : { text, truncated: false, size: text.length, modifiedAt: new Date().toISOString() };
  }
  async runPlanner(input: { cli: "claude" | "codex"; prompt: string }) {
    return this.planner(input);
  }
}

export class FakeGit implements GitHost {
  readonly shas: Set<string>;
  readonly branches = new Map<string, string>([["main", "f".repeat(40)]]);
  readonly merges: Array<{ base: string; head: string }> = [];
  readonly prs = new Map<string, PullRequestInfo>();
  conflictOn: string | null = null;
  /** Files each side of a compare reports (both sides alike, so they all count as changed on both). */
  compareFiles = ["src/api/index.ts"];
  prMergeable: boolean | null = true;

  constructor(shas: Set<string>) {
    this.shas = shas;
  }
  async getTree(): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    return { entries: [{ path: "src/api/index.ts", type: "blob", size: 10 }, { path: "web/app.tsx", type: "blob", size: 10 }], truncated: false };
  }
  async readSmallFile(_t: string, _r: string, path: string) {
    return path === "README.md" ? "# App\nA demo app." : null;
  }
  async commitExists(_t: string, _r: string, sha: string) {
    return this.shas.has(sha);
  }
  async compare(): Promise<CompareResult> {
    return { status: "ahead", aheadBy: 1, behindBy: 0, files: [...this.compareFiles] };
  }
  async getBranchHead(_t: string, _r: string, branch: string) {
    return this.branches.get(branch) ?? null;
  }
  async createBranch(_t: string, _r: string, branch: string, sha: string) {
    if (this.branches.has(branch)) return "exists" as const;
    this.branches.set(branch, sha);
    return "created" as const;
  }
  async mergeInto(_t: string, _r: string, base: string, head: string) {
    if (head === this.conflictOn) return "conflict" as const;
    this.merges.push({ base, head });
    return "merged" as const;
  }
  async findPullRequest(_t: string, _r: string, head: string) {
    return this.prs.get(head) ?? null;
  }
  async ensurePullRequest(_t: string, repo: string, input: { head: string }) {
    const existing = this.prs.get(input.head);
    if (existing) return existing;
    const pr: PullRequestInfo = { number: this.prs.size + 1, url: `https://github.com/${repo}/pull/${this.prs.size + 1}`, state: "open", mergeable: true, mergeableState: "clean" };
    this.prs.set(input.head, pr);
    return { ...pr, mergeable: this.prMergeable };
  }
  async getPullRequest(_t: string, _r: string, number: number) {
    return { ...[...this.prs.values()].find((p) => p.number === number)!, mergeable: this.prMergeable };
  }
}
