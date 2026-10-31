import { APP_NAME, type MeView } from "@morrow/contracts";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { GithubButton } from "@/components/auth/github-button";
import { LAST_TEAM_COOKIE, landingPath, loginErrorMessage, returnToFrom } from "@/components/auth/return-to";
import { SkyStage } from "@/components/auth/sky-stage";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/server-session";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <SkyStage live>
      <Suspense fallback={<LoginCard pending />}>
        <LoginGate searchParams={searchParams} />
      </Suspense>
    </SkyStage>
  );
}

async function LoginGate({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const params = await searchParams;
  const returnTo = returnToFrom(params.returnTo);
  const error = loginErrorMessage(params.error);

  let me: MeView | null = null;
  let offline = false;
  try {
    me = await getSession();
  } catch {
    // The backend is down: still offer sign-in, and say why it may not work.
    offline = true;
  }
  if (me) redirect(returnTo ?? landingPath(me, (await cookies()).get(LAST_TEAM_COOKIE)?.value));

  return <LoginCard returnTo={returnTo} error={error} offline={offline} />;
}

type LoginCardProps = { returnTo?: string | null; error?: string | null; offline?: boolean; pending?: boolean };

function LoginCard({ returnTo = null, error = null, offline = false, pending = false }: LoginCardProps) {
  return (
    <AuthCard
      title={`Sign in to ${APP_NAME}`}
      description="Your team's coding agents, on shared cloud machines."
      footer="New here? Signing in creates your account."
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {offline ? <Alert tone="warning">We can&apos;t reach the server right now. Sign-in may not finish.</Alert> : null}
      {pending ? (
        <Button variant="primary" size="xl" loading className="w-full">
          Sign in with GitHub
        </Button>
      ) : (
        <GithubButton variant="primary" size="xl" returnTo={returnTo} className="w-full" />
      )}
      <p className="text-[12.5px] leading-[1.5] text-muted text-balance">
        GitHub asks for your profile, email and repo access. {APP_NAME} pushes each agent&rsquo;s branch for it, so your token never reaches an agent.
      </p>
    </AuthCard>
  );
}
