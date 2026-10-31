"use client";

import { CliKind, type MeView } from "@morrow/contracts";
import { Check, FolderGit2, Server, SquareTerminal, Users } from "lucide-react";
import type { ReactNode } from "react";
import { HARNESS_LABEL, HarnessIcon } from "@/components/harness/harness-icon";
import { phaseInfo } from "@/components/workforce/status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useTeam, useWorkforce } from "@/lib/store";
import { useMyEnvironment } from "./environment-step";
import type { Step } from "./machine";
import { PrimaryAction, StepActions } from "./step-chrome";
import { StillConnecting, useStuck } from "./still-connecting";

type FinishStepProps = {
  me: MeView;
  leaving: boolean;
  onOpen: () => void;
  onEdit: (step: Step) => void;
};

/** A last look at what is set up, read live from the team, then into it. */
export function FinishStep({ me, leaving, onOpen, onEdit }: FinishStepProps) {
  const team = useTeam();
  const workforce = useWorkforce();
  const env = useMyEnvironment(me.user.id);
  const stuck = useStuck(team === null);

  if (team === null) {
    return (
      <>
        <StillConnecting label="Loading your team" stuck={stuck} />
        <StepActions>
          <PrimaryAction disabled>Open team</PrimaryAction>
        </StepActions>
      </>
    );
  }

  const signedIn = env
    ? CliKind.options.filter((cli) => Object.values(workforce?.profiles ?? {}).some((p) => p.envId === env.id && p.cli === cli && p.auth === "ok"))
    : [];
  const members = team.members.length;

  return (
    <>
      <ul className="flex flex-col divide-y divide-border">
        <Row
          icon={<Users />}
          title={team.name}
          detail={members === 1 ? "Just you so far. Invite teammates from Settings." : `${members} members`}
          done
          onEdit={() => onEdit("team")}
        />
        <Row
          icon={<FolderGit2 />}
          title={team.projects.length === 0 ? "No repos linked" : team.projects.length === 1 ? "1 repo linked" : `${team.projects.length} repos linked`}
          detail={team.projects.length === 0 ? "Agents need a repo to work on." : team.projects.map((p) => p.repoFullName).join(", ")}
          done={team.projects.length > 0}
          onEdit={() => onEdit("repos")}
        />
        <Row
          icon={<Server />}
          title={env ? env.name : "No VM yet"}
          detail={env ? phaseInfo(env.phase).label : "Your CLIs sign in on a VM of your own."}
          done={env?.phase === "ready" || env?.phase === "awaiting_login"}
          onEdit={() => onEdit("environment")}
        />
        <Row
          icon={<SquareTerminal />}
          title={signedIn.length === 0 ? "No agents signed in" : signedIn.length === 1 ? "1 agent signed in" : `${signedIn.length} agents signed in`}
          detail={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {CliKind.options.map((cli) => {
                const on = signedIn.includes(cli);
                return (
                  <span key={cli} className={cn("inline-flex items-center gap-1.5", on ? "text-label-secondary" : "opacity-60")}>
                    <HarnessIcon cli={cli} size={14} decorative />
                    {HARNESS_LABEL[cli]}
                    <span className="sr-only">{on ? "signed in" : "not signed in"}</span>
                  </span>
                );
              })}
            </span>
          }
          done={signedIn.length > 0}
          onEdit={env ? () => onEdit("agents") : undefined}
        />
      </ul>
      <StepActions>
        <PrimaryAction onClick={onOpen} loading={leaving} className="max-w-full">
          <span className="truncate">Open {team.name}</span>
        </PrimaryAction>
      </StepActions>
    </>
  );
}

type RowProps = {
  icon: ReactNode;
  title: string;
  detail: ReactNode;
  done: boolean;
  onEdit?: () => void;
};

function Row({ icon, title, detail, done, onEdit }: RowProps) {
  return (
    <li className="flex min-h-[60px] items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span className="grid size-9 shrink-0 place-items-center rounded-control-compact bg-surface text-muted shadow-raised [&>svg]:size-4.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-[14px] font-[600] tracking-[-0.01em]">
          <span className="truncate">{title}</span>
          {done ? <Check className="size-3.5 shrink-0 text-soft-mint-ink" strokeWidth={2.5} aria-label="Done" /> : null}
        </p>
        <div className={cn("truncate text-[12.5px]", done ? "text-muted" : "text-faint")}>{detail}</div>
      </div>
      {onEdit ? (
        <Button size="xs" variant="quiet" onClick={onEdit}>
          {done ? "Change" : "Set up"}
        </Button>
      ) : null}
    </li>
  );
}
