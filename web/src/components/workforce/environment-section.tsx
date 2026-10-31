"use client";

import { CliKind, type EnvironmentView, type MemberView, type ProfileView, type ProjectView } from "@morrow/contracts";
import { Ellipsis, Pause, Play, Plus, RotateCw, SquareTerminal, Unplug } from "lucide-react";
import { useState } from "react";
import { HARNESSES, HarnessStack } from "@/components/harness/harness-icon";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/components/settings/rows";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Menu, MenuItem } from "@/components/ui/menu";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { toast } from "@/components/ui/toast";
import { disconnectEnvironment, errorMessage, pauseEnvironment, resumeEnvironment } from "@/lib/api";
import { optimisticEnvironment, useTeamStoreApi } from "@/lib/store";
import { AddProfileDialog } from "./add-profile-dialog";
import { DisabledHint } from "./disabled-hint";
import { ProfileRow } from "./profile-row";
import { SetupProgress } from "./setup-progress";
import { phaseInfo, signInBlocker, vmPower } from "./status";

const TERMINAL_PHASES = new Set<EnvironmentView["phase"]>(["awaiting_login", "ready"]);
const SETUP_PHASES = new Set<EnvironmentView["phase"]>(["provisioning", "bootstrapping"]);

type EnvironmentSectionProps = {
  teamId: string;
  env: EnvironmentView;
  owner: MemberView | null;
  profiles: readonly ProfileView[];
  projects: readonly ProjectView[];
  liveLeases: number;
  viewerId: string;
  viewerIsAdmin: boolean;
  /** With a profile: its sign-in command is typed in, and it is checked when the terminal closes. */
  onOpenTerminal: (envId: string, signIn?: ProfileView) => void;
};

