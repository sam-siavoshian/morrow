import type { Metadata } from "next";
import { ActivityView } from "@/components/timeline/activity-view";

export const metadata: Metadata = { title: "Activity" };

/** The team-wide Relay timeline. The team layout checks membership and owns the shell and the TeamProvider. */
export default function ActivityPage() {
  return <ActivityView />;
}
