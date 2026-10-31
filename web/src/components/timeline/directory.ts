import type { CliKind, LeaseView, MemberView, ProfileView, TeamView, WorkforceView } from "@morrow/contracts";
import { HARNESS_LABEL } from "@/components/harness/harness-icon";

/** Everything the UI knows about one Relay agent name, joined from its lease, profile, owner and VM. */
export type AgentInfo = {
  name: string;
  role: string;
  epoch: number | null;
  /** Started by another worker to help it (docs/subagents.md); its name ends in `-sub-e<epoch>`. */
  subagent: boolean;
  cli: CliKind | null;
  lease: LeaseView | null;
  profile: ProfileView | null;
  owner: MemberView | null;
  /** The environment (VM) name, or the Relay node name when the environment is unknown. */
  vm: string | null;
};

export type Directory = {
  agent: (name: string) => AgentInfo | null;
  human: (name: string) => MemberView | null;
  /** Readable name for any sender: an agent's role, a member's name, or the raw name. */
  displayName: (name: string) => string;
};

/** Worker names look like `w-<taskShort>-<role>-e<epoch>`, subagents `w-<taskShort>-<role>-sub-e<epoch>`. */
const WORKER_NAME = /^w-[a-z0-9]+-(.+?)(-sub)?-e(\d+)$/;

export function parseWorkerName(name: string): { role: string; epoch: number; subagent: boolean } | null {
  const match = WORKER_NAME.exec(name);
  return match ? { role: match[1]!, epoch: Number(match[3]), subagent: match[2] !== undefined } : null;
}

/** A worker name anywhere in free text ("w-ab12cd34-core-e1 hit its usage limit"), not part of a longer word, address or path. */
const WORKER_IN_TEXT = /(?<![\w@/.-])w-[a-z0-9]+-[a-z0-9][a-z0-9-]*?-e\d+(?![\w-])/g;

/**
 * Text with every raw worker name read as its display name ("core e1"), so system lines, notices and trace entries
 * never show `w-ab12cd34-core-e1`. Text in, text out: the caller still renders it as text.
 */
export function readableNames(text: string, displayName: (name: string) => string): string {
  return text.includes("w-") ? text.replace(WORKER_IN_TEXT, (name) => displayName(name)) : text;
}

/** Roles that read as acronyms, so "cdp" shows as "CDP" rather than "Cdp". */
const ACRONYMS: ReadonlySet<string> = new Set(["api", "cdp", "cli", "ci", "db", "sdk", "ui", "ux", "qa", "e2e", "css", "sql", "ml", "pr"]);

/**
 * What a person calls a worker: its role, title-cased ("Core", "CDP", "Test runner"). The first worker on a
 * workstream is just the role; a replacement after a handoff is "Core #2"; a subagent is "Core helper".
 */
export function agentLabel(role: string, epoch: number | null, subagent: boolean): string {
  const words = role.split(/[-_\s]+/).filter(Boolean);
  const title = words
    .map((w, i) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ") || role;
  const base = subagent ? `${title} helper` : title;
  return epoch !== null && epoch > 1 ? `${base} #${epoch}` : base;
}

/** "ada's Claude Code": whose subscription a worker runs on. */
export function ownership(owner: Pick<MemberView, "login"> | null, cli: CliKind | null): string {
  const harness = cli ? HARNESS_LABEL[cli] : "agent";
  return owner ? `${owner.login}'s ${harness}` : harness;
}

export function buildDirectory(workforce: WorkforceView | null, team: TeamView | null): Directory {
  const leases = new Map<string, LeaseView>();
  // The newest lease wins when a name was ever reused.
  for (const lease of Object.values(workforce?.leases ?? {}).sort((a, b) => a.createdAt - b.createdAt)) leases.set(lease.agentName, lease);
  const members = new Map((team?.members ?? []).map((m) => [m.userId, m]));
  const byLogin = new Map((team?.members ?? []).map((m) => [m.login.toLowerCase(), m]));
  const envs = new Map((team?.environments ?? []).map((e) => [e.id, e]));
  const cache = new Map<string, AgentInfo | null>();

  const agent = (name: string): AgentInfo | null => {
    if (cache.has(name)) return cache.get(name)!;
    const lease = leases.get(name) ?? null;
    const parsed = parseWorkerName(name);
    let info: AgentInfo | null = null;
    if (lease || parsed) {
      const profile = lease ? (workforce?.profiles[lease.profileId] ?? null) : null;
      const env = profile ? envs.get(profile.envId) : undefined;
      info = {
        name,
        role: parsed?.role ?? name,
        epoch: lease?.epoch ?? parsed?.epoch ?? null,
        subagent: Boolean(lease?.parentLeaseId) || (parsed?.subagent ?? false),
        cli: profile?.cli ?? null,
        lease,
        profile,
        owner: profile ? (members.get(profile.ownerUserId) ?? null) : null,
        vm: env?.name ?? lease?.nodeName ?? null,
      };
    }
    cache.set(name, info);
    return info;
  };

  const human = (name: string): MemberView | null => byLogin.get(name.replace(/^h-/, "").toLowerCase()) ?? null;

  const displayName = (name: string): string => {
    const a = agent(name);
    if (a) return agentLabel(a.role, a.epoch, a.subagent);
    const h = human(name);
    if (h) return h.name || h.login;
    return name;
  };

  return { agent, human, displayName };
}
