import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type StatusTone = "neutral" | "live" | "attention" | "success" | "danger" | "info" | "idle";

const TONE: Record<StatusTone, string> = {
  neutral: "bg-muted",
  live: "bg-soft-sky",
  attention: "bg-warning",
  success: "bg-success",
  danger: "bg-danger",
  info: "bg-info",
  idle: "bg-faint",
};

type StatusDotProps = ComponentProps<"span"> & {
  tone?: StatusTone;
  /** A slow stepped pulse, for things happening right now. */
  pulse?: boolean;
  /** A ring that rings outward once a cycle, for things that want you. */
  ping?: boolean;
  /** Spoken text; without it the dot is decoration. */
  label?: string;
};

/** opencode's 7px status dot. */
export function StatusDot({ tone = "neutral", pulse, ping, label, className, ...props }: StatusDotProps) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("relative inline-flex size-[7px] shrink-0", className)}
      {...props}
    >
      {ping ? (
        <span className={cn("absolute inset-0 rounded-full opacity-0 animate-status-ping", TONE[tone])} />
      ) : null}
      <span className={cn("relative size-full rounded-full", TONE[tone], pulse && "animate-status-pulse")} />
    </span>
  );
}

type StatusSlotProps = {
  /** What shows at rest: a StatusDot, a RadarSpinner, a count. */
  status: ReactNode;
  /** What replaces it while the row is hovered or focused, usually a close button. */
  action: ReactNode;
  className?: string;
};

/**
 * opencode's tab trick: the status sits exactly where the close button
 * appears. Hovering or focusing the parent `group` swaps them at once, with no
 * transition. Where there is no hover, the action always shows.
 */
export function StatusSlot({ status, action, className }: StatusSlotProps) {
  return (
    <span className={cn("relative grid size-5 shrink-0 place-items-center", className)}>
      <span className="col-start-1 row-start-1 grid place-items-center [@media(hover:hover)]:group-hover:invisible [@media(hover:hover)]:group-has-focus-visible:invisible [@media(hover:none)]:invisible">
        {status}
      </span>
      <span className="invisible col-start-1 row-start-1 grid place-items-center group-hover:visible group-has-focus-visible:visible [@media(hover:none)]:visible">
        {action}
      </span>
    </span>
  );
}
