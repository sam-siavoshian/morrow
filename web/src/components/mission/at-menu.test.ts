import { describe, expect, test } from "bun:test";
import { MAX_TASK_WORKSTREAMS, type EnvironmentView, type ProfileView, type TaskView } from "@morrow/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { groupByVm, vmTone } from "@/components/workforce/vm-groups";
import { addBlock, buildAtMenu, resolveTarget } from "./at-menu";
import { MessageBar } from "./message-bar";

const NOW = 1_800_000_000_000;

const env = (id: string, patch: Partial<EnvironmentView> = {}): EnvironmentView => ({
  id,
  ownerUserId: "u-ada",
  name: id,
  linuxUser: null,
  nodeName: `n-${id}`,
  phase: "ready",
  vmState: "running",
  nodeOnline: true,
  lastError: null,
  createdAt: 0,
  ...patch,
});
const profile = (id: string, envId: string, patch: Partial<ProfileView> = {}): ProfileView => ({
  id,
  envId,
  ownerUserId: "u-ada",
  cli: "claude",
  label: id,
  auth: "ok",
  availability: "ready",
  cooldownUntil: null,
  limitedReason: null,
  limitedSource: null,
  maxConcurrent: 1,
  activeLeases: 0,
  scopes: "all",
  lastSeenAt: null,
  ...patch,
});
const ws = (id: string, status: TaskView["workstreams"][number]["status"] = "active") => ({ id, branch: `morrow/abc/${id}`, status, leaseId: null });
const task = (patch: Partial<TaskView> = {}): Pick<TaskView, "status" | "strategy" | "maxAgents" | "workstreams" | "projectId"> => ({
  status: "running",
  strategy: "split",
  maxAgents: 3,
  workstreams: [ws("ws-api")],
  projectId: "p-1",
  ...patch,
});
const members = [
  { userId: "u-ada", login: "ada" },
  { userId: "u-bob", login: "bob" },
];
const POLICY = { maxParallelPerTask: 3 };

describe("groupByVm", () => {
  test("groups by VM name, sorts profiles, names the owner only when the VM name doesn't", () => {
    const envs = [env("e-2", { name: "zed box", ownerUserId: "u-bob" }), env("e-1", { name: "ada's box" })];
    const groups = groupByVm([profile("cp-b", "e-1", { label: "b" }), profile("cp-a", "e-1", { label: "a" }), profile("cp-z", "e-2")], envs, members);
    expect(groups.map((g) => [g.name, g.owner, g.profiles.map((p) => p.label)])).toEqual([
      ["ada's box", null, ["a", "b"]],
      ["zed box", "bob", ["cp-z"]],
    ]);
  });

  test("includeEmpty lists VMs with no profile; a profile on an unknown VM still shows", () => {
    const groups = groupByVm([profile("cp-x", "e-gone")], [env("e-1")], members, { includeEmpty: true });
    expect(groups.map((g) => [g.envId, g.name, g.profiles.length])).toEqual([
      ["e-gone", "Unknown environment", 1],
      ["e-1", "e-1", 0],
    ]);
    expect(groupByVm([], [env("e-1")], members)).toEqual([]);
  });

  test("tone follows the VM's phase and its node", () => {
    expect(vmTone(env("e"))).toBe("success");
    expect(vmTone(env("e", { nodeOnline: false }))).toBe("attention");
    expect(vmTone(env("e", { phase: "paused" }))).toBe("idle");
    expect(vmTone(undefined)).toBe("idle");
  });
});

describe("addBlock", () => {
  test("only a running split task under its caps takes a new agent", () => {
    expect(addBlock(task(), POLICY)).toBeNull();
    expect(addBlock(task({ status: "starting" }), POLICY)).toBeNull();
    expect(addBlock(task({ status: "handoff" }), POLICY)).toBeNull();
    expect(addBlock(task({ status: "planned" }), POLICY)).toBe("Agents can join once the task starts.");
    expect(addBlock(task({ status: "verifying" }), POLICY)).toBe("Agents can only join while the task runs.");
    expect(addBlock(task({ status: "completed" }), POLICY)).toBe("Agents can only join while the task runs.");
    expect(addBlock(task({ strategy: "compare" }), POLICY)).toBe("A compare task runs one agent per harness.");
    // The team's cap, not the task's maxAgents; a stream waiting for a replacement holds a slot too.
    expect(addBlock(task({ workstreams: [ws("ws-a"), ws("ws-b", "handoff")] }), { maxParallelPerTask: 2 })).toBe("This task already runs 2 agents, its limit.");
    expect(addBlock(task({ maxAgents: 1, workstreams: [ws("ws-a"), ws("ws-b", "handoff")] }), POLICY)).toBeNull();
    expect(addBlock(task(), { maxParallelPerTask: 1 })).toBe("This task already runs 1 agent, its limit.");
    expect(addBlock(task({ maxAgents: 5, workstreams: [ws("ws-a"), ...["b", "c", "d", "e"].map((r) => ws(`ws-${r}`, "done"))] }), { maxParallelPerTask: 5 })).toBe(
      "This task holds as many workstreams as it can.",
    );
    // The conflict resolver does not count against the ceiling.
    const four = ["b", "c", "d"].map((r) => ws(`ws-${r}`, "done"));
    expect(addBlock(task({ maxAgents: 5, workstreams: [ws("ws-a"), ...four, ws("ws-resolver", "done")] }), { maxParallelPerTask: 5 })).toBeNull();
    expect(MAX_TASK_WORKSTREAMS).toBe(5);
  });
});

