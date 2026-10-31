// Shared looks for every floating surface (menu, select, popover, command).

/** t3code dropdown glass on the row radius. */
export const popupSurface = "dropdown-glass rounded-row p-1 text-text outline-none";

/**
 * Zephium open: opacity on --ease-out, the travel on --ease-emphasized; leaving
 * is quicker than arriving.
 */
export const popupMotion = [
  "origin-(--transform-origin)",
  "transition-[opacity,scale,translate] duration-[120ms] ease-emphasized",
  "data-starting-style:scale-98 data-starting-style:opacity-0",
  "data-ending-style:scale-98 data-ending-style:opacity-0 data-ending-style:duration-[90ms] data-ending-style:ease-exit",
  "data-instant:transition-none",
].join(" ");

/** One row in a menu-like list: highlighted rows fill, never outline. */
export const popupItem = [
  "relative flex min-h-9 cursor-default select-none items-center gap-2 rounded-[8px] px-2 py-1 sm:min-h-8",
  "text-[14.5px] sm:text-[14px] tracking-[-0.006em] outline-none",
  "data-highlighted:bg-row-active data-disabled:pointer-events-none data-disabled:opacity-50",
  "[&_svg]:shrink-0 [&_svg]:text-muted [&_svg:not([class*='size-'])]:size-4",
].join(" ");

/** The selected-row check: always at the row's right end, at text strength. */
export const popupCheck = "size-3.5 shrink-0 !text-text";

export const popupLabel = "px-2 pt-1.5 pb-1 text-[12px] font-[550] tracking-[0.01em] text-faint select-none";

export const popupSeparator = "mx-2 my-1 h-px bg-menu-separator";
