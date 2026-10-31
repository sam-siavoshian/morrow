/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Adapted from github.com/zephium-browser/Zephium (frame/src/features/onboarding/components/Onboarding.svelte: head, scene and bar). */
"use client";

import { ArrowLeft } from "lucide-react";
import { createContext, useContext, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/cn";
import { COUNTED_STEPS, position, type Step } from "./machine";

/** Where the current step puts its actions: the one bar at the foot of the flow. */
const ActionSlot = createContext<HTMLElement | null>(null);
export const ActionSlotProvider = ActionSlot.Provider;

/** Renders a step's actions into the bar, so every step steers from the same place. */
export function StepActions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionSlot);
  return slot ? createPortal(children, slot) : null;
}

type ActionProps = Omit<ButtonProps, "variant" | "size">;

/** The step's one primary action. Enter presses it (see keys.ts), so it carries the ↵ hint. */
export function PrimaryAction({ children, className, ...props }: ActionProps) {
  return (
    <Button variant="primary" size="lg" data-step-primary="" className={cn("gap-2.5 pr-3 pl-4.5 max-sm:flex-1", className)} {...props}>
      {children}
      <Kbd
        keys="enter"
        aria-hidden
        className="[&>span[aria-hidden]]:bg-[color-mix(in_srgb,var(--color-on-lit)_12%,transparent)] [&>span[aria-hidden]]:text-[color-mix(in_srgb,var(--color-on-lit)_64%,transparent)]"
      />
    </Button>
  );
}

export function SecondaryAction({ className, ...props }: ActionProps) {
  return <Button variant="ghost" size="lg" className={cn("max-sm:flex-1", className)} {...props} />;
}

type StepFrameProps = {
  step: Step;
  title: ReactNode;
  description?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
};

/** Heading on the sky, the step's scene in glass under it. Both rise in when the step arrives. */
export function StepFrame({ step, title, description, headingRef, children }: StepFrameProps) {
  return (
    <section data-step={step} aria-labelledby={`onboarding-${step}-title`} className="flex w-full flex-col gap-6 sm:gap-7">
      <header className="relative flex flex-col items-center gap-2.5 px-2 text-center text-white [text-shadow:0_1px_18px_var(--sky-shadow)]">
        <h1
          ref={headingRef}
          id={`onboarding-${step}-title`}
          tabIndex={-1}
          className="text-[28px] leading-[1.1] font-[550] tracking-[-0.032em] text-balance outline-none sm:text-[36px] motion-safe:animate-[rise_0.9s_var(--ease-emphasized)_120ms_backwards]"
        >
          {title}
        </h1>
        {description ? (
          <p className="max-w-[46ch] text-[15px] leading-[1.5] text-white/85 text-balance motion-safe:animate-[rise_0.9s_var(--ease-emphasized)_200ms_backwards]">
            {description}
          </p>
        ) : null}
      </header>
      <div className="sky-glass w-full rounded-panel p-4 text-text sm:p-6 motion-safe:animate-[rise_0.9s_var(--ease-emphasized)_260ms_backwards]">
        {children}
      </div>
    </section>
  );
}

type StepBarProps = {
  step: Step;
  onBack?: () => void;
  slotRef: Ref<HTMLDivElement>;
};

/**
 * One quiet row for the whole journey, at the foot of the screen: Back, where you are, and the
 * step's own actions. Nothing floats over the scene it steers.
 */
export function StepBar({ step, onBack, slotRef }: StepBarProps) {
  const place = position(step);
  return (
    <nav
      aria-label="Setup"
      className="sticky bottom-0 z-10 -mx-(--gutter) mt-auto w-[calc(100%+var(--gutter)*2)] bg-[linear-gradient(to_top,var(--color-ground)_62%,transparent)] px-(--gutter) pt-8 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-6"
    >
      <div className="mx-auto flex w-full max-w-[600px] flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <Progress step={step} at={place.at} of={place.of} />
        <div className="flex items-center gap-2 sm:contents">
          <div className="flex shrink-0 items-center sm:order-1 sm:min-w-[7.5rem]">
            {onBack ? (
              <Button variant="ghost" size="lg" data-step-back="" onClick={onBack} aria-label="Back" className="gap-1.5 max-sm:w-10 max-sm:px-0 sm:pl-3">
                <ArrowLeft />
                <span className="max-sm:hidden">Back</span>
                <Kbd keys="escape" variant="ghost" aria-hidden className="max-sm:hidden" />
              </Button>
            ) : null}
          </div>
          <div ref={slotRef} className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:order-3 sm:min-w-[7.5rem] sm:flex-none" />
        </div>
      </div>
    </nav>
  );
}

/** Zephium's dashes: done ones dim, the current one long and lit. */
function Progress({ step, at, of }: { step: Step; at: number; of: number }) {
  return (
    <ol aria-label={`Step ${at} of ${of}`} className="flex items-center justify-center gap-[5px] sm:order-2 sm:flex-1">
      {COUNTED_STEPS.map((candidate, index) => {
        const state = index + 1 < at ? "done" : candidate === step ? "now" : "next";
        return (
          <li
            key={candidate}
            aria-current={state === "now" ? "step" : undefined}
            className={cn(
              "h-[3px] rounded-capsule transition-[width,background-color] duration-(--motion-page) ease-emphasized",
              state === "now" ? "w-[34px] bg-text" : "w-[18px]",
              state === "done" && "bg-faint",
              state === "next" && "bg-fill-strong",
            )}
          />
        );
      })}
    </ol>
  );
}