describe("buildAtMenu", () => {
  const envs = [env("e-ada", { name: "ada's box" }), env("e-bob", { name: "build box", ownerUserId: "u-bob", phase: "paused" }), env("e-new", { name: "new box" })];
  const profiles = [
    profile("cp-idle", "e-ada", { label: "Claude" }),
    profile("cp-busy", "e-ada", { cli: "codex", label: "Codex", availability: "busy", activeLeases: 1 }),
    profile("cp-out", "e-ada", { label: "Signed out one", auth: "auth_required" }),
    profile("cp-scope", "e-ada", { label: "Scoped", scopes: ["p-other"] }),
    profile("cp-half", "e-ada", { label: "Half", maxConcurrent: 2, activeLeases: 1 }),
    profile("cp-paused", "e-bob", { label: "Paused VM's" }),
  ];
  const workers = [
    { name: "w-abc-api-e1", label: "api", cli: "codex" as const, profileId: "cp-busy" },
    { name: "w-abc-web-e2", label: "web", cli: "claude" as const, profileId: "cp-removed" },
  ];
  const menu = buildAtMenu({ task: task(), profiles, environments: envs, members, policy: POLICY, workers, now: NOW });

  test("every VM, every profile with its state, and live workers under their profile", () => {
    expect(menu.addBlock).toBeNull();
    expect(menu.vms.map((vm) => [vm.name, vm.owner, vm.status, vm.available])).toEqual([
      ["ada's box", null, "Any free agent", true],
      ["build box", "bob", "Paused", false],
      ["new box", "ada", "No agents yet", false],
    ]);
    expect(menu.vms[0]!.profiles.map((p) => [p.label, p.status, p.available, p.workers.map((w) => w.name)])).toEqual([
      ["Claude", "Idle", true, []],
      ["Codex", "Busy", false, ["w-abc-api-e1"]],
      ["Half", "Ready", true, []],
      ["Scoped", "Not on this project", false, []],
      ["Signed out one", "Signed out", false, []],
    ]);
    expect(menu.vms[1]!.profiles.map((p) => [p.status, p.available])).toEqual([["Offline", false]]);
    // A worker on a profile that left the team can still be steered.
    expect(menu.otherWorkers).toEqual([{ name: "w-abc-web-e2", label: "web", cli: "claude" }]);
  });

  test("a task that takes no agent keeps the rows, all disabled, and says why once", () => {
    const blocked = buildAtMenu({ task: task({ status: "verifying" }), profiles, environments: envs, members, policy: POLICY, workers, now: NOW });
    expect(blocked.addBlock).toBe("Agents can only join while the task runs.");
    expect(blocked.vms.flatMap((vm) => vm.profiles).some((p) => p.available)).toBe(false);
    expect(blocked.vms.some((vm) => vm.available)).toBe(false);
    expect(blocked.vms[0]!.status).toBe("");
  });

  test("a VM with only busy or signed-out profiles has no free agent", () => {
    const m = buildAtMenu({ task: task(), profiles: [profile("cp-x", "e-ada", { auth: "auth_required" })], environments: [envs[0]!], members, policy: POLICY, workers: [], now: NOW });
    expect(m.vms[0]).toMatchObject({ status: "No free agent", available: false });
  });

  test("resolveTarget: what the bar shows and why it can't send, or the team channel", () => {
    expect(resolveTarget(menu, { kind: "team" })).toBeNull();
    expect(resolveTarget(menu, { kind: "worker", name: "w-abc-api-e1" })).toEqual({ label: "api", cli: "codex", adds: false, blocked: null });
    expect(resolveTarget(menu, { kind: "worker", name: "w-abc-web-e2" })).toMatchObject({ label: "web", adds: false });
    expect(resolveTarget(menu, { kind: "worker", name: "w-gone-e9" })).toBeNull();
    expect(resolveTarget(menu, { kind: "profile", id: "cp-idle" })).toEqual({ label: "Claude", cli: "claude", adds: true, blocked: null });
    expect(resolveTarget(menu, { kind: "profile", id: "cp-busy" })).toMatchObject({ adds: true, blocked: "Codex is busy." });
    expect(resolveTarget(menu, { kind: "profile", id: "cp-gone" })).toBeNull();
    expect(resolveTarget(menu, { kind: "env", id: "e-ada" })).toEqual({ label: "ada's box", cli: null, adds: true, blocked: null });
    expect(resolveTarget(menu, { kind: "env", id: "e-bob" })).toMatchObject({ blocked: "build box: paused." });
    expect(resolveTarget(menu, { kind: "env", id: "e-gone" })).toBeNull();
    const blocked = buildAtMenu({ task: task({ status: "planned" }), profiles, environments: envs, members, policy: POLICY, workers, now: NOW });
    expect(resolveTarget(blocked, { kind: "profile", id: "cp-idle" })?.blocked).toBe("Agents can join once the task starts.");
  });
});

describe("MessageBar", () => {
  test("says @ reaches agents and VMs", () => {
    const menu = buildAtMenu({ task: task(), profiles: [], environments: [], members, policy: POLICY, workers: [], now: NOW });
    const html = renderToStaticMarkup(createElement(MessageBar, { teamId: "t-1", taskId: "tk-1", menu, disabledReason: null, onSent: () => {} }));
    expect(html).toContain('placeholder="Message the team. @ an agent or VM"');
    expect(html).toContain("Everyone on the task sees it in Relay. @ an agent or VM.");
    expect(html).toContain('aria-label="Sending to the team channel. Change"');
  });
});
