"use client";

import type { AssignableRole, MemberView, Role, TeamView } from "@morrow/contracts";
import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { carryToast } from "@/components/ui/carried-toast";
import { toast } from "@/components/ui/toast";
import { Select } from "@/components/ui/select";
import { errorMessage, removeMember, setMemberRole } from "@/lib/api";
import { useOptimisticTeam } from "@/lib/store";
import { ConfirmDialog } from "./confirm-dialog";
import { canChangeRole, memberAction } from "./permissions";
import { SettingsGroup, SettingsRow, SettingsSection } from "./rows";
import { memberRoleField } from "./team-fields";

const ROLE: Record<Role, { label: string; tone: BadgeTone }> = {
  owner: { label: "Owner", tone: "lilac" },
  admin: { label: "Admin", tone: "sky" },
  member: { label: "Member", tone: "neutral" },
};

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

const ASSIGNABLE: readonly { value: AssignableRole; label: string }[] = [
  { value: "admin", label: ROLE.admin.label },
  { value: "member", label: ROLE.member.label },
];

type Pending = { member: MemberView; kind: "remove" | "leave" };

/** Owner only: the badge becomes a select. The new role shows at once and rolls back if the server says no. */
function RoleControl({ team, member, viewerRole }: { team: TeamView; member: MemberView; viewerRole: Role }) {
  const optimistic = useOptimisticTeam();
  const role = member.role;
  if (!canChangeRole(viewerRole, role)) {
    return (
      <Badge tone={ROLE[role].tone} size="sm">
        {ROLE[role].label}
      </Badge>
    );
  }
  async function change(next: AssignableRole) {
    if (next === role) return;
    try {
      await optimistic(memberRoleField(member.userId), next, () => setMemberRole(team.id, member.userId, next));
      toast.success(`@${member.login} is now ${next === "admin" ? "an admin" : "a member"}`);
    } catch (e) {
      toast.error("Couldn't change the role", { description: errorMessage(e, "Check your connection and try again.") });
    }
  }
  return (
    <Select<AssignableRole>
      size="sm"
      aria-label={`Role for @${member.login}`}
      value={role}
      onValueChange={(next) => next && void change(next)}
      options={ASSIGNABLE}
    />
  );
}

export function MembersSection({ team, viewerId }: { team: TeamView; viewerId: string }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const viewer = { userId: viewerId, role: team.viewerRole };
  const members = [...team.members].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.login.localeCompare(b.login));

  return (
    <SettingsSection
      title="Members"
      description={`${members.length} ${members.length === 1 ? "person" : "people"}. Everyone's agents share one Relay workspace, so members trust each other's agents.`}
    >
      <SettingsGroup>
        {members.map((member) => {
          const action = memberAction(viewer, member);
          const self = member.userId === viewerId;
          return (
            <SettingsRow
              key={member.userId}
              icon={<Avatar name={member.name ?? member.login} src={member.avatarUrl} login={member.login} size={30} />}
              title={
                <span className="flex items-center gap-2">
                  <span className="truncate">{member.name ?? member.login}</span>
                  {self ? <span className="text-[12.5px] font-[450] text-muted">You</span> : null}
                </span>
              }
              description={`@${member.login}`}
              control={
                <>
                  <RoleControl team={team} member={member} viewerRole={viewer.role} />
                  {action ? (
                    <Button size="xs" variant={action === "leave" ? "ghost" : "quiet"} onClick={() => setPending({ member, kind: action })}>
                      {action === "leave" ? "Leave team" : "Remove"}
                    </Button>
                  ) : null}
                </>
              }
            />
          );
        })}
      </SettingsGroup>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.kind === "leave" ? `Leave ${team.name}?` : `Remove @${pending?.member.login ?? ""}?`}
        description={
          pending?.kind === "leave"
            ? "You lose access to its tasks and agents, including VMs you added here. Disconnect those first if the team shouldn't keep them. You'll need a new invite to come back."
            : "They lose access to this team's tasks and agents right away. They'll need a new invite to come back."
        }
        confirmLabel={pending?.kind === "leave" ? "Leave team" : "Remove"}
        onConfirm={async () => {
          if (!pending) return;
          await removeMember(team.id, pending.member.userId);
          if (pending.kind === "leave") {
            // A full load: the browser still holds this team's pages, and the account's team list, for a few minutes.
            carryToast("neutral", `You left ${team.name}`);
            window.location.replace("/");
          } else {
            toast(`Removed @${pending.member.login}`);
          }
        }}
      />
    </SettingsSection>
  );
}
