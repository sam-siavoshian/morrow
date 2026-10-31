import type { TerminalTokenResponse } from "@morrow/contracts";
import { isApiError } from "@/lib/api";

export type TerminalGrant = TerminalTokenResponse;

/** Refresh this long before expiry (capped at a quarter of the token's life for short tokens). */
export const REFRESH_LEAD_MS = 60_000;
/** Never schedule a refresh sooner than this. */
export const MIN_REFRESH_DELAY_MS = 1_000;
/** A grant this close to expiry is not used for a new connection. */
export const STALE_MS = 10_000;
/** After a failed refresh, try again this often until the token runs out. */
export const REFRESH_RETRY_MS = 15_000;
/** Reconnect attempts after a drop before giving up and showing Reconnect. */
export const MAX_ATTEMPTS = 6;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * When to mint the next token: a minute before `expiresAt`, or a quarter of what is left if that is
 * sooner. Null once the token has expired: the next connection mints one on demand instead.
 */
export function refreshDelay(expiresAt: number, now: number): number | null {
  const remaining = expiresAt - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const lead = Math.min(REFRESH_LEAD_MS, remaining / 4);
  const delay = Math.max(MIN_REFRESH_DELAY_MS, remaining - lead);
  return Math.min(delay, remaining, MAX_TIMER_MS);
}

export const isFresh = (grant: TerminalGrant | null, now: number): grant is TerminalGrant =>
  grant !== null && grant.expiresAt - now > STALE_MS;

/** 0.5 s, 1 s, 2 s... capped at 10 s. */
export const backoff = (attempt: number) => Math.min(500 * 2 ** Math.max(0, attempt - 1), 10_000);

export type TerminalState =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "disconnected"; message: string }
  /** Our own sign-in ended: only signing in again helps. */
  | { kind: "expired"; message: string }
  /** Freestyle is not configured on this server. */
  | { kind: "disabled"; message: string }
  /** The server refused for a reason a retry will not fix (paused, not ready, not the owner). */
  | { kind: "unavailable"; message: string };

export type TerminalConnection = { dispose(): void };

export type TerminalDeps = {
  mint(): Promise<TerminalGrant>;
  /** Opens the shell with this grant. `onClose` fires if it drops later. */
  connect(grant: TerminalGrant, onClose: () => void): Promise<TerminalConnection>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
};

type MintFailure = { retryInMs: number } | Exclude<TerminalState, { kind: "connecting" | "connected" | "reconnecting" }>;

function classifyMintError(error: unknown): MintFailure {
  if (!isApiError(error)) return { retryInMs: 0 };
  switch (error.code) {
    case "unauthenticated":
      return { kind: "expired", message: "Your session ended. Sign in again to open the terminal." };
    case "feature_disabled":
      return { kind: "disabled", message: error.message };
    case "forbidden":
    case "conflict":
    case "not_found":
    case "bad_request":
      return { kind: "unavailable", message: error.message };
    case "rate_limited":
      return { retryInMs: (error.retryAfter ?? 5) * 1000 };
    default:
      return { retryInMs: 0 };
  }
}

/**
 * The private terminal's connection: mints a short-lived token, keeps it fresh in memory while the
 * terminal is open, and reconnects to the same named shell after drops. The token never leaves this
 * object; nothing is written to storage or logged.
 */
export class TerminalController {
  #deps: TerminalDeps;
  #onState: (state: TerminalState) => void;
  #grant: TerminalGrant | null = null;
  #conn: TerminalConnection | null = null;
  /** Bumped on every open/stop so late callbacks from an older connection are ignored. */
  #generation = 0;
  #attempt = 0;
  #refreshTimer: unknown = null;
  #retryTimer: unknown = null;
  #stopped = false;

  constructor(deps: TerminalDeps, onState: (state: TerminalState) => void) {
    this.#deps = deps;
    this.#onState = onState;
  }

  start(): void {
    this.#stopped = false;
    this.#attempt = 0;
    void this.#open();
  }

