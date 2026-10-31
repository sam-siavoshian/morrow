/**
 * Chat-style "stick to the end" rules, kept pure so they can be tested without a browser.
 *
 * The feed follows new messages while the reader is at (or near) the end. Only the reader can stop that, by moving
 * up. Content growing under them (a new message, a "working" line changing height, a row opening, fonts loading)
 * never does: it leaves scrollTop where it was, which is how we tell it apart from a scroll up.
 */

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Within this many pixels of the end counts as "at the end": the feed keeps following new messages. */
export const FOLLOW_THRESHOLD_PX = 120;

/** Moves smaller than this are layout noise (subpixel rounding, zoom), not the reader scrolling. */
const JITTER_PX = 2;

/** How far the viewport is from the end of the content, in pixels (never negative). */
export function distanceFromEnd(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

export function isNearEnd(m: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromEnd(m) <= threshold;
}

/**
 * Whether to keep following after a scroll event. Near the end always follows. Otherwise the reader moving up
 * (scrollTop went down) stops following; anything else (our own jump to the end, a smooth scroll on its way down,
 * the browser clamping after content shrank) keeps whatever was true before.
 */
export function followAfterScroll(following: boolean, previousTop: number, m: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  if (isNearEnd(m, threshold)) return true;
  if (m.scrollTop < previousTop - JITTER_PX) return false;
  return following;
}

/**
 * Older rows were put in above: how far to scroll so the row the reader was looking at stays put. `before` is
 * where the anchor row sat at the last render, `after` where it sits now (null when it is gone).
 */
export function anchorShift(before: number | null, after: number | null): number {
  if (before === null || after === null) return 0;
  const shift = after - before;
  return Math.abs(shift) < 1 ? 0 : shift;
}
