import { z } from "zod";
import { DEFAULT_BASE_SNAPSHOT } from "./integrations/freestyle/client.ts";
import { HOSTED_RELAY_BASE_URL } from "./integrations/relay/config.ts";
import { base64UrlEncode, decodeKeyMaterial } from "./lib/crypto.ts";
import { LOOPBACK_HOSTS } from "./lib/loopback.ts";

const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const key32 = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    try {
      decodeKeyMaterial(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: `${(error as Error).message} (generate with: openssl rand -base64 32)` });
    }
  });

const httpOrigin = z
  .string()
  .trim()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") ctx.addIssue({ code: "custom", message: "must be http(s)" });
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
      ctx.addIssue({ code: "custom", message: "must be a bare origin like https://app.example.com (no path)" });
  })
  .transform((value) => new URL(value).origin);

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((v) => /^https?:$/.test(new URL(v).protocol), "must be http(s)")
  .transform((v) => v.replace(/\/+$/, ""));

const wsBase = z
  .string()
  .trim()
  .url()
  .refine((v) => /^wss?:$/.test(new URL(v).protocol), "must start with ws:// or wss://")
  .refine((v) => !new URL(v).search && !new URL(v).hash, "must not contain a query or hash")
  .transform((v) => v.replace(/\/+$/, ""));

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

const PROJECT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const secureOrLoopback = (v: string) => new URL(v).protocol === "https:" || LOOPBACK_HOSTS.has(new URL(v).hostname);

