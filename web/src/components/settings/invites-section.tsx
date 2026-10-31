"use client";

import { INVITE_MAX_USES, type CreateInviteResponse, type TeamView } from "@morrow/contracts";
import { Check, Copy, Link2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { createInvite, errorMessage } from "@/lib/api";
import { InviteList } from "./invite-list";
import { canManageTeam, INVITE_EXPIRY_CHOICES, inviteSummary, parseMaxUses } from "./permissions";
import { SettingsGroup, SettingsRow, SettingsSection } from "./rows";

type Created = CreateInviteResponse & { maxUses: number; /** When the link was made: the clock for "until". */ shownAt: number };

export function InvitesSection({ team }: { team: TeamView }) {
  const [maxUses, setMaxUses] = useState(String(INVITE_MAX_USES.default));
  const [hours, setHours] = useState<string>("168");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState(0);

  if (!canManageTeam(team.viewerRole)) {
    return (
      <SettingsSection title="Invites" description="Bring teammates in with a link.">
        <SettingsGroup>
          <SettingsRow title="Ask an admin" description="Only the team owner and admins can create invite links." />
        </SettingsGroup>
      </SettingsSection>
    );
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const uses = parseMaxUses(maxUses);
    if (uses === null) return setError(`Enter a number from ${INVITE_MAX_USES.min} to ${INVITE_MAX_USES.max}.`);
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const invite = await createInvite(team.id, { maxUses: uses, expiresInHours: Number(hours) });
      setCreated({ ...invite, maxUses: uses, shownAt: Date.now() });
      setMaxUses(String(uses));
      setVersion((v) => v + 1);
    } catch (e) {
      setError(errorMessage(e, "Couldn't create the link. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      toast.success("Invite link copied");
    } catch {
      toast.error("Couldn't copy", { description: "Select the link and copy it by hand." });
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection title="Invites" description="Anyone with the link can join until it runs out or expires. We only store a hash of it.">
        <SettingsGroup>
          <form onSubmit={create} className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-end">
            <Field label="Max uses" className="sm:w-32">
              <Input
                inputMode="numeric"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                aria-describedby="invite-uses-help"
                maxLength={3}
              />
            </Field>
            <div className="sm:w-40">
              <Select
                label="Expires after"
                value={hours}
                onValueChange={(next) => next && setHours(next)}
                options={INVITE_EXPIRY_CHOICES.map((c) => ({ value: String(c.hours), label: c.label }))}
              />
            </div>
            <Button type="submit" variant="primary" loading={busy} className="sm:mb-px">
              <Link2 />
              Create link
            </Button>
          </form>
          <p id="invite-uses-help" className="sr-only">
            How many people can join with this link, from {INVITE_MAX_USES.min} to {INVITE_MAX_USES.max}.
          </p>
          {error ? (
            <div className="px-4 py-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}
          {created ? (
            <div className="flex flex-col gap-2.5 px-4 py-4">
              <div className="flex items-center gap-2 rounded-control-compact bg-fill py-1 pr-1 pl-3 shadow-hairline">
                <input
                  readOnly
                  value={created.url}
                  aria-label="Invite link"
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-text outline-none"
                />
                <Button size="sm" variant={copied ? "secondary" : "primary"} onClick={copy}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-[12.5px] leading-[1.5] text-muted">
                {inviteSummary(created.maxUses, created.expiresAt, created.shownAt)} This link is shown once. Copy it now; if you lose
                it, create another.
              </p>
            </div>
          ) : null}
        </SettingsGroup>
      </SettingsSection>
      <InviteList team={team} version={version} />
    </div>
  );
}
