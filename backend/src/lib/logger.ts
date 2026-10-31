export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Keys whose values never reach a log line. Matching is by substring on the lowercased key, so
 * `githubToken`, `x-morrow-csrf`, `set-cookie` and `websocketUrl` (grants carry a bearer key) are all caught.
 */
const REDACT_SUBSTRINGS = [
  "token",
  "secret",
  "password",
  "cookie",
  "authorization",
  "apikey",
  "api_key",
  "grant",
  "ticket",
  "websocketurl",
  "csrf",
  "credential",
  "privatekey",
];
/** Exact keys that carry user content or one-time codes. */
const REDACT_EXACT = new Set(["body", "text", "prompt", "code_verifier", "oauthcode", "state", "invite", "key"]);
const MAX_DEPTH = 4;
const MAX_STRING = 2000;

function redactKey(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT_EXACT.has(k) || REDACT_SUBSTRINGS.some((s) => k.includes(s));
}

function sanitize(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return serializeError(value, depth);
  if (depth >= MAX_DEPTH) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactKey(k) ? "[redacted]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function serializeError(error: Error, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: sanitize(error.message, depth + 1) };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") out.code = code;
  if (error.stack) out.stack = error.stack.split("\n").slice(0, 12).join("\n");
  if (error.cause !== undefined && depth < MAX_DEPTH) out.cause = sanitize(error.cause, depth + 1);
  return out;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  flush(): Promise<void>;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  bindings?: LogFields;
}

/** Structured JSON lines on stdout. Fields named like secrets are redacted at any depth. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const min = ORDER[options.level ?? "info"];
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const bindings = options.bindings ?? {};

  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[level] < min) return;
    const record = sanitize({ ...bindings, ...fields }, 0) as Record<string, unknown>;
    let line: string;
    try {
      line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...record });
    } catch {
      line = JSON.stringify({ t: new Date().toISOString(), level, msg, logError: "unserializable fields" });
    }
    write(`${line}\n`);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger({ ...options, bindings: { ...bindings, ...fields } }),
    flush: () =>
      new Promise<void>((resolve) => {
        if (options.write) return resolve();
        // An empty write's callback fires once everything queued before it has been handed to the OS.
        process.stdout.write("", () => resolve());
      }),
  };
}

/** A logger that discards everything; for tests that do not assert on logs. */
export const silentLogger: Logger = createLogger({ write: () => {} });
