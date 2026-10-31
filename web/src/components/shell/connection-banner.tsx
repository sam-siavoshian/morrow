"use client";

import { RotateCw, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { cn } from "@/lib/cn";
import type { ConnectionStatus } from "@/lib/realtime";
import { useConnection, useRetryConnection } from "@/lib/store";

/** Blips shorter than this never show: the socket usually heals before anyone notices. */
export const BANNER_GRACE_MS = 2_000;
/** The first connect gets longer before we call it slow. */
export const FIRST_CONNECT_GRACE_MS = 4_000;

export type BannerKind = "connecting" | "reconnecting" | "offline";

export function bannerDelay(status: ConnectionStatus): number | null {
  if (status === "open") return null;
  return status === "connecting" ? FIRST_CONNECT_GRACE_MS : BANNER_GRACE_MS;
}

const COPY: Record<BannerKind, { title: string; detail: string }> = {
  connecting: { title: "Still connecting", detail: "Live updates start once the connection is up." },
  reconnecting: { title: "Reconnecting…", detail: "What you see may be a little behind." },
  offline: { title: "Offline", detail: "Live updates paused. Check your connection." },
};

/** A thin strip under the topbar when live updates stop, with a way to try again now. */
export function ConnectionBanner() {
  const status = useConnection();
  const retry = useRetryConnection();
  const [shown, setShown] = useState<BannerKind | null>(null);
  const shownRef = useRef(shown);

  useEffect(() => {
    const show = (kind: BannerKind | null) => {
      shownRef.current = kind;
      setShown(kind);
    };
    const delay = bannerDelay(status);
    if (delay === null) return show(null);
    // Moving from one bad state to another keeps the banner up; a fresh problem waits out the grace.
    if (shownRef.current !== null) return show(status as BannerKind);
    const timer = window.setTimeout(() => show(status as BannerKind), delay);
    return () => window.clearTimeout(timer);
  }, [status]);

  if (!shown) return null;
  const copy = COPY[shown];
  const offline = shown === "offline";
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-9 shrink-0 items-center gap-2.5 border-b px-4 py-1.5 text-[12.5px] leading-4",
        offline ? "border-danger/20 bg-danger/8 text-text" : "border-warning/20 bg-warning/8 text-text",
      )}
    >
      <span className={cn("flex shrink-0 [&_svg]:size-3.5", offline ? "text-danger" : "text-warning")}>
        {offline ? <WifiOff aria-hidden /> : <RadarSpinner />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-[600]">{copy.title}</span>
        <span className="text-muted max-sm:hidden"> {copy.detail}</span>
      </span>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          if (!retry()) window.location.reload();
        }}
        className="shrink-0 pointer-coarse:h-9"
      >
        <RotateCw aria-hidden />
        Retry
      </Button>
    </div>
  );
}
