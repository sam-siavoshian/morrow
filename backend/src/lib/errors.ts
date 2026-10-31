import type { ApiError, ErrorCode } from "@morrow/contracts";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  feature_disabled: 501,
  dependency_unavailable: 503,
  internal: 500,
};

/** An error whose code and message are safe to show to the browser. Never put internals in `message`. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(code: ErrorCode, message: string, options: { headers?: Record<string, string>; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.headers = options.headers ?? {};
  }

  toBody(): ApiError {
    return { error: { code: this.code, message: this.message } };
  }
}

export const badRequest = (message = "Invalid request.") => new AppError("bad_request", message);
export const unauthenticated = (message = "Sign in to continue.") => new AppError("unauthenticated", message);
export const forbidden = (message = "You do not have access to this.") => new AppError("forbidden", message);
export const notFound = (message = "Not found.") => new AppError("not_found", message);
export const conflict = (message: string) => new AppError("conflict", message);
export const featureDisabled = (message: string) => new AppError("feature_disabled", message);
export const dependencyUnavailable = (message = "A service we depend on is unavailable. Try again shortly.", cause?: unknown) =>
  new AppError("dependency_unavailable", message, { cause });
export const internalError = (cause?: unknown) => new AppError("internal", "Something went wrong.", { cause });
export const rateLimited = (retryAfterSeconds: number) =>
  new AppError("rate_limited", "Too many requests. Slow down and try again.", {
    headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });

export function errorBody(code: ErrorCode, message: string): ApiError {
  return { error: { code, message } };
}
