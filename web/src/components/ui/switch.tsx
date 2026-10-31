"use client";

import { Switch as Base } from "@base-ui/react/switch";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Zephium's switch: the knob travels on the emphasized curve, the track fills. */
export function Switch({ className, ...props }: ComponentProps<typeof Base.Root>) {
  return (
    <Base.Root
      className={cn(
        "relative inline-flex h-[19px] w-8 shrink-0 cursor-pointer rounded-capsule bg-fill-strong p-0.5 outline-none",
        "transition-colors duration-150 ease-out data-checked:bg-lit",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
        "data-disabled:cursor-not-allowed data-disabled:opacity-64",
        className,
      )}
      {...props}
    >
      <Base.Thumb
        className={cn(
          "block size-[15px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)]",
          "transition-[translate,background-color] duration-200 ease-emphasized data-checked:translate-x-[13px] data-checked:bg-on-lit",
        )}
      />
    </Base.Root>
  );
}
