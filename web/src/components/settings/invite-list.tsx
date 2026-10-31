"use client";

import type { InviteView, TeamView } from "@morrow/contracts";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { errorMessage, isApiError, listInvites, revokeInvite } from "@/lib/api";
import { ConfirmDialog } from "./confirm-dialog";
import { inviteRow } from "./permissions";
import { SettingsGroup, SettingsRow, SettingsSection } from "./rows";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; invites: InviteView[]; at: number };

/** Links that still work, with a way to kill one. `version` bumps when a new link is made, to reload. */
export function InviteList({ team, version }: { team: TeamView; version: number }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [revoking, setRevoking] = useState<InviteView | null>(null);

  const fetchInvites = useCallback(
    (signal?: AbortSignal) =>
      listInvites(team.id, { signal }).then(
        ({ invites }) => setLoad({ status: "ready", invites, at: Date.now() }),
        (e: unknown) => {
          if (!signal?.aborted) setLoad({ status: "error", message: errorMessage(e, "Couldn't load invite links.") });
        },
      ),
    [team.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchInvites(controller.signal);
    return () => controller.abort();
  }, [fetchInvites, version]);

  return (
    <SettingsSection title="Active links" description="Revoke a link to stop it working right away. People who already joined stay.">
      <SettingsGroup>
        {load.status === "loading" ? (
          <div className="px-4 py-4">
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : load.status === "error" ? (
          <div className="px-4 py-3">
            <Alert tone="danger">{load.message}</Alert>
          </div>
        ) : load.invites.length === 0 ? (
          <SettingsRow title="No active links" description="Links that expire or fill up drop off this list." />
        ) : (
          load.invites.map((invite) => {
            const row = inviteRow(invite, team.members, load.at);
            return (
              <SettingsRow
                key={invite.id}
                title={row.title}
                description={row.detail}
                control={
                  <Button size="xs" variant="quiet" onClick={() => setRevoking(invite)}>
                    Revoke
                  </Button>
                }
              />
            );
          })
        )}
      </SettingsGroup>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke this link?"
        description="Anyone who has it can no longer join with it. You can make a new link any time."
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (!revoking) return;
          try {
            await revokeInvite(team.id, revoking.id);
            toast("Link revoked");
          } catch (e) {
            // Expired, filled up or revoked by someone else meanwhile: it already stopped working.
            if (!isApiError(e) || e.code !== "not_found") throw e;
            toast("That link had already stopped working");
          }
          await fetchInvites();
        }}
      />
    </SettingsSection>
  );
}
