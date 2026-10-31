import { GithubError } from "../integrations/github/client.ts";
import { decrypt, encrypt } from "../lib/crypto.ts";
import { AppError, dependencyUnavailable, forbidden, notFound, rateLimited } from "../lib/errors.ts";
import type { AppDeps } from "./context.ts";

/** AAD binds a token ciphertext to its owner: a blob copied onto another user does not decrypt. */
const tokenContext = (userId: string) => `morrow:github-token:v1:${userId}`;

export function encryptGithubToken(deps: Pick<AppDeps, "keys">, userId: string, token: string): Promise<string> {
  return encrypt(deps.keys.data, token, tokenContext(userId));
}

/** Decrypts the user's GitHub token in memory for one call. Never logged, never returned. */
export async function githubTokenFor(deps: Pick<AppDeps, "keys" | "actors">, userId: string): Promise<string> {
  const enc = await deps.actors.getGithubTokenEnc(userId);
  const token = enc ? await decrypt(deps.keys.data, enc, tokenContext(userId)) : null;
  if (!token) throw new AppError("unauthenticated", "GitHub access expired. Sign in again.");
  return token;
}

/** GitHub failures in browser terms. A revoked token asks the user to sign in again, which re-issues it. */
export function mapGithubError(error: unknown, notFoundMessage = "Not found on GitHub."): AppError {
  if (error instanceof AppError) return error;
  if (!(error instanceof GithubError)) return dependencyUnavailable("GitHub is unavailable. Try again shortly.", error);
  switch (error.kind) {
    case "unauthorized":
      return new AppError("unauthenticated", "GitHub access expired. Sign in again.");
    case "forbidden":
      return forbidden("GitHub denied access to that resource.");
    case "not_found":
      return notFound(notFoundMessage);
    case "rate_limited":
      return rateLimited(error.retryAfterSeconds ?? 60);
    default:
      return dependencyUnavailable("GitHub is unavailable. Try again shortly.", error);
  }
}
