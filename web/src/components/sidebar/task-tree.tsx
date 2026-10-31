"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import { ChevronDown, SquarePen } from "lucide-react";
import Link from "next/link";
import { useCallback, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { GithubMark } from "@/components/auth/github-button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { shortcutLabel, useJumpHintsVisible, useShortcutLabel, TASK_JUMP_COMMANDS } from "@/lib/keymap";
import { cn } from "@/lib/cn";
import { settingsPath } from "@/components/settings/sections";
import { useTeam } from "@/lib/store";
import { INBOX_GROUPS, type InboxGroup } from "@/lib/store/selectors";
import { parseRepoFullName } from "./project-identity";
import { taskPath, useSidebarModel } from "./sidebar-model";
import { GROUP_LABEL, DONE_PAGE_MORE, isUnread } from "./task-meta";
import { TaskRow } from "./task-row";
import { handleTreeKeyDown } from "./tree-keys";
import { useListFlip } from "./use-list-flip";

const shelfKey = (group: InboxGroup) => `shelf:${group}`;

/** The inbox: Needs you, Running, Recovering, Done, as one keyboard-walkable ARIA tree. */
export function TaskTree({ onNavigate }: { onNavigate: () => void }) {
  const model = useSidebarModel();
  const team = useTeam();
  const listRef = useRef<HTMLUListElement>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const hints = useJumpHintsVisible();

  const groups = INBOX_GROUPS.filter((group) => model.inbox[group].length > 0);
  const total = groups.reduce((sum, group) => sum + model.inbox[group].length, 0);

  // Every key the tree shows, in order: the roving tab stop must land on one of them.
  const keys: string[] = [];
  for (const group of groups) {
    keys.push(shelfKey(group));
    if (model.shelves[group]) keys.push(...visibleTasks(group).map((t) => t.id));
    if (group === "done" && model.shelves.done && model.inbox.done.length > model.doneLimit) keys.push("done:more");
  }
  const rovingKey =
    focusedKey && keys.includes(focusedKey)
      ? focusedKey
      : model.currentTaskId && keys.includes(model.currentTaskId)
        ? model.currentTaskId
        : (keys[0] ?? null);

  useListFlip(listRef, keys.join("|"));

  function visibleTasks(group: InboxGroup) {
    return group === "done" ? model.inbox.done.slice(0, model.doneLimit) : model.inbox[group];
  }

  // Stable: TaskRow is memoized, so a live update re-renders only the rows whose task changed.
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const key = event.currentTarget.dataset.treeKey;
    if (key) setFocusedKey(key);
  }, []);

  if (!model.loaded || model.projects === null) return <TreeSkeleton />;
  if (model.projects.length === 0) return <NoProjects teamId={model.teamId} canLink={team?.viewerRole !== "member"} />;
  if (total === 0) {
    const project = model.projectId ? model.projectById.get(model.projectId) : null;
    return <NoTasks projectName={project ? parseRepoFullName(project.repoFullName).repo : null} />;
  }

  const jumpIndex = new Map(model.order.slice(0, TASK_JUMP_COMMANDS.length).map((id, index) => [id, index]));

  return (
    // Lists drop the tooltip delay so moving between rows feels instant (t3code: 150ms, warm 400ms).
    <Tooltip.Provider delay={150} closeDelay={0} timeout={400}>
      <ul
        ref={listRef}
        role="tree"
        aria-label="Tasks"
        className="relative flex flex-col gap-px px-(--sidebar-content-inset) pb-2"
        onKeyDown={(event) => listRef.current && handleTreeKeyDown(event, listRef.current)}
      >
        {groups.map((group) => {
          const tasks = visibleTasks(group);
          const expanded = model.shelves[group];
          const hidden = group === "done" ? model.inbox.done.length - tasks.length : 0;
          const items: ReactNode[] = [
            <li key={shelfKey(group)} data-flip-key={shelfKey(group)} role="none" className={cn("list-none", group !== groups[0] && "mt-2")}>
              <ShelfHeader
                group={group}
                count={model.inbox[group].length}
                expanded={expanded}
                onToggle={() => model.toggleShelf(group)}
                tabIndex={rovingKey === shelfKey(group) ? 0 : -1}
                onFocus={onFocus}
              />
            </li>,
          ];
          if (expanded) {
            tasks.forEach((task, index) => {
              const jump = jumpIndex.get(task.id);
              items.push(
                <li key={task.id} data-flip-key={task.id} role="none" className="list-none py-px">
                  <TaskRow
                    task={task}
                    href={taskPath(model.teamId, task.id)}
                    project={model.projectById.get(task.projectId) ?? null}
                    team={team}
                    active={task.id === model.currentTaskId}
                    unread={isUnread(task, model.visits[task.id])}
                    asked={model.asked.has(task.id)}
                    variant={group === "done" ? "slim" : "card"}
                    jumpLabel={hints && jump !== undefined ? shortcutLabel(TASK_JUMP_COMMANDS[jump]!) : null}
                    onNavigate={onNavigate}
                    treeKey={task.id}
                    parentKey={shelfKey(group)}
                    posInSet={index + 1}
                    setSize={model.inbox[group].length}
                    tabIndex={rovingKey === task.id ? 0 : -1}
                    onFocus={onFocus}
                  />
                </li>,
              );
            });
            if (hidden > 0) {
              items.push(
                <li key="done:more" data-flip-key="done:more" role="none" className="list-none">
                  <button
                    type="button"
                    role="treeitem"
                    aria-level={2}
                    aria-selected={false}
                    data-tree-key="done:more"
                    data-tree-parent={shelfKey("done")}
                    tabIndex={rovingKey === "done:more" ? 0 : -1}
                    onFocus={onFocus}
                    onClick={model.showMoreDone}
                    className="flex h-8.5 w-full items-center gap-2 rounded-[var(--control-radius)] px-(--sidebar-row-content-inset) text-left text-[13px] text-muted outline-none transition-colors duration-150 hover:bg-row-hover hover:text-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    {/* Plus means add; revealing more is a chevron (t3code). */}
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                    Show {Math.min(hidden, DONE_PAGE_MORE)} more
                  </button>
                </li>,
              );
            }
          }
          return items;
        })}
      </ul>
    </Tooltip.Provider>
  );
}

