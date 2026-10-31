import type { EnvironmentView, ProfileView } from "@morrow/contracts";
import { profileAvailability, type AvailabilityKind } from "@/components/workforce/status";

// How one CLI profile reads in the picker and the plan card. Never a token balance: only
// ready / busy / limited (with a reset time when we know it) / auth needed / offline.

export type ProfileStateKind = AvailabilityKind | "scope";

export type ProfileState = {
  kind: ProfileStateKind;
  label: string;
  /** Only profiles that can take work can be picked or placed. */
  pickable: boolean;
};

/** `12m`, `1h 05m`; under a minute reads as `<1m`. */
export function formatDuration(ms: number): string {
  const minutes = Math.ceil(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The Workforce page's `profileAvailability`, plus the two things only placement cares about: project scope and pickability. */
export function profileState(
  profile: ProfileView,
  env: Pick<EnvironmentView, "phase"> | undefined,
  now: number,
  projectId?: string | null,
): ProfileState {
  // Placement needs a set-up VM (the backend's eligibility rule), so that is what "online" means here.
  const availability = profileAvailability(profile, { now, online: env?.phase === "ready" });
  const { kind } = availability;
  if (kind === "auth" || kind === "offline") return { kind, label: availability.label, pickable: false };
  if (kind === "limited") {
    const label = availability.until !== null ? `Limited (resets in ${formatDuration(availability.until - now)})` : "Limited";
    return { kind, label, pickable: false };
  }
  if (projectId && profile.scopes !== "all" && !profile.scopes.includes(projectId))
    return { kind: "scope", label: "Not on this project", pickable: false };
  // A CLI nobody has checked yet still takes work, as the backend allows.
  return { kind, label: availability.label, pickable: kind === "ready" || kind === "unchecked" };
}
