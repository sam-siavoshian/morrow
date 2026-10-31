import type { Metadata } from "next";
import { Suspense } from "react";
import { SkyStage } from "@/components/auth/sky-stage";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { StillConnecting } from "@/components/onboarding/still-connecting";
import { GlassPanel } from "@/components/ui/card";
import { requireSession } from "@/lib/server-session";

export const metadata: Metadata = { title: "Set up" };

/** First-run setup. Reached from `/` when you have no team; never in the way of a deep link. */
export default function OnboardingPage() {
  return (
    <SkyStage align="start" horizon={70}>
      <Suspense fallback={<Pending />}>
        <OnboardingGate />
      </Suspense>
    </SkyStage>
  );
}

function Pending() {
  return (
    <GlassPanel variant="sky" padding="md" className="w-full max-w-[560px]">
      <StillConnecting label="Loading your account" stuck={false} />
    </GlassPanel>
  );
}

async function OnboardingGate() {
  const me = await requireSession("/onboarding");
  return <OnboardingWizard me={me} />;
}