const SHELF_TONE: Record<InboxGroup, string> = {
  "needs-you": "text-label-secondary",
  running: "text-faint",
  recovering: "text-warning",
  done: "text-faint",
};

/** t3code CollapsibleSectionHeader: small label, a rule that stretches, the count, a chevron. */
function ShelfHeader({
  group,
  count,
  expanded,
  onToggle,
  tabIndex,
  onFocus,
}: {
  group: InboxGroup;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  tabIndex: 0 | -1;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
}) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={1}
      aria-expanded={expanded}
      aria-selected={false}
      aria-label={`${GROUP_LABEL[group]}, ${count} ${count === 1 ? "task" : "tasks"}`}
      data-tree-key={shelfKey(group)}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={onToggle}
      className={cn(
        "group/shelf flex h-7 w-full cursor-pointer items-center gap-2 rounded-[6px] px-(--sidebar-row-content-inset) text-left text-[11.5px] font-[600] tracking-[0.01em] outline-none",
        "transition-colors duration-150 hover:text-text focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset",
        SHELF_TONE[group],
      )}
    >
      <span className="shrink-0">{GROUP_LABEL[group]}</span>
      <span aria-hidden className="h-px min-w-2 flex-1" />
      <span className="font-[500] text-faint tabular-nums">{count}</span>
      <ChevronDown
        aria-hidden
        className={cn("size-3 shrink-0 text-faint transition-transform duration-150 ease-out", !expanded && "-rotate-90")}
      />
    </button>
  );
}

function TreeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading tasks" className="flex flex-col gap-1 px-(--sidebar-content-inset) pt-1">
      <Skeleton className="mx-2.5 my-2 h-3 w-16 rounded-full" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex h-[4.75rem] flex-col gap-2 px-2.5 py-2.5">
          <Skeleton className="h-3 w-24 rounded-full" />
          <Skeleton className={cn("h-3.5 rounded-full", i === 1 ? "w-3/5" : "w-4/5")} />
          <Skeleton className="h-2.5 w-28 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function EmptyNote({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-5 pt-10 pb-6 text-center">
      <span className="mb-1 grid size-8 place-items-center rounded-[10px] bg-surface text-faint shadow-raised [&_svg]:size-4">{icon}</span>
      <p className="text-[13px] font-[550] text-label-secondary">{title}</p>
      {children}
    </div>
  );
}

function NoProjects({ teamId, canLink }: { teamId: string; canLink: boolean }) {
  return (
    <EmptyNote icon={<GithubMark />} title="No projects yet">
      <p className="text-[12.5px] leading-[1.45] text-muted text-balance">
        {canLink ? "Link a GitHub repo to start giving your team tasks." : "Ask a team admin to link a GitHub repo."}
      </p>
      {canLink ? (
        <Link
          href={settingsPath(teamId, "projects")}
          className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-capsule px-3 text-[12.5px] font-[550] text-text shadow-hairline transition-colors duration-150 hover:bg-fill-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Link a repo
        </Link>
      ) : null}
    </EmptyNote>
  );
}

function NoTasks({ projectName }: { projectName: string | null }) {
  const shortcut = useShortcutLabel("task.new");
  return (
    <EmptyNote icon={<SquarePen />} title={projectName ? `No tasks in ${projectName} yet` : "No tasks yet"}>
      <p className="flex items-center gap-1.5 text-[12.5px] text-muted">
        Start one with New task {shortcut ? <Kbd keys="mod+shift+o" /> : null}
      </p>
    </EmptyNote>
  );
}
