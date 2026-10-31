import { AppError, dependencyUnavailable, internalError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import { retry, type RetryOptions } from "../lib/retry.ts";

/**
 * Duck-typed: the generated client ships its own runtime copy, so `instanceof` against the
 * durable-actors package class would be false for errors it throws.
 */
export interface InvocationErrorLike {
  name: "ActorInvocationError";
  code: string;
  requestId: string;
  message: string;
}

export function isInvocationError(error: unknown): error is InvocationErrorLike {
  return (
    error instanceof Error &&
    error.name === "ActorInvocationError" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

export interface InvokePolicy {
  /** Operation label for logs, e.g. "Team.get". */
  op: string;
  /**
   * True when running the call twice has the same effect as once (reads, set-style writes, writes that
   * carry an idempotency key). Only then is `outcome_unknown` retried; `unavailable` never ran, so it is
   * always retried.
   */
  idempotent: boolean;
}

export interface InvokeOptions {
  log: Logger;
  retry?: Partial<Pick<RetryOptions, "attempts" | "baseDelayMs" | "maxDelayMs" | "sleep">>;
}

export function shouldRetryInvocation(error: unknown, idempotent: boolean): boolean {
  if (!isInvocationError(error)) return false;
  if (error.code === "unavailable") return true;
  if (error.code === "outcome_unknown") return idempotent;
  return false;
}

/** Turns a failed actor call into a browser-safe AppError. The actor's message stays in our logs only. */
export function translateInvocationError(error: unknown, op: string, log: Logger): AppError {
  if (error instanceof AppError) return error;
  if (isInvocationError(error)) {
    const fields = { op, actorCode: error.code, requestId: error.requestId, error };
    switch (error.code) {
      case "unavailable":
      case "outcome_unknown":
        log.warn("actor call did not complete", fields);
        return dependencyUnavailable("Our state service is unavailable. Try again shortly.", error);
      case "unauthenticated":
        log.error("actor call rejected our credentials (check DURABLE_ACTORS_SECRET)", fields);
        return dependencyUnavailable("Our state service is unavailable. Try again shortly.", error);
      default:
        // actor_error and anything new: the actor threw, which means a validation or invariant failure
        // we did not anticipate. Surface it as a server error, not a retry.
        log.error("actor call failed", fields);
        return internalError(error);
    }
  }
  if (error instanceof TypeError || (error instanceof Error && /fetch|network|ECONN|timed? ?out/i.test(error.message))) {
    log.warn("actor call transport failure", { op, error });
    return dependencyUnavailable("Our state service is unavailable. Try again shortly.", error);
  }
  log.error("actor call failed unexpectedly", { op, error });
  return internalError(error);
}

export async function invoke<T>(fn: () => Promise<T>, policy: InvokePolicy, options: InvokeOptions): Promise<T> {
  try {
    return await retry(() => fn(), {
      attempts: options.retry?.attempts ?? 4,
      baseDelayMs: options.retry?.baseDelayMs ?? 100,
      maxDelayMs: options.retry?.maxDelayMs ?? 1_500,
      sleep: options.retry?.sleep,
      shouldRetry: (error) => shouldRetryInvocation(error, policy.idempotent),
      onRetry: (error, attempt, delayMs) =>
        options.log.warn("retrying actor call", {
          op: policy.op,
          attempt,
          delayMs,
          actorCode: isInvocationError(error) ? error.code : undefined,
        }),
    });
  } catch (error) {
    throw translateInvocationError(error, policy.op, options.log);
  }
}
