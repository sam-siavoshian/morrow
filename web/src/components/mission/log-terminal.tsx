"use client";

import "@xterm/xterm/css/xterm.css";
import { WORKER_TERMINAL } from "@morrow/contracts";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { connectInspect, type InspectEnd } from "@/lib/realtime";
import type { ApiError } from "@/lib/api";
import { createOutputBatcher, fitFontSize, measureAdvance, MIN_FONT_PX, TERMINAL_THEME } from "./terminal-view";

export type LogStatus = { kind: "connecting" } | { kind: "live"; agentName: string } | { kind: "ended"; reason: InspectEnd; message: string | null };

/** Servers older than the size pin send no size; their workers' PTYs were 80x24. */
const LEGACY_TERMINAL = { cols: 80, rows: 24 };
/** Breathing room inside the dark box, each side (matches `p-2` below). */
const INSET_PX = 8;
const LINE_HEIGHT = 1.2;

type LogTerminalProps =
  | {
      teamId: string;
      leaseId: string;
      /** Bumped by Reconnect to open a fresh stream. */
      attempt: number;
      onStatus: (status: LogStatus) => void;
      text?: undefined;
    }
  | {
      /** A finished log, written once: no stream is opened. */
      text: string;
      teamId?: undefined;
      leaseId?: undefined;
      attempt?: undefined;
      onStatus?: undefined;
    };

/**
 * A read-only xterm mirror of a worker's terminal: live (`connectInspect`), or a finished log passed as `text`.
 * It is exactly the worker's PTY size (the server says which in its hello), never fitted to the panel: the stream is
 * cursor-addressed for that size, and any other width paints a TUI's redraws over the wrong cells. The font scales so
 * the full width fits; below the smallest readable size it scrolls sideways instead. Output is batched into one write
 * per animation frame, and written as is (no newline rewriting). Stdin is off and nothing is ever sent; the server
 * drops input anyway. Loaded on demand, so xterm never weighs on the first paint.
 */
export default function LogTerminal({ teamId, leaseId, attempt, onStatus, text }: LogTerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const statusRef = useRef(onStatus);
  useEffect(() => {
    statusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    const outer = host.current;
    const el = screen.current;
    if (!outer || !el) return;
    const fontFamily = getComputedStyle(el).fontFamily;
    let advance = measureAdvance(fontFamily);
    const terminal = new Terminal({
      cols: WORKER_TERMINAL.cols,
      rows: WORKER_TERMINAL.rows,
      disableStdin: true,
      convertEol: false,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      scrollback: 5000,
      fontFamily,
      fontSize: MIN_FONT_PX,
      lineHeight: LINE_HEIGHT,
      theme: TERMINAL_THEME,
    });
    terminal.open(el);

    const refit = () => {
      const width = outer.clientWidth - INSET_PX * 2;
      if (width <= 0) return; // Hidden: the next resize fits it.
      const { fontSize, overflow } = fitFontSize(width - 2, terminal.cols, advance);
      if (terminal.options.fontSize !== fontSize) terminal.options.fontSize = fontSize;
      outer.style.overflowX = overflow ? "auto" : "hidden";
    };
    refit();
    const watch = new ResizeObserver(refit);
    watch.observe(outer);
    let alive = true;
    // A web font that finished loading after mount has different metrics.
    void document.fonts?.ready.then(() => {
      if (!alive) return;
      advance = measureAdvance(fontFamily);
      refit();
    });
    const cleanup = () => {
      alive = false;
      watch.disconnect();
      terminal.dispose();
    };

    if (text !== undefined) {
      terminal.write(text, () => terminal.scrollToBottom());
      return cleanup;
    }

    const batch = createOutputBatcher((data) => terminal.write(data));
    statusRef.current?.({ kind: "connecting" });
    const handle = connectInspect(
      teamId,
      leaseId,
      (frame) => {
        if (frame.kind === "inspect.hello") {
          const size = frame.cols && frame.rows ? { cols: frame.cols, rows: frame.rows } : LEGACY_TERMINAL;
          if (terminal.cols !== size.cols || terminal.rows !== size.rows) terminal.resize(size.cols, size.rows);
          refit();
          statusRef.current?.({ kind: "live", agentName: frame.agentName });
        } else {
          batch.push(frame.data, frame.reset);
        }
      },
      { onEnd: (reason, error?: ApiError) => statusRef.current?.({ kind: "ended", reason, message: error?.message ?? null }) },
    );
    return () => {
      handle.close();
      batch.dispose();
      cleanup();
    };
  }, [teamId, leaseId, attempt, text]);

  return (
    <div
      ref={host}
      className="size-full min-h-0 overflow-y-auto rounded-row p-2 [scrollbar-color:#3a3f48_transparent]"
      style={{ background: TERMINAL_THEME.background, overflowX: "hidden" }}
      aria-label={text !== undefined ? "Worker's last terminal output, read only" : "Worker terminal, read only"}
      role="log"
    >
      <div ref={screen} className="w-max font-mono" />
    </div>
  );
}
