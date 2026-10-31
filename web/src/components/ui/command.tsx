"use client";

import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog as Base } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { useEffect, useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { DialogBackdrop } from "./dialog";
import { Kbd } from "./kbd";
import { popupItem, popupLabel } from "./popup-styles";
import { usePortalContainer } from "./portal";

export type CommandItem = {
  /** Unique id. */
  value: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string | readonly string[];
  /** Extra words that should match, never shown. */
  keywords?: string;
  onSelect?: () => void;
};

export type CommandGroup = { label: string; items: readonly CommandItem[] };

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly CommandGroup[];
  placeholder?: string;
  /** Opens the palette on ⌘K / Ctrl+K. */
  hotkey?: boolean;
  empty?: ReactNode;
};

/**
 * The ⌘K shell: a dialog holding a filtering list (Base UI Autocomplete).
 * Data comes from the caller; this owns only look and keyboard.
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  placeholder = "Search commands…",
  hotkey = true,
  empty = "Nothing matches.",
}: CommandPaletteProps) {
  const container = usePortalContainer();
  const hintId = useId();

  useEffect(() => {
    if (!hotkey) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey, open, onOpenChange]);

  const select = (item: CommandItem) => {
    onOpenChange(false);
    item.onSelect?.();
  };

  return (
    <Base.Root open={open} onOpenChange={onOpenChange}>
      <Base.Portal container={container}>
        <DialogBackdrop />
        <Base.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[12vh] pb-3">
          <Base.Popup
            aria-label="Command palette"
            className={cn(
              "dialog-glass flex max-h-[min(34rem,calc(100dvh-6rem))] w-full max-w-xl flex-col overflow-hidden rounded-panel text-text outline-none",
              "origin-top transition-[opacity,scale,translate] duration-[130ms] ease-emphasized",
              "data-starting-style:-translate-y-2 data-starting-style:scale-98 data-starting-style:opacity-0",
              "data-ending-style:scale-98 data-ending-style:opacity-0 data-ending-style:duration-[90ms] data-ending-style:ease-exit",
            )}
          >
            <Autocomplete.Root
              open
              inline
              items={groups}
              autoHighlight="always"
              keepHighlight
              itemToStringValue={(item: CommandItem) => `${item.label} ${item.keywords ?? ""}`}
            >
              <Autocomplete.InputGroup className="flex items-center gap-2.5 px-4">
                <Search className="size-4.5 text-muted" />
                <Autocomplete.Input
                  aria-label="Search commands"
                  aria-describedby={hintId}
                  placeholder={placeholder}
                  className="h-13 w-full bg-transparent text-[16px] tracking-[-0.011em] text-text outline-none placeholder:text-faint"
                />
                <Kbd keys="escape" variant="ghost" />
              </Autocomplete.InputGroup>
              <Base.Close className="sr-only">Close command palette</Base.Close>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border p-1.5 [scroll-padding-block:0.375rem]">
                <Autocomplete.Empty className="flex min-h-28 items-center justify-center text-[14px] text-muted empty:hidden">
                  {empty}
                </Autocomplete.Empty>
                <Autocomplete.List>
                  {(group: CommandGroup) => (
                    <Autocomplete.Group key={group.label} items={group.items} className="not-last:mb-1">
                      <Autocomplete.GroupLabel className={popupLabel}>{group.label}</Autocomplete.GroupLabel>
                      <Autocomplete.Collection>
                        {(item: CommandItem) => (
                          <Autocomplete.Item
                            key={item.value}
                            value={item}
                            onClick={() => select(item)}
                            className={cn(popupItem, "min-h-10 sm:min-h-9 [scroll-margin-block:0.375rem]")}
                          >
                            {item.icon}
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            {item.shortcut ? <Kbd keys={item.shortcut} variant="ghost" /> : null}
                          </Autocomplete.Item>
                        )}
                      </Autocomplete.Collection>
                    </Autocomplete.Group>
                  )}
                </Autocomplete.List>
              </div>
              <div className="flex items-center gap-4 border-t border-border bg-fill px-4 py-2 text-[12px] text-muted">
                <span id={hintId} className="sr-only">
                  Arrow keys move, Enter runs the highlighted command.
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd keys={["up"]} /> <Kbd keys={["down"]} /> Move
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd keys="enter" /> Run
                </span>
              </div>
            </Autocomplete.Root>
          </Base.Popup>
        </Base.Viewport>
      </Base.Portal>
    </Base.Root>
  );
}
