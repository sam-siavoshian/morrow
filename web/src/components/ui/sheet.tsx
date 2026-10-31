"use client";

import { Dialog as Base } from "@base-ui/react/dialog";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { DialogBackdrop } from "./dialog";
import { usePortalContainer } from "./portal";

type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read out when the sheet opens. */
  title: string;
  description?: string;
  side?: "left" | "right";
  className?: string;
  children: ReactNode;
} & Pick<ComponentProps<typeof Base.Popup>, "initialFocus">;

/**
 * A panel that slides in from the edge (t3code SheetPopup): the phone sidebar. Focus is trapped,
 * Escape and the backdrop close it, safe areas are padded.
 */
export function Sheet({ open, onOpenChange, title, description, side = "left", className, initialFocus, children }: SheetProps) {
  const container = usePortalContainer();
  return (
    <Base.Root open={open} onOpenChange={onOpenChange}>
      <Base.Portal container={container}>
        <DialogBackdrop />
        <Base.Popup
          initialFocus={initialFocus}
          className={cn(
            "fixed inset-y-0 z-50 flex h-dvh w-[min(22rem,calc(100vw-0.75rem))] flex-col text-text outline-none",
            "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
            side === "left"
              ? "left-0 pl-[env(safe-area-inset-left)] shadow-[1px_0_0_var(--color-border),12px_0_40px_-12px_rgb(0_0_0/0.25)] data-ending-style:-translate-x-full data-starting-style:-translate-x-full"
              : "right-0 pr-[env(safe-area-inset-right)] shadow-[-1px_0_0_var(--color-border),-12px_0_40px_-12px_rgb(0_0_0/0.25)] data-ending-style:translate-x-full data-starting-style:translate-x-full",
            "transition-transform duration-200 ease-drawer data-ending-style:duration-[140ms] data-ending-style:ease-exit",
            className,
          )}
        >
          <Base.Title className="sr-only">{title}</Base.Title>
          {description ? <Base.Description className="sr-only">{description}</Base.Description> : null}
          {children}
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  );
}
