"use client";

import { ENVIRONMENT_NAME_MAX, EnvironmentView, type MeView } from "@morrow/contracts";
import { RotateCw, Server } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { SetupProgress } from "@/components/workforce/setup-progress";
import { phaseInfo } from "@/components/workforce/status";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { createEnvironment, errorMessage, getEnvironment, resumeEnvironment } from "@/lib/api";
import { useTeam, useTeamId, useTeamStore } from "@/lib/store";
import { PrimaryAction, SecondaryAction, StepActions } from "./step-chrome";
import { StillConnecting, useStuck } from "./still-connecting";

/** While setup runs, ask REST this often too, in case a socket frame is missed. */
const POLL_MS = 4_000;
const SETUP = new Set<EnvironmentView["phase"]>(["provisioning", "bootstrapping"]);
export const USABLE = new Set<EnvironmentView["phase"]>(["awaiting_login", "ready"]);

/** The signed-in user's live environment in this team, if any. */
export function useMyEnvironment(userId: string): EnvironmentView | null | undefined {
  const team = useTeam();
  if (!team) return undefined;
  return team.environments.find((e) => e.ownerUserId === userId && e.phase !== "disconnected") ?? null;
}

type EnvironmentStepProps = {
  me: MeView;
  onContinue: () => void;
  /** Leave the rest for later: straight to the last step. */
  onLater: () => void;
};

/** Create the user's VM and watch it come up, phase by phase, live. */
export function EnvironmentStep({ me, onContinue, onLater }: EnvironmentStepProps) {
  const teamId = useTeamId();
  const env = useMyEnvironment(me.user.id);
  const applyFrame = useTeamStore((s) => s.applyFrame);
  const [name, setName] = useState(`${me.user.login}'s VM`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stuck = useStuck(env === undefined);

  // Socket frames drive the phases; this poll is only a safety net while setup runs.
  const envId = env?.id;
  const inSetup = env ? SETUP.has(env.phase) : false;
  useEffect(() => {
    if (!envId || !inSetup) return;
    const abort = new AbortController();
    const timer = window.setInterval(() => {
      getEnvironment(teamId, envId, { signal: abort.signal })
        // The detail adds profiles and leases; the frame carries only the environment itself.
        .then((detail) => applyFrame({ kind: "env.view", teamId, data: EnvironmentView.parse(detail) }))
        .catch(() => {});
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [teamId, envId, inSetup, applyFrame]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createEnvironment(teamId, { name: name.trim() || undefined });
      applyFrame({ kind: "env.view", teamId, data: created });
    } catch (e) {
      setError(errorMessage(e, "Couldn't create the VM. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!env || busy) return;
    setBusy(true);
    setError(null);
    try {
      applyFrame({ kind: "env.view", teamId, data: await resumeEnvironment(teamId, env.id) });
    } catch (e) {
      setError(errorMessage(e, "Couldn't retry. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (env === undefined) {
    return (
      <>
        <StillConnecting label="Looking for your environment" stuck={stuck} />
        <StepActions>
          <PrimaryAction disabled>Continue</PrimaryAction>
        </StepActions>
      </>
    );
  }

  if (env === null) {
    return (
      <form id="onboarding-env" onSubmit={create} noValidate className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-control-compact bg-surface text-muted shadow-raised">
            <Server className="size-4.5" />
          </span>
          <p className="text-[14px] leading-[1.55] text-muted text-pretty">
            A persistent Ubuntu VM under your name. You sign in to your coding CLIs there, and only you can open its terminal.
          </p>
        </div>
        <Field label="Name" description="Teammates see this next to your CLIs." error={error}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={ENVIRONMENT_NAME_MAX} autoComplete="off" disabled={busy} />
        </Field>
        <StepActions>
          <SecondaryAction onClick={onLater} disabled={busy}>
            Skip for now
          </SecondaryAction>
          <PrimaryAction type="submit" form="onboarding-env" loading={busy}>
            Create my VM
          </PrimaryAction>
        </StepActions>
      </form>
    );
  }

  const phase = phaseInfo(env.phase);
  const usable = USABLE.has(env.phase);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <Server className="size-4 shrink-0 text-faint" />
          <span className="truncate text-[14.5px] font-[600]">{env.name}</span>
        </span>
        <Badge tone={phase.tone} size="sm">
          {phase.label}
        </Badge>
      </div>
      {env.phase === "error" ? (
        <Alert
          tone="danger"
          title="Setup stopped"
          action={
            <Button size="xs" variant="secondary" loading={busy} onClick={retry}>
              <RotateCw />
              Retry
            </Button>
          }
        >
          {env.lastError ?? "Something went wrong while setting up the VM."}
        </Alert>
      ) : env.phase === "paused" ? (
        <Alert
          tone="neutral"
          title="This VM is paused"
          action={
            <Button size="xs" variant="secondary" loading={busy} onClick={retry}>
              Resume
            </Button>
          }
        >
          Resume it to sign in to your CLIs.
        </Alert>
      ) : (
        <SetupProgress phase={env.phase} since={env.createdAt} />
      )}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {SETUP.has(env.phase) ? <p className="text-[13px] text-muted">This takes a few minutes. You can leave; setup keeps going.</p> : null}
      <StepActions>
        {usable ? null : (
          <SecondaryAction onClick={onLater} disabled={busy}>
            Finish later
          </SecondaryAction>
        )}
        <PrimaryAction disabled={!usable} onClick={onContinue}>
          Continue
        </PrimaryAction>
      </StepActions>
    </div>
  );
}
