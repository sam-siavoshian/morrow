import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/** The frame's shape while the session loads, so the real shell lands without a jump. */
export function ShellSkeleton({ children }: { children?: ReactNode }) {
  return (
    <div aria-busy="true" className="flex h-dvh w-full overflow-hidden bg-canvas">
      <div className="hidden w-(--sidebar-width) shrink-0 flex-col gap-1 border-r border-border px-(--sidebar-content-inset) md:flex">
        <div className="flex h-13 items-center gap-2 px-1">
          <Skeleton className="size-5 rounded-[6px]" />
          <Skeleton className="h-3.5 w-24 rounded-full" />
        </div>
        <Skeleton className="mx-2 mb-3 h-3.5 w-28 rounded-full" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2 px-2.5 py-2.5">
            <Skeleton className="h-3 w-20 rounded-full" />
            <Skeleton className={i % 2 ? "h-3.5 w-3/5 rounded-full" : "h-3.5 w-4/5 rounded-full"} />
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col bg-ground">
        <div className="flex h-13 shrink-0 items-center gap-2 border-b border-border px-3">
          <Skeleton className="size-7 rounded-[8px]" />
          <Skeleton className="h-3.5 w-32 rounded-full" />
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
