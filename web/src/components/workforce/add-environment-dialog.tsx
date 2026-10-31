"use client";

import { ENVIRONMENT_NAME_MAX, type EnvironmentView } from "@morrow/contracts";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogContent, DialogRoot } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { createEnvironment, errorMessage } from "@/lib/api";

type AddEnvironmentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  defaultName: string;
  onCreated: (env: EnvironmentView) => void;
};

/** Names and creates a cloud VM for the signed-in user. Setup then runs on its own. */
export function AddEnvironmentDialog({ open, onOpenChange, teamId, defaultName, onCreated }: AddEnvironmentDialogProps) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Give it a name.");
    setBusy(true);
    setError(null);
    try {
      const env = await createEnvironment(teamId, { name: trimmed });
      onCreated(env);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Couldn't create the environment. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) {
          setName(defaultName);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        size="sm"
        title="Add a coding environment"
        description="A persistent Ubuntu VM under your name. You sign in to your CLIs there; nobody else can open its terminal."
        footer={
          <>
            <DialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</DialogClose>
            <Button variant="primary" type="submit" form="add-environment" loading={busy}>
              Create VM
            </Button>
          </>
        }
      >
        <form id="add-environment" onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Name" description="Teammates see this next to your CLIs.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={ENVIRONMENT_NAME_MAX} autoComplete="off" required />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
