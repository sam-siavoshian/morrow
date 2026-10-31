import { USAGE_STALE_MS, type CliKind, type EnvStatusView, type ProfileView, type TeamView, type UsageSource, type UsageWindow, type WorkforceView } from "@morrow/contracts";
import { cliAvailability, formatResetTime } from "@/components/workforce/status";

/**
 * One CLI in the pool, as the meter draws it. `low` is under `LOW_LEFT` percent left in the binding window;
 * `unmetered` is a CLI with no subscription windows (opencode bills the user's own provider keys);
 * `unknown` has no usage reading yet.
 */
export type PoolState = "healthy" | "low" | "limited" | "auth" | "offline" | "unknown" | "unmetered";

export const LOW_LEFT = 20;

export type PoolWindow = Pick<UsageWindow, "kind" | "label" | "resetsAt"> & {
  /** Percent of the window left, 0-100. A window whose reset has passed reads as full again. */
  left: number;
};

export type PoolSegment = {
  profileId: string;
  cli: CliKind;
  label: string;
  state: PoolState;
  /** Headroom in the binding window (the window with the least left of 5-hour and weekly). Null when unknown. */
  left: number | null;
  binding: PoolWindow | null;
  windows: PoolWindow[];
  observedAt: number | null;
  source: UsageSource | null;
  /** The reading is older than `USAGE_STALE_MS`: drawn dimmed, never counted as current. */
  stale: boolean;
  /** When a limit lifts, if known and still ahead. */
  until: number | null;
};

export type PoolGroup = { userId: string; name: string; isViewer: boolean; segments: PoolSegment[] };

export type Pool = {
  groups: PoolGroup[];
  /** Every CLI in the pool. */
  total: number;
  /** Pool headroom: the mean of the binding headroom over CLIs with a current reading (limited ones count as 0). */
  left: number | null;
  /** CLIs counted in `left`. */
  measured: number;
  limited: number;
  /** The soonest a limited CLI comes back, when known. */
  nextReset: number | null;
  stale: number;
  needsSignIn: number;
  offline: number;
};

const CLI_ORDER: Record<CliKind, number> = { claude: 0, codex: 1, opencode: 2, cursor: 3, gemini: 4, grok: 5 };
const BINDING_KINDS: ReadonlySet<UsageWindow["kind"]> = new Set(["five_hour", "weekly"]);

type PoolInput = {
  workforce: Pick<WorkforceView, "profiles"> | null;
  team: Pick<TeamView, "members" | "environments"> | null;
  envStatus: Record<string, Pick<EnvStatusView, "vmState" | "nodeOnline">>;
  viewerId: string | null;
  now: number;
};

function poolWindows(windows: readonly UsageWindow[], now: number): PoolWindow[] {
  return windows.map((w) => {
    const reset = w.resetsAt !== null && w.resetsAt <= now;
    return { kind: w.kind, label: w.label, resetsAt: reset ? null : w.resetsAt, left: reset ? 100 : Math.max(0, Math.min(100, 100 - w.usedPercent)) };
  });
}

/** The window that binds first: least left among 5-hour and weekly (any window when neither is reported). */
export function bindingWindow(windows: readonly PoolWindow[]): PoolWindow | null {
  const main = windows.filter((w) => BINDING_KINDS.has(w.kind));
  const pool = main.length > 0 ? main : windows;
  let best: PoolWindow | null = null;
  for (const w of pool) {
    if (!best || w.left < best.left || (w.left === best.left && (w.resetsAt ?? Infinity) < (best.resetsAt ?? Infinity))) best = w;
  }
  return best;
}

export function poolSegment(profile: ProfileView, ctx: { vmRunning: boolean; nodeOnline: boolean; now: number }): PoolSegment {
  const usage = profile.usage ?? null;
  const windows = usage ? poolWindows(usage.windows, ctx.now) : [];
  const binding = bindingWindow(windows);
  const stale = usage !== null && ctx.now - usage.observedAt > USAGE_STALE_MS;
  const availability = cliAvailability(profile, ctx);
  const base = {
    profileId: profile.id,
    cli: profile.cli,
    label: profile.label,
    windows,
    binding,
    observedAt: usage?.observedAt ?? null,
    source: usage?.source ?? null,
    stale,
    until: availability.until,
  };
  if (availability.kind === "auth") return { ...base, state: "auth", left: binding?.left ?? null };
  if (availability.kind === "offline") return { ...base, state: "offline", left: binding?.left ?? null };
  if (availability.kind === "limited") return { ...base, state: "limited", left: 0 };
  if (profile.cli === "opencode") return { ...base, state: "unmetered", left: null, windows: [], binding: null };
  if (!binding) return { ...base, state: "unknown", left: null };
  return { ...base, state: binding.left < LOW_LEFT ? "low" : "healthy", left: binding.left };
}

