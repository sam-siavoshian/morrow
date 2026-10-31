import { MAX_TASK_WORKSTREAMS, RESOLVER_ROLE, type CliKind, type EnvironmentView, type MemberView, type ProfileView, type TaskView, type TeamPolicy } from "@morrow/contracts";
import { profileState } from "@/components/composer/profile-status";
import { phaseInfo } from "@/components/workforce/status";
import { groupByVm, type VmGroup } from "@/components/workforce/vm-groups";

// What the task's @ menu lists: every VM of the team with every CLI profile on it, this task's live workers under the
// profile they run on, and whether each can take a new agent now. The backend and the actor decide for real; this only
// says ahead of time what they would say.

/** A live worker of this task: a direct message steers it. */
export type AtWorker = { name: string; label: string; cli: CliKind | null };

export type AtProfile = {
  id: string;
  label: string;
  cli: CliKind;
  /** One or two words: Idle, Ready, Busy, Signed out, Offline, Limited (resets in 12m), Not on this project. */
  status: string;
  /** It can take a new agent on this task now. */
  available: boolean;
  /** This task's live workers on it. */
  workers: AtWorker[];
};

export type AtVm = VmGroup<AtProfile> & {
  /** Some profile on it can take a new agent now (the backend picks the best one). */
  available: boolean;
  /** What the VM row says on its right: why it can't, or that it can. */
  status: string;
};

export type AtMenu = {
  /** Why this task takes no new agent right now, or null. Live workers can still be steered. */
  addBlock: string | null;
  vms: AtVm[];
  /** Live workers whose profile left the team: still steerable, under no VM. */
  otherWorkers: AtWorker[];
};

/** A started task that is still working (the actor's rule). */
const ADDABLE: ReadonlySet<TaskView["status"]> = new Set(["starting", "running", "handoff"]);
const NOT_STARTED: ReadonlySet<TaskView["status"]> = new Set(["draft", "planning", "planned"]);
const RESOLVER_ID = `ws-${RESOLVER_ROLE}`;

type TaskFacts = Pick<TaskView, "status" | "strategy" | "workstreams">;

/** Why no agent can be added to this task now, in the words the backend would use, or null. */
export function addBlock(task: TaskFacts, policy: Pick<TeamPolicy, "maxParallelPerTask">): string | null {
  if ((task.strategy ?? "split") === "compare") return "A compare task runs one agent per harness.";
  if (!ADDABLE.has(task.status)) return NOT_STARTED.has(task.status) ? "Agents can join once the task starts." : "Agents can only join while the task runs.";
  // The team's cap on live workers; the task's `maxAgents` only sized its plan.
  const limit = policy.maxParallelPerTask;
  const busy = task.workstreams.filter((ws) => ws.status === "active" || ws.status === "handoff").length;
  if (busy >= limit) return `This task already runs ${limit} ${limit === 1 ? "agent" : "agents"}, its limit.`;
  if (task.workstreams.filter((ws) => ws.id !== RESOLVER_ID).length >= MAX_TASK_WORKSTREAMS) return "This task holds as many workstreams as it can.";
  return null;
}

/** A profile's word for the @ menu: placement's `profileState`, where "Ready" with nothing running reads "Idle". */
function profileStatus(profile: ProfileView, env: EnvironmentView | undefined, now: number, projectId: string) {
  const state = profileState(profile, env, now, projectId);
  if (state.kind === "ready" && profile.activeLeases === 0) return { ...state, label: "Idle" };
  if (state.kind === "auth") return { ...state, label: "Signed out" };
  return state;
}

function vmStatus(env: EnvironmentView | undefined, profiles: readonly AtProfile[], block: string | null): string {
  if (!env) return "Not found";
  if (env.phase !== "ready") return phaseInfo(env.phase).label;
  if (profiles.length === 0) return "No agents yet";
  if (block) return "";
  return profiles.some((p) => p.available) ? "Any free agent" : "No free agent";
}

export function buildAtMenu(input: {
  task: TaskFacts & Pick<TaskView, "projectId">;
  profiles: readonly ProfileView[];
  environments: readonly EnvironmentView[];
  members: readonly Pick<MemberView, "userId" | "login">[];
  policy: Pick<TeamPolicy, "maxParallelPerTask">;
  /** This task's live workers with the profile each runs on. */
  workers: readonly (AtWorker & { profileId: string })[];
  now: number;
}): AtMenu {
  const block = addBlock(input.task, input.policy);
  const known = new Set(input.profiles.map((p) => p.id));
  const envs = new Map(input.environments.map((e) => [e.id, e]));
  const atProfiles = input.profiles.map((p): AtProfile => {
    const state = profileStatus(p, envs.get(p.envId), input.now, input.task.projectId);
    return {
      id: p.id,
      label: p.label,
      cli: p.cli,
      status: state.label,
      available: block === null && state.pickable,
      workers: input.workers.filter((w) => w.profileId === p.id).map(({ profileId: _, ...w }) => w),
    };
  });
  const byId = new Map(atProfiles.map((p) => [p.id, p]));
  const groups = groupByVm(
    input.profiles.map((p) => ({ envId: p.envId, label: p.label, id: p.id })),
    input.environments,
    input.members,
    { includeEmpty: true },
  );
  return {
    addBlock: block,
    vms: groups.map((group) => {
      const profiles = group.profiles.map((p) => byId.get(p.id)!);
      return { ...group, profiles, available: group.env !== undefined && profiles.some((p) => p.available), status: vmStatus(group.env, profiles, block) };
    }),
    otherWorkers: input.workers.filter((w) => !known.has(w.profileId)).map(({ profileId: _, ...w }) => w),
  };
}

/** What the message bar sends to. A worker is reached by direct message; a profile or VM gets a new agent. */
export type AtTarget = { kind: "team" } | { kind: "worker"; name: string } | { kind: "profile"; id: string } | { kind: "env"; id: string };

export type ResolvedTarget = {
  label: string;
  cli: CliKind | null;
  /** Sending adds an agent instead of a message. */
  adds: boolean;
  /** Why sending to it is off right now, or null. */
  blocked: string | null;
};

/** The chosen target as the menu has it now, or null for the team channel and for a target that is gone. */
export function resolveTarget(menu: AtMenu, target: AtTarget): ResolvedTarget | null {
  switch (target.kind) {
    case "team":
      return null;
    case "worker": {
      const workers = [...menu.vms.flatMap((vm) => vm.profiles.flatMap((p) => p.workers)), ...menu.otherWorkers];
      const worker = workers.find((w) => w.name === target.name);
      return worker ? { label: worker.label, cli: worker.cli, adds: false, blocked: null } : null;
    }
    case "profile": {
      const profile = menu.vms.flatMap((vm) => vm.profiles).find((p) => p.id === target.id);
      if (!profile) return null;
      const blocked = profile.available ? null : (menu.addBlock ?? `${profile.label} is ${profile.status.toLowerCase()}.`);
      return { label: profile.label, cli: profile.cli, adds: true, blocked };
    }
    case "env": {
      const vm = menu.vms.find((v) => v.envId === target.id && v.env);
      if (!vm) return null;
      const blocked = vm.available ? null : (menu.addBlock ?? `${vm.name}: ${vm.status.toLowerCase()}.`);
      return { label: vm.name, cli: null, adds: true, blocked };
    }
  }
}
