"use client";

import { Checkbox as Base } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

type CheckboxProps = ComponentProps<typeof Base.Root> & { size?: "sm" | "md" };

/**
 * The switch's sibling: a raised box when off, the lit fill when on, so a ticked
 * box is the brightest thing in its row in day and night alike.
 */
export function Checkbox({ className, size = "md", ...props }: CheckboxProps) {
  return (
    <Base.Root
      className={cn(
        "relative inline-grid shrink-0 cursor-pointer place-items-center rounded-[5px] bg-surface text-on-lit outline-none",
        "shadow-[inset_0_0_0_1px_var(--color-border-strong),0_1px_1.5px_light-dark(rgb(24_24_27/0.08),rgb(0_0_0/0.3))]",
        "transition-[background-color,box-shadow,scale] duration-200 ease-out",
        "hover:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-text)_34%,transparent),0_1px_1.5px_light-dark(rgb(24_24_27/0.08),rgb(0_0_0/0.3))]",
        "data-checked:bg-lit data-checked:shadow-[inset_0_1px_0_rgb(255_255_255/0.16)] data-indeterminate:bg-lit data-indeterminate:shadow-none",
        "active:scale-[0.92] active:duration-[130ms] active:ease-press",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
        "data-disabled:cursor-not-allowed data-disabled:opacity-64",
        // Coarse pointers get a 44px hit area whatever the drawn size.
        "pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-11 pointer-coarse:after:-translate-1/2",
        size === "sm" ? "size-3.5" : "size-4",
        className,
      )}
      {...props}
    >
      <Base.Indicator
        keepMounted
        className={cn(
          "grid place-items-center transition-[opacity,scale] duration-200 ease-emphasized",
          "data-unchecked:scale-50 data-unchecked:opacity-0",
        )}
      >
        {props.indeterminate ? (
          <Minus className={size === "sm" ? "size-2.5" : "size-3"} strokeWidth={3} />
        ) : (
          <Check className={size === "sm" ? "size-2.5" : "size-3"} strokeWidth={3} />
        )}
      </Base.Indicator>
    </Base.Root>
  );
}
