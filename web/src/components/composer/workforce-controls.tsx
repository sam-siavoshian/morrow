"use client";

import { COMPARE_HARNESSES, type CliKind, type EnvironmentView, type ProfileView, type TaskStrategy, type WorkforceMode } from "@morrow/contracts";
import { Check, ChevronDown } from "lucide-react";
import { HARNESSES, HARNESS_LABEL, HarnessIcon, HarnessStack } from "@/components/harness/harness-icon";
import { Menu, MenuCheck, MenuItem, MenuSection } from "@/components/ui/menu";
import { Popover } from "@/components/ui/popover";
import { popupCheck, popupLabel } from "@/components/ui/popup-styles";
import { useMinuteClock } from "@/components/ui/timer";
import { cn } from "@/lib/cn";
import { ComposerControl } from "./composer-control";
import { profileState } from "./profile-status";

const MODES: { value: WorkforceMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "We pick the workers. Your picks are preferred." },
  { value: "manual", label: "Manual", hint: "Only the profiles you pick can take the work." },
];

export function ModeControl({
  mode,
  onModeChange,
  disabled,
}: {
  mode: WorkforceMode;
  onModeChange: (mode: WorkforceMode) => void;
  disabled?: boolean;
}) {
  return (
    <Menu
      side="top"
      align="start"
      trigger={
        <ComposerControl disabled={disabled} aria-label={`Workforce mode: ${mode === "auto" ? "Auto" : "Manual"}`}>
          {mode === "auto" ? "Auto" : "Manual"}
        </ComposerControl>
      }
    >
      <MenuSection label="Workforce">
        {MODES.map((m) => (
          <MenuItem key={m.value} onClick={() => onModeChange(m.value)} className="py-1.5">
            <span className="flex w-full items-start gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-[550]">{m.label}</span>
                <span className="text-[12.5px] leading-[1.4] whitespace-normal text-muted">{m.hint}</span>
              </span>
              <span className="flex h-5 items-center">
                <MenuCheck selected={mode === m.value} />
              </span>
            </span>
          </MenuItem>
        ))}
      </MenuSection>
    </Menu>
  );
}

const STRATEGIES: { value: TaskStrategy; label: string; hint: string }[] = [
  { value: "split", label: "Split", hint: "A planner splits the task into as many workstreams as it needs. Each gets its own agent." },
  { value: "compare", label: "Compare", hint: "Each harness you pick does the whole task. You pick the one to ship." },
];

/** Split the task across agents, or have several harnesses each attempt all of it. */
export function StrategyControl({
  strategy,
  onStrategyChange,
  disabled,
}: {
  strategy: TaskStrategy;
  onStrategyChange: (strategy: TaskStrategy) => void;
  disabled?: boolean;
}) {
  const current = STRATEGIES.find((s) => s.value === strategy) ?? STRATEGIES[0]!;
  return (
    <Menu
      side="top"
      align="start"
      trigger={
        <ComposerControl disabled={disabled} aria-label={`Strategy: ${current.label}`}>
          {current.label}
        </ComposerControl>
      }
    >
      <MenuSection label="Strategy">
        {STRATEGIES.map((m) => (
          <MenuItem key={m.value} onClick={() => onStrategyChange(m.value)} className="py-1.5">
            <span className="flex w-full items-start gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-[550]">{m.label}</span>
                <span className="text-[12.5px] leading-[1.4] whitespace-normal text-muted">{m.hint}</span>
              </span>
              <span className="flex h-5 items-center">
                <MenuCheck selected={strategy === m.value} />
              </span>
            </span>
          </MenuItem>
        ))}
      </MenuSection>
    </Menu>
  );
}

/** How many of a harness's profiles could take work now, for the picker's hint. */
export function harnessReadiness(
  profiles: readonly ProfileView[],
  environments: readonly EnvironmentView[],
  projectId: string | null,
  now: number,
): Record<CliKind, { total: number; ready: number }> {
  const out = Object.fromEntries(HARNESSES.map((cli) => [cli, { total: 0, ready: 0 }])) as Record<CliKind, { total: number; ready: number }>;
  for (const p of profiles) {
    out[p.cli].total++;
    if (profileState(p, environments.find((e) => e.id === p.envId), now, projectId).pickable) out[p.cli].ready++;
  }
  return out;
}

