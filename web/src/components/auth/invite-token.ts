import { Id } from "@morrow/contracts";

/** The random half of an invite: 32 bytes, base64url, no padding (mirrors the backend). */
const INVITE_CODE = /^[A-Za-z0-9_-]{43}$/;

export type InviteToken = { token: string; teamId: string };

/**
 * `<teamId>.<code>` from a `/join/[token]` segment. Team ids may contain dots, codes never do, so
 * this splits on the last one. Anything malformed is null and never reaches the server.
 */
export function parseInviteToken(raw: string | null | undefined): InviteToken | null {
  if (!raw || raw.length > 300) return null;
  let token: string;
  try {
    token = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const teamId = token.slice(0, dot);
  const code = token.slice(dot + 1);
  if (!Id.safeParse(teamId).success || /^\.+$/.test(teamId) || !INVITE_CODE.test(code)) return null;
  return { token, teamId };
}

/**
 * The invite in whatever someone pasted: the full link, just the path, or the bare token. Only the
 * token is kept; the host in a pasted link is ignored, so this can never send anyone off-site.
 */
export function inviteFromInput(input: string): InviteToken | null {
  const text = input.trim();
  if (!text) return null;
  const match = /\/join\/([^/?#\s]+)/.exec(text);
  return parseInviteToken(match ? match[1] : text);
}

export const joinPath = (invite: InviteToken) => `/join/${encodeURIComponent(invite.token)}`;