const EnvSchema = z.object({
  APP_ORIGIN: httpOrigin,
  REALTIME_URL: wsBase,
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(65535).default(8787)),
  HOST: optional(z.string().trim().min(1)),
  SESSION_SECRET: key32,
  DATA_ENCRYPTION_KEY: key32,
  GITHUB_CLIENT_ID: z.string().trim().min(1),
  GITHUB_CLIENT_SECRET: z.string().trim().min(1),
  GITHUB_API_URL: z.preprocess(emptyToUndefined, httpUrl.default("https://api.github.com")),
  GITHUB_WEB_URL: z.preprocess(emptyToUndefined, httpUrl.default("https://github.com")),
  // Terse is configured one of two ways: Terse Cloud's pair (what `terse deploy` prints, plus an API key from the
  // Terse app), or a self-hosted or local server as origin, secret and project id. Either credential travels only as a
  // bearer token, never in clear text off this machine.
  TERSE_ACTOR_URL: optional(
    z
      .string()
      .trim()
      .refine((v) => terseActorUrl(v) !== null, "must be what `terse deploy` prints, like https://api.useterse.ai/<project-id>/actors")
      .refine((v) => secureOrLoopback(v), "must be https (plain http only for localhost)"),
  ),
  TERSE_API_KEY: optional(z.string().trim().min(16, "must be at least 16 characters")),
  DURABLE_ACTORS_CONTROL_PLANE_URL: optional(httpUrl.refine(secureOrLoopback, "must be https (plain http only for localhost)")),
  DURABLE_ACTORS_SECRET: optional(z.string().trim().min(16, "must be at least 16 characters")),
  DURABLE_ACTORS_PROJECT_ID: optional(z.string().regex(PROJECT_ID)),
  FREESTYLE_API_KEY: optional(z.string().trim().min(1)),
  FREESTYLE_BASE_SNAPSHOT: z.preprocess(emptyToUndefined, z.string().trim().min(1).default(DEFAULT_BASE_SNAPSHOT)),
  RELAY_BASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .union([z.literal("disabled"), httpUrl])
      .refine(
        (v) => v === "disabled" || new URL(v).protocol === "https:" || LOOPBACK_HOSTS.has(new URL(v).hostname),
        "must be https (plain http only for localhost), or \"disabled\"",
      )
      .default(HOSTED_RELAY_BASE_URL),
  ),
  TRUSTED_PROXY_HOPS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(5).default(0)),
  /** Replaced by TRUSTED_PROXY_HOPS; refused so an old config cannot silently change behavior. */
  TRUST_PROXY: z.preprocess(emptyToUndefined, z.undefined({ error: "was replaced by TRUSTED_PROXY_HOPS (see .env.example)" })),
  SIGNUP_ALLOWLIST: optional(
    z
      .string()
      .transform((v) => v.split(",").map((login) => login.trim()).filter(Boolean))
      .pipe(z.array(z.string().regex(/^[A-Za-z0-9-]{1,39}$/, "must be comma-separated GitHub logins")).min(1, "must name at least one GitHub login")),
  ),
  LOG_LEVEL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined),
    z.enum(["debug", "info", "warn", "error"]).default("info"),
  ),
}).superRefine((env, ctx) => {
  const cloud = env.TERSE_ACTOR_URL !== undefined || env.TERSE_API_KEY !== undefined;
  const server = env.DURABLE_ACTORS_CONTROL_PLANE_URL !== undefined || env.DURABLE_ACTORS_SECRET !== undefined || env.DURABLE_ACTORS_PROJECT_ID !== undefined;
  if (cloud && server) {
    ctx.addIssue({ code: "custom", path: ["TERSE_ACTOR_URL"], message: "set either TERSE_ACTOR_URL and TERSE_API_KEY, or the DURABLE_ACTORS_* settings, not both" });
    return;
  }
  if (cloud) {
    if (env.TERSE_ACTOR_URL === undefined) ctx.addIssue({ code: "custom", path: ["TERSE_ACTOR_URL"], message: "is required with TERSE_API_KEY" });
    if (env.TERSE_API_KEY === undefined) ctx.addIssue({ code: "custom", path: ["TERSE_API_KEY"], message: "is required with TERSE_ACTOR_URL" });
    return;
  }
  if (env.DURABLE_ACTORS_CONTROL_PLANE_URL === undefined)
    ctx.addIssue({ code: "custom", path: ["DURABLE_ACTORS_CONTROL_PLANE_URL"], message: "is required (or set TERSE_ACTOR_URL and TERSE_API_KEY for Terse Cloud)" });
  if (env.DURABLE_ACTORS_SECRET === undefined) ctx.addIssue({ code: "custom", path: ["DURABLE_ACTORS_SECRET"], message: "is required" });
  // Terse's configuration reference: a remote server needs the project id; only a local dev server has a default.
  if (
    env.DURABLE_ACTORS_CONTROL_PLANE_URL !== undefined &&
    !env.DURABLE_ACTORS_PROJECT_ID &&
    !LOOPBACK_HOSTS.has(new URL(env.DURABLE_ACTORS_CONTROL_PLANE_URL).hostname)
  )
    ctx.addIssue({ code: "custom", path: ["DURABLE_ACTORS_PROJECT_ID"], message: "is required when the control plane is not on localhost" });
});

/**
 * Reads the Terse Cloud actor endpoint `terse deploy` prints, `<origin>/<project-id>/actors`: the base the backend
 * exchanges its API key at (actors/client.ts). Any other path is refused rather than guessed at.
 */
export function terseActorUrl(value: string): { actorUrl: string; projectId: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.search || url.hash || url.username || url.password) return null;
  const match = /^\/([^/]+)\/actors\/?$/.exec(url.pathname);
  if (!match) return null;
  let projectId: string;
  try {
    projectId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!PROJECT_ID.test(projectId) || projectId === "." || projectId === "..") return null;
  return { actorUrl: `${url.origin}/${encodeURIComponent(projectId)}/actors`, projectId };
}

