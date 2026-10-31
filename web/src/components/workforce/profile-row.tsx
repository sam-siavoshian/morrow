"use client";

import type { ProfileView, ProjectView } from "@morrow/contracts";
import { Ellipsis, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";
import { useState } from "react";
import { HARNESS_LABEL, HarnessIcon } from "@/components/harness/harness-icon";
import { SettingsRow } from "@/components/settings/rows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Menu, MenuItem } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { useMinuteClock } from "@/components/ui/timer";
import { toast } from "@/components/ui/toast";
import { checkProfile, errorMessage, registerProfile, removeProfile, updateProfile } from "@/lib/api";
import { optimisticProfile, optimisticRemoveProfile, useTeamStoreApi } from "@/lib/store";
import { DisabledHint } from "./disabled-hint";
import { authBadge, cliAvailability, formatResetTime, WORKER_SLOT_CHOICES } from "./status";

type ProfileRowProps = {
  teamId: string;
  profile: ProfileView;
  projects: readonly ProjectView[];
  vmRunning: boolean;
  nodeOnline: boolean;
  /** The environment's owner: the only one who can check, remove or sign this CLI in. */
  canManage: boolean;
  /** Why the private terminal can't open right now, or null when it can. */
  signInBlocker: string | null;
  /** Opens the owner's private terminal with this CLI's sign-in command typed in. */
  onSignIn: (profile: ProfileView) => void;
};

const SLOT_OPTIONS = WORKER_SLOT_CHOICES.map((value) => ({ value, label: `${value} at once` }));

function scopeText(profile: ProfileView, projects: readonly ProjectView[]): string {
  if (profile.scopes === "all") return "All projects";
  const names = profile.scopes.map((id) => projects.find((p) => p.id === id)?.repoFullName.split("/")[1] ?? "removed project");
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
}

/** Probes one CLI and says what it found. Used by "Check now" and when the sign-in terminal closes. */
export async function checkAndReport(teamId: string, profile: Pick<ProfileView, "id" | "cli">): Promise<void> {
  const name = HARNESS_LABEL[profile.cli];
  try {
    const { probe } = await checkProfile(teamId, profile.id);
    if (!probe.ok) toast.error("Couldn't reach the VM", { description: "The check timed out. Try again in a moment." });
    else if (!probe.installed) toast.warning(`${name} isn't installed on this VM`);
    else if (probe.auth === "ok") toast.success(`${name} is signed in`);
    else if (probe.auth === "auth_required")
      toast.warning(`${name} is signed out`, { description: "Choose Sign in again, finish the steps in the terminal, then check." });
    else toast.warning(`Couldn't confirm ${name}'s sign-in`, { description: "Not signed in yet? Choose Sign in. Otherwise check again in a moment." });
  } catch (e) {
    toast.error("Check failed", { description: errorMessage(e, "Try again in a moment.") });
  }
}

/** One CLI login on a VM: who it is, whether it can take work, and what it is doing. */
export function ProfileRow({ teamId, profile, projects, vmRunning, nodeOnline, canManage, signInBlocker, onSignIn }: ProfileRowProps) {
  const now = useMinuteClock();
  const store = useTeamStoreApi();
  const [checking, setChecking] = useState(false);
  const auth = authBadge(profile.auth);
  const availability = cliAvailability(profile, { now, vmRunning, nodeOnline });
  const name = HARNESS_LABEL[profile.cli];
  const label = profile.label;

  async function check() {
    setChecking(true);
    try {
      await checkAndReport(teamId, profile);
    } finally {
      setChecking(false);
    }
  }

  /** Shown at once; the old number comes back if the server refuses. Running workers are never stopped. */
  async function setWorkers(maxConcurrent: number) {
    if (maxConcurrent === profile.maxConcurrent) return;
    try {
      await optimisticProfile(store, { ...profile, maxConcurrent }, () => updateProfile(teamId, profile.id, { maxConcurrent }));
    } catch (e) {
      toast.error("Couldn't change workers at once", { description: errorMessage(e, "Try again in a moment.") });
      return;
    }
    if (maxConcurrent < profile.activeLeases)
      toast(`${label} runs up to ${maxConcurrent} at once`, {
        description: `The ${profile.activeLeases} running now keep going. New work waits until fewer than ${maxConcurrent} are running.`,
      });
  }

  async function remove() {
    const { cli, scopes, maxConcurrent } = profile;
    try {
      // The row leaves at once; it comes back if the server refuses.
      await optimisticRemoveProfile(store, profile.id, () => removeProfile(teamId, profile.id));
    } catch (e) {
      toast.error("Couldn't remove it", { description: errorMessage(e, "Try again in a moment.") });
      return;
    }
    // The login stays on the VM, so adding the profile back restores it exactly.
    toast(`Removed ${label}`, {
      action: {
        label: "Undo",
        onClick: () => {
          registerProfile(teamId, profile.envId, { cli, label, scopes, maxConcurrent }).catch((e) =>
            toast.error("Couldn't restore it", { description: errorMessage(e, "Add it again from Add CLI.") }),
          );
        },
      },
    });
  }

  return (
    <SettingsRow
      icon={<HarnessIcon cli={profile.cli} size={28} />}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{label}</span>
          {label !== name ? <span className="truncate text-[12.5px] font-[450] text-muted">{name}</span> : null}
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-x-2">
          <span>{scopeText(profile, projects)}</span>
          <span aria-hidden="true" className="text-faint">·</span>
          <span className="tabular-nums">
            {profile.activeLeases} of {profile.maxConcurrent} running
          </span>
        </span>
      }
      control={
        <>
          <Badge tone={auth.tone} size="sm">
            {auth.label}
          </Badge>
          <Badge tone={availability.tone} size="sm">
            {availability.until && now ? `Limited until ${formatResetTime(availability.until, now)}` : availability.label}
          </Badge>
          {canManage ? (
            <>
              <Select
                size="sm"
                aria-label={`Workers at once for ${label}`}
                value={String(profile.maxConcurrent)}
                onValueChange={(next) => next && void setWorkers(Number(next))}
                options={SLOT_OPTIONS}
              />
              {profile.auth !== "ok" ? (
                <DisabledHint hint={signInBlocker}>
                  <Button size="xs" variant="primary" disabled={signInBlocker !== null || checking} onClick={() => onSignIn(profile)}>
                    <SquareTerminal />
                    {profile.auth === "auth_required" ? "Sign in again" : "Sign in"}
                  </Button>
                </DisabledHint>
              ) : null}
              <Button size="xs" variant="secondary" loading={checking} onClick={check}>
                <RefreshCw />
                Check now
              </Button>
              <Menu
                align="end"
                trigger={
                  <IconButton label={`More for ${label}`} size="xs" variant="quiet">
                    <Ellipsis />
                  </IconButton>
                }
              >
                <MenuItem icon={<Trash2 className="size-4" />} tone="danger" onClick={remove}>
                  Remove from team
                </MenuItem>
              </Menu>
            </>
          ) : null}
        </>
      }
    />
  );
}
