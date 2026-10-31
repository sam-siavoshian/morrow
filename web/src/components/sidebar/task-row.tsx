"use client";

import { Tooltip as Base } from "@base-ui/react/tooltip";
import type { ProjectView, TaskView, TeamView } from "@morrow/contracts";
import { CircleAlert, Ellipsis, GitBranch, Server, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, type FocusEvent, type FocusEventHandler, type KeyboardEventHandler, type ReactNode } from "react";
import { HARNESS_LABEL, HarnessIcon, HarnessStack } from "@/components/harness/harness-icon";
import { Avatar } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/icon-button";
import { ContextMenu, Menu, MenuItem } from "@/components/ui/menu";
import { usePortalContainer } from "@/components/ui/portal";
import { cn } from "@/lib/cn";
import { useTaskWorkers } from "@/lib/store";
import { useCanDeleteTask, useDeleteTask } from "./delete-task";
import { ProjectIcon } from "./project-icon";
import { parseRepoFullName } from "./project-identity";
import { isLiveWorker, liveHarnesses, rowStatus, taskBranches, type RowStatus } from "./task-meta";
import { TaskStatus, TimeAgo } from "./task-status";

export type TreeRowProps = {
  treeKey: string;
  tabIndex: 0 | -1;
  parentKey: string;
  posInSet: number;
  setSize: number;
  onFocus: FocusEventHandler<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
};

type TaskRowProps = TreeRowProps & {
  task: TaskView;
  href: string;
  project: ProjectView | null;
  team: TeamView | null;
  active: boolean;
  unread: boolean;
  /** A worker asked the viewer something still open. */
  asked: boolean;
  variant: "card" | "slim";
  /** `⌥1` while the jump modifier is held. */
  jumpLabel: string | null;
  onNavigate: () => void;
};

/** t3code row surface: inset focus ring, quiet hover, the open task filled. */
const surface = (active: boolean) =>
  cn(
    "group/row relative block w-full cursor-pointer overflow-hidden rounded-[var(--control-radius)] text-left outline-none select-none",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    "transition-[background-color] duration-150 ease-out",
    active ? "bg-row-active text-text shadow-row-rim" : "text-text hover:bg-row-hover",
  );

/** The row's actions button: shown on hover, on keyboard focus and while its menu is open. Touch uses long-press. */
const revealActions = cn(
  "absolute right-1.5 z-10 opacity-0 pointer-events-none transition-opacity duration-150 pointer-coarse:hidden",
  "group-hover/item:pointer-events-auto group-hover/item:opacity-100 group-has-[:focus-visible]/item:pointer-events-auto group-has-[:focus-visible]/item:opacity-100",
  "data-popup-open:pointer-events-auto data-popup-open:opacity-100",
);

/** What the actions button covers (the status or time): fades out in its place, so nothing shifts. */
const coveredByActions = cn(
  "transition-opacity duration-150 pointer-coarse:opacity-100",
  "group-hover/item:opacity-0 group-has-[:focus-visible]/item:opacity-0 group-has-[[data-popup-open]]/item:opacity-0",
);