/** One engineer's VM: power and setup up top, then a row per CLI signed in on it. */
export function EnvironmentSection({
  teamId,
  env,
  owner,
  profiles,
  projects,
  liveLeases,
  viewerId,
  viewerIsAdmin,
  onOpenTerminal,
}: EnvironmentSectionProps) {
  const store = useTeamStoreApi();
  const [busy, setBusy] = useState<"pause" | "resume" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [addingProfile, setAddingProfile] = useState(false);

  const isOwner = env.ownerUserId === viewerId;
  const canAdminister = isOwner || viewerIsAdmin;
  const power = vmPower(env.vmState, env.phase);
  const phase = phaseInfo(env.phase);
  const vmRunning = env.vmState === "running";
  const ownerName = owner ? `@${owner.login}` : "a former member";
  const missing = CliKind.options.filter((cli) => !profiles.some((p) => p.cli === cli));
  const canAddProfile = isOwner && TERMINAL_PHASES.has(env.phase) && missing.length > 0;

  async function pause() {
    setBusy("pause");
    try {
      // Shows Pausing at once; the VM takes a few seconds to get there.
      await optimisticEnvironment(store, { ...env, vmState: "pausing" }, () => pauseEnvironment(teamId, env.id));
      toast(`Paused ${env.name}`, isOwner ? { action: { label: "Undo", onClick: () => void resume() } } : undefined);
    } catch (e) {
      toast.error("Couldn't pause", { description: errorMessage(e, "Try again in a moment.") });
    } finally {
      setBusy(null);
    }
  }

  async function resume() {
    setBusy("resume");
    try {
      // A paused VM shows Starting at once. Retrying a failed setup has no honest guess, so it waits for the server.
      if (env.phase === "paused") await optimisticEnvironment(store, { ...env, vmState: "starting" }, () => resumeEnvironment(teamId, env.id));
      else await resumeEnvironment(teamId, env.id);
    } catch (e) {
      toast.error(env.phase === "error" ? "Couldn't retry setup" : "Couldn't resume", { description: errorMessage(e, "Try again in a moment.") });
    } finally {
      setBusy(null);
    }
  }

  const actions = (
    <>
      {isOwner ? (
        <DisabledHint
          hint={
            TERMINAL_PHASES.has(env.phase) ? null : "Available once the VM is set up and running."
          }
        >
          <Button
            size="sm"
            variant="secondary"
            disabled={!TERMINAL_PHASES.has(env.phase)}
            onClick={() => onOpenTerminal(env.id)}
          >
            <SquareTerminal />
            Open private terminal
          </Button>
        </DisabledHint>
      ) : null}
      {isOwner && env.phase === "paused" ? (
        <Button size="sm" variant="secondary" loading={busy === "resume"} onClick={resume}>
          <Play />
          Resume
        </Button>
      ) : null}
      {isOwner && env.phase === "error" ? (
        <Button size="sm" variant="secondary" loading={busy === "resume"} onClick={resume}>
          <RotateCw />
          Retry setup
        </Button>
      ) : null}
      {canAdminister && TERMINAL_PHASES.has(env.phase) && vmRunning ? (
        <DisabledHint hint={liveLeases > 0 ? `${liveLeases} worker${liveLeases === 1 ? " is" : "s are"} running here.` : null}>
          <Button size="sm" variant="ghost" disabled={liveLeases > 0} loading={busy === "pause"} onClick={pause}>
            <Pause />
            Pause if idle
          </Button>
        </DisabledHint>
      ) : null}
      {canAdminister ? (
        <Menu
          align="end"
          trigger={
            <IconButton label={`More for ${env.name}`} size="sm" variant="ghost">
              <Ellipsis />
            </IconButton>
          }
        >
          <MenuItem icon={<Unplug className="size-4" />} tone="danger" onClick={() => setConfirmDisconnect(true)}>
            Disconnect…
          </MenuItem>
        </Menu>
      ) : null}
    </>
  );

  return (
    <SettingsSection
      title={env.name}
      meta={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-muted">
          <span className="flex items-center gap-1.5" title="VM power">
            <StatusDot tone={power.tone} pulse={power.pulse} />
            VM {power.label.toLowerCase()}
          </span>
          <span className="flex items-center gap-1.5" title="Agent Relay node">
            <StatusDot tone={env.nodeOnline ? "success" : "idle"} />
            Node {env.nodeOnline ? "online" : "offline"}
          </span>
          <Badge tone={phase.tone} size="sm">
            {phase.working ? <RadarSpinner /> : null}
            {phase.label}
          </Badge>
          <span className="flex items-center gap-1.5">
            <Avatar name={owner?.name ?? owner?.login ?? "?"} src={owner?.avatarUrl} login={owner?.login} size={18} />
            {isOwner ? "Yours" : ownerName}
          </span>
        </div>
      }
      actions={actions}
    >
      <SettingsGroup>
        {env.phase === "error" ? (
          <div className="p-4">
            <Alert tone="danger" title="Setup stopped">
              {env.lastError ?? "Something went wrong while setting up this VM."} {isOwner ? "Retry setup to pick up where it left off." : null}
            </Alert>
          </div>
        ) : null}
        {SETUP_PHASES.has(env.phase) ? (
          <div className="px-4 py-4">
            <SetupProgress phase={env.phase} since={env.createdAt} />
          </div>
        ) : null}
        {profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            teamId={teamId}
            profile={profile}
            projects={projects}
            vmRunning={vmRunning}
            nodeOnline={env.nodeOnline}
            canManage={isOwner}
            signInBlocker={signInBlocker(env.phase)}
            onSignIn={(p) => onOpenTerminal(env.id, p)}
          />
        ))}
        {profiles.length === 0 && TERMINAL_PHASES.has(env.phase) ? (
          <SettingsRow
            icon={isOwner ? <HarnessStack clis={[...HARNESSES]} size={18} max={HARNESSES.length} /> : undefined}
            title="No CLIs yet"
            description={
              isOwner
                ? "Open the private terminal, sign in to Claude Code, Codex, Cursor, Gemini CLI, Grok or opencode, then add it here."
                : `${ownerName} hasn't added a CLI to this VM yet.`
            }
          />
        ) : null}
        {env.phase === "paused" && profiles.length === 0 ? (
          <SettingsRow title="Paused" description="Its CLIs show up again once it resumes." />
        ) : null}
        {canAddProfile ? (
          <div className="px-2 py-1.5">
            <Button size="sm" variant="quiet" onClick={() => setAddingProfile(true)}>
              <Plus />
              Add CLI
            </Button>
          </div>
        ) : null}
      </SettingsGroup>

      {canAddProfile ? (
        <AddProfileDialog
          open={addingProfile}
          onOpenChange={setAddingProfile}
          teamId={teamId}
          envId={env.id}
          available={missing}
          projects={projects}
          onAdded={(profile) => toast.success(`Added ${profile.label}`, { description: "Check it once you've signed in." })}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={`Disconnect ${env.name}?`}
        description="This deletes the VM, its CLI logins and any work not pushed to GitHub. Running workers on it stop. You can't undo this."
        confirmLabel="Disconnect VM"
        onConfirm={async () => {
          await disconnectEnvironment(teamId, env.id);
          toast(`Disconnected ${env.name}`);
        }}
      />
    </SettingsSection>
  );
}