export interface Env {
  appOrigin: string;
  /** True when the app is served over https: cookies get `Secure`. */
  secureCookies: boolean;
  realtimeUrl: string;
  port: number;
  host: string | undefined;
  sessionSecret: Uint8Array;
  dataEncryptionKey: Uint8Array;
  github: { clientId: string; clientSecret: string; apiUrl: string; webUrl: string };
  /**
   * Where the actors run. `runtime`: a durable-actors server (local dev, tests, self-hosted), called with its secret.
   * `cloud`: Terse Cloud, reached by exchanging the API key for runtime sessions and socket grants (actors/client.ts).
   */
  terse:
    | { kind: "runtime"; controlPlaneUrl: string; secret: string; projectId: string | undefined }
    | { kind: "cloud"; actorUrl: string; apiKey: string; projectId: string };
  /** Null when FREESTYLE_API_KEY is absent: environment features report as disabled. */
  freestyle: { apiKey: string; baseSnapshot: string } | null;
  /** Hosted Relaycast unless RELAY_BASE_URL overrides it; null when RELAY_BASE_URL=disabled. */
  relay: { baseUrl: string } | null;
  /**
   * Proxies in front of the backend that append the caller's address to X-Forwarded-For. The client IP
   * is taken that many hops from the right; 0 uses the socket peer. Next's rewrite does not append, so it
   * does not count.
   */
  trustedProxyHops: number;
  /** Lowercased GitHub logins allowed to sign in; null means anyone with a GitHub account. */
  signupAllowlist: ReadonlySet<string> | null;
  logLevel: "debug" | "info" | "warn" | "error";
}

export class EnvError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid backend configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvError";
    this.issues = issues;
  }
}

/** GitHub logins are case-insensitive. With no allowlist configured, everyone may sign in. */
export function signupAllowed(env: Pick<Env, "signupAllowlist">, login: string): boolean {
  return env.signupAllowlist === null || env.signupAllowlist.has(login.toLowerCase());
}

/** Validates configuration. Throws EnvError listing every missing or invalid variable (never their values). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const name = issue.path.join(".") || "(root)";
      const missing = source[name] === undefined || source[name] === "";
      return missing ? `${name} is missing` : `${name} is invalid: ${issue.message}`;
    });
    throw new EnvError([...new Set(issues)]);
  }
  const e = parsed.data;
  const sessionSecret = decodeKeyMaterial(e.SESSION_SECRET);
  const dataEncryptionKey = decodeKeyMaterial(e.DATA_ENCRYPTION_KEY);
  if (base64UrlEncode(sessionSecret) === base64UrlEncode(dataEncryptionKey))
    throw new EnvError(["SESSION_SECRET and DATA_ENCRYPTION_KEY must be different keys"]);

  return {
    appOrigin: e.APP_ORIGIN,
    secureCookies: e.APP_ORIGIN.startsWith("https://"),
    realtimeUrl: e.REALTIME_URL,
    port: e.PORT,
    host: e.HOST,
    sessionSecret,
    dataEncryptionKey,
    github: {
      clientId: e.GITHUB_CLIENT_ID,
      clientSecret: e.GITHUB_CLIENT_SECRET,
      apiUrl: e.GITHUB_API_URL,
      webUrl: e.GITHUB_WEB_URL,
    },
    terse: e.TERSE_ACTOR_URL
      ? { kind: "cloud", ...terseActorUrl(e.TERSE_ACTOR_URL)!, apiKey: e.TERSE_API_KEY! }
      : { kind: "runtime", controlPlaneUrl: e.DURABLE_ACTORS_CONTROL_PLANE_URL!, secret: e.DURABLE_ACTORS_SECRET!, projectId: e.DURABLE_ACTORS_PROJECT_ID },
    freestyle: e.FREESTYLE_API_KEY ? { apiKey: e.FREESTYLE_API_KEY, baseSnapshot: e.FREESTYLE_BASE_SNAPSHOT } : null,
    relay: e.RELAY_BASE_URL === "disabled" ? null : { baseUrl: e.RELAY_BASE_URL },
    trustedProxyHops: e.TRUSTED_PROXY_HOPS,
    signupAllowlist: e.SIGNUP_ALLOWLIST ? new Set(e.SIGNUP_ALLOWLIST.map((login) => login.toLowerCase())) : null,
    logLevel: e.LOG_LEVEL,
  };
}
