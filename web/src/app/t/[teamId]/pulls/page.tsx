import { Id } from "@morrow/contracts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { StillConnecting } from "@/components/onboarding/still-connecting";
import { PullsRoute } from "@/components/shell/route-views";

export const metadata: Metadata = { title: "Pull requests" };

/** The team's pull requests across its linked repositories. The team layout owns the shell and the TeamProvider. */
export default function PullsPage({ params }: PageProps<"/t/[teamId]/pulls">) {
  return (
    <Suspense fallback={<StillConnecting label="Loading pull requests" stuck={false} />}>
      <PullsGate params={params} />
    </Suspense>
  );
}

async function PullsGate({ params }: Pick<PageProps<"/t/[teamId]/pulls">, "params">) {
  const { teamId } = await params;
  if (!Id.safeParse(teamId).success) notFound();
  return <PullsRoute teamId={teamId} />;
}
