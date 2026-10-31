"use client";

import type { RelayMessageView } from "@morrow/contracts";
import { ArrowUp, AtSign, CornerDownRight, Server, Users } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HarnessIcon } from "@/components/harness/harness-icon";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { popupLabel } from "@/components/ui/popup-styles";
import { toast } from "@/components/ui/toast";
import { VmLabel } from "@/components/workforce/vm-groups";
import { errorMessage, isApiError, messageTask } from "@/lib/api";
import { cn } from "@/lib/cn";
import { resolveTarget, type AtMenu, type AtTarget } from "./at-menu";

type MessageBarProps = {
  teamId: string;
  taskId: string;
  /** Every VM and profile of the team, and this task's live workers (`buildAtMenu`). */
  menu: AtMenu;
  /** Why sending is off (Relay not ready, task ended), or null when it is on. */
  disabledReason: string | null;
  /** Shows the sent message at once; the live event replaces it by id. */
  onSent: (message: RelayMessageView) => void;
};

const MAX_CHARS = 4000;
const TEAM: AtTarget = { kind: "team" };

/** A fresh idempotency key for one add-an-agent request (the contract's `AddAgentKey`). */
const newRequestKey = () => crypto.randomUUID().replace(/-/g, "");

function sameTarget(a: AtTarget, b: AtTarget): boolean {
  switch (a.kind) {
    case "team":
      return b.kind === "team";
    case "worker":
      return b.kind === "worker" && b.name === a.name;
    case "profile":
      return b.kind === "profile" && b.id === a.id;
    case "env":
      return b.kind === "env" && b.id === a.id;
  }
}

/** Status text at a row's right end; the reason a disabled row can't be picked. */
function RowStatus({ children }: { children: string }) {
  return children ? <span className="ml-auto shrink-0 pl-2 text-[12.5px] whitespace-nowrap text-faint tabular-nums">{children}</span> : null;
}

/**
 * Message the team channel, steer one live worker, or add an agent on a VM or CLI profile with the message as its
 * brief (`messageTask`). Enter sends, Shift+Enter is a new line, and `@` at the start opens the menu.
 */
