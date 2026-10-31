import { APP_NAME } from "@morrow/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { Clouds } from "@/components/sky/clouds";
import { BakedSky } from "@/components/sky/static-sky";
import { SceneSwitcher } from "@/components/ui/scene-switcher";
import { cn } from "@/lib/cn";

type SkyStageProps = {
  children: ReactNode;
  /** The living WebGL sky. Off: the baked still, for pages that stay open a long time. */
  live?: boolean;
  /** Where the halftone horizon sits on the baked sky, as a percentage of the viewport. */
  horizon?: number;
  /** Top-align long content instead of centring it. */
  align?: "center" | "start";
  className?: string;
};

/** Full-screen sky with the brand bar: the backdrop for sign-in, invites and first-run setup. */
export function SkyStage({ children, live = false, horizon = 62, align = "center", className }: SkyStageProps) {
  return (
    <main className="relative isolate flex min-h-svh flex-col">
      <div className="fixed inset-0 -z-10">{live ? <Clouds /> : <BakedSky horizon={horizon} arrive />}</div>
      <header className="container-page flex h-(--nav-height) shrink-0 items-center justify-between">
        <Link href="/" className="rounded-control-compact outline-offset-4" aria-label={`${APP_NAME} home`}>
          <Logo className="text-sky-ink sky-text" />
        </Link>
        {/* Night tokens give light ink over any sky. */}
        <div data-theme="night" className="vibrant rounded-capsule">
          <SceneSwitcher className="bg-transparent" />
        </div>
      </header>
      <div
        className={cn(
          "container-page flex flex-1 justify-center pt-4 pb-[max(2.5rem,env(safe-area-inset-bottom))]",
          align === "center" ? "items-center" : "items-start sm:pt-[6vh]",
          className,
        )}
      >
        {children}
      </div>
    </main>
  );
}
