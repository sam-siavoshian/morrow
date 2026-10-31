"use client";

import { TEAM_NAME_MAX, type TeamPolicy, type TeamView } from "@morrow/contracts";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { errorMessage, renameTeam, updatePolicy } from "@/lib/api";
import { useOptimisticTeam } from "@/lib/store";
import { canManageTeam, MAX_PARALLEL_CHOICES, teamNameProblem } from "./permissions";
import { SettingsGroup, SettingsRow, SettingsSection } from "./rows";
import { nameField, policyField } from "./team-fields";

const ONLY_ADMINS = "Only the owner and admins can change this.";

export function TeamSection({ team }: { team: TeamView }) {
  const editable = canManageTeam(team.viewerRole);
  return (
    <SettingsSection title="Team" description="The basics everyone in the team sees.">
      <SettingsGroup>
        {editable ? (
          <RenameRow team={team} />
        ) : (
          <SettingsRow title="Name" description={ONLY_ADMINS} control={<span className="text-[14px] font-[550]">{team.name}</span>} />
        )}
        <SettingsRow
          title="Agent Relay workspace"
          description="Where every agent and teammate in this team talks."
          control={
            <Badge tone={team.relayReady ? "mint" : "neutral"} size="sm">
              {team.relayReady ? "Connected" : "Not set up"}
            </Badge>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

/** The new name shows everywhere at once; if the server refuses it, the old one comes back. */
function RenameRow({ team }: { team: TeamView }) {
  const optimistic = useOptimisticTeam();
  // Null until the viewer types, so a rename by someone else shows up here too.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? team.name;
  const unchanged = value.trim() === team.name;

  async function save(event: FormEvent) {
    event.preventDefault();
    const problem = teamNameProblem(value);
    if (problem) return setError(problem);
    if (unchanged) return setDraft(null);
    const name = value.trim();
    setBusy(true);
    setError(null);
    try {
      await optimistic(nameField, name, () => renameTeam(team.id, name));
      setDraft(null);
      toast.success("Team renamed");
    } catch (e) {
      setError(errorMessage(e, "Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsRow title="Name" description={error ? <span className="text-danger">{error}</span> : "Shown to everyone in the team and on invite links."}>
      <form onSubmit={save} className="mt-2.5 flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          aria-label="Team name"
          aria-invalid={error ? true : undefined}
          maxLength={TEAM_NAME_MAX}
          size="sm"
          className="max-w-72"
        />
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={unchanged}>
          Save
        </Button>
      </form>
    </SettingsRow>
  );
}

/** Changes apply at once and roll back with a toast if the server says no. */
export function PolicySection({ team }: { team: TeamView }) {
  const optimistic = useOptimisticTeam();
  const editable = canManageTeam(team.viewerRole);

  async function change<K extends keyof TeamPolicy>(key: K, value: TeamPolicy[K]) {
    try {
      await optimistic(policyField(key), value, () => updatePolicy(team.id, { [key]: value }));
    } catch (e) {
      toast.error("Couldn't save that change", { description: errorMessage(e, "Check your connection and try again.") });
    }
  }

  return (
    <SettingsSection title="Policy" description={editable ? "How agents run in this team." : `How agents run in this team. ${ONLY_ADMINS}`}>
      <SettingsGroup>
        <SettingsRow
          title="Read-only inspect"
          description="Any member can watch a running worker's log tail. Never its private terminal."
          control={
            <Switch
              checked={team.policy.allowInspect}
              disabled={!editable}
              onCheckedChange={(checked) => void change("allowInspect", checked)}
              aria-label="Read-only inspect"
            />
          }
        />
        <SettingsRow
          title="Max agents per task"
          description="The most workers that run on one task at the same time."
          control={
            <Select
              size="sm"
              aria-label="Max agents per task"
              disabled={!editable}
              value={String(team.policy.maxParallelPerTask)}
              onValueChange={(next) => next && void change("maxParallelPerTask", Number(next))}
              options={MAX_PARALLEL_CHOICES.map((n) => ({ value: String(n), label: String(n) }))}
            />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
