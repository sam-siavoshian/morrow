"use client";

import type { MeView } from "@morrow/contracts";
import { SquarePen } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProjectFilter } from "./project-filter";
import { SidebarFooter } from "./sidebar-footer";
import { TaskTree } from "./task-tree";
import { TeamSwitcher } from "./team-switcher";

type AppSidebarProps = {
  me: MeView;
  teamId: string;
  onNewTask: () => void;
  /** Closes the phone sheet after a navigation; a no-op on desktop. */
  onNavigate: () => void;
};

/** What the sidebar holds, the same in the desktop rail and the phone sheet. */
export function AppSidebar({ me, teamId, onNewTask, onNavigate }: AppSidebarProps) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex h-13 shrink-0 items-center gap-1 px-(--sidebar-content-inset)">
        <div className="min-w-0 flex-1">
          <TeamSwitcher me={me} teamId={teamId} onNavigate={onNavigate} />
        </div>
        <IconButton
          label="New task"
          shortcut="mod+shift+o"
          size="sm"
          tooltipSide="bottom"
          onClick={onNewTask}
          className="text-muted hover:text-text pointer-coarse:size-11"
        >
          <SquarePen />
        </IconButton>
      </div>
      <div className="flex shrink-0 px-(--sidebar-content-inset) pb-1.5">
        <ProjectFilter />
      </div>
      <ScrollArea className="flex-1" viewportClassName="pt-1" contentClassName="min-w-0!">
        <TaskTree onNavigate={onNavigate} />
      </ScrollArea>
      <SidebarFooter teamId={teamId} onNavigate={onNavigate} />
    </div>
  );
}
