"use client";

import { TEST_COMMAND_MAX, type ProjectView, type TeamView } from "@morrow/contracts";
import { GitBranch, Pencil, Plus } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { GithubMark } from "@/components/auth/github-button";
import { RepoPicker } from "@/components/onboarding/repo-picker";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogRoot } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { errorMessage, unlinkProject, updateProject } from "@/lib/api";
import { useOptimisticTeam } from "@/lib/store";
import { ConfirmDialog } from "./confirm-dialog";
import { canManageTeam, parseTestCommand } from "./permissions";
import { SettingsGroup, SettingsRow, SettingsSection } from "./rows";
import { projectTestCommandField } from "./team-fields";

export function ProjectsSection({ team }: { team: TeamView }) {
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<ProjectView | null>(null);
  /** The project whose test command is open for editing; one at a time. */
  const [editing, setEditing] = useState<string | null>(null);
  const manage = canManageTeam(team.viewerRole);

  return (
    <SettingsSection
      title="Projects"
      description="GitHub repos the team's agents work on. Each task runs against one."
      actions={
        manage ? (
          <Button size="sm" variant="secondary" onClick={() => setLinking(true)}>
            <Plus />
            Link repo
          </Button>
        ) : null
      }
    >
      <SettingsGroup>
        {team.projects.length === 0 ? (
          <SettingsRow
            title="No repos linked yet"
            description={manage ? "Link a repo you can push to, and agents can open branches on it." : "Ask an admin to link one."}
          />
        ) : null}
        {team.projects.map((project) => (
          <SettingsRow
            key={project.id}
            icon={<GithubMark className="size-5 text-muted" />}
            title={project.repoFullName}
            description={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="size-3.5" />
                  {project.defaultBranch}
                </span>
                {editing === project.id ? null : (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    Tests:{" "}
                    {project.testCommand ? (
                      <code className="min-w-0 rounded-[4px] bg-fill px-1 py-px font-mono text-[12px] break-all text-text">{project.testCommand}</code>
                    ) : (
                      "none set"
                    )}
                    {manage ? (
                      <Button
                        size="xs"
                        variant="quiet"
                        className="ml-0.5"
                        onClick={() => setEditing(project.id)}
                        aria-label={`Edit the test command for ${project.repoFullName}`}
                      >
                        <Pencil />
                        Edit
                      </Button>
                    ) : null}
                  </span>
                )}
              </span>
            }
            control={
              manage ? (
                <Button size="xs" variant="quiet" onClick={() => setUnlinking(project)}>
                  Unlink
                </Button>
              ) : null
            }
          >
            {manage && editing === project.id ? <TestCommandForm teamId={team.id} project={project} onDone={() => setEditing(null)} /> : null}
          </SettingsRow>
        ))}
      </SettingsGroup>
      <p className="mt-2 px-1 text-[12.5px] text-muted">
        The test command is detected when a repo is linked, and owners and admins can change it here. Verification runs it on a
        teammate&apos;s VM before a task counts as done; with none set, tests are skipped.
      </p>

      {manage ? (
        <DialogRoot open={linking} onOpenChange={setLinking}>
          <DialogContent title="Link repos" description="Repos you can push to on GitHub.">
            {linking ? (
              <RepoPicker
                teamId={team.id}
                linked={team.projects.map((p) => p.repoFullName)}
                onLinked={(projects) => {
                  toast.success(projects.length === 1 ? `Linked ${projects[0]!.repoFullName}` : `Linked ${projects.length} repos`);
                  setLinking(false);
                }}
              />
            ) : null}
          </DialogContent>
        </DialogRoot>
      ) : null}
      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(open) => {
          if (!open) setUnlinking(null);
        }}
        title={`Unlink ${unlinking?.repoFullName ?? ""}?`}
        description="Agents stop taking new tasks on it. Branches already pushed to GitHub stay there. You can link it again later."
        confirmLabel="Unlink"
        onConfirm={async () => {
          if (!unlinking) return;
          await unlinkProject(team.id, unlinking.id);
          toast(`Unlinked ${unlinking.repoFullName}`);
        }}
      />
    </SettingsSection>
  );
}

/**
 * Inline editor for one project's test command. The new value shows at once and comes back if the server refuses
 * it. An empty field clears the command. Escape cancels.
 */
function TestCommandForm({ teamId, project, onDone }: { teamId: string; project: ProjectView; onDone: () => void }) {
  const optimistic = useOptimisticTeam();
  const [value, setValue] = useState(project.testCommand ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = `test-command-${project.id}`;
  const errorId = `${inputId}-error`;
  const unchanged = value.trim() === (project.testCommand ?? "");

  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = parseTestCommand(value);
    if ("problem" in parsed) return setError(parsed.problem);
    if (unchanged) return onDone();
    setBusy(true);
    setError(null);
    try {
      await optimistic(projectTestCommandField(project.id), parsed.value, () => updateProject(teamId, project.id, { testCommand: parsed.value }));
      toast.success(parsed.value ? "Test command saved" : "Test command cleared");
      onDone();
    } catch (e) {
      setError(errorMessage(e, "Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onDone();
    }
  }

  return (
    <form onSubmit={save} className="mt-2.5 flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[12.5px] font-[550] text-label-secondary">
        Test command
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="bun test"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={TEST_COMMAND_MAX + 50}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          size="sm"
          className="min-w-0 flex-1 basis-56 font-mono text-[12.5px]"
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={unchanged}>
            Save
          </Button>
          <Button type="button" size="sm" variant="quiet" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      ) : (
        <p className="text-[12.5px] text-muted">Runs from the repo root as one line. Leave it empty to skip tests.</p>
      )}
    </form>
  );
}
