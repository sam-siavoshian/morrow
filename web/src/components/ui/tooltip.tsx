"use client";

import { Tooltip as Base } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Kbd } from "./kbd";
import { usePortalContainer } from "./portal";

/** opencode timing: 400ms to open, the next one instantly within 300ms, closes at once. */
export const TOOLTIP_DELAY = 400;

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Base.Provider delay={TOOLTIP_DELAY} closeDelay={0} timeout={300}>
      {children}
    </Base.Provider>
  );
}

type TooltipProps = {
  /** The element that shows the tip. Must accept a ref and DOM props. */
  children: ReactElement;
  content: ReactNode;
  /** A shortcut shown after the text, one chip per key. */
  shortcut?: string | readonly string[];
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Lists drop the delay so moving between rows feels instant (t3code). */
  delay?: number;
  disabled?: boolean;
  className?: string;
};

/**
 * opencode's tooltip: a small light surface, 11px at weight 530, scaling in
 * from its anchor. Not a black pill.
 */
export function Tooltip({
  children,
  content,
  shortcut,
  side = "top",
  align = "center",
  delay = TOOLTIP_DELAY,
  disabled,
  className,
}: TooltipProps) {
  const container = usePortalContainer();
  return (
    <Base.Root disabled={disabled}>
      <Base.Trigger delay={delay} render={children} />
      <Base.Portal container={container}>
        <Base.Positioner side={side} align={align} sideOffset={6} collisionPadding={8} className="z-[60]">
          <Base.Popup
            className={cn(
              "flex max-w-72 origin-(--transform-origin) items-center gap-1.5 rounded-[6px] bg-float px-1.5 py-[5px] text-[11px] leading-3 font-[530] tracking-[0.05px] text-text tabular-nums shadow-float select-none",
              "transition-[opacity,scale] duration-[120ms] ease-out data-ending-style:duration-[80ms] data-ending-style:ease-in",
              "data-starting-style:scale-96 data-starting-style:opacity-0 data-ending-style:scale-96 data-ending-style:opacity-0",
              "data-instant:transition-none",
              className,
            )}
          >
            {content}
            {shortcut ? <Kbd keys={shortcut} /> : null}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
