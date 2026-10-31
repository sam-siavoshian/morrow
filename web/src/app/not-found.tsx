import type { Metadata } from "next";
import { SearchX } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "Not found" };

/** Anything unknown, including a team you are not a member of (we do not say which). */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-ground px-4">
      <EmptyState
        icon={<SearchX />}
        title="Page not found"
        description="This page doesn't exist, or you don't have access to it."
        action={
          <Button variant="secondary" render={<Link href="/" />}>
            Go home
          </Button>
        }
      />
    </main>
  );
}
