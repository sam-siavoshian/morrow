"use client";

import type { RelayEventView } from "@morrow/contracts";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/cn";
import { prefersReducedMotion } from "@/lib/motion";
import type { RelayMarks } from "@/lib/store/team-store";
import { buildTimelineRows, type TimelineFilter } from "./classify";
import { conversationIndex } from "./conversation";
import type { Directory } from "./directory";
import { Divider, RelayMarksContext, TimelineRowView } from "./rows";
import { anchorShift, distanceFromEnd, FOLLOW_THRESHOLD_PX, followAfterScroll } from "./scroll-follow";

export { distanceFromEnd } from "./scroll-follow";

export type TimelineHistory = { hasMore: boolean; loading: boolean; loadOlder: () => boolean };

type RelayTimelineProps = {
  /** Oldest first, already scoped to a task or channel. */
  events: readonly RelayEventView[];
  filter: TimelineFilter;
  directory: Directory;
  history: TimelineHistory;
  /** Shown when nothing matches (no traffic yet, or the filter hides it all). */
  empty: ReactNode;
  /** A live line at the end, like "2 agents working 1m 03s". */
  footer?: ReactNode;
  /** Work is happening. Kept for callers; the list follows new rows whenever you are at the end. */
  live?: boolean;
  /** Live reactions by message id (the team store's `relayMarks`), laid over each message's own. */
  marks?: Readonly<Record<string, RelayMarks>>;
  className?: string;
};

/** Rows rendered at first, newest last. Older ones come in pages as you scroll up, so the DOM stays small. */
export const TIMELINE_WINDOW = 150;
/** Within this many pixels of the end counts as "at the end": the list keeps following new rows. */
export const STICK_THRESHOLD_PX = FOLLOW_THRESHOLD_PX;
/** Near the top, the next page of older rows (or messages) loads. */
const LOAD_OLDER_PX = 240;
const SHOW_PILL_DELAY_MS = 150;

/** How many rows came after `after` (the newest row when the reader looked away). 0 when it is gone or unknown. */
export function newSince(rows: readonly { key: string }[], after: string | null): number {
  if (after === null) return rows.length;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.key === after) return rows.length - 1 - i;
  return 0;
}

/** The first row index to render: the newest `size` rows, never past the start. */
export function windowStart(total: number, size: number): number {
  return Math.max(0, total - Math.max(0, size));
}

/**
 * The Relay timeline: pinned to the newest message while you are at the end, staying put (with t3code's "Scroll to
 * end" glass pill counting what arrived) once you scroll up, and loading older rows and pages at the top. Plain flow
 * layout, so every row is laid out at its real size: no measured slots to go stale, clip or leave gaps.
 */
