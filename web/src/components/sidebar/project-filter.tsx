"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, Layers, Search } from "lucide-react";
import { useMemo } from "react";
import { popupCheck, popupItem, popupMotion, popupSurface } from "@/components/ui/popup-styles";
import { usePortalContainer } from "@/components/ui/portal";
import { cn } from "@/lib/cn";
import { ProjectIcon } from "./project-icon";
import { parseRepoFullName } from "./project-identity";
import { useSidebarModel } from "./sidebar-model";

type Option = { id: string | null; label: string; repoFullName: string | null };

const ALL: Option = { id: null, label: "All projects", repoFullName: null };

/** The project filter: one button, a searchable list in the popup, "All projects" on top. */
export function ProjectFilter() {
  const { projects, projectId, setProjectId } = useSidebarModel();
  const container = usePortalContainer();
  const options = useMemo<Option[]>(
    () => [ALL, ...(projects ?? []).map((p) => ({ id: p.id, label: parseRepoFullName(p.repoFullName).repo, repoFullName: p.repoFullName }))],
    [projects],
  );
  const selected = options.find((o) => o.id === projectId) ?? ALL;
  const disabled = !projects || projects.length === 0;

  return (
    <Combobox.Root<Option>
      items={options}
      value={selected}
      onValueChange={(next) => setProjectId(next?.id ?? null)}
      itemToStringLabel={(o) => o.label}
      itemToStringValue={(o) => `${o.label} ${o.repoFullName ?? ""}`}
      isItemEqualToValue={(a, b) => a.id === b.id}
      disabled={disabled}
    >
      <Combobox.Trigger
        aria-label={`Project filter: ${selected.label}`}
        className={cn(
          "group/filter flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--control-radius)] px-2 text-left outline-none pointer-coarse:h-11",
          "transition-colors duration-150 hover:bg-row-hover data-popup-open:bg-row-active",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        <OptionIcon option={selected} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-[500] text-label-secondary group-hover/filter:text-text">{selected.label}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-faint" aria-hidden />
      </Combobox.Trigger>
      <Combobox.Portal container={container}>
        <Combobox.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-50 outline-none">
          <Combobox.Popup className={cn(popupSurface, popupMotion, "flex max-h-[min(22rem,var(--available-height))] w-64 flex-col p-0")}>
            <div className="flex items-center gap-2 border-b border-border px-2.5">
              <Search className="size-3.5 shrink-0 text-faint" aria-hidden />
              <Combobox.Input
                aria-label="Search projects"
                placeholder="Search projects"
                className="h-9 w-full bg-transparent text-[13.5px] text-text outline-none placeholder:text-faint"
              />
            </div>
            <Combobox.Empty className="px-3 py-4 text-center text-[13px] text-muted empty:hidden">No matching projects.</Combobox.Empty>
            <Combobox.List className="min-h-0 overflow-y-auto overscroll-contain p-1 empty:hidden">
              {(option: Option) => (
                <Combobox.Item key={option.id ?? "all"} value={option} className={cn(popupItem, "text-[13.5px] sm:text-[13.5px]")}>
                  <OptionIcon option={option} />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <Combobox.ItemIndicator className="flex">
                    <Check className={popupCheck} strokeWidth={2.25} aria-hidden />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

function OptionIcon({ option }: { option: Option }) {
  return option.repoFullName ? (
    <ProjectIcon repoFullName={option.repoFullName} className="size-4" />
  ) : (
    <Layers className="size-4 shrink-0 text-muted" aria-hidden />
  );
}