  /** The Reconnect button: starts over with a fresh retry budget. */
  reconnect(): void {
    if (this.#stopped) return;
    this.#attempt = 0;
    void this.#open();
  }

  /** Detaches (the shell keeps running on the VM) and forgets the token. */
  stop(): void {
    this.#stopped = true;
    this.#generation++;
    this.#clear("refresh");
    this.#clear("retry");
    this.#conn?.dispose();
    this.#conn = null;
    this.#grant = null;
  }

  async #open(): Promise<void> {
    const generation = ++this.#generation;
    this.#clear("retry");
    this.#conn?.dispose();
    this.#conn = null;
    this.#onState(this.#attempt === 0 ? { kind: "connecting" } : { kind: "reconnecting", attempt: this.#attempt });

    let grant: TerminalGrant;
    try {
      grant = await this.#freshGrant();
    } catch (error) {
      if (generation !== this.#generation) return;
      const failure = classifyMintError(error);
      if ("retryInMs" in failure) this.#retry(failure.retryInMs);
      else this.#onState(failure);
      return;
    }
    if (generation !== this.#generation) return;

    try {
      const conn = await this.#deps.connect(grant, () => {
        if (generation === this.#generation) this.#dropped();
      });
      if (generation !== this.#generation) {
        conn.dispose();
        return;
      }
      this.#conn = conn;
      this.#attempt = 0;
      this.#onState({ kind: "connected" });
    } catch {
      if (generation !== this.#generation) return;
      // The VM refused the socket: maybe the token. Mint a new one next time.
      this.#grant = null;
      this.#retry(0);
    }
  }

  async #freshGrant(): Promise<TerminalGrant> {
    if (isFresh(this.#grant, this.#deps.now())) return this.#grant;
    const grant = await this.#deps.mint();
    this.#grant = grant;
    this.#scheduleRefresh();
    return grant;
  }

  #scheduleRefresh(): void {
    this.#clear("refresh");
    const grant = this.#grant;
    if (!grant || this.#stopped) return;
    const delay = refreshDelay(grant.expiresAt, this.#deps.now());
    if (delay === null) return;
    this.#refreshTimer = this.#deps.setTimer(() => void this.#refresh(), delay);
  }

  async #refresh(): Promise<void> {
    this.#refreshTimer = null;
    try {
      const grant = await this.#deps.mint();
      if (this.#stopped) return;
      this.#grant = grant;
      this.#scheduleRefresh();
    } catch (error) {
      if (this.#stopped) return;
      const failure = classifyMintError(error);
      const expiresAt = this.#grant?.expiresAt ?? 0;
      // An open shell outlives its token; only a reconnect needs a fresh one. Keep trying quietly
      // while the old one is still good, and surface hard failures only when the session ends.
      if (!("retryInMs" in failure) && failure.kind === "expired") {
        this.#grant = null;
        return;
      }
      const wait = Math.max(REFRESH_RETRY_MS, "retryInMs" in failure ? failure.retryInMs : 0);
      if (this.#deps.now() + wait < expiresAt) this.#refreshTimer = this.#deps.setTimer(() => void this.#refresh(), wait);
    }
  }

  #dropped(): void {
    if (this.#stopped) return;
    this.#conn = null;
    this.#retry(0);
  }

  #retry(minDelayMs: number): void {
    this.#attempt++;
    if (this.#attempt > MAX_ATTEMPTS) {
      this.#onState({ kind: "disconnected", message: "The terminal lost its connection." });
      return;
    }
    this.#onState({ kind: "reconnecting", attempt: this.#attempt });
    const generation = this.#generation;
    this.#retryTimer = this.#deps.setTimer(
      () => {
        if (generation === this.#generation && !this.#stopped) void this.#open();
      },
      Math.max(minDelayMs, backoff(this.#attempt)),
    );
  }

  #clear(which: "refresh" | "retry"): void {
    const handle = which === "refresh" ? this.#refreshTimer : this.#retryTimer;
    if (handle !== null) this.#deps.clearTimer(handle);
    if (which === "refresh") this.#refreshTimer = null;
    else this.#retryTimer = null;
  }
}
