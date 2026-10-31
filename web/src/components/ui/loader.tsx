import type { SVGProps } from "react";
import { cn } from "@/lib/cn";

/**
 * The plain busy ring for non-agent work (saving, loading a page): a faint
 * track and a third of an arc, turning every 900ms. Agents use RadarSpinner.
 */
export function Loader({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-slot="loader"
      className={cn("size-4 shrink-0 animate-[loader-spin_900ms_linear_infinite] text-muted", className)}
      {...props}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="33 67"
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
