import { APP_NAME } from "@morrow/contracts";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { dotFill, DOT_RADIUS, MARK_DOTS, MARK_RADIUS, MARK_SIZE, MARK_SKY } from "./cloud-mark-data";

/** The app mark: a dotted cloud on a squircle of sky. An empty title makes it decorative. */
export function CloudMark({ className, title = APP_NAME }: { className?: string; title?: string }) {
  // useId output may hold characters url(#…) does not accept.
  const id = `mark${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const label = title ? { role: "img", "aria-label": title } : { "aria-hidden": true };
  return (
    <svg viewBox={`0 0 ${MARK_SIZE} ${MARK_SIZE}`} {...label} className={cn("size-8 shrink-0", className)}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={MARK_SKY[0]} />
          <stop offset="1" stopColor={MARK_SKY[1]} />
        </linearGradient>
      </defs>
      <rect width={MARK_SIZE} height={MARK_SIZE} rx={MARK_RADIUS} fill={`url(#${id})`} />
      {MARK_DOTS.map(({ x, y, depth }) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={DOT_RADIUS} fill={dotFill(depth)} />
      ))}
    </svg>
  );
}