/** Memoized: the store keeps unchanged tasks' identity (share.ts), so a frame re-renders only the rows it touched. */
export const TaskRow = memo(function TaskRow(props: TaskRowProps) {
  const { task, project, team, active, unread, asked, variant } = props;
  const workers = useTaskWorkers(task.id);
  const live = workers.filter(isLiveWorker);
  const status = rowStatus(task, live.length, unread && !active, asked);
  const repo = project ? parseRepoFullName(project.repoFullName).repo : "Unknown project";
  const label = `${task.title}, ${repo}${status ? `, ${status.label}` : ""}`;
  const container = usePortalContainer();
  const router = useRouter();
  const canDelete = useCanDeleteTask(task);
  const requestDelete = useDeleteTask();
  // Rows are many, so nothing prefetches in view. Intent (hover or keyboard focus) warms the route instead.
  const warm = () => router.prefetch(props.href);

  const rowAttrs = {
    role: "treeitem",
    "aria-level": 2,
    "aria-posinset": props.posInSet,
    "aria-setsize": props.setSize,
    "aria-label": label,
    "aria-selected": active,
    "aria-current": active ? ("page" as const) : undefined,
    "data-tree-key": props.treeKey,
    "data-tree-parent": props.parentKey,
    tabIndex: props.tabIndex,
    onFocus: (event: FocusEvent<HTMLElement>) => {
      warm();
      props.onFocus(event);
    },
    onPointerEnter: warm,
    onKeyDown: props.onKeyDown,
    onClick: props.onNavigate,
  };

  const body =
    variant === "card" ? (
      <CardBody task={task} project={project} repo={repo} status={status} harnesses={liveHarnesses(workers)} active={active} actions={canDelete} />
    ) : (
      <SlimBody task={task} project={project} status={status} active={active} actions={canDelete} />
    );
  const deleteItem = (
    <MenuItem icon={<Trash2 />} tone="danger" onClick={() => requestDelete(task)}>
      Delete
    </MenuItem>
  );

  return (
    <ContextMenu items={deleteItem} disabled={!canDelete} className="group/item relative">
      <Base.Root>
        <Base.Trigger
          delay={150}
          render={<Link href={props.href} prefetch={false} className={surface(active)} {...rowAttrs} />}
        >
          {body}
          {props.jumpLabel ? <JumpHint label={props.jumpLabel} /> : null}
        </Base.Trigger>
        <Base.Portal container={container}>
          <Base.Positioner side="right" align="start" sideOffset={8} collisionPadding={8} className="z-[60]">
            <Base.Popup
              className={cn(
                "dropdown-glass w-72 max-w-[calc(100vw-1rem)] origin-(--transform-origin) rounded-row px-3 py-2.5 text-left text-text",
                "transition-[opacity,scale] duration-[120ms] ease-out data-ending-style:duration-[80ms]",
                "data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0 data-instant:transition-none",
              )}
            >
              <HoverCard task={task} project={project} team={team} workers={live} />
            </Base.Popup>
          </Base.Positioner>
        </Base.Portal>
      </Base.Root>
      {canDelete ? (
        <Menu
          align="end"
          trigger={
            <IconButton
              label={`Actions for ${task.title}`}
              size="xs"
              variant="quiet"
              tooltip={false}
              tabIndex={props.tabIndex}
              className={cn(revealActions, variant === "card" ? "top-[5px]" : "top-1/2 -translate-y-1/2")}
            >
              <Ellipsis />
            </IconButton>
          }
        >
          {deleteItem}
        </Menu>
      ) : null}
    </ContextMenu>
  );
});

function CardBody({
  task,
  project,
  repo,
  status,
  harnesses,
  active,
  actions,
}: {
  task: TaskView;
  project: ProjectView | null;
  repo: string;
  status: RowStatus | null;
  harnesses: ReturnType<typeof liveHarnesses>;
  active: boolean;
  /** The actions button sits over the status on hover. */
  actions: boolean;
}) {
  const branches = taskBranches(task);
  const meta = branches.length > 0 || harnesses.length > 0;
  // t3code recedes rows that do not need you (working, waiting) until hovered or open.
  const recede = !active && (status?.kind === "working" || status?.kind === "waiting" || status?.kind === "planning");
  return (
    <div className={cn("flex flex-col px-(--sidebar-row-content-inset) py-2", meta ? "h-[4.75rem]" : "h-[3.5rem]")}>
      <div className="flex h-4.5 min-w-0 items-center gap-1.5">
        {project ? <ProjectIcon repoFullName={project.repoFullName} className="size-3.5" /> : null}
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 font-[500] text-muted">{repo}</span>
        {status ? <TaskStatus status={status} className={cn(actions && coveredByActions)} /> : null}
      </div>
      <div
        className={cn(
          "mt-1 min-w-0 truncate text-[13.5px] leading-5 font-[550] tracking-[-0.008em] transition-colors duration-150",
          recede ? "text-label-secondary group-hover/row:text-text group-focus-visible/row:text-text" : "text-text",
        )}
        dir="auto"
      >
        {task.title}
      </div>
      {meta ? (
        <div className="mt-1 flex h-4 min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-faint">
          {branches.length > 0 ? (
            <>
              <GitBranch className="size-3 shrink-0" aria-hidden />
              <span className="min-w-0 truncate font-mono text-[11px]">{branches[0]}</span>
              {branches.length > 1 ? <span className="shrink-0 tabular-nums">+{branches.length - 1}</span> : null}
            </>
          ) : null}
          {harnesses.length > 0 ? <HarnessStack clis={harnesses} size={14} max={4} className="ml-auto shrink-0 pl-1" /> : null}
        </div>
      ) : null}
    </div>
  );
}

