import { ArrowDown } from "lucide-react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { GithubButton } from "@/components/auth/github-button";
import { LAST_TEAM_COOKIE, landingPath } from "@/components/auth/return-to";
import { Logo } from "@/components/brand/logo";
import { HarnessIcon, HARNESSES, HarnessStack } from "@/components/harness/harness-icon";
import { HandoffDiagram } from "@/components/onboarding/handoff-diagram";
import { Clouds } from "@/components/sky/clouds";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SceneSwitcher } from "@/components/ui/scene-switcher";
import { getSession } from "@/lib/server-session";

const HEADLINE = "Code together, up in the clouds.";

export default function Home() {
  return (
    <main className="relative isolate bg-ground">
      <Suspense fallback={null}>
        <SignedInRedirect />
      </Suspense>
      <Hero />
      <HowItWorks />
      <footer className="container-page flex flex-wrap items-center justify-between gap-4 pt-6 pb-10 text-[13px] text-muted">
        <Logo className="text-[14px] text-muted" />
        <span className="flex items-center gap-2">
          <HarnessStack clis={[...HARNESSES]} size={16} max={HARNESSES.length} />
          Bring your own Claude Code, Codex, Cursor, Gemini CLI, Grok or opencode login.
        </span>
      </footer>
    </main>
  );
}

/** Signed in: straight to the last team, or to setup when there is none yet. */
async function SignedInRedirect() {
  let target: string | null = null;
  try {
    const me = await getSession();
    if (me) target = landingPath(me, (await cookies()).get(LAST_TEAM_COOKIE)?.value);
  } catch {
    // The backend is unreachable: stay on the landing page rather than fail it.
  }
  if (target) redirect(target);
  return null;
}

function Hero() {
  return (
    <section className="relative isolate flex h-svh min-h-[560px] flex-col overflow-hidden text-white">
      <Clouds className="-z-10" />
      <header className="container-page flex h-(--nav-height) items-center justify-between">
        <Logo className="text-white" />
        {/* Night tokens give light ink over any sky. */}
        <div data-theme="night" className="vibrant rounded-capsule">
          <SceneSwitcher className="bg-transparent" />
        </div>
      </header>
      <div className="container-page flex flex-1 flex-col items-center justify-center pb-[12vh] text-center">
        <div className="relative flex flex-col items-center before:absolute before:-inset-x-[8%] before:-top-[12%] before:-bottom-[18%] before:-z-10 before:bg-[radial-gradient(closest-side,var(--sky-veil),transparent)]">
          <Badge className="h-7 bg-sky-veil px-3 text-[13px] text-sky-ink shadow-sky-veil sky-text animate-[rise_1.1s_var(--ease-emphasized)_backwards]">
            Private preview
          </Badge>
          <h1 className="mt-6 max-w-[14ch] text-[clamp(2.5rem,1rem+3.7vw,4.8rem)] leading-[0.98] font-[600] tracking-[-0.05em] text-balance sky-text">
            {HEADLINE.split(" ").map((word, index) => (
              <span
                key={index}
                className="inline-block animate-[word_1.1s_var(--ease-emphasized)_backwards] whitespace-pre"
                style={{ animationDelay: `${0.08 + index * 0.045}s` }}
              >
                {index > 0 ? ` ${word}` : word}
              </span>
            ))}
          </h1>
          <p className="mt-5 max-w-[34rem] text-lede text-white/85 text-balance sky-text animate-[rise-visible_1.1s_var(--ease-emphasized)_0.55s_backwards]">
            Pool your team&apos;s coding agent logins on cloud machines. The agents work side by side, talk to each
            other, and cover for each other when one runs out.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 animate-[rise_1.1s_var(--ease-emphasized)_0.65s_backwards]">
            <GithubButton variant="sky" size="xl" />
            <Button variant="sky-secondary" size="xl" render={<a href="#how" />}>
              How it works
              <ArrowDown />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

type Point = { title: string; body: string; art: ReactNode };

const POINTS: readonly Point[] = [
  {
    title: "One pool of subscriptions",
    body: "Each teammate signs in to Claude Code, Codex, Cursor, Gemini CLI, Grok or opencode once, on their own cloud VM. Tasks run on whichever login is free.",
    art: (
      <span className="flex items-center gap-1.5">
        {HARNESSES.map((cli) => (
          <HarnessIcon key={cli} cli={cli} size={22} />
        ))}
      </span>
    ),
  },
  {
    title: "Agents that talk",
    body: "Every agent on the team joins one Agent Relay workspace. They split the work, ask each other questions and review each other's changes.",
    art: <Example label="Example message">@codex is the API done?</Example>,
  },
  {
    title: "Work keeps going",
    body: "When one CLI hits its usage limit, its work is saved as a git checkpoint and another agent picks it up from there.",
    art: <Example label="Example handoff">ACK w-9f2c-api</Example>,
  },
];

/** A sample line, captioned so it never reads as live output. */
function Example({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
      <figcaption className="text-faint">{label}</figcaption>
      <code className="rounded-inset bg-fill px-2 py-0.5 font-mono text-muted">{children}</code>
    </figure>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="container-page scroll-mt-6 py-[clamp(4rem,10vw,7.5rem)]">
      <div className="grid items-center gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="max-w-[34rem]">
          <h2 className="text-[clamp(1.75rem,1.2rem+1.6vw,2.5rem)] leading-[1.05] font-[600] tracking-[-0.04em] text-balance">
            Your team&apos;s agents, as one workforce.{" "}
            <span className="text-quiet">Nobody&apos;s agent works alone.</span>
          </h2>
          <ol className="mt-10 flex flex-col gap-8">
            {POINTS.map((point, index) => (
              <li key={point.title} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
                <span className="pt-0.5 font-mono text-[13px] text-faint tabular-nums">0{index + 1}</span>
                <div>
                  <h3 className="text-[17px] font-[600] tracking-[-0.02em]">{point.title}</h3>
                  <p className="mt-1.5 text-[15px] leading-[1.55] text-muted text-pretty">{point.body}</p>
                  <div className="mt-3">{point.art}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <Card variant="solid" radius="panel" padding="none" className="justify-self-center overflow-x-auto p-5 sm:p-7">
          <HandoffDiagram />
        </Card>
      </div>
    </section>
  );
}
