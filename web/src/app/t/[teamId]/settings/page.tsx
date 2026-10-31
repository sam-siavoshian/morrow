import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsRoute } from "@/components/shell/route-views";

export const metadata: Metadata = { title: "Settings" };

/** Team, members, invites, projects, policy, security and account. The team layout checks membership and owns the shell. */
export default function SettingsPage({ params }: PageProps<"/t/[teamId]/settings">) {
  return (
    <Suspense>
      <SettingsGate params={params} />
    </Suspense>
  );
}

async function SettingsGate({ params }: Pick<PageProps<"/t/[teamId]/settings">, "params">) {
  const { teamId } = await params;
  return <SettingsRoute teamId={teamId} />;
}
