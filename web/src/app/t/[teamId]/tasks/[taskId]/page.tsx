import { Id } from "@morrow/contracts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TaskRoute } from "@/components/shell/route-views";

// The tab shows the task's live title once the store has it (the shell's RouteTitle).
export const metadata: Metadata = { title: "Task" };

/** Mission control for one task. The team layout checks membership and owns the shell and the TeamProvider. */
export default function TaskPage({ params }: PageProps<"/t/[teamId]/tasks/[taskId]">) {
  return (
    <Suspense>
      <TaskGate params={params} />
    </Suspense>
  );
}

// Only the URL is read here: no backend call, so opening a task is one quick round trip at most.
async function TaskGate({ params }: Pick<PageProps<"/t/[teamId]/tasks/[taskId]">, "params">) {
  const { teamId, taskId } = await params;
  if (!Id.safeParse(teamId).success || !Id.safeParse(taskId).success) notFound();
  return <TaskRoute teamId={teamId} taskId={taskId} />;
}
