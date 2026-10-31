import type { InvitePreviewView, MeView } from "@morrow/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { GithubButton } from "@/components/auth/github-button";
import { parseInviteToken } from "@/components/auth/invite-token";
import { JoinCard } from "@/components/auth/join-card";
import { SkyStage } from "@/components/auth/sky-stage";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api";
import { getInvitePreview, getSession } from "@/lib/server-session";

export const metadata: Metadata = { title: "Join a team", referrer: "no-referrer" };

export default function JoinPage({ params }: PageProps<"/join/[token]">) {
  return (
    <SkyStage live>
      <Suspense fallback={<Pending />}>
        <JoinGate params={params} />
      </Suspense>
    </SkyStage>
  );
}

const TITLE = "You're invited to a team";
const DESCRIPTION = "Join to share its cloud machines and coding agents with your teammates.";

function Pending() {
  return (
    <AuthCard title={TITLE} description={DESCRIPTION}>
      <Button variant="primary" size="xl" loading className="w-full">
        Accept invite
      </Button>
    </AuthCard>
  );
}

async function JoinGate({ params }: Pick<PageProps<"/join/[token]">, "params">) {
  const invite = parseInviteToken((await params).token);
  if (!invite) return <InvalidInvite />;

  let me: MeView | null = null;
  try {
    me = await getSession();
  } catch {
    return (
      <AuthCard title={TITLE} description={DESCRIPTION}>
        <Alert tone="warning">We can&apos;t reach the server right now. Reload in a moment to accept.</Alert>
      </AuthCard>
    );
  }

  const returnTo = `/join/${encodeURIComponent(invite.token)}`;
  if (!me) {
    return (
      <AuthCard title={TITLE} description={DESCRIPTION} footer="Sign in first. You'll come straight back here to accept.">
        <GithubButton variant="primary" size="xl" className="w-full" returnTo={returnTo} label="Sign in with GitHub to join" />
      </AuthCard>
    );
  }

  const existing = me.teams.find((t) => t.id === invite.teamId);
  if (existing) {
    return (
      <AuthCard title={`You're already in ${existing.name}`} description="This invite is for a team you belong to.">
        <Button variant="primary" size="xl" className="w-full" render={<Link href={`/t/${encodeURIComponent(existing.id)}`} />}>
          Open {existing.name}
        </Button>
      </AuthCard>
    );
  }

  // Every link that cannot be used (wrong code, expired, used up, revoked) reads the same.
  let preview: InvitePreviewView | null;
  try {
    preview = await getInvitePreview(invite.token);
  } catch (e) {
    return (
      <AuthCard title={TITLE} description={DESCRIPTION}>
        <Alert tone="warning">{isApiError(e) && e.code === "rate_limited" ? e.message : "We can't reach the server right now. Reload in a moment."}</Alert>
      </AuthCard>
    );
  }
  if (!preview) return <InvalidInvite />;

  return (
    <AuthCard title={`Join ${preview.teamName}`} description={DESCRIPTION}>
      <JoinCard token={invite.token} user={me.user} inviter={preview.inviter} />
    </AuthCard>
  );
}

function InvalidInvite() {
  return (
    <AuthCard title="This invite link isn't valid" description="It may have expired, been used up or been revoked. Ask for a new one.">
      <Button variant="primary" size="xl" className="w-full" render={<Link href="/" />}>
        Go home
      </Button>
    </AuthCard>
  );
}
