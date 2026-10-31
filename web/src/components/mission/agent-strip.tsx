"use client";

import type { CliKind, RelayEventView } from "@morrow/contracts";
import { useEffect, useRef, useState } from "react";
import { HarnessIcon } from "@/components/harness/harness-icon";
import { agentColor } from "@/components/timeline/agent-color";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { relayEventKey } from "@/lib/store/relay";
import { cn } from "@/lib/cn";
import { agentTone, StatusPip, TONE_TILE } from "./agent-status";
import styles from "./agent-strip.module.css";
import type { WorkerState } from "./workers";

export type StripMember = {
  name: string;
  label: string;
  /** Null for a person. */
  cli: CliKind | null;
  /** "saam's Claude Code on saam-box", or a person's name. */
  detail: string;
  /** Null for a person. */
  state: WorkerState["kind"] | null;
  avatarUrl?: string | null;
  login?: string;
};

/** How long a tile glows after its agent sends something. */
const PULSE_MS = 2_400;

type AgentStripProps = {
  members: readonly StripMember[];
  /** The task's Relay traffic, oldest first. Only messages that arrive while mounted make a tile pulse. */
  events: readonly RelayEventView[];
  /** The agent or person the chat is narrowed to. */
  focused: string | null;
  onFocus: (name: string) => void;
};

/**
 * Everyone in the chat as one row of tiles above it. A tile pulses when its agent sends a message; tapping it
 * shows only that agent's messages (tap again for everyone). Ended agents are dimmed with a status mark.
 */
export function AgentStrip({ members, events, focused, onFocus }: AgentStripProps) {
  const [pulsing, setPulsing] = useState<ReadonlyMap<string, string>>(new Map());
  const seen = useRef<Set<string> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    const keys = events.map(relayEventKey);
    if (!seen.current) {
      seen.current = new Set(keys);
      return;
    }
    const fresh = new Map<string, string>();
    events.forEach((event, i) => {
      const key = keys[i]!;
      if (seen.current!.has(key)) return;
      seen.current!.add(key);
      if (event.type === "message" && event.from.kind !== "system") fresh.set(event.from.name, key);
    });
    if (fresh.size === 0) return;
    setPulsing((prev) => new Map([...prev, ...fresh]));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setPulsing((prev) => {
        const next = new Map(prev);
        for (const [name, key] of fresh) if (next.get(name) === key) next.delete(name);
        return next;
      });
    }, PULSE_MS);
    timers.current.add(timer);
  }, [events]);

  if (members.length === 0) return null;
  return (
    <ul aria-label="Who is in the chat" className="-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 py-1 [scrollbar-width:none]">
      {members.map((m) => {
        const on = focused === m.name;
        const tone = m.state ? agentTone(m.state) : "live";
        const color = agentColor(m.name);
        const pulse = pulsing.has(m.name);
        return (
          <li key={m.name} className="shrink-0">
            <Tooltip content={m.state ? `${m.detail} · ${STATE_WORD[m.state]}` : m.detail}>
              <button
                type="button"
                onClick={() => onFocus(m.name)}
                aria-pressed={on}
                aria-label={`${m.label}${m.state ? `, ${STATE_WORD[m.state]}` : ""}. ${on ? "Show everyone's messages" : "Show only their messages"}`}
                className={cn(
                  "flex w-[4.25rem] flex-col items-center gap-1 rounded-row px-1 py-1.5 transition-colors duration-150 hover:bg-row-hover",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  on && "bg-row-active hover:bg-row-active",
                )}
              >
                <span className="relative isolate">
                  {pulse ? <span aria-hidden className={cn(styles.pulse, "absolute -inset-[3px] -z-10 rounded-[32%]", color.dot)} /> : null}
                  {m.cli ? (
                    <HarnessIcon cli={m.cli} size={30} decorative className={TONE_TILE[tone]} />
                  ) : (
                    <Avatar name={m.label} src={m.avatarUrl ?? null} login={m.login} size={30} />
                  )}
                  {m.state ? <StatusPip kind={m.state} size={13} /> : null}
                </span>
                <span className={cn("max-w-full truncate text-[11px] font-[600]", m.cli ? color.text : "text-label-secondary", tone === "ended" && "opacity-60")}>{m.label}</span>
              </button>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

const STATE_WORD: Record<WorkerState["kind"], string> = {
  working: "working",
  starting: "starting",
  waiting: "waiting",
  cooldown: "on cooldown",
  failed: "failed",
  done: "done",
  stopped: "ended",
};

/** Rows shown before "and 2 more". */
const WORKING_SHOWN = 4;

/** "api e2 is working…" for each live agent, at the foot of the chat, so it reads alive between messages. */
export function WorkingNow({ members }: { members: readonly StripMember[] }) {
  const live = members.filter((m) => m.state === "working" || m.state === "starting");
  if (live.length === 0) return null;
  const shown = live.slice(0, WORKING_SHOWN);
  return (
    <ul aria-label="Agents working now" className="flex flex-col gap-1 py-1">
      {shown.map((m) => (
        <li key={m.name} className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted">
          {m.cli ? <HarnessIcon cli={m.cli} size={16} decorative /> : null}
          <span className={cn("truncate font-[600]", agentColor(m.name).text)}>{m.label}</span>
          <span className="shrink-0">{m.state === "starting" ? "is starting" : "is working"}</span>
          <span aria-hidden className={cn(styles.dots, "flex items-center gap-[3px]")}>
            <span className="size-1 rounded-full bg-current" />
            <span className="size-1 rounded-full bg-current" />
            <span className="size-1 rounded-full bg-current" />
          </span>
        </li>
      ))}
      {live.length > shown.length ? <li className="pl-6 text-[12px] text-faint">and {live.length - shown.length} more working</li> : null}
    </ul>
  );
}
