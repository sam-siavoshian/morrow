"use client";

import { Dialog as Base } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconButton } from "./icon-button";
import { usePortalContainer } from "./portal";

export const DialogRoot = Base.Root;
export const DialogTrigger = Base.Trigger;
export const DialogClose = Base.Close;

/** The dimmed, softly blurred page behind any modal surface. */
export function DialogBackdrop({ className }: { className?: string }) {
  return (
    <Base.Backdrop
      className={cn(
        "dialog-backdrop fixed inset-0 z-50 transition-opacity duration-[180ms] ease-out",
        "data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-[120ms]",
        className,
      )}
    />
  );
}

type DialogContentProps = Omit<ComponentProps<typeof Base.Popup>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  /** Visually hide the title; it is still read out. */
  hideTitle?: boolean;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  showClose?: boolean;
};

const WIDTH = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl" };

/**
 * t3code dialog on Zephium glass: centred on wide screens, a bottom sheet on
 * phones. Focus is trapped, Escape and the backdrop close it.
 */
export function DialogContent({
  title,
  description,
  hideTitle,
  footer,
  size = "md",
  showClose = true,
  className,
  children,
  ...props
}: DialogContentProps) {
  const container = usePortalContainer();
  return (
    <Base.Portal container={container}>
      <DialogBackdrop />
      <Base.Viewport className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
        <Base.Popup
          className={cn(
            "dialog-glass relative flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden text-text outline-none",
            "rounded-t-sheet sm:rounded-panel",
            WIDTH[size],
            "transition-[opacity,translate,scale] duration-[180ms] ease-emphasized",
            "data-starting-style:translate-y-full data-ending-style:translate-y-full",
            "sm:data-starting-style:translate-y-3 sm:data-starting-style:scale-98 sm:data-starting-style:opacity-0",
            "sm:data-ending-style:translate-y-0 sm:data-ending-style:scale-98 sm:data-ending-style:opacity-0",
            "data-ending-style:duration-[120ms] data-ending-style:ease-exit",
            className,
          )}
          {...props}
        >
          <div className={cn("px-6 pt-5 pb-2", showClose && "pr-14")}>
            <Base.Title
              className={cn("text-[17px] leading-snug font-[600] tracking-[-0.018em]", hideTitle && "sr-only")}
            >
              {title}
            </Base.Title>
            {description ? (
              <Base.Description className="mt-1 text-[14px] leading-[1.5] text-muted">{description}</Base.Description>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-5">{children}</div>
          {footer ? <DialogFooter>{footer}</DialogFooter> : null}
          {/* Last in the DOM so opening focus lands on the first field, not here. */}
          {showClose ? (
            <Base.Close
              render={
                <IconButton label="Close" shortcut="escape" size="sm" variant="quiet" className="absolute top-4.5 right-4" />
              }
            >
              <X />
            </Base.Close>
          ) : null}
        </Base.Popup>
      </Base.Viewport>
    </Base.Portal>
  );
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t border-border bg-fill px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:pb-4",
        className,
      )}
      {...props}
    />
  );
}
