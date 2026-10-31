"use client";

import { FileDiff, FlaskConical, GitBranch, GitPullRequest, SquareTerminal, X } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { ShellRightPanel } from "@/components/shell/shell-context";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet } from "@/components/ui/sheet";
import { Tab, Tabs, TabsList, TabsPanel } from "@/components/ui/tabs";
import { ResizeHandle, usePersistentSize, type SizeRule } from "./resize";

export type PanelTab = "pr" | "diff" | "branches" | "tests" | "log";

/** t3code: below 980px the right panel becomes a sheet. */
const NARROW_QUERY = "(max-width: 979px)";
const subscribeNarrow = (onChange: () => void) => {
  const list = window.matchMedia(NARROW_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
};
export const useNarrowPanel = () => useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW_QUERY).matches, () => false);

const PANEL_MIN = 360;
const panelRule = (taskId: string): SizeRule => ({
  storageKey: `morrow:mission-panel-width:${taskId}`,
  initial: 540,
  min: PANEL_MIN,
  // 70% of the window, and never so wide that the timeline drops under 360px.
  max: ({ width }) => Math.min(Math.floor(width * 0.7), width - 640),
});

type SidePanelProps = {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  /** The task's pull request on GitHub, with review, merge and comments. */
  pullRequest: ReactNode;
  /** What each workstream changed, as diffs. */
  diff: ReactNode;
  branches: ReactNode;
  tests: ReactNode;
  log: ReactNode;
  /** Small counts or marks next to tab names. */
  badges?: Partial<Record<PanelTab, ReactNode>>;
};

/** Pull request, diffs, branches, tests and the read-only log. Resizable on the right; a sheet on narrow screens. */
export function SidePanel({ taskId, open, onOpenChange, tab, onTabChange, pullRequest, diff, branches, tests, log, badges }: SidePanelProps) {
  const narrow = useNarrowPanel();
  const rule = panelRule(taskId);
  const { size, setSize, reset } = usePersistentSize(rule);

  const body = (
    <Tabs value={tab} onValueChange={(value) => onTabChange(value as PanelTab)} className="flex h-full min-h-0 flex-col gap-0">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <TabsList variant="underline" className="h-full gap-4 border-b-0">
          <Tab value="pr" className="h-full">
            <GitPullRequest className="size-3.5" />
            PR
            {badges?.pr}
          </Tab>
          <Tab value="diff" className="h-full">
            <FileDiff className="size-3.5" />
            Diff
            {badges?.diff}
          </Tab>
          <Tab value="branches" className="h-full">
            <GitBranch className="size-3.5" />
            Branches
            {badges?.branches}
          </Tab>
          <Tab value="tests" className="h-full">
            <FlaskConical className="size-3.5" />
            Tests
            {badges?.tests}
          </Tab>
          <Tab value="log" className="h-full">
            <SquareTerminal className="size-3.5" />
            Log
            {badges?.log}
          </Tab>
        </TabsList>
        <IconButton label="Close panel" size="sm" variant="quiet" className="ml-auto" onClick={() => onOpenChange(false)}>
          <X />
        </IconButton>
      </div>
      <TabsPanel value="pr" className="min-h-0 flex-1 overflow-y-auto p-4">
        {pullRequest}
      </TabsPanel>
      <TabsPanel value="diff" className="min-h-0 flex-1 overflow-y-auto p-4">
        {diff}
      </TabsPanel>
      <TabsPanel value="branches" className="min-h-0 flex-1 overflow-y-auto p-4">
        {branches}
      </TabsPanel>
      <TabsPanel value="tests" className="min-h-0 flex-1 overflow-y-auto p-4">
        {tests}
      </TabsPanel>
      <TabsPanel value="log" className="min-h-0 flex-1 p-4">
        {log}
      </TabsPanel>
    </Tabs>
  );

  if (narrow)
    return (
      <Sheet open={open} onOpenChange={onOpenChange} side="right" title="Task details" className="w-[min(28rem,calc(100vw-1.5rem))] bg-canvas">
        {body}
      </Sheet>
    );

  if (!open) return null;
  const max = typeof window === "undefined" ? 900 : rule.max({ width: window.innerWidth, height: window.innerHeight });
  return (
    <ShellRightPanel>
      <aside aria-label="Task details" className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-canvas" style={{ width: size }}>
        <ResizeHandle axis="x" size={size} min={PANEL_MIN} max={Math.max(PANEL_MIN, max)} onResize={setSize} onReset={reset} label="Resize task details" />
        {body}
      </aside>
    </ShellRightPanel>
  );
}