function SlimBody({
  task,
  project,
  status,
  active,
  actions,
}: {
  task: TaskView;
  project: ProjectView | null;
  status: RowStatus | null;
  active: boolean;
  actions: boolean;
}) {
  const covered = cn(actions && coveredByActions);
  return (
    <div className="flex h-8.5 items-center gap-2 px-(--sidebar-row-content-inset)">
      {project ? (
        <span
          className={cn(
            "flex shrink-0 transition-[opacity,filter] duration-150",
            !active && "opacity-45 grayscale group-hover/row:opacity-100 group-hover/row:grayscale-0 group-focus-visible/row:opacity-100 group-focus-visible/row:grayscale-0",
          )}
        >
          <ProjectIcon repoFullName={project.repoFullName} className="size-3.5" />
        </span>
      ) : null}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px] leading-5 transition-colors duration-150",
          active || status ? "text-text" : "text-muted group-hover/row:text-text group-focus-visible/row:text-text",
        )}
        dir="auto"
      >
        {task.title}
      </span>
      {status ? <TaskStatus status={status} className={covered} /> : task.status === "cancelled" ? (
        <span className={cn("shrink-0 text-[11.5px] text-faint", covered)}>Cancelled</span>
      ) : (
        <TimeAgo at={task.updatedAt} className={covered} />
      )}
    </div>
  );
}

/** t3code JumpHintBadge: shows on the first nine rows while the jump modifier is held. */
function JumpHint({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 right-1.5 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-capsule bg-surface px-1.5 font-mono text-[10.5px] font-[550] text-text shadow-badge"
    >
      {label}
    </span>
  );
}

function HoverLine({ icon, children, tone }: { icon: ReactNode; children: ReactNode; tone?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", tone)}>
      <span className="flex size-3.5 shrink-0 items-center justify-center text-faint [&_svg]:size-3">{icon}</span>
      <div className="min-w-0 truncate">{children}</div>
    </div>
  );
}

/** Who, where and which branch: the detail that does not fit the row (t3code ThreadHoverCard + owner). */
function HoverCard({
  task,
  project,
  team,
  workers,
}: {
  task: TaskView;
  project: ProjectView | null;
  team: TeamView | null;
  workers: ReturnType<typeof useTaskWorkers>;
}) {
  const owner = team?.members.find((m) => m.userId === task.createdBy) ?? null;
  const envName = (envId: string) => team?.environments.find((e) => e.id === envId)?.name ?? "Unknown environment";
  const envs = [...new Set(workers.flatMap((w) => (w.profile ? [w.profile.envId] : [])))];
  const branches = taskBranches(task);
  const last = task.trace.at(-1);
  const problem = task.status === "failed" || task.status === "handoff" ? last : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="line-clamp-2 text-[12.5px] leading-[1.35] font-[600] tracking-[-0.006em]" dir="auto">
        {task.title}
      </div>
      <div className="grid gap-1.5 text-[12px] leading-4 text-muted">
        {project ? (
          <HoverLine icon={<ProjectIcon repoFullName={project.repoFullName} className="size-3" />}>{project.repoFullName}</HoverLine>
        ) : null}
        <HoverLine icon={<Avatar name={owner?.name ?? owner?.login ?? "Unknown"} src={owner?.avatarUrl} login={owner?.login} size={14} />}>
          Started by {owner ? (owner.name ?? owner.login) : "a former member"}
        </HoverLine>
        {envs.map((envId) => (
          <HoverLine key={envId} icon={<Server />}>
            {envName(envId)}
          </HoverLine>
        ))}
        {branches.slice(0, 3).map((branch) => (
          <HoverLine key={branch} icon={<GitBranch />}>
            <span className="font-mono text-[11.5px]">{branch}</span>
          </HoverLine>
        ))}
        {workers.map((w) =>
          w.profile ? (
            <HoverLine key={w.lease.id} icon={<HarnessIcon cli={w.profile.cli} size={12} decorative />}>
              {HARNESS_LABEL[w.profile.cli]} · {w.profile.label}
            </HoverLine>
          ) : null,
        )}
        {problem ? (
          <HoverLine icon={<CircleAlert />} tone={task.status === "failed" ? "text-danger" : "text-warning"}>
            {problem.message}
          </HoverLine>
        ) : null}
      </div>
    </div>
  );
}
