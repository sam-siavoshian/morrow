import type { Metadata } from "next";
import { HomeRoute } from "@/components/shell/route-views";

export const metadata: Metadata = { title: "Home" };

/** Team home: the task composer and recent tasks. The team layout owns the shell, the member and the TeamProvider. */
export default function TeamHomePage() {
  return <HomeRoute />;
}
