"use client";

import { RotateCw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/** A page in the team shell crashed. The shell stays usable; only the main pane shows this. */
export default function TeamPageError({ error, retry }: { error: unknown; retry: () => void }) {
  // Server errors arrive with only a digest (Next strips the message); client errors stay in the console.
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex h-full min-h-80 flex-col items-center justify-center px-4">
      <EmptyState
        icon={<TriangleAlert />}
        title="This page hit a problem"
        description="Something went wrong loading it. Your tasks keep running in the cloud."
        action={
          <Button variant="secondary" onClick={() => retry()}>
            <RotateCw aria-hidden />
            Try again
          </Button>
        }
      />
      {digest ? <p className="-mt-6 font-mono text-[11.5px] text-faint select-all">Reference {digest}</p> : null}
    </div>
  );
}
