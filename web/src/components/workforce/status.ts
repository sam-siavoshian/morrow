import { PROFILE_MAX_CONCURRENT, type EnvironmentPhase, type LeaseView, type ProfileView, type VmState, type WorkforceView } from "@morrow/contracts";
import type { BadgeTone } from "@/components/ui/badge";
import type { StatusTone } from "@/components/ui/status-dot";

/** "Workers at once" for one login, every value the contract allows (1 to `PROFILE_MAX_CONCURRENT`). */
export const WORKER_SLOT_CHOICES = Array.from({ length: PROFILE_MAX_CONCURRENT }, (_, i) => String(i + 1));

/** VM power, drawn as a dot. Kept apart from CLI status on purpose: a running VM can hold a signed-out CLI. */
export type PowerStatus = { label: string; tone: StatusTone; pulse: boolean };

export function vmPower(vmState: VmState, phase: EnvironmentPhase): PowerStatus {
  if (phase === "disconnected") return { label: "Disconnected", tone: "idle", pulse: false };
  switch (vmState) {
    case "running":
      return { label: "Running", tone: "success", pulse: false };
    case "starting":
      return { label: "Starting", tone: "attention", pulse: true };
    case "pausing":
      return { label: "Pausing", tone: "attention", pulse: true };
    case "paused":
      return { label: "Paused", tone: "idle", pulse: false };
    case "stopped":
      return { label: "Stopped", tone: "neutral", pulse: false };
    default:
      // No VM yet while it is being created; after that, unknown means we lost track of it.
      return phase === "provisioning"
        ? { label: "Starting", tone: "attention", pulse: true }
        : { label: "Unknown", tone: "idle", pulse: false };
  }
}

export type PhaseInfo = { label: string; tone: BadgeTone; working: boolean };

const PHASE: Record<EnvironmentPhase, PhaseInfo> = {
  provisioning: { label: "Creating VM", tone: "sky", working: true },
  bootstrapping: { label: "Setting up", tone: "sky", working: true },
  awaiting_login: { label: "Waiting for sign-in", tone: "lemon", working: false },
  ready: { label: "Ready", tone: "mint", working: false },
  paused: { label: "Paused", tone: "neutral", working: false },
  error: { label: "Setup failed", tone: "rose", working: false },
  disconnected: { label: "Disconnected", tone: "outline", working: false },
};

export const phaseInfo = (phase: EnvironmentPhase): PhaseInfo => PHASE[phase];

export type AuthBadge = { label: string; tone: BadgeTone };

export function authBadge(auth: ProfileView["auth"]): AuthBadge {
  if (auth === "ok") return { label: "Signed in", tone: "mint" };
  if (auth === "auth_required") return { label: "Signed out", tone: "peach" };
  return { label: "Not checked", tone: "outline" };
}

export type AvailabilityKind = "ready" | "busy" | "limited" | "auth" | "offline" | "unchecked";

export type Availability = {
  kind: AvailabilityKind;
  label: string;
  tone: BadgeTone;
  /** When a limit lifts, if the CLI said so and it is still ahead. */
  until: number | null;
};

export type AvailabilityProfile = Pick<ProfileView, "auth" | "availability" | "cooldownUntil" | "activeLeases" | "maxConcurrent">;

/**
 * One word for whether this CLI can take work right now, shared by the Workforce page and the composer's
 * picker so both always say the same thing. Never a balance: only what the CLI tells us. Order matters:
 * a signed-out CLI is "Auth needed" even on a stopped VM, because that is the thing a person has to fix.
 * `online` is whether the CLI's machine can run it; each screen says what that means for it.
 */
export function profileAvailability(profile: AvailabilityProfile, ctx: { now: number; online: boolean }): Availability {
  const base = { until: null };
  if (profile.auth === "auth_required") return { ...base, kind: "auth", label: "Auth needed", tone: "peach" };
  if (!ctx.online || profile.availability === "offline") return { ...base, kind: "offline", label: "Offline", tone: "neutral" };
  if (profile.availability === "limited") {
    const until = profile.cooldownUntil !== null && profile.cooldownUntil > ctx.now ? profile.cooldownUntil : null;
    return { kind: "limited", label: "Limited", tone: "lemon", until };
  }
  // Busy only when every slot is taken, the backend's eligibility rule: a free slot still takes work.
  if (profile.activeLeases >= profile.maxConcurrent) return { ...base, kind: "busy", label: "Busy", tone: "sky" };
  if (profile.auth === "unknown") return { ...base, kind: "unchecked", label: "Not checked", tone: "outline" };
  return { ...base, kind: "ready", label: "Ready", tone: "mint" };
}

/** `profileAvailability` for a CLI on a VM: online only while the VM runs and its Relay node is connected. */
export function cliAvailability(profile: AvailabilityProfile, ctx: { now: number; vmRunning: boolean; nodeOnline: boolean }): Availability {
  return profileAvailability(profile, { now: ctx.now, online: ctx.vmRunning && ctx.nodeOnline });
}

const LIVE_LEASE: ReadonlySet<LeaseView["state"]> = new Set(["reserved", "spawning", "running"]);

/** Live leases on any of these profiles: the workers running on an environment right now. */
export function liveLeaseCount(workforce: Pick<WorkforceView, "leases"> | null, profileIds: ReadonlySet<string>): number {
  if (!workforce) return 0;
  let count = 0;
  for (const lease of Object.values(workforce.leases)) if (profileIds.has(lease.profileId) && LIVE_LEASE.has(lease.state)) count++;
  return count;
}

/**
 * The viewer's own signed-out CLIs: the attention count on the Workforce link. Only the VM owner can
 * sign a CLI back in (the terminal is theirs), so a teammate's lost login is not counted against you.
 */
export function signedOutCount(workforce: Pick<WorkforceView, "profiles"> | null, viewerId: string | null): number {
  if (!workforce || !viewerId) return 0;
  let count = 0;
  for (const profile of Object.values(workforce.profiles)) if (profile.ownerUserId === viewerId && profile.auth === "auth_required") count++;
  return count;
}

/** Why "Sign in again" is disabled, or null when the private terminal can open. Mirrors the terminal route. */
export function signInBlocker(phase: EnvironmentPhase): string | null {
  if (phase === "awaiting_login" || phase === "ready") return null;
  return phase === "paused" ? "Resume this VM to sign in." : "Available once the VM is set up and running.";
}

/** "4:10 PM" today, "Tue 4:10 PM" within a week, else a short date. */
export function formatResetTime(at: number, now: number, locale?: string): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  if (at - now < 6 * 24 * 60 * 60 * 1000) return `${date.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString(locale, { month: "short", day: "numeric" })} ${time}`;
}
