"use client";

import type { EnvironmentView, MeView, ProfileView, WorkforceResponse } from "@morrow/contracts";
import { Plus, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { LOGIN_COMMAND } from "@/components/onboarding/agents-step";
import { StillConnecting, useStuck } from "@/components/onboarding/still-connecting";
import { ShellTitle } from "@/components/shell/shell-context";
import { TerminalDialog } from "@/components/terminal/terminal-dialog";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { errorMessage, getWorkforce } from "@/lib/api";
import { useEnvStatus, useTeam, useWorkforce } from "@/lib/store";
import { HARNESS_LABEL, HARNESSES, HarnessStack } from "@/components/harness/harness-icon";
import { AddEnvironmentDialog } from "./add-environment-dialog";
import { EnvironmentSection } from "./environment-section";
import { checkAndReport } from "./profile-row";
import { liveLeaseCount } from "./status";

type WorkforceViewProps = { teamId: string; me: MeView };

/** The open private terminal. With `signIn`, it was opened to sign that CLI back in. */
type OpenTerminal = { envId: string; signIn: ProfileView | null };

/** Every teammate's VM and the CLIs on it, live from the team socket, with a REST snapshot first. */
export function WorkforceView({ teamId, me }: WorkforceViewProps) {
  const team = useTeam();
  const workforce = useWorkforce();
  const [snapshot, setSnapshot] = useState<WorkforceResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [terminal, setTerminal] = useState<OpenTerminal | null>(null);

  // The socket's views make the snapshot pointless: coming back to this page with them loaded costs no request,
  // and a snapshot still in flight when they land is dropped.
  const live = team !== null && workforce !== null;
  useEffect(() => {
    if (live) return;
    const abort = new AbortController();
    getWorkforce(teamId, { signal: abort.signal })
      .then(setSnapshot)
      .catch((e) => {
        if (!abort.signal.aborted) setLoadError(errorMessage(e, "Couldn't load the workforce."));
      });
    return () => abort.abort();
  }, [teamId, live]);

  // The socket's views win once they arrive; the snapshot only fills the gap before that.
  const environments: EnvironmentView[] | null = useMemo(() => {
    const list = team?.environments ?? snapshot?.environments ?? null;
    return list ? list.filter((env) => env.phase !== "disconnected").sort((a, b) => a.createdAt - b.createdAt) : null;
  }, [team, snapshot]);

  const profilesByEnv = useMemo(() => {
    const all: ProfileView[] = workforce ? Object.values(workforce.profiles) : (snapshot?.environments.flatMap((e) => e.profiles) ?? []);
    const map = new Map<string, ProfileView[]>();
    for (const profile of all) map.set(profile.envId, [...(map.get(profile.envId) ?? []), profile]);
    for (const list of map.values()) list.sort((a, b) => a.cli.localeCompare(b.cli));
    return map;
  }, [workforce, snapshot]);

  const stuck = useStuck(environments === null && !loadError);
  const viewerRole = team?.viewerRole ?? me.teams.find((t) => t.id === teamId)?.role ?? "member";
  const defaultName = `${me.user.login}'s VM`;

  // The one action on an empty page; beside a list, a sign-in on a CLI is what matters most.
  const addButton = (
    <Button variant={environments?.length ? "secondary" : "primary"} size="sm" onClick={() => setAdding(true)}>
      <Plus />
      Add environment
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-(--gutter) py-6 sm:py-8">
      <ShellTitle>
        <h1 className="truncate text-[13.5px] font-[600] tracking-[-0.01em] text-text">Workforce</h1>
      </ShellTitle>
      <header className="flex flex-wrap items-center justify-between gap-4 pb-6">
        <p className="min-w-0 max-w-[52ch] text-[14px] leading-[1.5] text-muted text-pretty">
          Each teammate&apos;s cloud VM and the coding CLIs signed in on it. Tasks run on whichever CLI is ready.
        </p>
        {environments && environments.length > 0 ? addButton : null}
      </header>

      {loadError && environments === null ? <Alert tone="danger">{loadError}</Alert> : null}

      {environments === null && !loadError ? <StillConnecting label="Loading the workforce" stuck={stuck} /> : null}

      {environments && environments.length === 0 ? (
        <div className="rounded-panel border border-dashed border-border">
          <EmptyState
            icon={<Server />}
            title="No environments yet"
            description={
              <>
                Add a cloud VM, sign in to Claude Code, Codex, Cursor, Gemini CLI, Grok or opencode on it, and your team can route tasks to it.
                <span className="mt-4 flex justify-center">
                  <HarnessStack clis={[...HARNESSES]} size={22} max={HARNESSES.length} />
                </span>
              </>
            }
            action={addButton}
            className="min-h-[320px]"
          />
        </div>
      ) : null}

      {environments && environments.length > 0 ? (
        <div className="flex flex-col gap-10">
          {environments.map((env) => (
            <LiveEnvironment
              key={env.id}
              env={env}
              teamId={teamId}
              me={me}
              viewerIsAdmin={viewerRole === "owner" || viewerRole === "admin"}
              profiles={profilesByEnv.get(env.id) ?? []}
              team={team}
              liveLeases={liveLeaseCount(workforce, new Set((profilesByEnv.get(env.id) ?? []).map((p) => p.id)))}
              onOpenTerminal={(envId, signIn) => setTerminal({ envId, signIn: signIn ?? null })}
            />
          ))}
        </div>
      ) : null}

      <AddEnvironmentDialog
        open={adding}
        onOpenChange={setAdding}
        teamId={teamId}
        defaultName={defaultName}
        onCreated={(env) => {
          toast.success(`Creating ${env.name}`, { description: "Setup takes a few minutes. You can leave this page." });
          setSnapshot((prev) => (prev ? { ...prev, environments: [...prev.environments, { ...env, profiles: [], liveLeases: 0 }] } : prev));
        }}
      />
      {terminal ? (
        <TerminalDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            // Closing after a sign-in checks the login right away, so the row flips without a manual check.
            if (terminal.signIn) void checkAndReport(teamId, terminal.signIn);
            setTerminal(null);
          }}
          teamId={teamId}
          envId={terminal.envId}
          {...(terminal.signIn
            ? {
                title: `Sign in to ${HARNESS_LABEL[terminal.signIn.cli]}`,
                hint: LOGIN_COMMAND[terminal.signIn.cli].hint,
                command: LOGIN_COMMAND[terminal.signIn.cli].command,
              }
            : {})}
        />
      ) : null}
    </div>
  );
}

type LiveEnvironmentProps = {
  env: EnvironmentView;
  teamId: string;
  me: MeView;
  viewerIsAdmin: boolean;
  profiles: ProfileView[];
  team: ReturnType<typeof useTeam>;
  liveLeases: number;
  onOpenTerminal: (envId: string, signIn?: ProfileView) => void;
};

/** Folds the socket's quick VM/node pings into the environment before drawing it. */
function LiveEnvironment({ env, teamId, me, viewerIsAdmin, profiles, team, liveLeases, onOpenTerminal }: LiveEnvironmentProps) {
  const status = useEnvStatus(env.id);
  const live = status ? { ...env, vmState: status.vmState, nodeOnline: status.nodeOnline } : env;
  return (
    <EnvironmentSection
      teamId={teamId}
      env={live}
      owner={team?.members.find((m) => m.userId === env.ownerUserId) ?? null}
      profiles={profiles}
      projects={team?.projects ?? []}
      liveLeases={liveLeases}
      viewerId={me.user.id}
      viewerIsAdmin={viewerIsAdmin}
      onOpenTerminal={onOpenTerminal}
    />
  );
}
