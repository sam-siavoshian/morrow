"use client";

import type { InvitePreviewView, UserView } from "@morrow/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { carryToast } from "@/components/ui/carried-toast";
import { acceptInvite, isApiError, loginPath, logout, type ApiError } from "@/lib/api";

type Failure = { message: string; final: boolean };

/** Codes where trying the same link again cannot help. */
const FINAL = new Set(["not_found", "conflict", "forbidden", "bad_request"]);

function failureOf(error: unknown): Failure {
  if (!isApiError(error)) return { message: "Something went wrong. Try again.", final: false };
  const e: ApiError = error;
  return { message: e.message, final: FINAL.has(e.code) };
}

/** Signed in, not yet a member: one button to join, with every way it can fail said plainly. */
export function JoinCard({ token, user, inviter }: { token: string; user: UserView; inviter: InvitePreviewView["inviter"] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function accept() {
    setBusy(true);
    setFailure(null);
    try {
      const team = await acceptInvite(token);
      // A full load: any team page the browser kept from before was rendered without this team in the account.
      carryToast("success", `You joined ${team.name}`);
      window.location.replace(`/t/${encodeURIComponent(team.id)}`);
    } catch (error) {
      if (isApiError(error) && error.code === "unauthenticated") {
        router.replace(loginPath(`/join/${encodeURIComponent(token)}`));
        return;
      }
      setFailure(failureOf(error));
      setBusy(false);
    }
  }

  async function switchAccount() {
    try {
      await logout();
    } finally {
      window.location.assign(loginPath(`/join/${encodeURIComponent(token)}`));
    }
  }

  return (
    <>
      {inviter ? (
        <div className="flex items-center justify-center gap-2.5 text-[14px]">
          <Avatar name={inviter.login} src={inviter.avatarUrl} login={inviter.login} size={28} />
          <span className="min-w-0 truncate">
            <span className="font-[600]">@{inviter.login}</span> invited you
          </span>
        </div>
      ) : null}
      <div className="flex items-center justify-center gap-2.5 rounded-capsule bg-fill py-1.5 pr-3.5 pl-1.5 text-[13.5px] shadow-hairline">
        <Avatar name={user.name ?? user.login} src={user.avatarUrl} login={user.login} size={24} />
        <span className="min-w-0 truncate">
          Joining as <span className="font-[600]">@{user.login}</span>
        </span>
      </div>
      {failure ? <Alert tone="danger">{failure.message}</Alert> : null}
      {failure?.final ? (
        <Button variant="primary" size="xl" className="w-full" render={<Link href="/" />}>
          Go to your teams
        </Button>
      ) : (
        <Button variant="primary" size="xl" className="w-full" loading={busy} onClick={accept}>
          {failure ? "Try again" : "Accept invite"}
        </Button>
      )}
      <button
        type="button"
        onClick={switchAccount}
        className="mx-auto rounded-[4px] text-[12.5px] text-muted underline-offset-4 hover:text-text hover:underline"
      >
        Not you? Use another GitHub account
      </button>
    </>
  );
}
