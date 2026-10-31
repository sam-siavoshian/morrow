"use client";

import type { ReactElement } from "react";
import { Tooltip } from "@/components/ui/tooltip";

/** A tooltip saying why a control is disabled. Disabled buttons get no pointer events, so the wrapper takes them. */
export function DisabledHint({ hint, children }: { hint: string | null; children: ReactElement }) {
  if (!hint) return children;
  return (
    <Tooltip content={hint}>
      <span tabIndex={0} className="inline-flex rounded-capsule">
        {children}
      </span>
    </Tooltip>
  );
}
