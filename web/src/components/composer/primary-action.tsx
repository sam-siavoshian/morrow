"use client";

import { ChevronDown } from "lucide-react";
import type { PointerEvent } from "react";
import { MenuItem, MenuRoot } from "@/components/ui/menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { popupMotion, popupSurface } from "@/components/ui/popup-styles";
import { usePortalContainer } from "@/components/ui/portal";
import { cn } from "@/lib/cn";
import type { PrimaryAction } from "@/components/plan/plan-flow";
import styles from "./composer.module.css";

type PrimaryActionProps = {
  action: PrimaryAction;
  /** Why the action cannot run right now; shown as the tooltip and spoken label. */
  disabledReason: string | null;
  /** A request for this action is in flight. */
  busy: boolean;
  /** Null hides "Start with fewer agents" (the plan already has one, or it is a compare). */
  fewerAgents: number | null;
  onStartFewer: () => void;
  /** Null hides "Re-plan" (a compare task has no planner). With neither, Start is a plain pill. */
  onReplan: (() => void) | null;
};

// Pressing a button leaves focus in the editor, so typing carries on.
const keepFocus = (event: PointerEvent) => event.preventDefault();

const pill =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap bg-lit text-on-lit font-[550] text-[14px] tracking-[-0.01em] outline-none " +
  "shadow-lit transition-[background-color,scale,opacity] duration-150 ease-out hover:bg-lit-hover " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-canvas focus-visible:ring-inset " +
  "disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none [&:active:not([aria-haspopup])]:scale-[0.97] h-9 sm:h-8 sm:text-[13.5px]";

/**
 * The composer's one primary button, which changes shape with the flow: a round arrow to plan,
 * a split Start once a plan is ready, Refine when feedback is typed over a plan. Every face is a
 * submit button: the form decides what a submit means, so Enter and a click always agree.
 */
export function PrimaryActionButton(props: PrimaryActionProps) {
  const { action, disabledReason, busy } = props;
  const disabled = busy || disabledReason !== null;

  if (action === "refine") {
    return (
      <Tooltip content={disabledReason ?? "Plan again with your feedback"}>
        <button
          key="refine"
          type="submit"
          onPointerDown={keepFocus}
          disabled={disabled}
          aria-label={busy ? "Refining" : (disabledReason ?? "Refine the plan")}
          className={cn(pill, styles.morph, "rounded-capsule px-4")}
        >
          {busy ? <RadarSpinner className="size-3.5" /> : null}
          {busy ? "Refining" : "Refine"}
        </button>
      </Tooltip>
    );
  }

  if (action === "start") {
    return (
      <div key="start" className={cn(styles.morph, "flex items-center")}>
        <Tooltip content={disabledReason ?? "Start the workers"} shortcut="enter">
          <button
            type="submit"
            onPointerDown={keepFocus}
            disabled={disabled}
            aria-label={busy ? "Starting" : (disabledReason ?? "Start")}
            className={cn(pill, props.fewerAgents === null && props.onReplan === null ? "rounded-capsule px-4" : "rounded-l-capsule rounded-r-none pr-3 pl-4")}
          >
            {busy ? <RadarSpinner className="size-3.5" /> : null}
            {busy ? "Starting" : "Start"}
          </button>
        </Tooltip>
        {props.fewerAgents !== null || props.onReplan !== null ? <StartMenu {...props} /> : null}
      </div>
    );
  }

  const planning = action === "planning";
  const label = planning ? "Planning" : busy ? "Sending" : (disabledReason ?? "Plan this task");
  return (
    <Tooltip content={planning ? "The planner is working" : (disabledReason ?? "Plan this task")} shortcut={planning || disabledReason ? undefined : "enter"}>
      <button
        key="send"
        type="submit"
        onPointerDown={keepFocus}
        disabled={disabled || planning}
        aria-label={label}
        className={cn(
          styles.morph,
          "relative grid size-9 shrink-0 cursor-pointer place-items-center rounded-full outline-none sm:size-8",
          "bg-lit text-on-lit shadow-lit transition-[background-color,scale,color] duration-150 ease-out",
          "enabled:hover:scale-105 enabled:hover:bg-lit-hover enabled:active:scale-[0.97]",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          "disabled:pointer-events-none disabled:bg-fill-strong disabled:text-faint disabled:shadow-none",
        )}
      >
        {busy ? (
          <RadarSpinner className="size-4" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
    </Tooltip>
  );
}

function StartMenu({ busy, fewerAgents, onStartFewer, onReplan }: PrimaryActionProps) {
  const container = usePortalContainer();
  return (
    <MenuRoot>
      <BaseMenu.Trigger
        disabled={busy}
        aria-label="More ways to start"
        onPointerDown={keepFocus}
        className={cn(pill, "rounded-l-none rounded-r-capsule border-l border-on-lit/20 pr-2.5 pl-2")}
      >
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal container={container}>
        <BaseMenu.Positioner side="top" align="end" sideOffset={6} collisionPadding={8} className="z-50 outline-none">
          <BaseMenu.Popup className={cn(popupSurface, popupMotion, "min-w-56")}>
            {fewerAgents !== null ? (
              <MenuItem onClick={onStartFewer}>Start with fewer agents ({fewerAgents})</MenuItem>
            ) : null}
            {onReplan ? <MenuItem onClick={onReplan}>Re-plan</MenuItem> : null}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </MenuRoot>
  );
}