/** The whole team's pool: every member's CLIs grouped by member (viewer first), with one headline number. */
export function selectPool({ workforce, team, envStatus, viewerId, now }: PoolInput): Pool {
  const envs = new Map((team?.environments ?? []).map((e) => [e.id, e]));
  const members = team?.members ?? [];
  const order = new Map(members.map((m, i) => [m.userId, i]));
  const byOwner = new Map<string, PoolSegment[]>();
  for (const profile of Object.values(workforce?.profiles ?? {})) {
    const env = envs.get(profile.envId);
    const live = envStatus[profile.envId] ?? env;
    const segment = poolSegment(profile, { vmRunning: live?.vmState === "running", nodeOnline: live?.nodeOnline ?? false, now });
    byOwner.set(profile.ownerUserId, [...(byOwner.get(profile.ownerUserId) ?? []), segment]);
  }
  const groups: PoolGroup[] = [...byOwner.entries()]
    .map(([userId, segments]) => {
      const member = members.find((m) => m.userId === userId);
      return {
        userId,
        name: member ? (member.name ?? member.login) : "Former member",
        isViewer: userId === viewerId,
        segments: segments.sort((a, b) => CLI_ORDER[a.cli] - CLI_ORDER[b.cli] || a.label.localeCompare(b.label) || (a.profileId < b.profileId ? -1 : 1)),
      };
    })
    .sort((a, b) => Number(b.isViewer) - Number(a.isViewer) || (order.get(a.userId) ?? Infinity) - (order.get(b.userId) ?? Infinity) || a.name.localeCompare(b.name));

  const all = groups.flatMap((g) => g.segments);
  const counted = all.filter((s) => s.state === "limited" || ((s.state === "healthy" || s.state === "low") && !s.stale));
  const limited = all.filter((s) => s.state === "limited");
  const resets = limited.map((s) => s.until).filter((t): t is number => t !== null);
  return {
    groups,
    total: all.length,
    left: counted.length > 0 ? Math.round(counted.reduce((sum, s) => sum + (s.left ?? 0), 0) / counted.length) : null,
    measured: counted.length,
    limited: limited.length,
    nextReset: resets.length > 0 ? Math.min(...resets) : null,
    stale: all.filter((s) => s.stale && s.state !== "unmetered").length,
    needsSignIn: all.filter((s) => s.state === "auth").length,
    offline: all.filter((s) => s.state === "offline").length,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the headline number does not say: how many CLIs, what is limited and until when, who has to sign in. */
export function poolFacts(pool: Pool, now: number, locale?: string): string[] {
  const facts = [plural(pool.total, "CLI")];
  if (pool.limited > 0) {
    const what = `${pool.limited} limited`;
    facts.push(pool.nextReset !== null ? `${what} until ${formatResetTime(pool.nextReset, now, locale)}` : what);
  }
  if (pool.needsSignIn > 0) facts.push(`${pool.needsSignIn} need${pool.needsSignIn === 1 ? "s" : ""} sign-in`);
  return facts;
}

/** "Pool · 64% left · 6 CLIs · 1 limited until 3:40 PM". */
export function poolSummary(pool: Pool, now: number, locale?: string): string {
  if (pool.total === 0) return "Connect a CLI to start the pool";
  return ["Pool", pool.left === null ? "no usage data yet" : `${pool.left}% left`, ...poolFacts(pool, now, locale)].join(" · ");
}

/** "just now", "3m ago", "2h ago", "4d ago". */
export function formatAgo(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** Whole percent for display; never "100% left" for a window that has been touched, never "0%" for one not full. */
export function percentLabel(left: number): string {
  const rounded = Math.round(left);
  if (rounded === 100 && left < 100) return "99%";
  if (rounded === 0 && left > 0) return "1%";
  return `${rounded}%`;
}
