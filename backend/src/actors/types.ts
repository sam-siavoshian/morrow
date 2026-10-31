import type { AssignableRole, EnvironmentView, InviteView, ProjectView, Role, TeamPolicy, WorkforceView } from "@morrow/contracts";

/** What the backend core needs from the User actor, in backend terms. */
export interface UserRecord {
  id: string;
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  sessionVersion: number;
  teamIds: string[];
}

export interface GithubProfile {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
}

/** Profile snapshot stored on the Team at join time, so team reads never fan out to User actors. */
export interface MemberIdentity {
  userId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface MemberRecord extends MemberIdentity {
  role: Role;
}

export interface ProjectRecord extends ProjectView {
  repoId: number;
  createdBy: string;
}

export interface TeamRecord {
  id: string;
  name: string;
  slug: string;
  members: MemberRecord[];
  projects: ProjectView[];
  environments: EnvironmentView[];
  policy: TeamPolicy;
  relayReady: boolean;
}

export type AcceptInviteResult =
  | { ok: true; role: Role; alreadyMember: boolean }
  | { ok: false; reason: "invalid" | "expired" | "exhausted" | "full" };

export type RemoveMemberResult = { ok: true; removed: boolean } | { ok: false; reason: "last_owner" };

export type SetMemberRoleResult = { ok: true; changed: boolean } | { ok: false; reason: "not_a_member" | "owner_role_fixed" };

/** A usable invite. `inviter` is the creator's member card, or null when they have left the team. */
export interface InvitePreviewRecord {
  teamName: string;
  expiresAt: number;
  createdBy: string;
  inviter: { login: string; avatarUrl: string | null } | null;
}

export type LinkProjectResult = { ok: true } | { ok: false; reason: "duplicate" };

export type SocketActor = "Team" | "TeamWorkforce";

export interface SocketGrant {
  websocketUrl: string;
  connectByMs: number;
}

/** Team actor state as emitted over its socket, already mapped to backend terms. */
export type TeamStateMapper = (state: Record<string, unknown>, teamId: string) => TeamRecord | null;
export type WorkforceStateMapper = (state: Record<string, unknown>) => WorkforceView | null;

/**
 * The only door from the backend core into Terse. Implementations translate actor results into these
 * records and actor failures into AppError (see gateway.ts). Routes never import the generated client.
 */
export interface ActorGateway {
  // User
  upsertUserFromGithub(profile: GithubProfile, githubTokenEnc: string): Promise<UserRecord>;
  getUser(userId: string): Promise<UserRecord | null>;
  getGithubTokenEnc(userId: string): Promise<string | null>;
  bumpSessionVersion(userId: string): Promise<number>;
  addUserTeam(userId: string, teamId: string): Promise<void>;
  removeUserTeam(userId: string, teamId: string): Promise<void>;

  // Team
  createTeam(input: { teamId: string; name: string; slug: string; owner: MemberIdentity }): Promise<TeamRecord>;
  getTeam(teamId: string): Promise<TeamRecord | null>;
  createInvite(teamId: string, invite: { id: string; hash: string; createdBy: string; expiresAt: number; maxUses: number }): Promise<void>;
  listInvites(teamId: string): Promise<InviteView[]>;
  /** False when no active invite has that id. */
  revokeInvite(teamId: string, inviteId: string): Promise<boolean>;
  acceptInvite(teamId: string, input: { hash: string; member: MemberIdentity }): Promise<AcceptInviteResult>;
  removeMember(teamId: string, userId: string): Promise<RemoveMemberResult>;
  setMemberRole(teamId: string, userId: string, role: AssignableRole): Promise<SetMemberRoleResult>;
  renameTeam(teamId: string, name: string): Promise<void>;
  /** Merges the given settings onto the current policy atomically. */
  setTeamPolicy(teamId: string, patch: Partial<TeamPolicy>): Promise<void>;
  /** Null for every invite `userId` cannot use (no team, unknown hash, expired, used up, removed since) alike. */
  getInvitePreview(teamId: string, hash: string, userId: string): Promise<InvitePreviewRecord | null>;
  linkProject(teamId: string, project: ProjectRecord): Promise<LinkProjectResult>;
  unlinkProject(teamId: string, projectId: string): Promise<boolean>;
  /** Sets or clears a project's test command. Null when the team has no such project. */
  setProjectTestCommand(teamId: string, projectId: string, testCommand: string | null): Promise<ProjectView | null>;

  // Sockets (backend-held; grants never reach the browser)
  prepareSocket(actor: SocketActor, teamId: string): Promise<SocketGrant>;
  mapTeamState: TeamStateMapper;
  mapWorkforceState: WorkforceStateMapper;

  /** Cheap round trip to Terse for /readyz. Throws when unreachable. */
  ping(): Promise<void>;
}
