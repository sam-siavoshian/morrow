"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";

/** "Back to tasks" for the current team; not-found pages get no params, so read them on the client. */
export function BackHomeLink() {
  const params = useParams<{ teamId?: string }>();
  const href = params.teamId ? `/t/${encodeURIComponent(params.teamId)}` : "/";
  return (
    <Button variant="secondary" render={<Link href={href} />}>
      Back to tasks
    </Button>
  );
}
