"use client";

import { Tabs as Base } from "@base-ui/react/tabs";
import { createContext, useContext, type ComponentProps } from "react";
import { cn } from "@/lib/cn";

type Variant = "segmented" | "underline";

const VariantContext = createContext<Variant>("segmented");

export function Tabs({ className, ...props }: ComponentProps<typeof Base.Root>) {
  return <Base.Root className={cn("flex flex-col gap-3", className)} {...props} />;
}

type TabsListProps = ComponentProps<typeof Base.List> & { variant?: Variant };

/**
 * Segmented: a thumb that slides on a launched spring. Underline: a
 * 1.5px rule under the active tab. Arrow keys move between tabs.
 */
export function TabsList({ variant = "segmented", className, children, ...props }: TabsListProps) {
  return (
    <VariantContext.Provider value={variant}>
      <Base.List
        className={cn(
          "relative isolate flex w-fit items-center",
          variant === "segmented"
            ? "gap-0.5 rounded-capsule bg-fill p-[3px]"
            : "gap-5 border-b border-border",
          className,
        )}
        {...props}
      >
        {children}
        <Base.Indicator
          className={cn(
            "absolute -z-10 transition-[left,width,top,height] duration-[220ms] ease-snap",
            variant === "segmented"
              ? "top-(--active-tab-top) left-(--active-tab-left) h-(--active-tab-height) w-(--active-tab-width) rounded-capsule bg-thumb shadow-thumb"
              : "bottom-[-1px] left-(--active-tab-left) h-[1.5px] w-(--active-tab-width) rounded-full bg-text",
          )}
        />
      </Base.List>
    </VariantContext.Provider>
  );
}

export function Tab({ className, ...props }: ComponentProps<typeof Base.Tab>) {
  const variant = useContext(VariantContext);
  return (
    <Base.Tab
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-[550] tracking-[-0.01em] text-muted outline-none select-none",
        "transition-colors duration-150 ease-out hover:text-text data-active:text-text data-disabled:pointer-events-none data-disabled:opacity-50",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        variant === "segmented"
          ? "h-[30px] rounded-capsule px-3.5 text-[14px] sm:h-[26px] sm:text-[13.5px]"
          : "h-9 rounded-[4px] px-0.5 text-[14.5px]",
        className,
      )}
      {...props}
    />
  );
}

export function TabsPanel({ className, ...props }: ComponentProps<typeof Base.Panel>) {
  return (
    <Base.Panel
      className={cn(
        "rounded-[4px] outline-none animate-[arrive_360ms_var(--ease-out)_backwards]",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
}
