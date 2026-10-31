"use client";

import "@xterm/xterm/css/xterm.css";
import type { Terminal } from "@xterm/xterm";
import { ArrowUpRight, Check, Copy, KeyRound, LogIn, RotateCw, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { RadarSpinner } from "@/components/ui/radar-spinner";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { toast } from "@/components/ui/toast";
import { loginPath, mintTerminalToken } from "@/lib/api";
import { cn } from "@/lib/cn";
import { findSignInLink, type SignInLink, type TerminalLine } from "./sign-in-link";
import { TerminalController, type TerminalState } from "./terminal-controller";
import { terminalTheme } from "./terminal-theme";

/** The Claude TUI exits without TERM; a login shell picks up the user's PATH. */
const SHELL = "env TERM=xterm-256color bash -l";
/** Wait for the replayed scrollback to settle before typing a suggested command. */
const PREFILL_DELAY_MS = 700;
/** Ctrl-U: clear whatever is on the prompt line before the suggestion goes in. */
const CLEAR_LINE = "\x15";
/** Look for a sign-in link once output pauses this long, not on every chunk. */
const LINK_SCAN_DELAY_MS = 120;

const LABEL: Record<TerminalState["kind"], string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  expired: "Signed out",
  disabled: "Unavailable",
  unavailable: "Unavailable",
};

const TONE: Record<TerminalState["kind"], StatusTone> = {
  connecting: "attention",
  connected: "success",
  reconnecting: "attention",
  disconnected: "danger",
  expired: "danger",
  disabled: "idle",
  unavailable: "idle",
};

type PrivateTerminalProps = {
  teamId: string;
  envId: string;
  /** Typed at the prompt once, never run: the person reviews it and presses Enter. */
  command?: string;
  className?: string;
};

/**
 * The owner's own shell on their VM, straight from the browser to Freestyle with a short-lived token
 * held only in memory. Closing it detaches; the shell keeps running and the next open replays it.
 */
