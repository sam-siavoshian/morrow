import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { AppError, errorBody } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import type { AppEnv } from "./context.ts";

/** Field paths only; never echo submitted values back. */
export function describeZodError(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "body";
    return `${path}: ${issue.message}`;
  });
  return `Invalid request. ${parts.join("; ")}`.slice(0, 500);
}

function respond(c: Context, error: AppError): Response {
  for (const [k, v] of Object.entries(error.headers)) c.header(k, v);
  return c.json(error.toBody(), error.status as ContentfulStatusCode);
}

export function errorHandler(fallbackLog: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    const log = c.get("log") ?? fallbackLog;
    if (err instanceof AppError) {
      if (err.status >= 500) log.error("request failed", { code: err.code, error: err.cause ?? err });
      return respond(c, err);
    }
    if (err instanceof z.ZodError) return respond(c, new AppError("bad_request", describeZodError(err)));
    if (err instanceof HTTPException) {
      const status = err.status;
      if (status === 413) return c.json(errorBody("bad_request", "Request body too large."), 413);
      if (status < 500) return c.json(errorBody("bad_request", "Invalid request."), status as ContentfulStatusCode);
    }
    log.error("unhandled error", { error: err });
    return c.json(errorBody("internal", "Something went wrong."), 500);
  };
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => c.json(errorBody("not_found", "Not found."), 404);

/** Parses a JSON body against a contracts schema. An empty body is treated as `{}` so defaults apply. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const type = c.req.header("content-type") ?? "";
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim()) {
    if (!/^application\/json\b/i.test(type)) throw new AppError("bad_request", "Expected a JSON body.");
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AppError("bad_request", "Malformed JSON.");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError("bad_request", describeZodError(parsed.error));
  return parsed.data;
}
