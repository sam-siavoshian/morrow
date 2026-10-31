type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

const NPM_INIT_PLACEHOLDER = /no test specified/i;

function packageManagerFrom(pkg: Record<string, unknown>, rootFiles: Set<string>): PackageManager {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  if (declared === "bun" || declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  if (rootFiles.has("bun.lock") || rootFiles.has("bun.lockb")) return "bun";
  if (rootFiles.has("pnpm-lock.yaml")) return "pnpm";
  if (rootFiles.has("yarn.lock")) return "yarn";
  return "npm";
}

const RUN_TEST: Record<PackageManager, string> = {
  bun: "bun run test",
  pnpm: "pnpm test",
  yarn: "yarn test",
  npm: "npm test",
};

/**
 * Picks a test command from the repo root. package.json `scripts.test` wins (run through the repo's
 * package manager); Cargo and Go modules have a canonical command. Anything else returns null and the
 * user sets one explicitly.
 */
export function detectTestCommand(rootFiles: readonly string[], packageJsonText: string | null): string | null {
  const files = new Set(rootFiles);
  if (packageJsonText !== null) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(packageJsonText);
    } catch {
      pkg = null;
    }
    if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
      const scripts = (pkg as Record<string, unknown>).scripts;
      const test = scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>).test : undefined;
      if (typeof test === "string" && test.trim() && !NPM_INIT_PLACEHOLDER.test(test)) {
        return RUN_TEST[packageManagerFrom(pkg as Record<string, unknown>, files)];
      }
    }
  }
  if (files.has("Cargo.toml")) return "cargo test";
  if (files.has("go.mod")) return "go test ./...";
  return null;
}
