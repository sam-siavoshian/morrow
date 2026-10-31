"use client";

import { Select as Base } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { popupCheck, popupItem, popupMotion, popupSurface } from "./popup-styles";
import { usePortalContainer } from "./portal";

export type SelectOption<Value extends string = string> = {
  value: Value;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
};

type SelectProps<Value extends string> = {
  options: readonly SelectOption<Value>[];
  value?: Value | null;
  defaultValue?: Value | null;
  onValueChange?: (value: Value | null) => void;
  placeholder?: ReactNode;
  /** A visible label above the trigger. Without one, pass `aria-label`. */
  label?: ReactNode;
  "aria-label"?: string;
  name?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
};

/**
 * One choice from a short list. The popup lines its selected row up with the
 * trigger (macOS style) when there is room, else drops below it.
 *
 * `md` is a form field (field fill, field radius). `sm` is a toolbar control:
 * the same height, fill and capsule as a small button or segmented control, so
 * the three sit in one row without a seam.
 */
export function Select<Value extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Choose…",
  label,
  name,
  disabled,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: SelectProps<Value>) {
  const container = usePortalContainer();
  const withIcons = options.some((option) => option.icon);
  // Root renders no element of its own, so this keeps the label, trigger and
  // hidden form input together as one item in whatever stack holds them.
  return (
    <div className="flex min-w-0 flex-col">
      <Base.Root<Value>
        items={options.map((option) => ({ value: option.value, label: option.label }))}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => onValueChange?.(next)}
        name={name}
        disabled={disabled}
      >
        {label ? (
          <Base.Label className="mb-1.5 block text-[13.5px] font-[550] tracking-[-0.006em] text-label-secondary">
            {label}
          </Base.Label>
        ) : null}
        <Base.Trigger
          aria-label={ariaLabel}
          className={cn(
            "flex w-full min-w-40 items-center justify-between gap-2 text-left text-text outline-none select-none",
            "transition-[background-color,box-shadow] duration-150 ease-out data-disabled:opacity-64",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            size === "sm"
              ? "h-8 rounded-capsule bg-fill pr-2.5 pl-3 text-[13.5px] font-[500] hover:bg-fill-hover data-popup-open:bg-fill-hover sm:h-7 sm:text-[13px]"
              : "h-10 rounded-control-compact bg-field px-3 text-[15px] hover:bg-[color-mix(in_srgb,var(--color-field),var(--color-field-hover))] data-popup-open:shadow-field-focus sm:h-9",
            className,
          )}
        >
          {withIcons ? (
            // The trigger shows the chosen option the way the list does: its icon, then its label.
            <Base.Value className="flex min-w-0 items-center gap-2 data-placeholder:text-faint">
              {(current: Value | null) => {
                const option = options.find((o) => o.value === current);
                if (!option) return placeholder;
                return (
                  <>
                    {option.icon}
                    <span className="min-w-0 truncate">{option.label}</span>
                  </>
                );
              }}
            </Base.Value>
          ) : (
            <Base.Value className="flex min-w-0 items-center gap-2 truncate data-placeholder:text-faint" placeholder={placeholder} />
          )}
          <Base.Icon className="flex shrink-0 text-faint">
            <ChevronsUpDown className="size-3.5" aria-hidden />
          </Base.Icon>
        </Base.Trigger>
        <Base.Portal container={container}>
          <Base.Positioner sideOffset={6} collisionPadding={8} className="z-50 outline-none select-none">
            <Base.Popup
              className={cn(
                popupSurface,
                popupMotion,
                "min-w-(--anchor-width) data-[side=none]:min-w-[calc(var(--anchor-width)+1.5rem)]",
                "data-[side=none]:data-starting-style:scale-100 data-[side=none]:data-starting-style:opacity-100",
              )}
            >
              <Base.List className="max-h-(--available-height) scroll-py-1 overflow-y-auto">
                {options.map((option) => (
                  <Base.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className={cn(popupItem, "pr-2")}
                  >
                    <Base.ItemText className="flex min-w-0 flex-1 items-center gap-2 truncate">
                      {option.icon}
                      {option.label}
                    </Base.ItemText>
                    <Base.ItemIndicator className="ml-3 flex">
                      <Check className={popupCheck} strokeWidth={2.25} aria-hidden />
                    </Base.ItemIndicator>
                  </Base.Item>
                ))}
              </Base.List>
            </Base.Popup>
          </Base.Positioner>
        </Base.Portal>
      </Base.Root>
    </div>
  );
}
