import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { backendUrl, requiredSetting } from "./src/lib/backend-url";
import { securityHeaders } from "./src/lib/security-headers";

// The Bun workspace root. Pinned because a stray package.json/bun.lock higher
// up (the home directory) otherwise becomes the inferred root.
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

const production = process.env.NODE_ENV === "production";

// Both are baked in at build time. A production build without them would quietly proxy to localhost and ship a
// CSP that blocks the realtime socket, so `requiredSetting` fails the build instead. Dev falls back to the local stack.

// Same-origin REST: the browser only ever talks to /api on this host, so the session cookie stays
// first-party. Realtime does not go through here (see src/lib/realtime.ts).
const backend = backendUrl();

// CSP and friends on every page (not /api, whose responses the backend already labels). See src/lib/security-headers.ts
// for why the policy is static rather than nonce-based.
const pageHeaders = securityHeaders({
  dev: !production,
  realtimeUrl: requiredSetting("NEXT_PUBLIC_REALTIME_URL", "ws://127.0.0.1:8787"),
});

const nextConfig: NextConfig = {
  cacheComponents: true,
  poweredByHeader: false,
  // The default bottom-left spot covers the sidebar's account chip.
  devIndicators: { position: "bottom-right" },
  partialPrefetching: true,
  outputFileTracingRoot: workspaceRoot,
  transpilePackages: ["@morrow/contracts"],
  async headers() {
    return [
      { source: "/((?!api/).*)", headers: pageHeaders },
      // The baked skies are 40-250 KB each and change only when scripts/bake-sky.ts reruns. public/ files get
      // `max-age=0` by default (a revalidation round trip per view); a day fresh, then served stale while revalidating.
      { source: "/sky/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
    ];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
  turbopack: {
    root: workspaceRoot,
    rules: {
      // CSS modules stay out: `as: "*.css"` would re-type them as global CSS
      // and their class maps would come back empty.
      "*.css": {
        condition: { not: { path: /\.module\.css$/ } },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
