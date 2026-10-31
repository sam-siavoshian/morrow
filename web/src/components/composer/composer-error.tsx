"use client";

import { CircleAlert, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSecondClock } from "@/components/ui/timer";
import type { ApiError } from "@/lib/api";
import { AttachedBanner } from "./attached-banner";

export type ComposerFailure = {
  error: ApiError;
  /** What failed, e.g. "Couldn't plan the task". */
  title: string;
  /** Runs the same request again. */
  retry: (() => void) | null;
  at: number;
};

/** The ApiError message, inline on the composer, with Retry (held back while rate limited). */
export function ComposerError({ failure, onDismiss }: { failure: ComposerFailure; onDismiss: () => void }) {
  const now = useSecondClock();
  // The first client render has no clock yet; count from the failure time until it ticks.
  const [mountedAt] = useState(() => failure.at);
  const waitUntil = failure.error.retryAfter ? failure.at + failure.error.retryAfter * 1000 : 0;
  const left = waitUntil ? Math.ceil((waitUntil - (now || mountedAt)) / 1000) : 0;
  const waiting = left > 0;

  return (
    <AttachedBanner variant="error" role="alert">
      <div className="flex items-start gap-2 pb-1.5">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-[13px] text-text">
          <span className="font-[550]">{failure.title}.</span> <span className="text-label-secondary">{failure.error.message}</span>
          {failure.error.code === "rate_limited" && waiting ? (
            <span className="text-muted tabular-nums"> Try again in {left}s.</span>
          ) : null}
        </p>
        {failure.retry ? (
          <Button size="xs" variant="secondary" disabled={waiting} onClick={failure.retry} className="-my-0.5">
            {waiting ? `Retry in ${left}s` : "Retry"}
          </Button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-my-0.5 grid size-7 place-items-center rounded-[6px] text-muted outline-none hover:bg-fill-hover hover:text-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:size-6"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </AttachedBanner>
  );
}
