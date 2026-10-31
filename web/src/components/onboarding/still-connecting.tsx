"use client";

import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { cn } from "@/lib/cn";

/** How long a load may spin before we admit it is stuck (t3code's first-run guard). */
export const STUCK_AFTER_MS = 4_000;

/** True once `waiting` has been true for `ms` without a break. */
export function useStuck(waiting: boolean, ms = STUCK_AFTER_MS): boolean {
  const [stuck, setStuck] = useState(false);
  const [wasWaiting, setWasWaiting] = useState(waiting);
  if (waiting !== wasWaiting) {
    setWasWaiting(waiting);
    if (!waiting) setStuck(false);
  }
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setStuck(true), ms);
    return () => window.clearTimeout(timer);
  }, [waiting, ms]);
  return waiting && stuck;
}

type StillConnectingProps = {
  /** What is loading, for the first few seconds: "Loading your team". */
  label: string;
  stuck: boolean;
  className?: string;
};

/** A live line while loading, and after four seconds an honest "Still connecting" with Reload. */
export function StillConnecting({ label, stuck, className }: StillConnectingProps) {
  return (
    <div role="status" className={cn("flex flex-col items-center gap-3 py-10 text-center", className)}>
      {stuck ? (
        <>
          <p className="text-[14.5px] font-[600] tracking-[-0.01em] text-text">Still connecting…</p>
          <p className="max-w-xs text-[13.5px] leading-[1.5] text-muted">We couldn&apos;t confirm this yet. Reloading usually fixes it.</p>
          <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
            <RotateCw />
            Reload
          </Button>
        </>
      ) : (
        <span className="flex items-center gap-2 text-[13.5px] text-muted">
          <RadarSpinner className="text-soft-sky" />
          {label}
        </span>
      )}
    </div>
  );
}
