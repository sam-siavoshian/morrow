"use client";

import { TASK_PINS_MAX, type EnvironmentView, type MemberView, type ProfileView } from "@morrow/contracts";
import { Check, ChevronDown, Users } from "lucide-react";
import { useMemo } from "react";
import { HarnessIcon, HarnessStack } from "@/components/harness/harness-icon";
import { Popover } from "@/components/ui/popover";
import { popupCheck, popupLabel, popupSeparator } from "@/components/ui/popup-styles";
import { useMinuteClock } from "@/components/ui/timer";
import { groupByVm, VmLabel } from "@/components/workforce/vm-groups";
import { cn } from "@/lib/cn";
import { ComposerControl } from "./composer-control";
import { profileState } from "./profile-status";

type ProfilePickerProps = {
  profiles: readonly ProfileView[];
  environments: readonly EnvironmentView[];
  members: readonly MemberView[];
  projectId: string | null;
  pins: readonly string[];
  onPinsChange: (pins: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
};

/** "Any profile" or the picked ones; opens a list of every CLI profile grouped by its VM. */
export function ProfilePicker({
  profiles,
  environments,
  members,
  projectId,
  pins,
  onPinsChange,
  open,
  onOpenChange,
  disabled,
}: ProfilePickerProps) {
  const picked = profiles.filter((p) => pins.includes(p.id));
  const trigger = (
    <ComposerControl disabled={disabled} aria-label={picked.length ? `${picked.length} profiles picked` : "Any profile"}>
      {picked.length > 0 ? (
        <>
          <HarnessStack clis={picked.map((p) => p.cli)} size={14} max={3} />
          <span>{picked.length === 1 ? picked[0]!.label : `${picked.length} picked`}</span>
        </>
      ) : (
        <>
          <Users aria-hidden="true" />
          <span>Any profile</span>
        </>
      )}
      <ChevronDown aria-hidden="true" className="size-3 opacity-60" />
    </ComposerControl>
  );

  return (
    <Popover
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      side="top"
      align="start"
      className="w-[min(21rem,calc(100vw-1rem))] p-1"
    >
      <ProfileList
        profiles={profiles}
        environments={environments}
        members={members}
        projectId={projectId}
        pins={pins}
        onPinsChange={onPinsChange}
      />
    </Popover>
  );
}

function ProfileList({
  profiles,
  environments,
  members,
  projectId,
  pins,
  onPinsChange,
}: Omit<ProfilePickerProps, "open" | "onOpenChange" | "disabled">) {
  const now = useMinuteClock();
  const groups = useMemo(() => groupByVm(profiles, environments, members), [profiles, environments, members]);

  const full = pins.length >= TASK_PINS_MAX;
  const toggle = (id: string) =>
    onPinsChange(pins.includes(id) ? pins.filter((p) => p !== id) : full ? [...pins] : [...pins, id]);

  if (profiles.length === 0) {
    return (
      <p className="px-2 py-2.5 text-[13.5px] leading-[1.45] text-muted">
        No CLI profiles yet. Add one from a coding environment in Workforce.
      </p>
    );
  }

  return (
    <div className="flex max-h-[min(24rem,60vh)] flex-col overflow-y-auto overscroll-contain">
      <div className="flex h-8 items-center justify-between gap-2 pr-1">
        <span className={cn(popupLabel, "pb-1.5")}>Profiles</span>
        {pins.length > 0 ? (
          <span className="flex items-center gap-1 text-[12px] font-[550] text-faint tabular-nums">
            <span aria-live="polite">
              {pins.length} of {TASK_PINS_MAX}
            </span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => onPinsChange([])}
              className="rounded-[6px] px-1 py-0.5 text-muted outline-none transition-colors duration-150 hover:text-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              Clear
            </button>
          </span>
        ) : (
          <span className="px-1 text-[12px] font-[550] text-faint">Up to {TASK_PINS_MAX}</span>
        )}
      </div>
      {groups.map((group, i) => {
        const { env, envId, name, profiles: list } = group;
        return (
          <section key={envId} aria-label={name}>
            {i > 0 ? <div role="separator" className={popupSeparator} /> : null}
            <h4 className={cn(popupLabel, "flex items-center gap-1.5")}>
              <VmLabel group={group} />
            </h4>
            <ul className="flex flex-col">
              {list.map((p) => {
                const state = profileState(p, env, now || Date.now(), projectId);
                const selected = pins.includes(p.id);
                // A picked profile stays clickable whatever its state, so it can always be unpicked.
                const blocked = !selected && (!state.pickable || full);
                const reason = state.kind === "ready" ? null : state.label;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      disabled={blocked}
                      onClick={() => toggle(p.id)}
                      className={cn(
                        "group flex min-h-9 w-full items-center gap-2.5 rounded-[8px] px-2 py-1 text-left outline-none sm:min-h-8",
                        "transition-colors duration-150 hover:bg-row-hover focus-visible:bg-row-active",
                        "disabled:cursor-not-allowed disabled:hover:bg-transparent",
                      )}
                    >
                      <HarnessIcon
                        cli={p.cli}
                        size={18}
                        decorative
                        className="transition-opacity duration-150 group-disabled:opacity-40 group-disabled:grayscale"
                      />
                      <span className="min-w-0 flex-1 truncate text-[14.5px] tracking-[-0.006em] text-text group-disabled:text-muted sm:text-[14px]">
                        {p.label}
                      </span>
                      {reason ? (
                        <span className="shrink-0 text-[12.5px] whitespace-nowrap text-faint tabular-nums">{reason}</span>
                      ) : null}
                      <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
                        {selected ? <Check className={popupCheck} strokeWidth={2.25} /> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
