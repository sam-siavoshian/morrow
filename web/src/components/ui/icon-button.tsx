"use client";

import { Button, type ButtonProps } from "./button";
import { Tooltip } from "./tooltip";

type IconSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE = {
  xs: "icon-xs",
  sm: "icon-sm",
  md: "icon",
  lg: "icon-lg",
  xl: "icon-xl",
} as const;

export type IconButtonProps = Omit<ButtonProps, "size" | "aria-label"> & {
  /** Spoken name and tooltip text. Required: an icon alone says nothing. */
  label: string;
  shortcut?: string | readonly string[];
  size?: IconSize;
  /** Hide the tooltip, e.g. when a visible label sits next to the button. */
  tooltip?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
};

export function IconButton({
  label,
  shortcut,
  size = "md",
  variant = "ghost",
  tooltip = true,
  tooltipSide,
  ...props
}: IconButtonProps) {
  const button = <Button aria-label={label} variant={variant} size={SIZE[size]} {...props} />;
  if (!tooltip) return button;
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  );
}
