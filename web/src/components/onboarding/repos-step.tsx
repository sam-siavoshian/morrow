"use client";

import type { MeView, ProjectView } from "@morrow/contracts";
import { canManageTeam } from "@/components/settings/permissions";
import { Alert } from "@/components/ui/alert";
import { toast } from "@/components/ui/toast";
import { useTeam } from "@/lib/store";
import { RepoList, useRepoPicker } from "./repo-picker";
import { linkLabel } from "./repo-selection";
import { PrimaryAction, SecondaryAction, StepActions } from "./step-chrome";
import { StillConnecting, useStuck } from "./still-connecting";

type ReposStepProps = { me: MeView; teamId: string; onDone: () => void };

/** Link the repos agents should work on, or skip. Members who can't link see what is linked. */
export function ReposStep({ me, teamId, onDone }: ReposStepProps) {
  const team = useTeam();
  const stuck = useStuck(team === null);

  if (team === null) {
    return (
      <>
        <StillConnecting label="Loading your team" stuck={stuck} />
        <StepActions>
          <PrimaryAction disabled>Continue</PrimaryAction>
        </StepActions>
      </>
    );
  }

  const role = team.viewerRole ?? me.teams.find((t) => t.id === teamId)?.role ?? "member";
  const linked = team.projects.map((p) => p.repoFullName);

  if (!canManageTeam(role)) {
    return (
      <>
        <Alert tone="neutral">
          {linked.length > 0
            ? `This team works on ${linked.join(", ")}. Only owners and admins link repos.`
            : "Only owners and admins link repos. Ask one to link the repos you'll work on."}
        </Alert>
        <StepActions>
          <PrimaryAction onClick={onDone}>Continue</PrimaryAction>
        </StepActions>
      </>
    );
  }

  return <Picker teamId={teamId} linked={linked} onDone={onDone} />;
}

function Picker({ teamId, linked, onDone }: { teamId: string; linked: string[]; onDone: () => void }) {
  const picker = useRepoPicker({ teamId, linked });
  const count = picker.selected.size;

  async function link() {
    const done: ProjectView[] = await picker.link();
    if (done.length === 0) return;
    toast.success(done.length === 1 ? `Linked ${done[0]!.repoFullName}` : `Linked ${done.length} repos`);
    // Some failed: stay, so the person sees which and why.
    if (done.length === count) onDone();
  }

  return (
    <>
      <RepoList picker={picker} onSubmit={() => void link()} />
      <StepActions>
        {count === 0 && linked.length > 0 ? (
          <PrimaryAction onClick={onDone}>Continue</PrimaryAction>
        ) : (
          <>
            <SecondaryAction onClick={onDone} disabled={picker.linking}>
              Skip for now
            </SecondaryAction>
            <PrimaryAction disabled={count === 0} loading={picker.linking} onClick={() => void link()}>
              {linkLabel(count)}
            </PrimaryAction>
          </>
        )}
      </StepActions>
    </>
  );
}
