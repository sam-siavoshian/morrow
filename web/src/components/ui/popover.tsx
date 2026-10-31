"use client";

import { Popover as Base } from "@base-ui/react/popover";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { popupMotion, popupSurface } from "./popup-styles";
import { usePortalContainer } from "./portal";

export const PopoverClose = Base.Close;

type PopoverProps = {
  trigger: ReactElement;
  children: ReactNode;
  /** Heading read out when the popover opens; shown unless `hideTitle`. */
  title?: ReactNode;
  description?: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Open on hover too (with a delay), like a preview card. */
  openOnHover?: boolean;
  className?: string;
} & Omit<ComponentProps<typeof Base.Root>, "children">;

/** Rich content anchored to a trigger; focus moves in and returns on close. */
export function Popover({
  trigger,
  children,
  title,
  description,
  side = "bottom",
  align = "center",
  openOnHover,
  className,
  ...root
}: PopoverProps) {
  const container = usePortalContainer();
  return (
    <Base.Root {...root}>
      <Base.Trigger render={trigger} openOnHover={openOnHover} delay={openOnHover ? 300 : undefined} />
      <Base.Portal container={container}>
        <Base.Positioner side={side} align={align} sideOffset={8} collisionPadding={8} className="z-50">
          <Base.Popup className={cn(popupSurface, popupMotion, "w-72 max-w-[calc(100vw-1rem)] p-3.5", className)}>
            {title ? (
              <Base.Title className="text-[14.5px] font-[600] tracking-[-0.012em] text-text">{title}</Base.Title>
            ) : null}
            {description ? (
              <Base.Description className="mt-1 text-[13.5px] leading-[1.45] text-muted">{description}</Base.Description>
            ) : null}
            {children}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
