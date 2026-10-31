"use client";

import type { TaskView } from "@morrow/contracts";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { canManageTask } from "@/components/settings/permissions";
import { toast } from "@/components/ui/toast";
import { deleteTask, errorMessage, isApiError } from "@/lib/api";
import { removeTask, useTeam, useTeamStore, useTeamStoreApi } from "@/lib/store";
import { teamPath } from "./sidebar-model";
import { taskIdFromPath } from "./task-meta";

type DeleteTaskValue = {
  /** Asks to delete `task`: opens the confirm dialog. */
  request: (task: TaskView) => void;
  /** The task whose delete is in flight, so its page can wait instead of saying it is gone. */
  deleting: string | null;
};

const DeleteTaskContext = createContext<DeleteTaskValue | null>(null);

/** What a failed delete says. The server's message is safe to show; a task already gone says so plainly. */
export function deleteFailure(error: unknown): string {
  if (isApiError(error) && error.code === "not_found") return "It was already deleted.";
  return errorMessage(error, "Try again in a moment.");
}

/**
 * One confirm dialog for every "Delete" in the team (sidebar rows, the task page menu). It lives above both, so it
 * stays open while the task leaves the live view, which can happen before the request answers.
 */
export function DeleteTaskProvider({ teamId, children }: { teamId: string; children: ReactNode }) {
  const store = useTeamStoreApi();
  const router = useRouter();
  const pathname = usePathname();
  const [target, setTarget] = useState<TaskView | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  // A delete settles once the page moves on (off the deleted task's page, or anywhere else).
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setDeleting(null);
  }

  const request = useCallback((task: TaskView) => {
    setTarget(task);
    setOpen(true);
  }, []);

  async function confirm() {
    const task = target;
    if (!task) return;
    setDeleting(task.id);
    try {
      await deleteTask(teamId, task.id);
    } catch (error) {
      setDeleting(null);
      toast.error("Couldn't delete the chat", { description: deleteFailure(error) });
      return;
    }
    if (taskIdFromPath(pathname) === task.id) router.replace(teamPath(teamId));
    removeTask(store, task.id);
    toast("Chat deleted");
  }

  const value = useMemo(() => ({ request, deleting }), [request, deleting]);
  return (
    <DeleteTaskContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this chat?"
        description="The conversation, plan and decision trace go away for everyone on the team. Running agents stop. Branches and pull requests on GitHub stay."
        confirmLabel="Delete"
        onConfirm={confirm}
      />
    </DeleteTaskContext.Provider>
  );
}

function useDeleteTaskContext(): DeleteTaskValue {
  const ctx = useContext(DeleteTaskContext);
  if (!ctx) throw new Error("useDeleteTask must be used inside <DeleteTaskProvider>.");
  return ctx;
}

/** Opens the delete confirm for a task. */
export const useDeleteTask = () => useDeleteTaskContext().request;

/** The task whose delete is in flight, or null. */
export const useDeletingTask = () => useDeleteTaskContext().deleting;

/** The server's rule: the task's creator, the owner or an admin. */
export function useCanDeleteTask(task: Pick<TaskView, "createdBy">): boolean {
  const team = useTeam();
  const viewerId = useTeamStore((s) => s.viewerId);
  return team !== null && canManageTask(team.viewerRole, viewerId, task.createdBy);
}
