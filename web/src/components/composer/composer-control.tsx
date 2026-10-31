"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/**
 * t3code's ComposerControl: a borderless inline text button. The footer controls sit a word space
 * apart and read as one phrase ("Split · Auto · any profile"); hover and open brighten the
 * text instead of drawing a box.
 */
export function ComposerControl({ className, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button
      type={type}
      data-slot="composer-control"
      className={cn(
        "relative inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-[var(--control-radius)] px-1.5 sm:h-6",
        "text-[13.5px] font-[500] tracking-[-0.006em] whitespace-nowrap text-muted outline-none sm:text-[13px]",
        "transition-colors duration-150 ease-out hover:text-text data-popup-open:text-text aria-expanded:text-text",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        "disabled:pointer-events-none disabled:opacity-64",
        "[&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        // 44px hit area on touch, whatever the drawn size.
        "pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-1/2",
        className,
      )}
      {...props}
    />
  );
}

/** The dot between phrase parts. */
export function ControlSeparator() {
  return (
    <span aria-hidden="true" className="px-0.5 text-[12px] text-faint select-none">
      ·
    </span>
  );
}
