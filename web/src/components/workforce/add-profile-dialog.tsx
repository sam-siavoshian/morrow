"use client";

import { PROFILE_DEFAULT_CONCURRENT, PROFILE_LABEL_MAX, type CliKind, type ProfileView, type ProjectView } from "@morrow/contracts";
import { useState, type FormEvent } from "react";
import { HARNESS_LABEL, HarnessIcon } from "@/components/harness/harness-icon";
import { CheckRow } from "@/components/settings/check-row";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogContent, DialogRoot } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { errorMessage, registerProfile } from "@/lib/api";
import { WORKER_SLOT_CHOICES } from "./status";

type ScopeMode = "all" | "pick";
const SLOT_OPTIONS = WORKER_SLOT_CHOICES.map((value) => ({ value, label: value }));
const DEFAULT_SLOTS = String(PROFILE_DEFAULT_CONCURRENT);

type AddProfileDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  envId: string;
  /** CLIs this environment has no profile for yet. */
  available: readonly CliKind[];
  projects: readonly ProjectView[];
  onAdded: (profile: ProfileView) => void;
};

/** Registers a CLI already installed on the VM. Signing in happens in the private terminal. */
export function AddProfileDialog({ open, onOpenChange, teamId, envId, available, projects, onAdded }: AddProfileDialogProps) {
  const [cli, setCli] = useState<CliKind | null>(available[0] ?? null);
  const [label, setLabel] = useState(available[0] ? HARNESS_LABEL[available[0]] : "");
  const [mode, setMode] = useState<ScopeMode>("all");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [slots, setSlots] = useState(DEFAULT_SLOTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    const first = available[0] ?? null;
    setCli(first);
    setLabel(first ? HARNESS_LABEL[first] : "");
    setMode("all");
    setPicked(new Set());
    setSlots(DEFAULT_SLOTS);
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!cli) return;
    if (mode === "pick" && picked.size === 0) return setError("Pick at least one project, or allow all of them.");
    setBusy(true);
    setError(null);
    try {
      const profile = await registerProfile(teamId, envId, {
        cli,
        label: label.trim() || HARNESS_LABEL[cli],
        scopes: mode === "all" ? "all" : [...picked],
        maxConcurrent: Number(slots),
      });
      onAdded(profile);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Couldn't add that CLI. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        title="Add a CLI"
        description="Pick a coding CLI on this VM. The team can route tasks to it once it's signed in."
        footer={
          <>
            <DialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</DialogClose>
            <Button variant="primary" type="submit" form="add-profile" loading={busy} disabled={!cli}>
              Add CLI
            </Button>
          </>
        }
      >
        <form id="add-profile" onSubmit={submit} className="flex flex-col gap-4">
          <Select<CliKind>
            label="CLI"
            value={cli}
            onValueChange={(next) => {
              if (!next) return;
              setCli(next);
              setLabel(HARNESS_LABEL[next]);
            }}
            options={available.map((kind) => ({
              value: kind,
              label: HARNESS_LABEL[kind],
              icon: <HarnessIcon cli={kind} size={16} decorative />,
            }))}
          />
          <Field label="Label" description="Shown to teammates, e.g. “Claude Max (Ada)”.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={PROFILE_LABEL_MAX} autoComplete="off" />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-[13.5px] font-[550] tracking-[-0.006em] text-label-secondary">Projects it may work on</span>
            <Segmented<ScopeMode>
              aria-label="Projects it may work on"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "all", label: "All projects" },
                { value: "pick", label: "Pick projects" },
              ]}
              className="self-start"
            />
            {mode === "pick" ? (
              projects.length === 0 ? (
                <p className="text-[13px] text-muted">No projects are linked yet. Link one in Settings, or allow all projects.</p>
              ) : (
                <div className="flex max-h-56 flex-col overflow-y-auto rounded-row bg-fill p-1">
                  {projects.map((project) => (
                    <CheckRow
                      key={project.id}
                      checked={picked.has(project.id)}
                      onCheckedChange={(on) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(project.id);
                          else next.delete(project.id);
                          return next;
                        })
                      }
                      label={project.repoFullName}
                    />
                  ))}
                </div>
              )
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <Select label="Workers at once" value={slots} onValueChange={(next) => next && setSlots(next)} options={SLOT_OPTIONS} className="w-24" />
            <p className="text-[12.5px] leading-[1.45] text-muted">
              How many agents this login runs side by side. Every one spends the same subscription, so lower it if your plan&apos;s limits
              run out. You can change it later.
            </p>
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
