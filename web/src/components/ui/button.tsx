"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";
import { Loader } from "./loader";

// Capsules throughout; mobile-first sizing, one step smaller from `sm:`; hover a
// faint brighten, press 0.98 on a quicker curve.
export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-capsule font-[550] tracking-[-0.012em] tabular-nums",
    "transition-[background-color,color,box-shadow,scale,opacity] duration-150 ease-out",
    "[&:active:not([aria-haspopup])]:scale-[0.98] active:duration-[90ms] active:ease-press",
    "disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    // Coarse pointers get a 44px hit area whatever the drawn size.
    "pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-1/2",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-lit text-on-lit shadow-lit hover:bg-lit-hover",
        secondary:
          "bg-control text-text shadow-raised hover:bg-control-hover active:bg-control-pressed",
        outline: "text-text shadow-hairline hover:bg-fill-hover active:bg-fill-pressed",
        ghost: "text-text hover:bg-fill-hover active:bg-fill-pressed data-popup-open:bg-fill-hover",
        quiet: "text-muted hover:bg-fill hover:text-text active:bg-fill-pressed data-popup-open:text-text",
        danger:
          "bg-[color-mix(in_oklab,var(--color-danger)_11%,transparent)] text-danger hover:bg-[color-mix(in_oklab,var(--color-danger)_17%,transparent)]",
        glass: "surface-glass text-text shadow-hairline hover:brightness-[1.03]",
        // Hero capsules, for UI standing on the sky.
        sky: "bg-sky-ink text-sky-on-ink hover:bg-sky-ink-hover",
        // A deep-sky veil: a white one would vanish over the cloud bank, which
        // the hero buttons sit on at every width.
        "sky-secondary":
          "bg-sky-veil text-sky-ink shadow-sky-veil sky-text hover:bg-sky-veil-hover",
        beam: "beam-edge bg-fill text-text shadow-hairline hover:bg-fill-hover [&_svg]:opacity-75 [&_svg]:transition-transform [&_svg]:duration-200 hover:[&_svg:last-child]:translate-x-0.5",
        "sky-beam":
          "beam-edge bg-white/14 text-white shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.3)] [--beam-light:rgb(255_255_255/0.95)] hover:bg-white/22 [&_svg]:opacity-75 [&_svg]:transition-transform [&_svg]:duration-200 hover:[&_svg:last-child]:translate-x-0.5",
        link: "h-auto rounded-[4px] px-0 font-medium text-text underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-7 gap-1 px-2.5 text-[13px] sm:h-6 sm:text-[12.5px] [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 px-3 text-[13.5px] sm:h-7 sm:text-[13px] [&_svg:not([class*='size-'])]:size-3.75",
        md: "h-9 gap-2 px-3.5 text-[14.5px] sm:h-8 sm:text-[14px] [&_svg:not([class*='size-'])]:size-4",
        lg: "h-10 gap-2 px-4 text-[15px] sm:h-9 sm:text-[14.5px] [&_svg:not([class*='size-'])]:size-4.25",
        xl: "h-12 gap-[9px] px-5 text-[15.5px] min-[720px]:px-6 [&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs": "size-7 sm:size-6 [&_svg:not([class*='size-'])]:size-3.75",
        "icon-sm": "size-8 sm:size-7 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-9 sm:size-8 [&_svg:not([class*='size-'])]:size-4.25",
        "icon-lg": "size-10 sm:size-9 [&_svg:not([class*='size-'])]:size-4.5",
        "icon-xl": "size-12 [&_svg:not([class*='size-'])]:size-5",
      },
    },
    compoundVariants: [
      // Solid buttons lift a hair on hover; flat ones only change fill.
      {
        variant: ["primary", "secondary", "outline", "glass", "sky", "sky-secondary", "beam", "sky-beam", "danger"],
        className: "[@media(hover:hover)]:[&:hover:not(:active)]:scale-[1.012]",
      },
    ],
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export type ButtonProps = useRender.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keeps the button's width, swaps its content for a ring and blocks presses. */
  loading?: boolean;
};

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  render,
  children,
  ...props
}: ButtonProps) {
  const content = loading ? (
    <>
      <span className="invisible inline-flex items-center gap-[inherit]">{children}</span>
      <span className="absolute inset-0 grid place-items-center">
        <Loader className="size-[1.1em] text-current" />
      </span>
    </>
  ) : (
    children
  );

  const defaults = {
    className: cn(buttonVariants({ variant, size }), className),
    type: render ? undefined : ("button" as const),
    disabled: render ? undefined : disabled || loading,
    "aria-disabled": render && (disabled || loading) ? true : undefined,
    "aria-busy": loading || undefined,
    "data-slot": "button",
    children: content,
  };

  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(defaults, props),
  });
}
