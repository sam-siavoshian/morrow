"use client";

import type { MeView, ProjectView, TaskView } from "@morrow/contracts";
import { Activity, ArrowLeftRight, Check, Keyboard, Monitor, Moon, PanelLeft, Settings, Sparkles, SquarePen, Sun, Sunrise, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { CommandPalette, type CommandGroup, type CommandItem } from "@/components/ui/command";
import { setScenePreference, useScenePreference } from "@/components/ui/theme";
import { ProjectIcon } from "@/components/sidebar/project-icon";
import { taskPath, teamPath, useSidebarModel } from "@/components/sidebar/sidebar-model";
import { SCENE_LABEL, type ScenePreference } from "@/components/sky/scenes";
import { DEFAULT_KEYBINDINGS, useShortcutContext, type ShortcutCommand } from "@/lib/keymap";
import { readMotionPreference, setMotionPreference } from "@/lib/motion";

/** The palette lists this many tasks, newest first; typing still searches them all by title. */
export const PALETTE_TASK_LIMIT = 200;

const keysFor = (command: ShortcutCommand) => DEFAULT_KEYBINDINGS.find((b) => b.command === command)?.key;

const THEMES: { value: ScenePreference; label: string; icon: ReactNode }[] = [
  { value: "system", label: "Match system", icon: <Monitor /> },
  { value: "day", label: SCENE_LABEL.day, icon: <Sun /> },
  { value: "dawn", label: SCENE_LABEL.dawn, icon: <Sunrise /> },
  { value: "night", label: SCENE_LABEL.night, icon: <Moon /> },
];

/** Most recently touched first, capped. Pure, for tests. */
export function paletteTasks(tasks: Record<string, TaskView>, limit = PALETTE_TASK_LIMIT): TaskView[] {
  return Object.values(tasks)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

type AppPaletteProps = {
  me: MeView;
  teamId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewTask: () => void;
  onToggleSidebar: () => void;
  onShowShortcuts: () => void;
};

/** mod+k: jump to any task or page, switch team, and the shell's actions. */
export function AppPalette({ me, teamId, open, onOpenChange, onNewTask, onToggleSidebar, onShowShortcuts }: AppPaletteProps) {
  const router = useRouter();
  const model = useSidebarModel();
  const scene = useScenePreference();
  useShortcutContext("paletteOpen", open);

  const go = (href: string) => () => router.push(href);
  // Storage is read only while open: the list is not rendered otherwise, and the server has none.
  const reduced = open && readMotionPreference() === "reduce";

  const tasks: CommandItem[] = paletteTasks(model.tasksById).map((task) => ({
    value: `task:${task.id}`,
    label: task.title,
    keywords: projectWords(model.projectById.get(task.projectId)),
    icon: taskIcon(model.projectById.get(task.projectId)),
    onSelect: go(taskPath(teamId, task.id)),
  }));
  const pages: CommandItem[] = [
    { value: "page:workforce", label: "Workforce", icon: <Users />, keywords: "workers machines agents", onSelect: go(teamPath(teamId, "/workforce")) },
    { value: "page:activity", label: "Activity", icon: <Activity />, keywords: "feed messages relay", onSelect: go(teamPath(teamId, "/activity")) },
    { value: "page:settings", label: "Settings", icon: <Settings />, keywords: "projects members policy appearance theme", onSelect: go(teamPath(teamId, "/settings")) },
  ];
  const teams: CommandItem[] = me.teams
    .filter((t) => t.id !== teamId)
    .map((t) => ({ value: `team:${t.id}`, label: `Switch to ${t.name}`, icon: <ArrowLeftRight />, keywords: "team", onSelect: go(teamPath(t.id)) }));
  const actions: CommandItem[] = [
    { value: "action:new-task", label: "New task", icon: <SquarePen />, shortcut: keysFor("task.new"), keywords: "create start", onSelect: onNewTask },
    { value: "action:sidebar", label: "Toggle sidebar", icon: <PanelLeft />, shortcut: keysFor("sidebar.toggle"), onSelect: onToggleSidebar },
    ...THEMES.map((theme) => ({
      value: `theme:${theme.value}`,
      label: `Theme: ${theme.label}`,
      icon: scene === theme.value ? <Check /> : theme.icon,
      keywords: "appearance color dark light scene",
      onSelect: () => setScenePreference(theme.value),
    })),
    {
      value: "action:motion",
      label: reduced ? "Use system motion setting" : "Reduce motion",
      icon: <Sparkles />,
      keywords: "animation accessibility motion",
      onSelect: () => setMotionPreference(reduced ? "system" : "reduce"),
    },
  ];
  const help: CommandItem[] = [
    { value: "help:shortcuts", label: "Keyboard shortcuts", icon: <Keyboard />, shortcut: keysFor("shortcuts.help"), onSelect: onShowShortcuts },
  ];

  const groups: CommandGroup[] = [
    { label: "Tasks", items: tasks },
    { label: "Go to", items: [...pages, ...teams] },
    { label: "Actions", items: actions },
    { label: "Help", items: help },
  ].filter((group) => group.items.length > 0);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      hotkey={false}
      placeholder="Search tasks, pages and actions…"
      empty="Nothing matches."
    />
  );
}

const projectWords = (project: ProjectView | undefined) => project?.repoFullName.replace("/", " ") ?? "";

const taskIcon = (project: ProjectView | undefined) =>
  project ? <ProjectIcon repoFullName={project.repoFullName} className="size-4" /> : <SquarePen />;
