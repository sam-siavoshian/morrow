"use client";

import type { ReactNode } from "react";
import { DialogContent, DialogRoot } from "@/components/ui/dialog";
import { PrivateTerminal } from "./private-terminal";

type TerminalDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  envId: string;
  title?: ReactNode;
  /** One line above the terminal, e.g. how to log in. */
  hint?: ReactNode;
  /** Typed at the prompt, never run. */
  command?: string;
};

/**
 * The private terminal in a large dialog. The terminal only mounts while open, so closing it
 * detaches (the shell keeps running) and drops the token from memory.
 */
export function TerminalDialog({ open, onOpenChange, teamId, envId, title = "Private terminal", hint, command }: TerminalDialogProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={title}
        description="Your shell on your VM. It connects straight to the VM, so your logins stay there and never pass through our servers."
        className="sm:max-w-[min(60rem,calc(100vw-3rem))]"
      >
        {hint ? <div className="mb-3 text-[13.5px] leading-[1.5] text-label-secondary">{hint}</div> : null}
        {open ? <PrivateTerminal teamId={teamId} envId={envId} command={command} className="h-[min(62dvh,560px)]" /> : null}
      </DialogContent>
    </DialogRoot>
  );
}
