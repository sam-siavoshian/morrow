import type { Metadata } from "next";
import { Suspense } from "react";
import { WorkforceRoute } from "@/components/shell/route-views";

export const metadata: Metadata = { title: "Workforce" };

/** VMs, CLI cards and terminals. The team layout checks membership and owns the shell and the TeamProvider. */
export default function WorkforcePage({ params }: PageProps<"/t/[teamId]/workforce">) {
  return (
    <Suspense>
      <WorkforceGate params={params} />
    </Suspense>
  );
}

async function WorkforceGate({ params }: Pick<PageProps<"/t/[teamId]/workforce">, "params">) {
  const { teamId } = await params;
  return <WorkforceRoute teamId={teamId} />;
}
