// Security headers for every page, built once at config load (next.config.ts). Pure, no framework imports.
//
// Static CSP, no nonces. Next's CSP guide: a nonce must be minted per request, so every page would have to render
// dynamically, and Partial Prerendering (on here via cacheComponents) cannot carry one at all because the static
// shell is built once. The App Router also streams its RSC payload as inline `self.__next_f.push(...)` scripts on
// every page, so a hash-only policy cannot list them. That leaves the guide's "without nonces" policy:
// `script-src 'self' 'unsafe-inline'`. What keeps it tight: no third-party script origins, no eval in production,
// `object-src 'none'`, `base-uri 'self'`, and the app has no HTML sinks fed by data (the only
// dangerouslySetInnerHTML calls are two constant scripts: theme and sidebar width). Those two stay inline on purpose:
// adding their hashes would make CSP2+ browsers ignore 'unsafe-inline' and block the flight scripts.

/** Where the private terminal's PTY and REST calls go: the Freestyle browser SDK's default API host. */
export const FREESTYLE_ORIGINS = ["https://api.freestyle.sh", "wss://api.freestyle.sh"] as const;

export type SecurityHeaderOptions = {
  /** `next dev`: React needs eval for its debug stacks there, and there is no HTTPS to pin. */
  dev: boolean;
  /** NEXT_PUBLIC_REALTIME_URL: the team socket and inspect streams connect here. */
  realtimeUrl?: string;
};

/** The ws(s) origin of the realtime URL, or null when unset. A malformed value fails boot, never a silent hole. */
export function realtimeOrigin(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`NEXT_PUBLIC_REALTIME_URL is not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("NEXT_PUBLIC_REALTIME_URL must start with ws:// or wss://");
  return url.origin.replace(/^http/, "ws");
}

/**
 * Whether the site is served over HTTPS, so the HTTPS-only headers apply. The realtime URL tells: a site on HTTPS
 * must use wss:// (a browser blocks ws:// from it), and a production build run on plain http://127.0.0.1 uses ws://.
 * Pinning HTTPS there would upgrade the realtime socket to wss:// and break it.
 */
function servedOverHttps({ dev, realtimeUrl }: SecurityHeaderOptions): boolean {
  return !dev && realtimeOrigin(realtimeUrl)?.startsWith("wss:") === true;
}

export function contentSecurityPolicy({ dev, realtimeUrl }: SecurityHeaderOptions): string {
  const realtime = realtimeOrigin(realtimeUrl);
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    // React `style` props are inline style attributes, and Next injects <style> for fonts and (in dev) CSS.
    // CSS cannot run script, so this is the usual trade.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https://avatars.githubusercontent.com"],
    "font-src": ["'self'"],
    // 'self' covers same-origin REST and, in dev, the HMR socket.
    "connect-src": ["'self'", ...(realtime ? [realtime] : []), ...FREESTYLE_ORIGINS],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    // Forms submit here only. GitHub is allowed for its OAuth pages, the one place sign-in leaves the site.
    "form-action": ["'self'", "https://github.com"],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`);
  if (servedOverHttps({ dev, realtimeUrl })) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

export function securityHeaders(options: SecurityHeaderOptions): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(options) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    // Older browsers ignore frame-ancestors; this covers them.
    { key: "X-Frame-Options", value: "DENY" },
    // Only over real HTTPS: pinning localhost to HTTPS would break every other dev server on it.
    ...(!servedOverHttps(options) ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
  ];
}
