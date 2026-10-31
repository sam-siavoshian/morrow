import { RelayError } from "@agent-relay/sdk";

export type RelayIntegrationErrorCode =
  | "invalid_input"
  | "brief_too_large"
  | "identity_conflict"
  | "identity_token_invalid"
  | "provision_failed"
  | "relay_unavailable";

/**
 * A failure of this integration that callers branch on by `code`. `message` is internal (logs only) and never
 * carries a token, key or message body.
 */
export class RelayIntegrationError extends Error {
  readonly code: RelayIntegrationErrorCode;
  readonly details: Record<string, string | number | boolean>;
  constructor(
    code: RelayIntegrationErrorCode,
    message: string,
    details: Record<string, string | number | boolean> = {},
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RelayIntegrationError";
    this.code = code;
    this.details = details;
  }
}

export interface RelayErrorLike {
  code: string;
  /** The server's own code before the SDK folds it into `code` (a 429 `plan_limit_exceeded` arrives as `rate_limited`). */
  rawCode: string | undefined;
  status: number;
  retryable: boolean;
  message: string;
}

/** Duck-typed so a second copy of `@relaycast/sdk` in the tree cannot break `instanceof`. */
export function asRelayError(error: unknown): RelayErrorLike | null {
  if (error instanceof Error && (error instanceof RelayError || error.name === "RelayError")) {
    const e = error as Error & { code?: unknown; rawCode?: unknown; status?: unknown; retryable?: unknown };
    if (typeof e.code === "string")
      return {
        code: e.code,
        rawCode: typeof e.rawCode === "string" ? e.rawCode : undefined,
        status: typeof e.status === "number" ? e.status : 0,
        retryable: e.retryable === true,
        message: e.message,
      };
  }
  return null;
}

export const isRelayNotFound = (error: unknown) => asRelayError(error)?.code === "not_found";
export const isRelayNameConflict = (error: unknown) => asRelayError(error)?.code === "name_conflict";
export const isRelayAuthError = (error: unknown) => {
  const code = asRelayError(error)?.code;
  return code === "unauthorized" || code === "agent_token_invalid";
};