/** The most harnesses a compare can pick: the contract's ceiling, and never more than the team runs per task. */
export const compareMax = (cap: number) => Math.min(COMPARE_HARNESSES.max, cap);

/**
 * Which harnesses attempt a compare task. Each one runs the whole task at once on a teammate's subscription, so the
 * popover says what that costs. A harness with no profile can still be picked (Start says what is missing), but it
 * reads as not connected.
 */
export function HarnessControl({
  harnesses,
  onHarnessesChange,
  profiles,
  environments,
  projectId,
  cap,
  disabled,
}: {
  harnesses: readonly CliKind[];
  onHarnessesChange: (harnesses: CliKind[]) => void;
  profiles: readonly ProfileView[];
  environments: readonly EnvironmentView[];
  projectId: string | null;
  /** Team policy cap for agents per task. */
  cap: number;
  disabled?: boolean;
}) {
  const now = useMinuteClock();
  const readiness = harnessReadiness(profiles, environments, projectId, now);
  const max = compareMax(cap);
  const full = harnesses.length >= max;
  // Keep the order the copy uses, whatever order they were clicked in.
  const toggle = (cli: CliKind) =>
    onHarnessesChange(HARNESSES.filter((h) => (h === cli ? !harnesses.includes(cli) : harnesses.includes(h))));
  const label = harnesses.length === 0 ? "Pick harnesses" : harnesses.map((c) => HARNESS_LABEL[c]).join(" vs ");

  const trigger = (
    <ComposerControl disabled={disabled} aria-label={`Harnesses to compare: ${harnesses.length === 0 ? "none" : label}`}>
      {harnesses.length > 0 ? <HarnessStack clis={[...harnesses]} size={14} max={3} /> : null}
      <span className="max-sm:hidden">{label}</span>
      {/* Narrow screens: the marks say which; words only when none is picked yet. */}
      {harnesses.length === 0 ? <span className="sm:hidden">Harnesses</span> : null}
      <ChevronDown aria-hidden="true" className="size-3 opacity-60" />
    </ComposerControl>
  );

  return (
    <Popover trigger={trigger} side="top" align="start" className="w-[min(19rem,calc(100vw-1rem))] p-1">
      <div className="flex h-8 items-center justify-between gap-2 pr-1">
        <span className={cn(popupLabel, "pb-1.5")}>Compare</span>
        <span className="px-1 text-[12px] font-[550] text-faint tabular-nums" aria-live="polite">
          {harnesses.length} of {max}
        </span>
      </div>
      <ul className="flex flex-col">
        {HARNESSES.map((cli) => {
          const selected = harnesses.includes(cli);
          const { total, ready } = readiness[cli];
          const hint = total === 0 ? "Not connected" : ready === 0 ? "None free" : `${ready} free`;
          return (
            <li key={cli}>
              <button
                type="button"
                aria-pressed={selected}
                disabled={!selected && full}
                onClick={() => toggle(cli)}
                className={cn(
                  "group flex min-h-9 w-full items-center gap-2.5 rounded-[8px] px-2 py-1 text-left outline-none sm:min-h-8",
                  "transition-colors duration-150 hover:bg-row-hover focus-visible:bg-row-active",
                  "disabled:cursor-not-allowed disabled:hover:bg-transparent",
                )}
              >
                <HarnessIcon cli={cli} size={18} decorative className={cn("transition-opacity duration-150", total === 0 && "opacity-50 grayscale")} />
                <span className="min-w-0 flex-1 truncate text-[14.5px] tracking-[-0.006em] text-text group-disabled:text-muted sm:text-[14px]">
                  {HARNESS_LABEL[cli]}
                </span>
                <span className={cn("shrink-0 text-[12.5px] whitespace-nowrap tabular-nums", ready > 0 ? "text-muted" : "text-faint")}>{hint}</span>
                <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
                  {selected ? <Check className={popupCheck} strokeWidth={2.25} /> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="px-2 pt-1.5 pb-1.5 text-[12.5px] leading-[1.45] text-muted">
        {harnesses.length < COMPARE_HARNESSES.min
          ? `Pick at least ${COMPARE_HARNESSES.min}. Each one does the whole task on its own branch.`
          : `${harnesses.length} agents run at once, each on a teammate's own plan. You pick the one to ship.`}
      </p>
    </Popover>
  );
}
