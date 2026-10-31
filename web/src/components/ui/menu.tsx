"use client";

import { ContextMenu as BaseContext } from "@base-ui/react/context-menu";
import { Menu as Base } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Kbd } from "./kbd";
import { popupCheck, popupItem, popupLabel, popupMotion, popupSeparator, popupSurface } from "./popup-styles";
import { usePortalContainer } from "./portal";

export const MenuRoot = Base.Root;

type MenuProps = {
  /** The button that opens the menu. Must accept a ref and DOM props. */
  trigger: ReactElement;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
} & Omit<ComponentProps<typeof Base.Root>, "children">;

/** A dropdown of actions. Arrow keys move, typing jumps, Escape closes. */
export function Menu({ trigger, children, side = "bottom", align = "start", className, ...root }: MenuProps) {
  return (
    <Base.Root {...root}>
      <Base.Trigger render={trigger} />
      <MenuPopup side={side} align={align} className={className}>
        {children}
      </MenuPopup>
    </Base.Root>
  );
}

function MenuPopup({
  side,
  align,
  className,
  children,
}: {
  side: MenuProps["side"];
  align: MenuProps["align"];
  className?: string;
  children: ReactNode;
}) {
  const container = usePortalContainer();
  return (
    <Base.Portal container={container}>
      <Base.Positioner side={side} align={align} sideOffset={6} collisionPadding={8} className="z-50 outline-none">
        <Base.Popup className={cn(popupSurface, popupMotion, "min-w-48 max-w-80", className)}>
          {children}
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  );
}

/**
 * The same menu on right-click (long-press on touch) anywhere in `children`, at the pointer. Items are `MenuItem`s.
 * Pass `disabled` to leave the browser's own menu in place.
 */
export function ContextMenu({ items, children, className, disabled }: { items: ReactNode; children: ReactNode; className?: string; disabled?: boolean }) {
  const container = usePortalContainer();
  return (
    <BaseContext.Root disabled={disabled}>
      <BaseContext.Trigger className={className}>{children}</BaseContext.Trigger>
      <BaseContext.Portal container={container}>
        <BaseContext.Positioner collisionPadding={8} className="z-50 outline-none">
          <BaseContext.Popup className={cn(popupSurface, popupMotion, "min-w-48 max-w-80")}>{items}</BaseContext.Popup>
        </BaseContext.Positioner>
      </BaseContext.Portal>
    </BaseContext.Root>
  );
}

type ItemProps = ComponentProps<typeof Base.Item> & {
  icon?: ReactNode;
  shortcut?: string | readonly string[];
  tone?: "default" | "danger";
  /** Marks the chosen row of a single-choice menu. */
  checked?: boolean;
};

export function MenuItem({ icon, shortcut, tone = "default", checked, className, children, ...props }: ItemProps) {
  return (
    <Base.Item
      className={cn(popupItem, tone === "danger" && "text-danger [&_svg]:text-danger", className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked !== undefined ? <MenuCheck selected={checked} /> : null}
      {shortcut ? <Kbd keys={shortcut} variant="ghost" className="ml-4" /> : null}
    </Base.Item>
  );
}

/** The mark on the chosen row of a single-choice menu: a check at the row's right end. */
export function MenuCheck({ selected }: { selected: boolean }) {
  return selected ? <Check role="img" aria-label="Selected" className={cn(popupCheck, "ml-auto")} strokeWidth={2.25} /> : null;
}

export function MenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof Base.CheckboxItem>) {
  return (
    <Base.CheckboxItem className={cn(popupItem, "pl-7", className)} {...props}>
      <Base.CheckboxItemIndicator className="absolute left-2 flex">
        <Check className="size-3.5" strokeWidth={2.25} />
      </Base.CheckboxItemIndicator>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Base.CheckboxItem>
  );
}

/**
 * A labelled run of items. Base UI's group label only works inside a group, so the label and its
 * group always render together; screen readers announce the label for every item in it.
 */
export function MenuSection({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Base.Group className={className}>
      <Base.GroupLabel className={popupLabel}>{label}</Base.GroupLabel>
      {children}
    </Base.Group>
  );
}

/** A run of items named for screen readers only, for a group whose first item is its own heading. */
export function MenuGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <Base.Group aria-label={label} className={className}>
      {children}
    </Base.Group>
  );
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof Base.Separator>) {
  return <Base.Separator className={cn(popupSeparator, className)} {...props} />;
}

/** A row that opens a nested menu to its side. */
export function MenuSubmenu({ label, icon, children }: { label: ReactNode; icon?: ReactNode; children: ReactNode }) {
  return (
    <Base.SubmenuRoot>
      <Base.SubmenuTrigger className={cn(popupItem, "data-popup-open:bg-row-active")}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className="size-3.5" />
      </Base.SubmenuTrigger>
      <MenuPopup side="right" align="start">
        {children}
      </MenuPopup>
    </Base.SubmenuRoot>
  );
}
