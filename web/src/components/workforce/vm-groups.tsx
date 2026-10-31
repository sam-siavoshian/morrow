import type { EnvironmentView, MemberView, ProfileView } from "@morrow/contracts";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";

// CLI profiles under the VM they run on, as the composer's profile picker and the task's @ menu list them.

export type VmGroup<P> = {
  envId: string;
  /** Undefined when the team no longer lists the VM a profile points at. */
  env: EnvironmentView | undefined;
  name: string;
  /** The owner's login, only when the VM's name does not already say it ("ada's box"). */
  owner: string | null;
  tone: StatusTone;
  profiles: P[];
};

/** Green when the VM is set up and its Relay node is connected, amber when the node is not, grey otherwise. */
export function vmTone(env: Pick<EnvironmentView, "phase" | "nodeOnline"> | undefined): StatusTone {
  if (env?.phase !== "ready") return "idle";
  return env.nodeOnline ? "success" : "attention";
}

/**
 * Profiles grouped by VM, VMs by name and profiles by label. `includeEmpty` also lists the team's VMs that have no
 * profile yet (the @ menu shows every VM; the picker only the ones it can place work on).
 */
export function groupByVm<P extends Pick<ProfileView, "envId" | "label">>(
  profiles: readonly P[],
  environments: readonly EnvironmentView[],
  members: readonly Pick<MemberView, "userId" | "login">[],
  options: { includeEmpty?: boolean } = {},
): VmGroup<P>[] {
  const byEnv = new Map<string, P[]>();
  if (options.includeEmpty) for (const env of environments) byEnv.set(env.id, []);
  for (const p of profiles) byEnv.set(p.envId, [...(byEnv.get(p.envId) ?? []), p]);
  return [...byEnv.entries()]
    .map(([envId, list]) => {
      const env = environments.find((e) => e.id === envId);
      const name = env?.name ?? "Unknown environment";
      const login = env ? members.find((m) => m.userId === env.ownerUserId)?.login : undefined;
      return {
        envId,
        env,
        name,
        owner: login && !name.toLowerCase().includes(login.toLowerCase()) ? login : null,
        tone: vmTone(env),
        profiles: list.sort((a, b) => a.label.localeCompare(b.label)),
      };
    })
    .sort((a, b) => (a.env?.name ?? "").localeCompare(b.env?.name ?? ""));
}

/** A VM's status dot, name (truncated) and, when the name doesn't say it, its owner. Lays out inside a flex row. */
export function VmLabel({ group }: { group: Pick<VmGroup<unknown>, "name" | "owner" | "tone"> }) {
  return (
    <>
      <StatusDot tone={group.tone} />
      <span className="truncate">{group.name}</span>
      {group.owner ? <span className="shrink-0 font-[450]">· {group.owner}</span> : null}
    </>
  );
}
