import type { TerminalTokenResponse } from "@morrow/contracts";
import type { Freestyle } from "freestyle";
import { freestyle } from "./client.ts";
import { invalidInput, isFreestyleStatus, toIntegrationError } from "./errors.ts";
import { assertId, assertLinuxUser } from "./names.ts";

/** Named PTY session shared by the owner's terminal and read-only inspectors. */
export const TERMINAL_SESSION = "main";
/** PTY shells do not set TERM, and the claude TUI exits without it. */
export const TERMINAL_SHELL = "env TERM=xterm-256color bash -l";
export const TERMINAL_TOKEN_TTL_MS = 15 * 60_000;

export interface MintedTerminalToken {
  /** Persist on the User (first mint creates it). */
  identityId: string;
  /** For revocation. */
  tokenId: string;
  /** Send to the owner's browser only, with Cache-Control: no-store. Never log it. */
  response: TerminalTokenResponse;
}

/**
 * Approach B: a short-lived Freestyle identity token the owner's browser uses
 * directly with `connectXterm`. One identity per app user; its grant on this VM
 * is restricted to exactly the engineer's Linux user, so the token can open
 * exec/PTY on that VM as that user and nothing else.
 */
export async function mintTerminalToken(opts: {
  identityId: string | null;
  vmId: string;
  linuxUser: string;
  ttlMs?: number;
  client?: Freestyle;
  now?: number;
}): Promise<MintedTerminalToken> {
  assertLinuxUser(opts.linuxUser);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(opts.vmId)) throw invalidInput("Invalid VM id.");
  if (opts.identityId !== null) assertId(opts.identityId, "identityId");
  const ttlMs = opts.ttlMs ?? TERMINAL_TOKEN_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > TERMINAL_TOKEN_TTL_MS) throw invalidInput("Invalid token lifetime.");
  const fs = opts.client ?? freestyle();

  try {
    const identityId = opts.identityId ?? (await fs.identities.create()).identityId;
    const identity = fs.identities.ref(identityId);
    let grant;
    try {
      grant = await identity.permissions.vm.get(opts.vmId);
    } catch (error) {
      if (!isFreestyleStatus(error, 404)) throw error;
      grant = await identity.permissions.vm.grant({ vmId: opts.vmId, allowedLinuxUsers: [opts.linuxUser] });
    }
    const users = grant.allowedLinuxUsers;
    if (!users || users.length !== 1 || users[0] !== opts.linuxUser) {
      await identity.permissions.vm.update(opts.vmId, [opts.linuxUser]);
    }
    const expiresAtMs = (opts.now ?? Date.now()) + ttlMs;
    const created = await identity.tokens.create({ expiresAt: new Date(expiresAtMs).toISOString() });
    return {
      identityId,
      tokenId: created.id,
      response: {
        vmId: opts.vmId,
        linuxUser: opts.linuxUser,
        token: created.token,
        session: TERMINAL_SESSION,
        expiresAt: expiresAtMs,
      },
    };
  } catch (error) {
    throw toIntegrationError(error, "Open terminal");
  }
}

/** Cut a user's terminal access to one VM. 404 (never granted) counts as done. */
export async function revokeTerminalAccess(opts: { identityId: string; vmId: string; client?: Freestyle }): Promise<void> {
  assertId(opts.identityId, "identityId");
  try {
    await (opts.client ?? freestyle()).identities.ref(opts.identityId).permissions.vm.revoke(opts.vmId);
  } catch (error) {
    if (!isFreestyleStatus(error, 404)) throw toIntegrationError(error, "Revoke terminal access");
  }
}

/**
 * Cut everything an identity can reach right now: every VM grant and every unexpired token. The
 * identity stays, so the next terminal mint grants again. A missing identity counts as done.
 */
export async function revokeIdentityAccess(opts: { identityId: string; client?: Freestyle }): Promise<void> {
  assertId(opts.identityId, "identityId");
  const identity = (opts.client ?? freestyle()).identities.ref(opts.identityId);
  const ignore404 = (error: unknown) => {
    if (!isFreestyleStatus(error, 404)) throw error;
  };
  try {
    const grants = await identity.permissions.vm.list();
    for (const grant of grants) await identity.permissions.vm.revoke(grant.vmId).catch(ignore404);
    const tokens = await identity.tokens.list();
    for (const token of tokens) await identity.tokens.revoke(token.id).catch(ignore404);
  } catch (error) {
    if (!isFreestyleStatus(error, 404)) throw toIntegrationError(error, "Revoke terminal access");
  }
}

/** Delete an identity with its tokens and grants. A missing identity counts as done. */
export async function deleteTerminalIdentity(opts: { identityId: string; client?: Freestyle }): Promise<void> {
  assertId(opts.identityId, "identityId");
  try {
    await (opts.client ?? freestyle()).identities.delete(opts.identityId);
  } catch (error) {
    if (!isFreestyleStatus(error, 404)) throw toIntegrationError(error, "Delete terminal identity");
  }
}
