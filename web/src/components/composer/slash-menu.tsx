"use client";

import { ListChecks, Sparkles, Users } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { SlashCommand, SlashCommandId } from "./slash-commands";

const ICON: Record<SlashCommandId, ReactNode> = {
  workers: <Users />,
  plan: <Sparkles />,
  criteria: <ListChecks />,
};

export const slashOptionId = (id: SlashCommandId) => `composer-slash-${id}`;
export const SLASH_LIST_ID = "composer-slash-list";

type SlashMenuProps = {
  commands: SlashCommand[];
  active: number;
  onHover: (index: number) => void;
  onPick: (command: SlashCommand) => void;
};

/**
 * One menu for every `/` command, anchored above the card like t3code's. Mouse down never takes
 * focus from the editor; the editor owns the keys (see composer-keys.ts).
 */
export function SlashMenu({ commands, active, onHover, onPick }: SlashMenuProps) {
  return (
    <div className="absolute inset-x-[1.375rem] bottom-[calc(100%-0.5rem)] z-30">
      <div className="dropdown-glass rounded-row p-1">
        {commands.length === 0 ? (
          <p className="px-2 py-2 text-[13.5px] text-muted">No matching command</p>
        ) : (
          <ul id={SLASH_LIST_ID} role="listbox" aria-label="Commands" className="flex max-h-72 flex-col overflow-y-auto">
            {commands.map((command, index) => (
              <li
                key={command.id}
                id={slashOptionId(command.id)}
                role="option"
                aria-selected={index === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => onHover(index)}
                onClick={() => onPick(command)}
                className={cn(
                  "flex min-h-10 cursor-default items-center gap-2.5 rounded-[8px] px-2 py-1.5 select-none sm:min-h-9",
                  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted",
                  index === active && "bg-row-active",
                )}
              >
                {ICON[command.id]}
                <span className="font-mono text-[13.5px] font-[500] text-text">/{command.name}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{command.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
