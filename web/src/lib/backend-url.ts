// Where the backend lives, for next.config.ts (build time, plain Node) and the server-side session calls.
// Keep this file free of imports: next.config.ts loads it before anything is bundled.

type Env = Record<string, string | undefined>;

/**
 * A setting a production build or server must have. Without it production would quietly talk to localhost, so it
 * throws instead. Dev falls back to the local stack.
 */
export function requiredSetting(name: "BACKEND_URL" | "NEXT_PUBLIC_REALTIME_URL", devDefault: string, env: Env = process.env): string {
  const value = env[name]?.trim();
  if (value) return value;
  if (env.NODE_ENV === "production") throw new Error(`${name} must be set for a production build (see web/.env.example).`);
  return devDefault;
}

/** The backend origin, without a trailing slash. */
export const backendUrl = (env: Env = process.env): string => requiredSetting("BACKEND_URL", "http://127.0.0.1:8787", env).replace(/\/+$/, "");
