const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const dayClock = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "2:41 PM" today, "Oct 3, 2:41 PM" on another day. */
export function clockTime(ms: number, now = Date.now()): string {
  const a = new Date(ms);
  const b = new Date(now);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return (sameDay ? clock : dayClock).format(a);
}

export const fullTime = (ms: number): string => full.format(new Date(ms));
