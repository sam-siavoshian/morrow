"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { taskPath, teamPath, useSidebarModel } from "@/components/sidebar/sidebar-model";
import { adjacentTaskId } from "@/components/sidebar/task-meta";
import { TASK_JUMP_COMMANDS, useShortcut } from "@/lib/keymap";
import { requestComposerFocus } from "./composer-focus";
import { usePalette, useShortcutsSheet, useSidebarState } from "./shell-context";

/** New task: home, with the composer focused once it is there. Shared by the button, palette and shortcut. */
export function useNewTask(teamId: string): () => void {
  const router = useRouter();
  const { store } = useSidebarState();
  return useCallback(() => {
    store.setOpenMobile(false);
    router.push(teamPath(teamId));
    requestComposerFocus();
  }, [router, store, teamId]);
}

/** The shell's global shortcuts. Always mounted under the team layout; renders nothing. */
export function ShellCommands({ teamId }: { teamId: string }) {
  const router = useRouter();
  const model = useSidebarModel();
  const { store } = useSidebarState();
  const palette = usePalette();
  const shortcuts = useShortcutsSheet();
  const newTask = useNewTask(teamId);

  const openTask = (taskId: string | null) => {
    if (!taskId) return false;
    store.setOpenMobile(false);
    router.push(taskPath(teamId, taskId));
  };

  useShortcut("palette.toggle", () => {
    shortcuts.setOpen(false);
    palette.setOpen(!palette.open);
  });
  useShortcut("sidebar.toggle", () => store.toggle());
  useShortcut("task.new", () => {
    palette.setOpen(false);
    shortcuts.setOpen(false);
    newTask();
  });
  useShortcut("shortcuts.help", () => {
    palette.setOpen(false);
    shortcuts.setOpen(!shortcuts.open);
  });
  useShortcut("task.previous", () => openTask(adjacentTaskId(model.order, model.currentTaskId, -1)));
  useShortcut("task.next", () => openTask(adjacentTaskId(model.order, model.currentTaskId, 1)));
  return (
    <>
      {TASK_JUMP_COMMANDS.map((command, index) => (
        <JumpShortcut key={command} command={command} onJump={() => openTask(model.order[index] ?? null)} />
      ))}
    </>
  );
}

function JumpShortcut({ command, onJump }: { command: (typeof TASK_JUMP_COMMANDS)[number]; onJump: () => false | void }) {
  useShortcut(command, onJump);
  return null;
}
