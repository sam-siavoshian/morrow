import type { ErrorCode } from "@morrow/contracts";
import { FreestyleApiError, FreestyleTransportError } from "freestyle";

export type FreestyleErrorKind =
  | "feature_disabled"
  | "invalid_input"
  | "conflict"
  | "not_found"
  | "exec_failed"
  | "exec_timeout"
  | "unexpected_output"
  | "unsafe_path"
  | "dependency_unavailable"
  | "dependency_rejected";

const API_CODE: Record<FreestyleErrorKind, ErrorCode> = {
  feature_disabled: "feature_disabled",
  invalid_input: "bad_request",
  conflict: "conflict",
  not_found: "not_found",
  exec_failed: "dependency_unavailable",
  exec_timeout: "dependency_unavailable",
  unexpected_output: "dependency_unavailable",
  unsafe_path: "internal",
  dependency_unavailable: "dependency_unavailable",
  dependency_rejected: "dependency_unavailable",
};

/**
 * Every failure this integration raises. `message` is safe to show a user and
 * to store in `Environment.lastError`; `detail` is for server logs only (it can
 * hold bounded stderr from the VM) and never contains a secret we passed in.
 */
export class FreestyleIntegrationError extends Error {
  readonly kind: FreestyleErrorKind;
  readonly apiCode: ErrorCode;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    kind: FreestyleErrorKind,
    message: string,
    options: { retryable?: boolean; detail?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FreestyleIntegrationError";
    this.kind = kind;
    this.apiCode = API_CODE[kind];
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }
}

/** No `FREESTYLE_API_KEY` (or an unusable config): VM features are off, the rest of the app is not. */
export class FeatureDisabledError extends FreestyleIntegrationError {
  constructor(message = "Cloud environments are not configured on this server.") {
    super("feature_disabled", message);
    this.name = "FeatureDisabledError";
  }
}

export function invalidInput(message: string): FreestyleIntegrationError {
  return new FreestyleIntegrationError("invalid_input", message);
}

export function isFreestyleStatus(error: unknown, status: number): boolean {
  return error instanceof FreestyleApiError && error.status === status;
}

/**
 * Normalize anything thrown by the SDK or by us into a FreestyleIntegrationError.
 * Freestyle's own message is kept in `detail` only: it is prose that may change
 * and may name internal ids.
 */
export function toIntegrationError(error: unknown, action: string): FreestyleIntegrationError {
  if (error instanceof FreestyleIntegrationError) return error;
  if (error instanceof FreestyleApiError) {
    const detail = { status: error.status, code: error.code, path: error.path };
    if (error.status === 404) {
      return new FreestyleIntegrationError("not_found", `${action}: resource not found.`, { detail, cause: error });
    }
    if (error.status === 409) {
      return new FreestyleIntegrationError("conflict", `${action}: conflicting state, retry shortly.`, {
        retryable: true,
        detail,
        cause: error,
      });
    }
    if (error.status === 401 || error.status === 403) {
      return new FreestyleIntegrationError("dependency_rejected", `${action}: the VM provider rejected our credentials.`, {
        detail,
        cause: error,
      });
    }
    // Freestyle answers 429 LIMIT_EXCEEDED when the plan's cap on VMs or snapshots is reached. Retrying cannot
    // help, and "unavailable" would send people looking for an outage.
    if (error.status === 429 && error.code === "LIMIT_EXCEEDED") {
      return new FreestyleIntegrationError(
        "dependency_rejected",
        `${action}: the Freestyle plan limit is reached. Remove an unused environment or raise the plan's limit.`,
        { detail, cause: error },
      );
    }
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
      return new FreestyleIntegrationError("dependency_unavailable", `${action}: the VM provider is unavailable, retrying.`, {
        retryable: true,
        detail,
        cause: error,
      });
    }
    return new FreestyleIntegrationError("invalid_input", `${action}: the VM provider refused the request.`, {
      detail,
      cause: error,
    });
  }
  if (error instanceof FreestyleTransportError || error instanceof TypeError) {
    return new FreestyleIntegrationError("dependency_unavailable", `${action}: could not reach the VM provider, retrying.`, {
      retryable: true,
      detail: { name: (error as Error).name },
      cause: error,
    });
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new FreestyleIntegrationError("dependency_unavailable", `${action}: timed out, retrying.`, {
      retryable: true,
      cause: error,
    });
  }
  return new FreestyleIntegrationError("dependency_unavailable", `${action}: unexpected failure.`, {
    retryable: true,
    detail: { name: error instanceof Error ? error.name : typeof error },
    cause: error,
  });
}
