/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Adapted from zephium-browser/website components/island/shimmer.tsx.
 */
import { cn } from "@/lib/cn";
import styles from "./shimmer-text.module.css";

type ShimmerTextProps = {
  children: string;
  /** Off: plain text, no band. */
  active?: boolean;
  className?: string;
};

/**
 * "Thinking…" text with a light band sliding across it. Transform only, so
 * it never repaints the words.
 */
export function ShimmerText({ children, active = true, className }: ShimmerTextProps) {
  return (
    <span data-shimmer="" className={cn(styles.shimmer, active && styles.running, className)}>
      <span data-shimmer-words="" className={styles.words}>
        {children}
      </span>
      {active ? (
        <span data-shimmer-band="" className={styles.band} aria-hidden="true">
          <span className={styles.lit}>{children}</span>
        </span>
      ) : null}
    </span>
  );
}
