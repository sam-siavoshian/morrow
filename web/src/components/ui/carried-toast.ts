/**
 * A toast that survives a full page load. Flows that reload on purpose (membership changed, so every cached view of
 * the account has to go) still owe the user the reason; the next page's Toaster shows it.
 *
 * The landing page can itself redirect with another full load (`/` sends you to your team or to setup), so a page
 * shows the toast and clears it only once it has stayed up for a moment; a page that leaves first hands it on. An entry
 * older than MAX_AGE_MS is never shown, so a stale one cannot resurface later.
 */

export type CarriedToastKind = "neutral" | "success" | "error";
export type CarriedToast = { kind: CarriedToastKind; title: string };

const KEY = "morrow:carried-toast";
const KINDS: ReadonlySet<string> = new Set<CarriedToastKind>(["neutral", "success", "error"]);
const MAX_TITLE = 200;
export const MAX_AGE_MS = 30_000;
/** How long a page must stay up before the toast counts as seen. */
export const SEEN_AFTER_MS = 3_000;

/** The stored value if it is one we wrote and still fresh at `now`, else null. */
export function parseCarriedToast(raw: string | null, now: number): CarriedToast | null {
  if (!raw || raw.length > 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { kind, title, at } = value as Record<string, unknown>;
  if (typeof kind !== "string" || !KINDS.has(kind) || typeof title !== "string") return null;
  if (typeof at !== "number" || !Number.isFinite(at) || at > now || now - at > MAX_AGE_MS) return null;
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > MAX_TITLE) return null;
  return { kind: kind as CarriedToastKind, title: trimmed };
}

/** Keeps `title` for the next page load in this tab. Storage can be off (private mode, blocked): then it is dropped. */
export function carryToast(kind: CarriedToastKind, title: string, now = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ kind, title, at: now }));
  } catch {
    // Nothing to do: the reload still happens, only the message is lost.
  }
}

/** The carried toast, if any. Leaves it in place (see clearCarriedToast); drops anything unreadable or stale. */
export function peekCarriedToast(now = Date.now()): CarriedToast | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const toast = parseCarriedToast(raw, now);
    if (!toast) sessionStorage.removeItem(KEY);
    return toast;
  } catch {
    return null;
  }
}

/** Marks the carried toast as seen. */
export function clearCarriedToast(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage is off: there is nothing stored to clear.
  }
}
