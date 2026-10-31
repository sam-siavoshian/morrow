"use client";

import { DialogContent, DialogRoot } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { DEFAULT_KEYBINDINGS, SHORTCUT_TITLES, TASK_JUMP_COMMANDS, type ShortcutCommand } from "@/lib/keymap";

export type ShortcutRow = { title: string; keys: string };

const JUMPS = new Set<ShortcutCommand>(TASK_JUMP_COMMANDS);

/** Every default binding as a row; the nine task jumps fold into one "alt+1…9" row. Pure, for tests. */
export function shortcutRows(): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  for (const binding of DEFAULT_KEYBINDINGS) {
    if (JUMPS.has(binding.command)) continue;
    rows.push({ title: SHORTCUT_TITLES[binding.command], keys: binding.key });
  }
  const first = DEFAULT_KEYBINDINGS.find((b) => b.command === TASK_JUMP_COMMANDS[0]);
  if (first) rows.push({ title: "Go to task 1 to 9", keys: first.key.replace(/1$/, "1…9") });
  return rows;
}

/** mod+/: the keyboard map. */
export function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" size="sm">
        <ul className="-mx-2 flex flex-col">
          {shortcutRows().map((row) => (
            <li key={row.title} className="flex min-h-9 items-center justify-between gap-4 rounded-[8px] px-2 text-[14px]">
              <span className="text-label-secondary">{row.title}</span>
              <Kbd keys={row.keys} size="md" />
            </li>
          ))}
        </ul>
      </DialogContent>
    </DialogRoot>
  );
}
