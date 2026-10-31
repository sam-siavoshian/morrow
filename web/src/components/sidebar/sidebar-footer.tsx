"use client";

import type { MemberView } from "@morrow/contracts";
import { Activity, GitPullRequest, Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PoolMeter } from "@/components/pool/pool-meter";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { ConnectionStatus } from "@/lib/realtime";
import { signedOutCount } from "@/components/workforce/status";
import { useConnection, useTeam, useTeamStore } from "@/lib/store";
import { teamPath } from "./sidebar-model";

const MAX_FACES = 4;

const CONNECTION: Record<ConnectionStatus, { tone: StatusTone; ping: boolean; label: string }> = {
  open: { tone: "success", ping: false, label: "Live. Updates arrive as they happen." },
  connecting: { tone: "attention", ping: true, label: "Connecting…" },
  reconnecting: { tone: "attention", ping: true, label: "Reconnecting…" },
  offline: { tone: "danger", ping: false, label: "Offline. Changes show up when you reconnect." },
};

export function SidebarFooter({ teamId, onNavigate }: { teamId: string; onNavigate: () => void }) {
  const pathname = usePathname();
  const signedOut = useTeamStore((s) => signedOutCount(s.workforce, s.viewerId));
  const links: { href: string; label: string; icon: ReactNode; attention?: number }[] = [
    { href: teamPath(teamId, "/workforce"), label: "Workforce", icon: <Users />, attention: signedOut },
    { href: teamPath(teamId, "/pulls"), label: "Pull requests", icon: <GitPullRequest /> },
    { href: teamPath(teamId, "/activity"), label: "Activity", icon: <Activity /> },
    { href: teamPath(teamId, "/settings"), label: "Settings", icon: <Settings /> },
  ];
  return (
    <div className="flex flex-col gap-px border-t border-border px-(--sidebar-content-inset) pt-1.5 pb-2">
      <PoolMeter variant="sidebar" className="mb-1" />
      <nav aria-label="Team" className="flex flex-col gap-px">
        {links.map((link) => {
          const current = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              // Four fixed links on every team page: worth a per-link prefetch, so the page (which reads the team id
              // from the URL, outside the shared App Shell) is ready before the click.
              prefetch={true}
              onClick={onNavigate}
              aria-current={current ? "page" : undefined}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-[var(--control-radius)] px-(--sidebar-row-content-inset) text-[13px] font-[500] outline-none pointer-coarse:h-11",
                "transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                "[&_svg]:size-4 [&_svg]:shrink-0",
                current ? "bg-row-active text-text shadow-row-rim [&_svg]:text-text" : "text-label-secondary hover:bg-row-hover hover:text-text [&_svg]:text-faint",
              )}
            >
              {link.icon}
              {link.label}
              {link.attention ? (
                <Badge tone="peach" size="sm" className="ml-auto" title={signedOutLabel(link.attention)}>
                  <span aria-hidden="true">{link.attention}</span>
                  <span className="sr-only">{signedOutLabel(link.attention)}</span>
                </Badge>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className="mt-1 flex h-8 items-center gap-2 px-(--sidebar-row-content-inset)">
        <TeamFaces />
        <ConnectionDot />
      </div>
    </div>
  );
}

const signedOutLabel = (n: number) => `${n} of your CLIs ${n === 1 ? "is" : "are"} signed out`;

function TeamFaces() {
  const members = useTeam()?.members ?? [];
  if (members.length === 0) return <span className="flex-1" />;
  const shown = members.slice(0, MAX_FACES);
  const extra = members.length - shown.length;
  return (
    <Tooltip content={memberSummary(members)} side="top" align="start">
      <span tabIndex={0} aria-label={memberSummary(members)} className="flex flex-1 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex -space-x-0.5">
          {shown.map((m) => (
            <Avatar key={m.userId} name={m.name ?? m.login} src={m.avatarUrl} login={m.login} size={20} className="rounded-full ring-2 ring-canvas" />
          ))}
        </span>
        {extra > 0 ? <span className="ml-1.5 text-[11.5px] font-[550] text-faint tabular-nums">+{extra}</span> : null}
      </span>
    </Tooltip>
  );
}

function memberSummary(members: readonly MemberView[]): string {
  const names = members.slice(0, 3).map((m) => m.name ?? m.login);
  const rest = members.length - names.length;
  return rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
}

function ConnectionDot() {
  const status = CONNECTION[useConnection()];
  return (
    <Tooltip content={status.label} side="top" align="end">
      <span tabIndex={0} className="grid size-6 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <StatusDot tone={status.tone} ping={status.ping} label={status.label} />
      </span>
    </Tooltip>
  );
}
