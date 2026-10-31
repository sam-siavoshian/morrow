import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/**
 * A placeholder block with t3code's stepped pulse: four painted frames a
 * cycle instead of a smooth fade, so the compositor stays idle.
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn("animate-skeleton rounded-[8px] bg-fill-active", className)}
      {...props}
    />
  );
}

/** A few lines of text-shaped skeleton; the last one shorter, like prose. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn("h-3 rounded-full", index === lines - 1 ? "w-3/5" : "w-full")} />
      ))}
    </div>
  );
}