export function RelayTimeline({ events, filter, directory, history, empty, footer, marks, className }: RelayTimelineProps) {
  const rows = useMemo(() => buildTimelineRows(events, filter), [events, filter]);
  // From every event, not the filtered rows: "who it answers" needs the question even when the filter hides it.
  const conversation = useMemo(() => conversationIndex(events), [events]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // A new filter is a new list: it opens at the newest rows.
  const listKey = `${filter.scope}:${filter.agent ?? ""}`;
  const [windowed, setWindowed] = useState({ key: listKey, size: TIMELINE_WINDOW });
  const size = windowed.key === listKey ? windowed.size : TIMELINE_WINDOW;
  if (windowed.key !== listKey) setWindowed({ key: listKey, size: TIMELINE_WINDOW });
  const start = windowStart(rows.length, size);
  const shown = start > 0 ? rows.slice(start) : rows;

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Following the end. Only the reader scrolling up stops it (scroll-follow.ts); new or growing rows never do.
  const stick = useRef(true);
  // scrollTop at the last scroll event: a drop means the reader moved up.
  const lastTop = useRef(0);
  // The "Scroll to end" pill, for the list it was shown on: a new filter is a new list, so an old pill just stops counting.
  // `after`: the newest row when it appeared; rows past it are "new" (older pages loading in above are not).
  const [pillState, setPill] = useState<{ after: string | null; key: string } | null>(null);
  const pill = pillState?.key === listKey ? pillState : null;
  const pillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newestRow = useRef<string | null>(rows.at(-1)?.key ?? null);
  useEffect(() => {
    newestRow.current = rows.at(-1)?.key ?? null;
  });

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toEnd = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth && !prefersReducedMotion()) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  const hidePill = useCallback(() => {
    if (pillTimer.current) clearTimeout(pillTimer.current);
    pillTimer.current = null;
    setPill(null);
  }, []);

  const { hasMore, loading, loadOlder } = history;
  const showEarlier = useCallback(() => setWindowed({ key: listKey, size: size + TIMELINE_WINDOW }), [listKey, size]);

  // The row at the top of the view and where it sat. While the reader is scrolled up, anything that changes size
  // above it (older messages loading in, a reaction chip on an old message, a row opening) must not move what they
  // are reading: we scroll by the same amount. While following, every change lands on the end instead.
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    anchor.current = null;
    for (const node of content.querySelectorAll<HTMLElement>("[data-row-key]")) {
      if (node.offsetTop + node.offsetHeight > el.scrollTop) {
        anchor.current = { key: node.dataset.rowKey!, top: node.offsetTop };
        return;
      }
    }
  }, []);
  const holdPosition = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    if (stick.current) toEnd();
    else if (anchor.current) {
      const node = content.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(anchor.current.key)}"]`);
      const shift = anchorShift(anchor.current.top, node ? node.offsetTop : null);
      if (shift !== 0) {
        el.scrollTop += shift;
        lastTop.current = el.scrollTop;
      }
    }
    captureAnchor();
  }, [toEnd, captureAnchor]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atEnd = distanceFromEnd(el) <= STICK_THRESHOLD_PX;
    stick.current = followAfterScroll(stick.current, lastTop.current, el);
    lastTop.current = el.scrollTop;
    captureAnchor();
    if (stick.current) hidePill();
    else if (!pillTimer.current) {
      // Debounced on show only, so the pill never flashes during a smooth scroll back to the end.
      pillTimer.current = setTimeout(() => {
        pillTimer.current = null;
        if (!stick.current) setPill((p) => (p?.key === listKey ? p : { after: newestRow.current, key: listKey }));
      }, SHOW_PILL_DELAY_MS);
    }
    if (el.scrollTop < LOAD_OLDER_PX && !atEnd) {
      if (start > 0) showEarlier();
      else if (hasMore && !loading) loadOlder();
    }
  }, [hidePill, captureAnchor, start, showEarlier, hasMore, loading, loadOlder, listKey]);

  useEffect(() => () => void (pillTimer.current && clearTimeout(pillTimer.current)), []);

  useLayoutEffect(holdPosition);

  // Rows grow after they render (fonts, a group opening, a timer line) and the pane resizes (side panel, phone
  // rotation): while following, stay at the end through all of it.
  const noRows = rows.length === 0;
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(holdPosition);
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, [holdPosition, noRows]);

  // A new filter opens at the end (its pill, if any, belongs to the old list and no longer shows).
  useLayoutEffect(() => {
    stick.current = true;
    if (pillTimer.current) clearTimeout(pillTimer.current);
    pillTimer.current = null;
    toEnd();
  }, [listKey, toEnd]);

  const scrollToEnd = useCallback(() => {
    stick.current = true;
    hidePill();
    toEnd(true);
  }, [hidePill, toEnd]);

  const header = (
    <div className="mx-auto w-full max-w-[72rem] px-4 pt-3 sm:px-6">
      {start > 0 ? (
        <div className="flex justify-center py-1">
          <Button size="xs" variant="quiet" onClick={showEarlier}>
            Show earlier messages
          </Button>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-2 text-[12px] text-muted">
          <Loader className="size-3.5" /> Loading older messages
        </div>
      ) : hasMore ? (
        <div className="flex justify-center py-1">
          <Button size="xs" variant="quiet" onClick={() => loadOlder()}>
            Load older messages
          </Button>
        </div>
      ) : (
        <Divider>
          <span className="text-faint">Start of the conversation</span>
        </Divider>
      )}
    </div>
  );

  const newCount = pill ? newSince(rows, pill.after) : 0;

  if (rows.length === 0) {
    return (
      <div className={cn("relative flex h-full min-h-0 flex-col", className)}>
        {hasMore ? header : null}
        <div className="flex min-h-0 flex-1 items-center justify-center">{empty}</div>
        {footer ? <div className="mx-auto w-full max-w-[72rem] px-4 pb-2 sm:px-6">{footer}</div> : null}
      </div>
    );
  }

  return (
    <div className={cn("relative h-full min-h-0 w-full min-w-0 overflow-hidden", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full min-h-0 w-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none] [mask-image:linear-gradient(to_bottom,transparent,#000_14px)]"
      >
        <div ref={contentRef} role="log" className="relative flex min-h-full min-w-0 flex-col justify-end">
          {header}
          <RelayMarksContext.Provider value={marks ?? null}>
          {shown.map((item) => (
            <div key={item.key} data-row-key={item.key} className="mx-auto w-full max-w-[72rem] min-w-0 px-2 sm:px-4">
              <TimelineRowView row={item} directory={directory} expanded={expanded.has(item.key)} onToggle={toggle} conversation={conversation} />
            </div>
          ))}
          </RelayMarksContext.Provider>
          <div className="mx-auto w-full max-w-[72rem] px-4 pt-2 pb-4 sm:px-6">{footer}</div>
        </div>
      </div>
      {pill ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
          <Button
            size="xs"
            variant="glass"
            className="pointer-events-auto shadow-float"
            onPointerDown={(event) => event.preventDefault()}
            onClick={scrollToEnd}
          >
            <ChevronDown className="size-3.5" />
            Scroll to end
            {newCount > 0 ? <span className="text-muted">· {newCount} new</span> : null}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
