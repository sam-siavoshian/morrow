"use client";

import { ScrollArea as Base } from "@base-ui/react/scroll-area";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

type ScrollAreaProps = ComponentProps<typeof Base.Root> & {
  /** Fade the top and bottom edges, only as far as content overflows them. */
  fade?: boolean;
  viewportClassName?: string;
  /** Base UI sizes content to fit, so long rows push it wide; `min-w-0!` lets them truncate instead. */
  contentClassName?: string;
};

/**
 * A scroller with a thin thumb that shows only while hovering or scrolling
 * (opencode / t3code), and keyboard scrolling on the viewport.
 */
export function ScrollArea({ fade = true, className, viewportClassName, contentClassName, children, ...props }: ScrollAreaProps) {
  return (
    <Base.Root className={cn("relative flex min-h-0 overflow-hidden", className)} {...props}>
      <Base.Viewport
        className={cn(
          "min-h-0 flex-1 overscroll-contain rounded-[inherit] outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
          fade && "scroll-fade-y",
          viewportClassName,
        )}
      >
        <Base.Content className={contentClassName}>{children}</Base.Content>
      </Base.Viewport>
      <Base.Scrollbar
        orientation="vertical"
        className={cn(
          "m-[3px] flex w-[6px] justify-center rounded-full opacity-0",
          "transition-opacity delay-300 duration-200 ease-out",
          "data-hovering:opacity-100 data-hovering:delay-0 data-scrolling:opacity-100 data-scrolling:delay-0",
        )}
      >
        <Base.Thumb className="w-full rounded-full bg-(--scroll-thumb) transition-colors hover:bg-(--scroll-thumb-hover)" />
      </Base.Scrollbar>
    </Base.Root>
  );
}
