import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import type { Scene } from "./scenes";
import styles from "./static-sky.module.css";

type SkyProps = {
  /** Which sky. Follows the nearest `data-theme` when left out (pure CSS, no flash). */
  scene?: Scene;
  className?: string;
  style?: CSSProperties;
};

type BakedSkyProps = SkyProps & {
  /** Where the halftone horizon sits, as a percentage of the box's height. */
  horizon?: number;
  /** Fade in on mount. */
  arrive?: boolean;
};

/**
 * The sky as a still picture with the halftone dissolve printed into it. No
 * WebGL, no JavaScript: for sections that need the look without the cost.
 */
export function BakedSky({ scene, horizon, arrive, className, style }: BakedSkyProps) {
  const vars = { ...(horizon !== undefined && { "--horizon": horizon }), ...style } as CSSProperties;
  return (
    <div
      aria-hidden="true"
      data-arrive={arrive ? "" : undefined}
      // A pinned scene brings its own picture and the ground it dissolves into.
      data-theme={scene}
      className={cn(styles.baked, className)}
      style={vars}
    />
  );
}

/**
 * Frosted glass for free: the sky pre-blurred to 192x108 and stretched over the
 * box. Place it as the first child of a `relative isolate` panel.
 */
export function Frost({ scene, className, style }: SkyProps) {
  return <div aria-hidden="true" data-theme={scene} className={cn(styles.frost, className)} style={style} />;
}
