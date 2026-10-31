"use client";

import type { ProjectView, TaskView } from "@morrow/contracts";
import { CircleX, Ellipsis, PanelRight, PanelRightClose, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ShellActions, ShellTitle } from "@/components/shell/shell-context";
import { useDeleteTask } from "@/components/sidebar/delete-task";
import { ProjectIcon } from "@/components/sidebar/project-icon";
import { parseRepoFullName } from "@/components/sidebar/project-identity";
import { rowStatus } from "@/components/sidebar/task-meta";
import { TaskStatus } from "@/components/sidebar/task-status";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogRoot } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Menu, MenuItem } from "@/components/ui/menu";
import { ElapsedTime } from "@/components/ui/timer";
import { toast } from "@/components/ui/toast";
import { cancelTask, errorMessage, retryTask } from "@/lib/api";

export const isTerminal = (task: TaskView) => task.status === "completed" || task.status === "failed" || task.status === "cancelled";

type MissionHeaderProps = {
  teamId: string;
  task: TaskView;
  project: ProjectView | null;
  liveWorkers: number;
  canCancel: boolean;
  /** The task failed and the viewer created it or is an owner or admin. */
  canRetry: boolean;
  /** The viewer created the task or is an owner or admin (the server's rule for delete). */
  canDelete: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
};

/** Topbar for a task: project / title, status and elapsed on the left; panel toggle and task menu on the right. */
export function MissionHeader({ teamId, task, project, liveWorkers, canCancel, canRetry, canDelete, panelOpen, onTogglePanel }: MissionHeaderProps) {
  const requestDelete = useDeleteTask();
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const terminal = isTerminal(task);
  const status = rowStatus(task, liveWorkers, true);
  const repo = project ? parseRepoFullName(project.repoFullName).repo : null;

  const cancel = async () => {
    setCancelling(true);
    try {
      await cancelTask(teamId, task.id);
      toast("Task cancelled", { description: "Its workers were released. Branches keep their last checkpoint." });
      setConfirming(false);
    } catch (error) {
      toast.error("Couldn't cancel the task", { description: errorMessage(error, "Try again in a moment.") });
    } finally {
      setCancelling(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      const result = await retryTask(teamId, task.id);
      toast(
        "Retrying the task",
        result.mode === "verify"
          ? { description: "Every workstream is done, so the checks run again." }
          : {
              description:
                result.leases.length > 0
                  ? "Unfinished workstreams got new workers. Finished ones are kept."
                  : "Unfinished workstreams get new workers as soon as a CLI has a free slot.",
            },
      );
    } catch (error) {
      toast.error("Couldn't retry the task", { description: errorMessage(error, "Try again in a moment.") });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      <ShellTitle>
        <span className="flex min-w-0 items-center gap-2">
          {project ? (
            <Link
              href={`/t/${encodeURIComponent(teamId)}`}
              className="hidden min-w-0 shrink items-center gap-1.5 rounded-[6px] text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-ring sm:flex"
            >
              <ProjectIcon repoFullName={project.repoFullName} className="size-4" />
              <span className="max-w-40 truncate">{repo}</span>
            </Link>
          ) : null}
          {project ? (
            <span aria-hidden className="hidden text-faint sm:inline">
              /
            </span>
          ) : null}
          <h1 className="min-w-0 truncate text-[13.5px] font-[600] tracking-[-0.01em] text-text">{task.title}</h1>
          {status ? (
            <TaskStatus status={{ ...status, since: null }} className="hidden sm:inline-flex" />
          ) : (
            <span className="hidden text-[11.5px] font-[550] text-faint sm:inline">Cancelled</span>
          )}
          <ElapsedTime
            since={task.createdAt}
            until={terminal ? task.updatedAt : undefined}
            className="hidden text-[12px] text-faint md:inline"
            aria-label="Elapsed"
          />
        </span>
      </ShellTitle>
      <ShellActions>
        {canRetry ? (
          <Button size="sm" variant="secondary" loading={retrying} onClick={() => void retry()} aria-label="Retry this task">
            <RefreshCw aria-hidden />
            Retry
          </Button>
        ) : null}
        <IconButton
          label={panelOpen ? "Hide task details" : "Show task details"}
          size="sm"
          tooltipSide="bottom"
          aria-expanded={panelOpen}
          onClick={onTogglePanel}
          className="text-muted hover:text-text pointer-coarse:size-11"
        >
          {panelOpen ? <PanelRightClose /> : <PanelRight />}
        </IconButton>
        {canCancel || canDelete ? (
          <Menu
            align="end"
            trigger={
              <IconButton label="Task actions" size="sm" tooltipSide="bottom" className="text-muted hover:text-text pointer-coarse:size-11">
                <Ellipsis />
              </IconButton>
            }
          >
            {canCancel ? (
              <MenuItem icon={<CircleX />} tone="danger" onClick={() => setConfirming(true)}>
                Cancel task
              </MenuItem>
            ) : null}
            {canDelete ? (
              <MenuItem icon={<Trash2 />} tone="danger" onClick={() => requestDelete(task)}>
                Delete
              </MenuItem>
            ) : null}
          </Menu>
        ) : null}
      </ShellActions>
      <DialogRoot open={confirming} onOpenChange={(open) => !cancelling && setConfirming(open)}>
        <DialogContent
          size="sm"
          title="Cancel this task?"
          description="Every worker stops and its lease is released. Branches keep their last checkpoint. This can't be undone."
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={cancelling}>
                Keep running
              </Button>
              <Button variant="danger" onClick={() => void cancel()} disabled={cancelling}>
                {cancelling ? "Cancelling" : "Cancel task"}
              </Button>
            </>
          }
        />
      </DialogRoot>
    </>
  );
}
