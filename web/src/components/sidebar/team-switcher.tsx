"use client";

import { APP_NAME, type MeView } from "@morrow/contracts";
import { ChevronsUpDown, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { CloudMark } from "@/components/brand/cloud-mark";
import { Menu, MenuItem, MenuSection, MenuSeparator } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { useTeam } from "@/lib/store";
import { teamPath } from "./sidebar-model";

/** The sidebar header: the team you are in, and every other team you belong to. */
export function TeamSwitcher({ me, teamId, onNavigate }: { me: MeView; teamId: string; onNavigate: () => void }) {
  const router = useRouter();
  // The live name first: `me` can be a few minutes old (the browser keeps team pages), and a rename shows up at once.
  const liveName = useTeam()?.name;
  const teams = me.teams.map((t) => (t.id === teamId && liveName ? { ...t, name: liveName } : t));
  const current = teams.find((t) => t.id === teamId);
  const go = (href: string) => {
    onNavigate();
    router.push(href);
  };

  return (
    <Menu
      align="start"
      className="w-64"
      trigger={
        <button
          type="button"
          aria-label={`Team: ${current?.name ?? "Unknown"}. Switch team`}
          className={cn(
            "group/team flex h-8 min-w-0 max-w-full items-center gap-2 rounded-[var(--control-radius)] pr-1.5 pl-1 text-left outline-none",
            "transition-colors duration-150 hover:bg-row-hover data-popup-open:bg-row-active",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:h-11",
          )}
        >
          <CloudMark className="size-5 shrink-0 rounded-[6px]" title="" />
          <span className="min-w-0 truncate text-[13.5px] font-[600] tracking-[-0.01em] text-text">{current?.name ?? APP_NAME}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-faint transition-colors duration-150 group-hover/team:text-muted" aria-hidden />
        </button>
      }
    >
      <MenuSection label="Teams">
        {teams.map((team) => (
          <MenuItem
            key={team.id}
            onClick={() => (team.id === teamId ? undefined : go(teamPath(team.id)))}
            aria-current={team.id === teamId ? "true" : undefined}
            checked={team.id === teamId}
          >
            {team.name}
          </MenuItem>
        ))}
      </MenuSection>
      <MenuSeparator />
      <MenuItem icon={<Plus className="size-3.5" aria-hidden />} onClick={() => go("/onboarding")}>
        Create or join a team
      </MenuItem>
    </Menu>
  );
}
