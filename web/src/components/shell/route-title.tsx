"use client";

import { usePathname } from "next/navigation";
import { taskIdFromPath } from "@/components/sidebar/task-meta";
import { useTask } from "@/lib/store";
import { useDocumentTitle } from "./document-title";

/**
 * The tab title for a task is its live title, which route metadata cannot know. Every other route
 * keeps the title its page sets in metadata. Priority 0: a page's own `useDocumentTitle` wins.
 */
export function RouteTitle() {
  const taskId = taskIdFromPath(usePathname());
  const task = useTask(taskId ?? "");
  useDocumentTitle(taskId ? (task?.title ?? null) : null, 0);
  return null;
}
