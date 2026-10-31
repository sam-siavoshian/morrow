import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/cn";

type CheckRowProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  /** Something on the right, e.g. a "Private" badge. */
  trailing?: ReactNode;
  disabled?: boolean;
  className?: string;
};

/** A whole row that toggles one checkbox: the label wraps it, so the row is the hit area. */
export function CheckRow({ checked, onCheckedChange, label, description, trailing, disabled, className }: CheckRowProps) {
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-row px-3 py-2 transition-colors duration-150 hover:bg-row-hover",
        "has-focus-visible:shadow-[inset_0_0_0_2px_var(--color-ring)]",
        checked && "bg-row-active",
        disabled && "cursor-not-allowed opacity-64 hover:bg-transparent",
        className,
      )}
    >
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(next) => onCheckedChange(next)} className="focus-visible:outline-none" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-[550] tracking-[-0.008em] text-text">{label}</span>
        {description ? <span className="mt-0.5 block truncate text-[12.5px] text-muted">{description}</span> : null}
      </span>
      {trailing}
    </label>
  );
}
