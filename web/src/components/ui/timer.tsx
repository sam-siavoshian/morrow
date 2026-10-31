"use client";

import { useEffect, useState, useSyncExternalStore, type ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** opencode's elapsed format: `42s`, `3m 07s`, `1h 05m`. Negative counts as zero. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * A wall clock shared by every subscriber, ticking on whole periods. One interval per clock, started by the first
 * subscriber and stopped with the last, so a page with no timers runs none.
 */
function sharedClock(period: number) {
  let tick = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const floor = () => Math.floor(Date.now() / period) * period;
  const read = () => (tick ||= floor());
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!interval) {
      // Only notify when the period actually rolls over, so a late interval never renders twice.
      interval = setInterval(() => {
        const next = floor();
        if (next === tick) return;
        tick = next;
        for (const notify of listeners) notify();
      }, Math.min(period, 1000));
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && interval) {
        clearInterval(interval);
        interval = undefined;
        tick = 0;
      }
    };
  };
  return { read, subscribe };
}

const seconds = sharedClock(1000);
const minutes = sharedClock(60_000);
const serverTime = () => 0;
const frozen = () => () => {};

/** Wall time to the second, shared; 0 on the server. Re-renders every second: keep it in small leaf components. */
export function useSecondClock() {
  return useSyncExternalStore(seconds.subscribe, seconds.read, serverTime);
}

/** Wall time to the minute, shared; 0 on the server. For states that change in minutes (staleness, resets, limits). */
export function useMinuteClock() {
  return useSyncExternalStore(minutes.subscribe, minutes.read, serverTime);
}

/**
 * 0 until wall time passes `at`, then the time it woke. One timer for one deadline, so a timeout high in a big
 * tree re-renders it once, not every second. A new `at` starts over; null waits for nothing.
 */
export function useTimeAfter(at: number | null): number {
  const [woke, setWoke] = useState<{ at: number; time: number } | null>(null);
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setWoke({ at, time: Date.now() }), Math.max(0, at - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [at]);
  return woke && woke.at === at ? woke.time : 0;
}

type ElapsedTimeProps = Omit<ComponentProps<"span">, "children"> & {
  /** Epoch ms the work started. */
  since: number;
  /** Epoch ms it stopped; freezes the timer. */
  until?: number;
};

/** A live `Xm YYs` counter. Renders nothing until the client knows the time. */
export function ElapsedTime({ since, until, className, ...props }: ElapsedTimeProps) {
  // A stopped timer never changes: it does not subscribe to the clock at all.
  const now = useSyncExternalStore(until === undefined ? seconds.subscribe : frozen, seconds.read, serverTime);
  const end = until ?? now;
  return (
    <span className={cn("tabular-nums whitespace-nowrap", className)} {...props}>
      {end ? formatElapsed(end - since) : null}
    </span>
  );
}
