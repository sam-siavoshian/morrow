"use client";

import type { UserView } from "@morrow/contracts";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { GithubMark } from "@/components/auth/github-button";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { errorMessage, logout } from "@/lib/api";
import { ConfirmDialog } from "./confirm-dialog";
import { SettingsGroup, SettingsRow, SettingsSection } from "./rows";

export function AccountSection({ user }: { user: UserView }) {
  const [busy, setBusy] = useState(false);
  const [everywhere, setEverywhere] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await logout();
      // A full load drops every in-memory store, socket and terminal token with the session.
      window.location.replace(new URL("/", window.location.origin));
    } catch (e) {
      setBusy(false);
      toast.error("Couldn't sign out", { description: errorMessage(e, "Try again.") });
    }
  }

  return (
    <SettingsSection title="Account" description="Signed in with GitHub.">
      <SettingsGroup>
        <SettingsRow
          icon={<Avatar name={user.name ?? user.login} src={user.avatarUrl} login={user.login} size={34} />}
          title={user.name ?? user.login}
          description={
            <span className="inline-flex items-center gap-1.5">
              <GithubMark className="size-3.5" />@{user.login}
            </span>
          }
          control={
            <Button size="sm" variant="secondary" loading={busy} onClick={signOut}>
              <LogOut />
              Sign out
            </Button>
          }
        />
        <SettingsRow
          title="Sign out everywhere"
          description="Ends every session on every device, including this one. Use it if you signed in somewhere you don't trust."
          control={
            <Button size="sm" variant="danger" onClick={() => setEverywhere(true)}>
              Sign out everywhere
            </Button>
          }
        />
      </SettingsGroup>
      <ConfirmDialog
        open={everywhere}
        onOpenChange={setEverywhere}
        title="Sign out everywhere?"
        description="Every browser signed in to your account is signed out and its live views disconnect. A terminal already open on another device stays open until that tab closes it."
        confirmLabel="Sign out everywhere"
        onConfirm={async () => {
          await logout({ everywhere: true });
          window.location.replace(new URL("/", window.location.origin));
        }}
      />
    </SettingsSection>
  );
}