export function MessageBar({ teamId, taskId, menu, disabledReason, onSent }: MessageBarProps) {
  const [text, setText] = useState("");
  const [to, setTo] = useState<AtTarget>(TEAM);
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  // Kept across a failed send that may have reached the server, so a retry adds the agent once.
  const requestKey = useRef<string | null>(null);

  // A worker that ended, or a profile or VM that left the team, drops back to the team channel.
  const target = useMemo(() => resolveTarget(menu, to), [menu, to]);
  const disabled = disabledReason !== null;
  const trimmed = text.trim();
  const blocked = target?.blocked ?? null;
  const canSend = !disabled && !sending && !blocked && trimmed.length > 0 && trimmed.length <= MAX_CHARS;

  const choose = (next: AtTarget) => {
    setTo(next);
    requestKey.current = null;
    setPickerOpen(false);
    // A leading "@" only opened the picker; it is not part of the message.
    setText((t) => (t === "@" ? "" : t));
    requestAnimationFrame(() => input.current?.focus());
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const adding = target?.adds === true && (to.kind === "profile" || to.kind === "env");
    try {
      if (adding) {
        requestKey.current ??= newRequestKey();
        const res = await messageTask(teamId, taskId, { to: { kind: to.kind, id: to.id }, text: trimmed, key: requestKey.current });
        requestKey.current = null;
        if (res.message) onSent(res.message);
        setText("");
        setTo(TEAM);
        toast.success(`Agent added on ${target.label}`, { description: "It starts in a moment, with your message as its brief." });
      } else {
        // A worker keeps the string form, which every backend version reads.
        const { message } = await messageTask(teamId, taskId, { to: to.kind === "worker" && target ? to.name : "team", text: trimmed });
        if (message) onSent(message);
        setText("");
      }
    } catch (error) {
      // The server answered and refused: the next try is a new request. Otherwise it may have gone through, so a
      // retry keeps the key and gets the same agent back.
      if (isApiError(error) && error.status < 500) requestKey.current = null;
      toast.error(adding ? "Agent not added" : "Message not sent", {
        description: errorMessage(error, "It didn't reach the server. Check your connection; your text is still here."),
      });
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === "@" && text === "") {
      event.preventDefault();
      setPickerOpen(true);
    } else if (event.key === "Backspace" && text === "" && target) {
      choose(TEAM);
    }
  };

  const placeholder = disabled
    ? disabledReason
    : !target
      ? "Message the team. @ an agent or VM"
      : target.adds
        ? `Brief a new agent on ${target.label}…`
        : `Steer ${target.label}…`;
  const action = !target ? "Send to the team" : target.adds ? `Add an agent on ${target.label}` : `Steer ${target.label}`;
  const hasWorkers = menu.otherWorkers.length > 0 || menu.vms.some((vm) => vm.profiles.some((p) => p.workers.length > 0));
  const isChosen = (t: AtTarget) => sameTarget(to, t) && (t.kind === "team" || target !== null);

  return (
    <div className="@container mx-auto w-full max-w-[72rem] px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
      <div
        className={cn(
          "flex items-end gap-1.5 rounded-[20px] bg-surface p-1.5 shadow-composer shadow-hairline transition-shadow duration-200",
          "focus-within:shadow-[inset_0_0_0_1px_var(--color-field-ring),var(--shadow-composer)]",
          disabled && "opacity-80",
        )}
      >
        <Menu
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          side="top"
          align="start"
          className="max-h-[min(28rem,65dvh)] w-[min(23rem,calc(100vw-1.5rem))] max-w-none overflow-y-auto overscroll-contain"
          trigger={
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={target ? `Sending to ${target.label}. Change` : "Sending to the team channel. Change"}
              className="h-8 max-w-44 shrink-0 gap-1.5 px-2.5"
            >
              {target?.cli ? <HarnessIcon cli={target.cli} size={16} decorative /> : to.kind === "env" && target ? <Server /> : target ? <AtSign /> : <Users />}
              <span className="truncate">{target ? target.label : "Team"}</span>
            </Button>
          }
        >
          <MenuItem icon={<Users />} checked={isChosen(TEAM)} onClick={() => choose(TEAM)}>
            Team channel
          </MenuItem>
          <MenuSeparator />
          <div className={popupLabel}>Agents and VMs</div>
          {menu.addBlock ? (
            <p className="px-2 pb-1.5 text-[12.5px] leading-[1.4] text-muted">
              {menu.addBlock}
              {hasWorkers ? " You can still steer a live worker." : ""}
            </p>
          ) : null}
          {menu.vms.length === 0 ? (
            <p className="px-2 pt-0.5 pb-2 text-[13px] leading-[1.45] text-muted">No VMs yet. Set one up in Workforce to add agents here.</p>
          ) : null}
          {menu.vms.map((vm, i) => (
            <MenuGroup key={vm.envId} label={vm.owner ? `${vm.name}, ${vm.owner}'s VM` : vm.name} className={cn(i > 0 && "mt-1")}>
              <MenuItem disabled={!vm.available} checked={isChosen({ kind: "env", id: vm.envId })} onClick={() => choose({ kind: "env", id: vm.envId })}>
                <span className="flex min-w-0 items-center gap-1.5 font-[550]">
                  <VmLabel group={vm} />
                  <RowStatus>{vm.status}</RowStatus>
                </span>
              </MenuItem>
              {vm.profiles.length === 0 ? null : (
                <>
                  {vm.profiles.map((p) => (
                    <div key={p.id}>
                      <MenuItem
                        className="group pl-5"
                        icon={<HarnessIcon cli={p.cli} size={16} decorative className="group-data-disabled:grayscale" />}
                        disabled={!p.available}
                        checked={isChosen({ kind: "profile", id: p.id })}
                        onClick={() => choose({ kind: "profile", id: p.id })}
                      >
                        <span className="flex min-w-0 items-center">
                          <span className="min-w-0 truncate">{p.label}</span>
                          <RowStatus>{p.status}</RowStatus>
                        </span>
                      </MenuItem>
                      {p.workers.map((w) => (
                        <MenuItem
                          key={w.name}
                          className="pl-9"
                          icon={<CornerDownRight />}
                          checked={isChosen({ kind: "worker", name: w.name })}
                          onClick={() => choose({ kind: "worker", name: w.name })}
                        >
                          <span className="flex min-w-0 items-center">
                            <span className="min-w-0 truncate font-[550]">{w.label}</span>
                            <RowStatus>Steer</RowStatus>
                          </span>
                        </MenuItem>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </MenuGroup>
          ))}
          {menu.otherWorkers.length > 0 ? (
            <MenuGroup label="Other live workers" className="mt-1">
              <div className={popupLabel}>Other live workers</div>
              {menu.otherWorkers.map((w) => (
                <MenuItem
                  key={w.name}
                  icon={w.cli ? <HarnessIcon cli={w.cli} size={16} decorative /> : <AtSign />}
                  checked={isChosen({ kind: "worker", name: w.name })}
                  onClick={() => choose({ kind: "worker", name: w.name })}
                >
                  <span className="flex min-w-0 items-center">
                    <span className="min-w-0 truncate font-[550]">{w.label}</span>
                    <RowStatus>Steer</RowStatus>
                  </span>
                </MenuItem>
              ))}
            </MenuGroup>
          ) : null}
        </Menu>
        <label className="sr-only" htmlFor={`message-${taskId}`}>
          {action}
        </label>
        <textarea
          id={`message-${taskId}`}
          ref={input}
          rows={1}
          value={text}
          maxLength={MAX_CHARS}
          disabled={disabled || sending}
          placeholder={placeholder ?? undefined}
          onChange={(event) => {
            setText(event.target.value);
            requestKey.current = null;
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "max-h-40 min-h-8 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[5px] text-[16px] leading-[1.45] text-text outline-none [field-sizing:content] placeholder:text-faint sm:text-[14.5px]",
            "disabled:cursor-not-allowed",
          )}
        />
        <Button
          variant="primary"
          size={target ? "sm" : "icon-sm"}
          disabled={!canSend}
          loading={sending}
          onClick={() => void send()}
          aria-label={action}
          className="shrink-0"
        >
          {!target ? <ArrowUp /> : target.adds ? "Add" : "Steer"}
        </Button>
      </div>
      <p className="mt-1.5 flex min-w-0 items-center gap-1.5 truncate px-2 text-[11.5px] whitespace-nowrap text-faint @max-[36rem]:hidden">
        {disabled ? (
          <span>{disabledReason}</span>
        ) : blocked ? (
          <span className="truncate">{blocked}</span>
        ) : (
          <>
            <Kbd keys="enter" variant="ghost" /> send
            <span aria-hidden>·</span>
            <Kbd keys={["shift", "enter"]} variant="ghost" /> new line
            <span aria-hidden>·</span>
            {!target ? (
              <span>Everyone on the task sees it in Relay. @ an agent or VM.</span>
            ) : target.adds ? (
              <span className="truncate">Adds an agent to this task with your message as its brief.</span>
            ) : (
              <span>The worker reads this on its next turn.</span>
            )}
          </>
        )}
      </p>
    </div>
  );
}
