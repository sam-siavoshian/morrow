import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import styles from "./composer.module.css";

export type BannerVariant = "default" | "error" | "warning";

/**
 * A strip attached above the composer card (t3code ComposerBanner): narrower than the card and
 * tucked under its top edge, so the two read as one object. Stacked banners share edges.
 */
export function AttachedBanner({
  variant = "default",
  className,
  ...props
}: ComponentProps<"div"> & { variant?: BannerVariant }) {
  return (
    <div
      data-slot="composer-banner"
      data-variant={variant}
      className={cn(styles.attached, "px-3 pt-2 text-[13px] leading-[1.45]", className)}
      {...props}
    />
  );
}
