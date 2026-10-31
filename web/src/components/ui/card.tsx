import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { Frost } from "@/components/sky/static-sky";
import { cn } from "@/lib/cn";

export const cardVariants = cva("relative isolate overflow-hidden text-text", {
  variants: {
    variant: {
      /** A plain raised card on the page. */
      solid: "bg-surface shadow-raised",
      /** Recessed into the page, for grouping. */
      inset: "bg-fill shadow-row-rim",
      /** Translucent glass over whatever is behind (t3code). */
      glass: "surface-glass shadow-hairline",
      /** Glass floating over the live sky (Zephium). */
      sky: "sky-glass",
      /** The sky pre-blurred under a panel: glass with no runtime blur. */
      frost: "shadow-hairline",
    },
    radius: {
      row: "rounded-row",
      card: "rounded-card",
      panel: "rounded-panel",
    },
    padding: {
      none: "",
      sm: "p-3",
      md: "p-5",
      lg: "p-7",
    },
  },
  defaultVariants: { variant: "solid", radius: "card", padding: "md" },
});

type CardProps = ComponentProps<"div"> & VariantProps<typeof cardVariants>;

export function Card({ variant, radius, padding, className, children, ...props }: CardProps) {
  return (
    <div className={cn(cardVariants({ variant, radius, padding }), className)} {...props}>
      {variant === "frost" ? <Frost /> : null}
      {children}
    </div>
  );
}

/** A Card that floats: glass by default, panel radius, room inside. */
export function GlassPanel({ variant = "glass", radius = "panel", padding = "lg", ...props }: CardProps) {
  return <Card variant={variant} radius={radius} padding={padding} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-[16px] font-[600] tracking-[-0.016em]", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("mt-1 text-[14px] leading-[1.5] text-muted text-pretty", className)} {...props} />;
}
