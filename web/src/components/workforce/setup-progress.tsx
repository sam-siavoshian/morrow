"use client";

import type { EnvironmentPhase } from "@morrow/contracts";
import { Check } from "lucide-react";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { ElapsedTime } from "@/components/ui/timer";
import { cn } from "@/lib/cn";

const STEPS = [
  { phase: "provisioning", label: "Creating your VM", done: "VM created" },
  { phase: "bootstrapping", label: "Installing Agent Relay and cloning repos", done: "Set up" },
  { phase: "awaiting_login", label: "Waiting for you to sign in to a CLI", done: "Signed in" },
] as const satisfies readonly { phase: EnvironmentPhase; label: string; done: string }[];

/** Index of the step a phase is on; past the end once the environment is ready. */
export function setupStepIndex(phase: EnvironmentPhase): number {
  if (phase === "provisioning") return 0;
  if (phase === "bootstrapping") return 1;
  if (phase === "awaiting_login") return 2;
  return STEPS.length;
}

type SetupProgressProps = {
  phase: EnvironmentPhase;
  /** When the current step started, for the live timer. */
  since?: number;
  className?: string;
};

/**
 * The three setup phases as a short checklist: done steps ticked, the live one sweeping with the
 * radar and a running timer, later ones waiting. Text first, no progress bar to lie with.
 */
export function SetupProgress({ phase, since, className }: SetupProgressProps) {
  const current = setupStepIndex(phase);
  return (
    <ol className={cn("flex flex-col gap-2.5", className)}>
      {STEPS.map((step, index) => {
        const state = index < current ? "done" : index === current ? "live" : "waiting";
        const waitingOnYou = state === "live" && step.phase === "awaiting_login";
        return (
          <li key={step.phase} className="flex items-center gap-2.5 text-[13.5px]" aria-current={state === "live" ? "step" : undefined}>
            <span className="grid size-5 shrink-0 place-items-center">
              {state === "done" ? (
                <span className="grid size-4.5 place-items-center rounded-full bg-soft-mint-wash text-soft-mint-ink shadow-[inset_0_0_0_0.5px_var(--color-soft-mint-edge)]">
                  <Check className="size-3" strokeWidth={2.5} />
                </span>
              ) : state === "live" && !waitingOnYou ? (
                <RadarSpinner className="text-soft-sky" />
              ) : (
                <span className={cn("size-2 rounded-full", waitingOnYou ? "bg-warning" : "bg-fill-strong")} />
              )}
            </span>
            <span className={cn("min-w-0 flex-1", state === "waiting" ? "text-faint" : state === "done" ? "text-muted" : "text-text")}>
              {state === "done" ? step.done : state === "live" && !waitingOnYou ? <ShimmerText>{step.label}</ShimmerText> : step.label}
            </span>
            {state === "live" && !waitingOnYou && since ? <ElapsedTime since={since} className="text-[12.5px] text-muted" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
