"use client";

import { CliKind, type MeView, type ProfileCheckResponse, type ProfileView } from "@morrow/contracts";
import { Check, RefreshCw, SquareTerminal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { HARNESS_LABEL, HarnessIcon } from "@/components/harness/harness-icon";
import { TerminalDialog } from "@/components/terminal/terminal-dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { checkProfile, errorMessage, registerProfile } from "@/lib/api";
import { useTeamId, useWorkforce } from "@/lib/store";
import { USABLE, useMyEnvironment } from "./environment-step";
import { agentCardState } from "./machine";
import { PrimaryAction, StepActions } from "./step-chrome";
import { StillConnecting } from "./still-connecting";

/** What to type to sign in. Typed at the prompt for the person to review; never run for them. */
export const LOGIN_COMMAND: Record<CliKind, { command: string; hint: ReactNode }> = {
  claude: {
    command: "claude",
    hint: (
      <>
        Review the command, then press Enter to run it. When Claude Code opens, type <Code>/login</Code> and follow the steps.
      </>
    ),
  },
  codex: {
    command: "codex login --device-auth",
    hint: <>Review the command, then press Enter to run it. Codex shows a code to enter on openai.com.</>,
  },
  opencode: {
    command: "opencode auth login",
    hint: <>Review the command, then press Enter to run it. Pick your provider and follow the prompts.</>,
  },
  cursor: {
    command: "NO_OPEN_BROWSER=1 cursor-agent login",
    hint: <>Review the command, then press Enter to run it. Cursor prints a sign-in link: open it and sign in.</>,
  },
  gemini: {
    command: "NO_BROWSER=true gemini",
    hint: (
      <>
        Review the command, then press Enter to run it. If Gemini asks how to sign in, pick Sign in with Google. Open the link it
        prints, then paste the authorization code back here.
      </>
    ),
  },
  grok: {
    command: "grok login --device-auth",
    hint: <>Review the command, then press Enter to run it. Grok shows a code to enter on x.ai.</>,
  },
};

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-[4px] bg-fill px-1 py-px font-mono text-[12.5px] text-text">{children}</code>;
}

function probeNote(result: ProfileCheckResponse): string | null {
  const { probe } = result;
  if (!probe.ok) return "Couldn't reach your VM. Try again in a moment.";
  if (!probe.installed) return "It isn't installed on this VM.";
  if (probe.auth !== "ok") return "Not signed in yet. Finish the sign-in in the terminal, then check again.";
  return null;
}

type AgentsStepProps = { me: MeView; onContinue: () => void };

/** One card per CLI: sign in through the private terminal, then check. */
export function AgentsStep({ me, onContinue }: AgentsStepProps) {
  const teamId = useTeamId();
  const env = useMyEnvironment(me.user.id);
  const workforce = useWorkforce();
  const [checking, setChecking] = useState<CliKind | null>(null);
  const [notes, setNotes] = useState<Partial<Record<CliKind, string>>>({});
  const [checked, setChecked] = useState<Partial<Record<CliKind, ProfileView>>>({});
  const [terminal, setTerminal] = useState<CliKind | null>(null);

  // No environment: the machine sends this step back to Environment once the team says so.
  if (!env)
    return (
      <>
        <StillConnecting label="Looking for your environment" stuck={false} />
        <StepActions>
          <PrimaryAction disabled>Continue</PrimaryAction>
        </StepActions>
      </>
    );
  const envId = env.id;
  const usable = USABLE.has(env.phase);
  // A check we just ran is the freshest word on sign-in; the socket's view fills in the rest.
  const profileOf = (cli: CliKind): ProfileView | null =>
    checked[cli] ?? Object.values(workforce?.profiles ?? {}).find((p) => p.envId === envId && p.cli === cli) ?? null;
  const readyCount = CliKind.options.filter((cli) => profileOf(cli)?.auth === "ok").length;

  async function check(cli: CliKind) {
    setChecking(cli);
    setNotes((n) => ({ ...n, [cli]: undefined }));
    try {
      const profile = profileOf(cli) ?? (await registerProfile(teamId, envId, { cli, label: HARNESS_LABEL[cli] }));
      const result = await checkProfile(teamId, profile.id);
      setChecked((c) => ({ ...c, [cli]: result.profile }));
      setNotes((n) => ({ ...n, [cli]: probeNote(result) ?? undefined }));
    } catch (e) {
      setNotes((n) => ({ ...n, [cli]: errorMessage(e, "The check failed. Try again.") }));
    } finally {
      setChecking(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!usable ? <Alert tone="neutral">Your VM isn&apos;t running right now. Resume it from the previous step to sign in.</Alert> : null}
      <ul className="flex flex-col gap-2.5">
        {CliKind.options.map((cli) => {
          const state = agentCardState(profileOf(cli), checking === cli);
          return (
            <li key={cli} className="flex flex-col gap-3 rounded-card bg-surface p-3.5 shadow-raised sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <HarnessIcon cli={cli} size={32} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[14.5px] font-[600] tracking-[-0.012em]">
                    {HARNESS_LABEL[cli]}
                    {state === "ready" ? (
                      <Badge tone="mint" size="sm">
                        <Check strokeWidth={2.5} />
                        Ready
                      </Badge>
                    ) : state === "checking" ? (
                      <Badge tone="sky" size="sm">
                        <RadarSpinner />
                        Checking…
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[12.5px] leading-[1.45] text-muted" aria-live="polite">
                    {notes[cli] ?? (state === "ready" ? "Signed in on your VM." : <>Sign in with <Code>{LOGIN_COMMAND[cli].command}</Code></>)}
                  </p>
                </div>
              </div>
              {state !== "ready" ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="secondary" disabled={!usable || checking !== null} onClick={() => setTerminal(cli)}>
                    <SquareTerminal />
                    Sign in
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!usable || checking !== null} onClick={() => check(cli)}>
                    <RefreshCw />
                    Check
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="text-[13px] text-muted tabular-nums" aria-live="polite">
        {readyCount === 0 ? "One signed-in CLI is enough to start." : `${readyCount} of ${CliKind.options.length} signed in.`}
      </p>
      <StepActions>
        <PrimaryAction onClick={onContinue}>{readyCount === 0 ? "Finish later" : "Continue"}</PrimaryAction>
      </StepActions>
      {terminal ? (
        <TerminalDialog
          open
          onOpenChange={(open) => {
            if (!open) setTerminal(null);
          }}
          teamId={teamId}
          envId={envId}
          title={`Sign in to ${HARNESS_LABEL[terminal]}`}
          hint={LOGIN_COMMAND[terminal].hint}
          command={LOGIN_COMMAND[terminal].command}
        />
      ) : null}
    </div>
  );
}
