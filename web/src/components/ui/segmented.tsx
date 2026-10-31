"use client";

import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

export type SegmentedOption<Value extends string> = {
  value: Value;
  label: string;
  icon?: ReactNode;
  /** Show only the icon; the label becomes the tooltip and spoken name. */
  iconOnly?: boolean;
};

type SegmentedProps<Value extends string> = {
  options: readonly SegmentedOption<Value>[];
  value: Value;
  onValueChange: (value: Value) => void;
  "aria-label": string;
  size?: "sm" | "md";
  className?: string;
};

/** A radio group drawn as a segmented control; the thumb slides on --ease-snap. */
export function Segmented<Value extends string>({
  options,
  value,
  onValueChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: SegmentedProps<Value>) {
  const list = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);

  // The thumb is placed straight on the DOM: measuring needs layout, and a
  // re-render per resize would buy nothing.
  useLayoutEffect(() => {
    const root = list.current;
    const mark = thumb.current;
    if (!root || !mark) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>("[data-checked]");
      mark.hidden = !active;
      if (!active) return;
      mark.style.translate = `${active.offsetLeft}px 0`;
      mark.style.width = `${active.offsetWidth}px`;
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(root);
    return () => watch.disconnect();
  }, [value]);

  return (
    <RadioGroup
      ref={list}
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => onValueChange(next as Value)}
      className={cn("relative isolate inline-flex items-center gap-0.5 rounded-capsule bg-fill p-[3px]", className)}
    >
      <span
        ref={thumb}
        aria-hidden="true"
        hidden
        className="absolute top-[3px] bottom-[3px] left-0 -z-10 rounded-capsule bg-thumb shadow-thumb transition-[translate,width] duration-[220ms] ease-snap"
      />
      {options.map((option) => {
        const radio = (
          <Radio.Root
            key={option.value}
            value={option.value}
            aria-label={option.iconOnly ? option.label : undefined}
            className={cn(
              "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-capsule font-[550] tracking-[-0.01em] text-muted outline-none select-none",
              "transition-colors duration-150 ease-out hover:text-text data-checked:text-text",
              "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring",
              "[&_svg]:shrink-0",
              // Track padding included, sm matches a small button (32/28px) and md a medium one (36/32px).
              size === "sm"
                ? "h-[26px] px-2.5 text-[13px] sm:h-[22px] sm:text-[12.5px] [&_svg]:size-3.5"
                : "h-[30px] px-3 text-[14px] sm:h-[26px] sm:text-[13.5px] [&_svg]:size-4",
              option.iconOnly && (size === "sm" ? "w-[26px] px-0 sm:w-[22px]" : "w-[30px] px-0 sm:w-[26px]"),
            )}
          >
            {option.icon}
            {option.iconOnly ? null : option.label}
          </Radio.Root>
        );
        return option.iconOnly ? (
          <Tooltip key={option.value} content={option.label}>
            {radio}
          </Tooltip>
        ) : (
          radio
        );
      })}
    </RadioGroup>
  );
}
