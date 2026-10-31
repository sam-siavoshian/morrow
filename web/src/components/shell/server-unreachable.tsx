"use client";

import { APP_NAME } from "@morrow/contracts";
import { CloudOff, RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/** The team layout's answer when the backend is down: say so plainly, offer a retry, keep the user signed in. */
export function ServerUnreachable() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="grid min-h-dvh place-items-center bg-ground px-4">
      <EmptyState
        icon={<CloudOff />}
        title={`Can't reach ${APP_NAME}`}
        description="The server isn't answering right now. Your work is safe. Try again in a moment."
        action={
          <Button variant="secondary" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
            <RotateCw aria-hidden />
            {pending ? "Trying…" : "Try again"}
          </Button>
        }
      />
    </div>
  );
}
