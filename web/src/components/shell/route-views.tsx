"use client";

import { TeamHome } from "@/components/composer/team-home";
import { PullsView } from "@/components/github/pull-list";
import { MissionControl } from "@/components/mission/mission-control";
import { SettingsView } from "@/components/settings/settings-view";
import { WorkforceView } from "@/components/workforce/workforce-view";
import { useMe } from "./me-context";

// Team pages render straight from the shell's member and the live store: no backend round trip on navigation.

export function HomeRoute() {
  const me = useMe();
  return <TeamHome me={{ user: me.user, features: me.features }} />;
}

export function TaskRoute({ teamId, taskId }: { teamId: string; taskId: string }) {
  return <MissionControl teamId={teamId} taskId={taskId} githubWebUrl={useMe().features.githubWebUrl} />;
}

export function WorkforceRoute({ teamId }: { teamId: string }) {
  return <WorkforceView teamId={teamId} me={useMe()} />;
}

export function SettingsRoute({ teamId }: { teamId: string }) {
  return <SettingsView teamId={teamId} me={useMe()} />;
}

export function PullsRoute({ teamId }: { teamId: string }) {
  return <PullsView teamId={teamId} githubWebUrl={useMe().features.githubWebUrl} />;
}
