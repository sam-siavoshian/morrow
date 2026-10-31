"use client";

import type { CliKind } from "@morrow/contracts";
import type { ReactNode } from "react";
import { HarnessIcon } from "@/components/harness/harness-icon";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import type { TimelineFilter, TimelineScope } from "./classify";

const SCOPES = [
  { value: "all", label: "All" },
  { value: "channel", label: "Channel" },
  { value: "dms", label: "DMs" },
  { value: "threads", label: "Threads" },
] as const satisfies readonly { value: TimelineScope; label: string }[];

const ANY = "__any";

export type AgentOption = { name: string; label: string; cli: CliKind | null };

type TimelineFiltersProps = {
  filter: TimelineFilter;
  onChange: (filter: TimelineFilter) => void;
  agents: readonly AgentOption[];
  /** Extra controls on the left, like a channel picker. */
  leading?: ReactNode;
  className?: string;
};

/** Channel / DMs / threads, and one agent at a time. */
export function TimelineFilters({ filter, onChange, agents, leading, className }: TimelineFiltersProps) {
  const options = [
    { value: ANY, label: "Every agent" },
    ...agents.map((a) => ({
      value: a.name,
      label: a.label,
      icon: a.cli ? <HarnessIcon cli={a.cli} size={14} decorative /> : undefined,
    })),
  ];
  return (
    // Wraps rather than scrolls on a phone, so no control is ever cut off at the edge.
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {leading}
      <Segmented
        aria-label="Show"
        size="sm"
        options={SCOPES}
        value={filter.scope}
        onValueChange={(scope) => onChange({ ...filter, scope })}
      />
      {agents.length > 0 ? (
        <div className="max-w-44 min-w-28 flex-1">
          <Select
            aria-label="Filter by agent"
            size="sm"
            className="min-w-0"
            options={options}
            value={filter.agent ?? ANY}
            onValueChange={(value) => onChange({ ...filter, agent: !value || value === ANY ? null : value })}
          />
        </div>
      ) : null}
    </div>
  );
}
