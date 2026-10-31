"use client";

import { TEAM_NAME_MAX, type MeView, type TeamView } from "@morrow/contracts";
import { ChevronRight, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { inviteFromInput } from "@/components/auth/invite-token";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toast";
import { acceptInvite, createTeam, errorMessage } from "@/lib/api";
import { useTeam } from "@/lib/store";
import { PrimaryAction, StepActions } from "./step-chrome";

type Mode = "create" | "join";

type TeamStepProps = {
  me: MeView;
  /** The team already chosen, when coming back to this step. */
  teamId: string | null;
  onChosen: (teamId: string) => void;
  onChangeTeam: () => void;
};

/** Create a team, join one with an invite link, or carry on with one you are in. */
export function TeamStep({ me, teamId, onChosen, onChangeTeam }: TeamStepProps) {
  if (teamId) return <TeamChosen me={me} teamId={teamId} onContinue={() => onChosen(teamId)} onChange={onChangeTeam} />;
  return <ChooseTeam me={me} onChosen={onChosen} />;
}

function ChooseTeam({ me, onChosen }: { me: MeView; onChosen: (teamId: string) => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("create");
  const [name, setName] = useState(me.teams.length === 0 ? `${me.user.name?.split(" ")[0] ?? me.user.login}'s team` : "");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) return setError("Give your team a name.");
    setBusy(true);
    setError(null);
    try {
      const team: TeamView = await createTeam(trimmed);
      toast.success(`Created ${team.name}`);
      onChosen(team.id);
      // The server's view of `me` now lists the team; refresh it so the page stays in sync.
      router.refresh();
    } catch (e) {
      setError(errorMessage(e, "Couldn't create the team. Try again."));
      setBusy(false);
    }
  }

  async function join(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    // Only the token is kept: a pasted host is ignored, so nothing here can send anyone off-site.
    const parsed = inviteFromInput(invite);
    if (!parsed) return setError("That doesn't look like an invite link. Paste the whole link.");
    setBusy(true);
    setError(null);
    try {
      const team = await acceptInvite(parsed.token);
      toast.success(`You joined ${team.name}`);
      onChosen(team.id);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e, "Couldn't join the team. Try again."));
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-5">
      <Segmented
        aria-label="Create or join"
        value={mode}
        onValueChange={switchMode}
        options={[
          { value: "create", label: "Create a team" },
          { value: "join", label: "Join with a link" },
        ]}
        className="self-center"
      />

      {mode === "create" ? (
        <form id="onboarding-team" onSubmit={create} noValidate>
          <Field label="Team name" description="Teammates pool their CLIs here. You can invite them from Settings." error={error}>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              maxLength={TEAM_NAME_MAX}
              placeholder="Acme engineering"
              autoComplete="off"
              disabled={busy}
            />
          </Field>
        </form>
      ) : (
        <form id="onboarding-team" onSubmit={join} noValidate>
          <Field label="Invite link" description="Ask an owner or admin of the team for one." error={error}>
            <Input
              value={invite}
              onChange={(e) => {
                setInvite(e.target.value);
                setError(null);
              }}
              placeholder="https://…/join/…"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </Field>
        </form>
      )}

      {me.teams.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <span className="text-[13px] font-[550] text-label-secondary">Or carry on with a team you&apos;re in</span>
          <ul className="flex flex-col gap-1">
            {me.teams.map((team) => (
              <li key={team.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onChosen(team.id)}
                  className="flex h-11 w-full items-center gap-3 rounded-row px-3 text-left text-[14px] font-[550] transition-colors duration-150 hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-64"
                >
                  <Users className="size-4 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate">{team.name}</span>
                  <span className="text-[12.5px] font-[500] text-muted capitalize">{team.role}</span>
                  <ChevronRight className="size-4 text-faint" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <StepActions>
        <PrimaryAction type="submit" form="onboarding-team" loading={busy}>
          {mode === "create" ? "Create team" : "Join team"}
        </PrimaryAction>
      </StepActions>
    </div>
  );
}

type TeamChosenProps = { me: MeView; teamId: string; onContinue: () => void; onChange: () => void };

/** Back on this step with a team already picked: say which, and offer to change it. */
function TeamChosen({ me, teamId, onContinue, onChange }: TeamChosenProps) {
  // The live team when it has loaded; a team made a moment ago is not in `me` yet.
  const live = useTeam();
  const known = me.teams.find((t) => t.id === teamId);
  const name = live?.name ?? known?.name;
  const role = live?.viewerRole ?? known?.role;
  return (
    <div className="flex items-center gap-3 rounded-card bg-fill px-4 py-3.5 shadow-row-rim">
      <span className="grid size-9 shrink-0 place-items-center rounded-control-compact bg-surface text-muted shadow-raised">
        <Users className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14.5px] font-[600] tracking-[-0.012em]">{name ?? "Loading your team…"}</p>
        <p className="text-[12.5px] text-muted">{role ? `You're ${article(role)} ${role} here.` : "\u00a0"}</p>
      </div>
      <Button size="sm" variant="quiet" onClick={onChange}>
        Change
      </Button>
      <StepActions>
        <PrimaryAction onClick={onContinue}>Continue</PrimaryAction>
      </StepActions>
    </div>
  );
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