export function PrivateTerminal({ teamId, envId, command, className }: PrivateTerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<TerminalController | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [state, setState] = useState<TerminalState>({ kind: "connecting" });
  const [link, setLink] = useState<SignInLink | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let terminal: Terminal | null = null;
    let resize: ResizeObserver | null = null;
    let prefill = command ?? null;
    let prefillTimer = 0;
    let scanTimer = 0;

    (async () => {
      const [{ Terminal }, { FitAddon }, { Freestyle, connectXterm }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("freestyle"),
        document.fonts.ready,
      ]);
      if (disposed) return;
      const styles = getComputedStyle(element);
      const mono = styles.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
      const term = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: mono,
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 5000,
        theme: terminalTheme((property) => styles.getPropertyValue(property)),
      });
      terminal = term;
      terminalRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      const refit = () => {
        try {
          fit.fit();
        } catch {
          // Hidden or zero-sized for a frame: the next resize fits it.
        }
      };
      refit();
      resize = new ResizeObserver(() => requestAnimationFrame(refit));
      resize.observe(element);

      // Only the live screen counts: once a link scrolls away (signed in, cleared), the button goes with it.
      const scan = () => {
        const buffer = term.buffer.active;
        const lines: TerminalLine[] = [];
        for (let y = buffer.baseY; y < buffer.baseY + term.rows; y++) {
          const line = buffer.getLine(y);
          if (line) lines.push({ text: line.translateToString(true), wrapped: line.isWrapped });
        }
        const found = findSignInLink(lines, term.cols);
        setLink((current) => (current?.url === found?.url ? current : found));
      };
      const scheduleScan = () => {
        window.clearTimeout(scanTimer);
        scanTimer = window.setTimeout(() => {
          if (!disposed) scan();
        }, LINK_SCAN_DELAY_MS);
      };
      term.onWriteParsed(scheduleScan);
      term.onResize(scheduleScan);

      const next = new TerminalController(
        {
          mint: () => mintTerminalToken(teamId, envId),
          connect: async (grant, onClose) => {
            const pty = new Freestyle({ identityAccessToken: grant.token }).vms.ref(grant.vmId).linuxUser(grant.linuxUser).pty;
            const conn = await connectXterm({
              pty,
              terminal: term,
              slug: grant.session,
              exec: SHELL,
              replaceOnExit: true,
              // Reconnects go through the controller so each one can use a fresh token.
              reconnect: false,
              onClose,
            });
            if (prefill) {
              const text = prefill;
              prefill = null;
              prefillTimer = window.setTimeout(() => {
                if (conn.session.state === "connected") conn.session.write(CLEAR_LINE + text);
              }, PREFILL_DELAY_MS);
            }
            term.focus();
            return conn;
          },
          now: () => Date.now(),
          setTimer: (fn, ms) => window.setTimeout(fn, ms),
          clearTimer: (handle) => window.clearTimeout(handle as number),
        },
        (s) => {
          if (!disposed) setState(s);
        },
      );
      controller.current = next;
      next.start();
    })().catch(() => {
      if (!disposed) setState({ kind: "disconnected", message: "The terminal could not load. Check your connection." });
    });

    return () => {
      disposed = true;
      window.clearTimeout(prefillTimer);
      window.clearTimeout(scanTimer);
      terminalRef.current = null;
      controller.current?.stop();
      controller.current = null;
      resize?.disconnect();
      terminal?.dispose();
    };
  }, [teamId, envId, command]);

  const blocking = state.kind !== "connected" && state.kind !== "reconnecting";

  return (
    <div className={cn("relative isolate flex min-h-0 flex-col overflow-hidden rounded-card bg-terminal text-terminal-ink", className)}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/8 px-3 text-[12.5px]">
        <StatusDot tone={TONE[state.kind]} pulse={state.kind === "connecting" || state.kind === "reconnecting"} />
        <span role="status" className="font-[550] text-white/80">
          {LABEL[state.kind]}
          {state.kind === "reconnecting" ? ` (try ${state.attempt})` : null}
        </span>
        <span className="ml-auto truncate text-white/45">Only you can see this terminal</span>
      </div>
      <div className="relative min-h-0 flex-1 p-2 pr-0">
        <div ref={host} className="size-full [&_.xterm-viewport]:no-scrollbar" />
        {link && !blocking ? <SignInBar key={link.url} link={link} refocus={() => terminalRef.current?.focus()} /> : null}
        {blocking ? (
          <div className="absolute inset-0 grid place-items-center bg-terminal/92 p-6 text-center">
            <Overlay state={state} onReconnect={() => controller.current?.reconnect()} signInHref={loginPath(pathname)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A sign-in link from the terminal as a button, floating over the bottom of the shell so the terminal never resizes
 * (a resize would make the TUI redraw). Keyed by URL: a new link brings it back after a dismiss.
 */
function SignInBar({ link, refocus }: { link: SignInLink; refocus: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  const [opened, setOpened] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  if (dismissed) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy", { description: "Your browser blocked the clipboard." });
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center sm:justify-end">
      <div
        role="region"
        aria-label="Sign-in link"
        className="pointer-events-auto flex max-w-full items-center gap-1 rounded-capsule bg-white/8 py-1 pr-1 pl-3 shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.14),0_12px_32px_rgb(0_0_0/0.4)] backdrop-blur-md animate-[arrive_360ms_var(--ease-out)_backwards]"
      >
        <KeyRound className="size-3.5 shrink-0 text-white/55" aria-hidden />
        <span className="mr-1 ml-1.5 hidden truncate text-[12.5px] text-white/70 sm:inline">
          {opened ? (
            <>Finish on <span className="font-[550] text-white/90">{link.host}</span>, then come back here</>
          ) : (
            <>Sign-in link for <span className="font-[550] text-white/90">{link.host}</span></>
          )}
        </span>
        <IconButton
          label={copied ? "Copied" : "Copy link"}
          size="sm"
          variant="ghost"
          className="text-white/65 hover:bg-white/10 hover:text-white active:bg-white/14"
          onClick={() => void copy()}
        >
          {copied ? <Check className="text-[var(--terminal-green)]" strokeWidth={2.25} /> : <Copy />}
        </IconButton>
        <Button
          size="sm"
          variant="sky"
          render={<a href={link.url} target="_blank" rel="noopener noreferrer" />}
          onClick={() => {
            setOpened(true);
            refocus();
          }}
        >
          {opened ? "Open again" : "Open sign-in page"}
          <ArrowUpRight />
        </Button>
        <IconButton
          label="Dismiss"
          size="sm"
          variant="ghost"
          className="text-white/50 hover:bg-white/10 hover:text-white active:bg-white/14"
          onClick={() => {
            setDismissed(true);
            refocus();
          }}
        >
          <X />
        </IconButton>
      </div>
    </div>
  );
}

function Overlay({ state, onReconnect, signInHref }: { state: TerminalState; onReconnect: () => void; signInHref: string }) {
  if (state.kind === "connecting") {
    return (
      <div className="flex items-center gap-2 text-[13.5px] text-white/75">
        <RadarSpinner className="text-terminal-cursor" />
        Opening your shell…
      </div>
    );
  }
  if (state.kind === "connected" || state.kind === "reconnecting") return null;
  return (
    <div className="flex max-w-sm flex-col items-center gap-4">
      <p className="text-[14px] leading-[1.5] text-white/80 text-balance">{state.message}</p>
      {state.kind === "disconnected" || state.kind === "unavailable" ? (
        <Button size="sm" variant="secondary" onClick={onReconnect}>
          <RotateCw />
          {state.kind === "disconnected" ? "Reconnect" : "Try again"}
        </Button>
      ) : null}
      {state.kind === "expired" ? (
        <Button size="sm" variant="secondary" render={<a href={signInHref} />}>
          <LogIn />
          Sign in again
        </Button>
      ) : null}
    </div>
  );
}
