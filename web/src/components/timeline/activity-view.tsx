"use client";

import { projectChannel } from "@morrow/contracts";
import { Hash, MessagesSquare, Unplug } from "lucide-react";
import { useMemo, useState } from "react";
import { ShellTitle } from "@/components/shell/shell-context";
import { ProjectIcon } from "@/components/sidebar/project-icon";
import { parseRepoFullName } from "@/components/sidebar/project-identity";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_CHANNEL, useRelayEvents, useRelayHistory, useTeam, useTeamStore, useWorkforce } from "@/lib/store";
import { ALL_MESSAGES, isFiltered, type TimelineFilter } from "./classify";
import { buildDirectory } from "./directory";
import { RelayTimeline } from "./relay-timeline";
import { TimelineFilters, type AgentOption } from "./timeline-filters";

/**
 * `/t/[teamId]/activity`: everything said on Relay across the team. One channel at a time (history
 * pages per channel), plus the team-wide traffic around it: DMs between agents and status changes.
 */
export function ActivityView() {
  const team = useTeam();
  const workforce = useWorkforce();
  const all = useRelayEvents();
  const relayMarks = useTeamStore((s) => s.relayMarks);
  const channels = useMemo(
    () => [
      ...(team?.projects ?? []).map((p) => ({
        value: projectChannel(p.id),
        label: parseRepoFullName(p.repoFullName).repo,
        icon: <ProjectIcon repoFullName={p.repoFullName} className="size-3.5" />,
      })),
      { value: DEFAULT_CHANNEL, label: DEFAULT_CHANNEL, icon: <Hash className="size-3.5 text-faint" /> },
    ],
    [team?.projects],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const channel = picked && channels.some((c) => c.value === picked) ? picked : channels[0]!.value;
  const history = useRelayHistory(channel);
  const [filter, setFilter] = useState<TimelineFilter>(ALL_MESSAGES);
  const directory = useMemo(() => buildDirectory(workforce, team), [workforce, team]);

  const events = useMemo(
    () => all.filter((e) => e.type !== "message" || e.conversationId !== null || e.channel?.replace(/^#/, "") === channel),
    [all, channel],
  );

  const agents = useMemo<AgentOption[]>(() => {
    const seen = new Map<string, AgentOption>();
    for (const e of events) {
      if (e.type !== "message" || seen.has(e.from.name)) continue;
      const info = directory.agent(e.from.name);
      if (info) seen.set(e.from.name, { name: e.from.name, label: directory.displayName(e.from.name), cli: info.cli });
    }
    return [...seen.values()];
  }, [events, directory]);

  if (!team)
    return (
      <div className="mx-auto flex w-full max-w-[72rem] flex-col gap-4 px-6 pt-6" aria-busy="true" aria-label="Loading activity">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="h-16 w-3/4" />
      </div>
    );

  return (
    <>
      <ShellTitle>
        <h1 className="truncate text-[13.5px] font-[600] tracking-[-0.01em] text-text">Activity</h1>
      </ShellTitle>
      {team.relayReady ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="mx-auto w-full max-w-[72rem] px-3 pt-3 sm:px-6">
            <TimelineFilters
              filter={filter}
              onChange={setFilter}
              agents={agents}
              leading={
                <div className="max-w-44 min-w-28 flex-1">
                  <Select aria-label="Channel" size="sm" className="min-w-0" options={channels} value={channel} onValueChange={(v) => v && setPicked(v)} />
                </div>
              }
            />
          </div>
          <RelayTimeline
            key={channel}
            className="min-h-0 flex-1"
            events={events}
            filter={filter}
            directory={directory}
            history={history}
            marks={relayMarks}
            live
            empty={
              <EmptyState
                icon={<MessagesSquare />}
                title={isFiltered(filter) ? "Nothing matches this filter" : "Quiet so far"}
                description={isFiltered(filter) ? "No message here fits this view and agent." : "Agents and teammates post here while tasks run. Load older messages from the top."}
                action={
                  isFiltered(filter) ? (
                    <Button size="sm" variant="secondary" onClick={() => setFilter(ALL_MESSAGES)}>
                      Clear filter
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </div>
      ) : (
        <div className="grid h-full min-h-80 place-items-center px-4">
          <EmptyState
            icon={<Unplug />}
            title="Relay isn't connected"
            description="Team messages show here once Relay is set up for this team. Tasks still run; their decision trace is on each task."
          />
        </div>
      )}
    </>
  );
}
