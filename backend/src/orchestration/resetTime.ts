// Reset times printed by Claude Code and Codex, turned into epoch ms. Formats per docs/research/cli-signals.md
// sections 1.3 and 2.3. Workers run with TZ=UTC, so a time without a zone is UTC.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MS = 86_400_000;

export interface WallTime {
  hour: number;
  minute: number;
  ampm: string | null;
  month?: string | null;
  day?: number | null;
  year?: number | null;
  weekday?: string | null;
  tz?: string | null;
}

/** A valid IANA zone, else UTC (the zone our workers run in). */
export function safeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Calendar fields of `epochMs` as seen in `tz`. */
function partsIn(epochMs: number, tz: string): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")) - 1,
    day: Number(get("day")),
    weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase().slice(0, 3)),
  };
}

/** Offset of `tz` from UTC at `epochMs`, in ms. */
function offsetMs(epochMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(epochMs));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second"));
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch ms of a wall-clock time in `tz`. Two passes settle DST edges. */
export function zonedToEpoch(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

function to24h(hour: number, ampm: string | null): number | null {
  if (ampm === null) return hour >= 0 && hour <= 23 ? hour : null;
  if (hour < 1 || hour > 12) return null;
  const pm = ampm.toLowerCase() === "pm";
  return (hour % 12) + (pm ? 12 : 0);
}

/**
 * The instant a printed wall time refers to, relative to `now`:
 *  - date given: that date (current year in `tz` when the year is missing),
 *  - weekday given: the next such weekday at that time,
 *  - time only: its next occurrence after `now`.
 * Null when the fields do not form a real time.
 */
export function resolveWallTime(w: WallTime, now: number): number | null {
  const tz = safeZone(w.tz);
  const hour = to24h(w.hour, w.ampm);
  if (hour === null || w.minute < 0 || w.minute > 59) return null;
  const today = partsIn(now, tz);

  if (w.month) {
    const month = MONTHS.indexOf(w.month.toLowerCase().slice(0, 3));
    const day = w.day ?? 0;
    if (month < 0 || day < 1 || day > 31) return null;
    return zonedToEpoch(w.year ?? today.year, month, day, hour, w.minute, tz);
  }

  for (let add = 0; add <= 7; add++) {
    const date = partsIn(now + add * DAY_MS, tz);
    if (w.weekday && date.weekday !== WEEKDAYS.indexOf(w.weekday.toLowerCase().slice(0, 3))) continue;
    const at = zonedToEpoch(date.year, date.month, date.day, hour, w.minute, tz);
    if (at > now) return at;
  }
  return null;
}

/** `6d`, `3h 20m`, `2 days 3 hours 5 minutes`, `less than a minute`. */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase();
  if (value === "less than a minute") return 60_000;
  let total = 0;
  let matched = false;
  for (const m of value.matchAll(/(\d+)\s*(d|days?|h|hours?|m|minutes?)\b/g)) {
    const n = Number(m[1]);
    const unit = m[2]![0];
    total += n * (unit === "d" ? DAY_MS : unit === "h" ? 3_600_000 : 60_000);
    matched = true;
  }
  return matched && total > 0 ? total : null;
}
