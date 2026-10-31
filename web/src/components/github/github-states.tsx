"use client";

import type { GithubFreshness } from "@morrow/contracts";
import { RefreshCw } from "lucide-react";
import { usePathname } from "next/navigation";
import { GithubMark } from "@/components/auth/github-button";
import { clockTime } from "@/components/timeline/time";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useMinuteClock } from "@/components/ui/timer";
import { signInUrl } from "@/lib/api";
import { freshnessNote, githubFailure } from "./pull-state";

/**
 * A GitHub-layer failure with the one thing that fixes it: reconnect GitHub (expired or missing permission), wait
 * (rate limit), or try again. Messages come from the server and are safe to show.
 */
export function GithubProblem({ error, fallback, onRetry, className }: { error: unknown; fallback: string; onRetry?: () => void; className?: string }) {
  const pathname = usePathname();
  const failure = githubFailure(error, fallback);
  if (failure.kind === "reconnect")
    return (
      <Alert
        tone="warning"
        title="Reconnect GitHub"
        className={className}
        action={
          <Button size="sm" variant="secondary" render={<a href={signInUrl(pathname)} />}>
            <GithubMark className="size-3.5" />
            Reconnect
          </Button>
        }
      >
        {failure.message}
      </Alert>
    );
  const retry = onRetry ? (
    <Button size="sm" variant="quiet" onClick={onRetry}>
      <RefreshCw />
      Try again
    </Button>
  ) : undefined;
  if (failure.kind === "rate_limited")
    return (
      <Alert tone="warning" title="GitHub rate limit" className={className} action={retry}>
        {failure.message}
      </Alert>
    );
  if (failure.kind === "disabled" || failure.kind === "forbidden" || failure.kind === "not_found")
    return (
      <Alert tone="neutral" className={className}>
        {failure.message}
      </Alert>
    );
  return (
    <Alert tone="danger" className={className} action={retry}>
      {failure.message}
    </Alert>
  );
}

/** Says when GitHub data on screen is not live (rate limited, or GitHub not answering). Nothing when it is. */
export function FreshnessNote({ freshness, className }: { freshness: GithubFreshness; className?: string }) {
  const now = useMinuteClock();
  const note = freshnessNote(freshness, now, (ms) => clockTime(ms));
  if (!note) return null;
  return (
    <Alert tone="warning" className={className}>
      {note}
    </Alert>
  );
}
