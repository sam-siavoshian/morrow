"use client";

import type { ProjectView, TaskView } from "@morrow/contracts";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { selectInbox, useAskedTaskIds, useInbox, useTeam, useWorkforce } from "@/lib/store";
import type { Inbox, InboxGroup } from "@/lib/store/selectors";
import { recordTaskVisit, useProjectFilter, useShelves, useTaskVisits, type Visits } from "./sidebar-prefs";
import { DONE_PAGE_FIRST, DONE_PAGE_MORE, taskIdFromPath, visibleTaskIds, type ShelfState } from "./task-meta";

export const teamPath = (teamId: string, rest = "") => `/t/${encodeURIComponent(teamId)}${rest}`;
export const taskPath = (teamId: string, taskId: string) => teamPath(teamId, `/tasks/${encodeURIComponent(taskId)}`);

type SidebarModel = {
  teamId: string;
  /** Null until the first team view arrives. */
  projects: ProjectView[] | null;
  projectById: Map<string, ProjectView>;
  projectId: string | null;
  setProjectId: (id: string | null) => void;
  /** Null until the first workforce view arrives. */
  loaded: boolean;
  inbox: Inbox;
  shelves: ShelfState;
  toggleShelf: (group: InboxGroup) => void;
  doneLimit: number;
  showMoreDone: () => void;
  /** Task ids in on-screen order: what previous / next / alt+N walk. */
  order: string[];
  currentTaskId: string | null;
  visits: Visits;
  /** "Needs you" across every project, whatever the filter: the tab badge. */
  needsYouCount: number;
  /** Tasks whose workers asked the viewer something still open (the open task never counts). */
  asked: ReadonlySet<string>;
  tasksById: Record<string, TaskView>;
};

const SidebarModelContext = createContext<SidebarModel | null>(null);

/** The sidebar's state, shared with the shortcuts and the palette so they walk the same list. */
export function SidebarModelProvider({ teamId, children }: { teamId: string; children: ReactNode }) {
  const team = useTeam();
  const workforce = useWorkforce();
  const projects = team?.projects ?? null;
  const projectIds = useMemo(() => projects?.map((p) => p.id) ?? null, [projects]);
  const [projectId, setProjectId] = useProjectFilter(teamId, projectIds);
  const visits = useTaskVisits(teamId);
  const currentTaskId = taskIdFromPath(usePathname());
  // The task on screen counts as seen while it is open; the visit recorded on leaving keeps it seen after.
  const seen = useMemo(() => (currentTaskId ? { ...visits, [currentTaskId]: Number.POSITIVE_INFINITY } : visits), [visits, currentTaskId]);
  const asked = useAskedTaskIds(seen);
  const everything = useInbox(null, asked);
  // With no project filter (the default) the two lists are the same: one sort per workforce update, not two.
  const filtered = useMemo(() => (projectId ? selectInbox(workforce, { projectId, asked }) : null), [workforce, projectId, asked]);
  const inbox = filtered ?? everything;
  const [shelves, toggleShelf] = useShelves();
  const [done, setDone] = useState({ projectId, limit: DONE_PAGE_FIRST });
  // A new filter starts the Done shelf from its first page again.
  const doneLimit = done.projectId === projectId ? done.limit : DONE_PAGE_FIRST;

  // Visiting a task marks it read, and so does leaving it (it may have finished while open).
  useEffect(() => {
    if (!currentTaskId) return;
    recordTaskVisit(teamId, currentTaskId);
    return () => recordTaskVisit(teamId, currentTaskId);
  }, [teamId, currentTaskId]);

  const value = useMemo<SidebarModel>(
    () => ({
      teamId,
      projects,
      projectById: new Map((projects ?? []).map((p) => [p.id, p])),
      projectId,
      setProjectId,
      loaded: workforce !== null,
      inbox,
      shelves,
      toggleShelf,
      doneLimit,
      showMoreDone: () => setDone({ projectId, limit: doneLimit + DONE_PAGE_MORE }),
      order: visibleTaskIds(inbox, shelves, doneLimit),
      currentTaskId,
      visits,
      needsYouCount: everything["needs-you"].length,
      asked,
      tasksById: workforce?.tasks ?? {},
    }),
    [teamId, projects, projectId, setProjectId, workforce, inbox, shelves, toggleShelf, doneLimit, currentTaskId, visits, everything, asked],
  );
  return <SidebarModelContext.Provider value={value}>{children}</SidebarModelContext.Provider>;
}

const NONE: ReadonlySet<string> = new Set();

/** `asked` from the sidebar model, or nothing outside it (pages rendered without the app shell). */
export function useAskedTasks(): ReadonlySet<string> {
  return useContext(SidebarModelContext)?.asked ?? NONE;
}

export function useSidebarModel(): SidebarModel {
  const ctx = useContext(SidebarModelContext);
  if (!ctx) throw new Error("useSidebarModel must be used inside <SidebarModelProvider>.");
  return ctx;
}
