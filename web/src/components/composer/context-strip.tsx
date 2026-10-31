"use client";

import type { ProjectView } from "@morrow/contracts";
import { ChevronDown, FolderGit2, GitBranch, Plus } from "lucide-react";
import { useState } from "react";
import { RepoPicker } from "@/components/onboarding/repo-picker";
import { DialogContent, DialogRoot } from "@/components/ui/dialog";
import { Menu, MenuCheck, MenuItem, MenuSection, MenuSeparator } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { ComposerControl } from "./composer-control";

type ContextStripProps = {
  projects: readonly ProjectView[];
  projectId: string | null;
  onProjectChange: (projectId: string) => void;
  /** Once a task exists its project is fixed, so its branches never move under the workers. */
  locked: boolean;
  /** Set when the viewer may link repos (owner or admin): adds "Link a repo" to the menu. */
  link?: { teamId: string };
};

/** Under the card: which repo and which base branch the work starts from. */
export function ContextStrip({ projects, projectId, onProjectChange, locked, link }: ContextStripProps) {
  const [linking, setLinking] = useState(false);
  const project = projects.find((p) => p.id === projectId) ?? null;
  if (projects.length === 0 && !link) return null;

  const trigger = (
    <ComposerControl disabled={locked} aria-label={`Project: ${project?.repoFullName ?? "none"}`} className="max-w-[min(22rem,60vw)] min-w-0 shrink">
      <FolderGit2 aria-hidden="true" />
      <span className="truncate">{project?.repoFullName ?? "Choose a project"}</span>
      {locked ? null : <ChevronDown aria-hidden="true" className="size-3 opacity-60" />}
    </ComposerControl>
  );

  return (
    <div className="flex min-w-0 items-center gap-1 px-2 pt-1.5">
      {locked ? (
        <Tooltip content="This task's project is set">
          <span className="inline-flex min-w-0">{trigger}</span>
        </Tooltip>
      ) : (
        <Menu side="bottom" align="start" trigger={trigger}>
          {projects.length > 0 ? (
            <MenuSection label="Project">
              {projects.map((p) => (
                <MenuItem key={p.id} onClick={() => onProjectChange(p.id)}>
                  <span className="flex w-full min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{p.repoFullName}</span>
                    <MenuCheck selected={p.id === projectId} />
                  </span>
                </MenuItem>
              ))}
            </MenuSection>
          ) : null}
          {link ? (
            <>
              {projects.length > 0 ? <MenuSeparator /> : null}
              <MenuItem icon={<Plus aria-hidden="true" />} onClick={() => setLinking(true)}>
                Link a repo
              </MenuItem>
            </>
          ) : null}
        </Menu>
      )}
      {link ? (
        <DialogRoot open={linking} onOpenChange={setLinking}>
          <DialogContent title="Link repos" description="Repos you can push to on GitHub.">
            {linking ? (
              <RepoPicker
                teamId={link.teamId}
                linked={projects.map((p) => p.repoFullName)}
                onLinked={(linked) => {
                  toast.success(linked.length === 1 ? `Linked ${linked[0]!.repoFullName}` : `Linked ${linked.length} repos`);
                  // The new project reaches `projects` with the next team push; until then the composer keeps the
                  // current one, then switches.
                  onProjectChange(linked[0]!.id);
                  setLinking(false);
                }}
              />
            ) : null}
          </DialogContent>
        </DialogRoot>
      ) : null}
      {project ? (
        <Tooltip content="Each workstream gets its own branch from here">
          <span className="inline-flex min-w-0 shrink-[2] items-center gap-1 px-1.5 text-[13px] text-faint">
            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              from <span className="font-mono text-[12.5px] text-muted">{project.defaultBranch}</span>
            </span>
          </span>
        </Tooltip>
      ) : null}
    </div>
  );
}
