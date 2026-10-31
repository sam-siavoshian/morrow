"use client";

import type { MeView } from "@morrow/contracts";
import { Building2, FolderGit2, Link2, ShieldCheck, SlidersHorizontal, SunMoon, UserRound, Users } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { StillConnecting, useStuck } from "@/components/onboarding/still-connecting";
import { ShellTitle } from "@/components/shell/shell-context";
import { cn } from "@/lib/cn";
import { useTeam } from "@/lib/store";
import { AccountSection } from "./account-section";
import { AppearanceSection } from "./appearance-section";
import { InvitesSection } from "./invites-section";
import { MembersSection } from "./members-section";
import { ProjectsSection } from "./projects-section";
import { SecuritySection } from "./security-section";
import { sectionOf, SETTINGS_SECTIONS, settingsPath, type SettingsSectionId } from "./sections";
import { PolicySection, TeamSection } from "./team-section";

const NAV: Record<SettingsSectionId, { label: string; icon: ReactNode }> = {
  team: { label: "Team", icon: <Building2 /> },
  members: { label: "Members", icon: <Users /> },
  invites: { label: "Invites", icon: <Link2 /> },
  projects: { label: "Projects", icon: <FolderGit2 /> },
  policy: { label: "Policy", icon: <SlidersHorizontal /> },
  security: { label: "Security", icon: <ShieldCheck /> },
  appearance: { label: "Appearance", icon: <SunMoon /> },
  account: { label: "Account", icon: <UserRound /> },
};

/** A left nav and one section at a time, deep-linkable as `?section=`. */
export function SettingsView({ teamId, me }: { teamId: string; me: MeView }) {
  const team = useTeam();
  const section = sectionOf(useSearchParams().get("section"));
  const stuck = useStuck(team === null);
  const navRef = useRef<HTMLUListElement>(null);

  // On narrow screens the nav is a sideways strip: keep the open section in view. Only the strip
  // scrolls, never the page.
  useEffect(() => {
    const list = navRef.current;
    const item = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !item || list.scrollWidth <= list.clientWidth) return;
    const left = item.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft || left + item.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollTo({ left: Math.max(0, left - (list.clientWidth - item.offsetWidth) / 2) });
    }
  }, [section]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-(--gutter) py-6 sm:py-8 md:flex-row md:gap-10">
      <ShellTitle>
        <h1 className="truncate text-[13.5px] font-[600] tracking-[-0.01em] text-text">Settings</h1>
      </ShellTitle>
      <nav aria-label="Settings" className="shrink-0 md:w-48">
        <ul ref={navRef} className="-mx-(--gutter) flex gap-1 overflow-x-auto px-(--gutter) pb-1 no-scrollbar max-md:[mask-image:var(--mask-fade-end)] md:mx-0 md:flex-col md:px-0">
          {SETTINGS_SECTIONS.map((id) => {
            const active = id === section;
            return (
              <li key={id} className="shrink-0">
                <Link
                  href={settingsPath(teamId, id)}
                  scroll={false}
                  onClick={(event) => {
                    // A section is client state in the URL: swap it in place, with no server round trip.
                    // Modified clicks keep the Link's own behaviour (new tab, new window).
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    if (!active) window.history.pushState(null, "", settingsPath(teamId, id));
                  }}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-9 items-center gap-2.5 rounded-row px-2.5 text-[14px] font-[500] tracking-[-0.008em] text-muted transition-colors duration-150 md:h-8",
                    "hover:bg-row-hover hover:text-text [&_svg]:size-4 [&_svg]:shrink-0",
                    active && "bg-row-active text-text",
                  )}
                >
                  {NAV[id].icon}
                  {NAV[id].label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        {section === "security" ? (
          <SecuritySection />
        ) : section === "appearance" ? (
          <AppearanceSection />
        ) : section === "account" ? (
          <AccountSection user={me.user} />
        ) : team === null ? (
          <StillConnecting label="Loading team settings" stuck={stuck} />
        ) : section === "team" ? (
          <TeamSection team={team} />
        ) : section === "members" ? (
          <MembersSection team={team} viewerId={me.user.id} />
        ) : section === "invites" ? (
          <InvitesSection team={team} />
        ) : section === "projects" ? (
          <ProjectsSection team={team} />
        ) : (
          <PolicySection team={team} />
        )}
      </div>
    </div>
  );
}
