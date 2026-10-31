"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { deriveProjectIdentity, githubOwnerAvatarUrl, parseRepoFullName } from "./project-identity";

const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const graphemeCount = (text: string) => (graphemes ? Array.from(graphemes.segment(text)).length : Array.from(text).length);

/** t3code's ProjectMonogram: a 16-unit tile, 14% tint of the hue, bold mono letters squeezed to fit. */
export function ProjectMonogram({ name, className }: { name: string; className?: string }) {
  const { monogram, colorClassName } = deriveProjectIdentity(name);
  return (
    <span aria-hidden="true" className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}>
      <svg
        viewBox="0 0 16 16"
        className={cn("size-full overflow-hidden rounded-[25%] font-mono select-none", colorClassName)}
        style={{ backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)" }}
      >
        <text
          x="8"
          y="10.8"
          textAnchor="middle"
          fill="currentColor"
          fontSize="8.25"
          fontWeight="700"
          textLength={graphemeCount(monogram) === 1 ? 6 : 12}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {monogram}
        </text>
      </svg>
    </span>
  );
}

// Owners whose avatar failed this session: never retried, so a broken image never flashes twice.
const failedOwners = new Set<string>();

type ProjectIconProps = {
  /** `owner/repo`. */
  repoFullName: string;
  className?: string;
};

/**
 * The repo owner's GitHub avatar when it loads, the monogram otherwise. The image is decorative:
 * the project name always sits next to it. No referrer goes to GitHub.
 */
export function ProjectIcon({ repoFullName, className }: ProjectIconProps) {
  const { owner, repo } = parseRepoFullName(repoFullName);
  const src = githubOwnerAvatarUrl(repoFullName);
  const [failed, setFailed] = useState(() => (owner ? failedOwners.has(owner) : false));

  const fail = () => {
    if (owner) failedOwners.add(owner);
    setFailed(true);
  };

  if (!src || failed) return <ProjectMonogram name={repo} className={className} />;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center",
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-[25%] after:shadow-[inset_0_0_0_0.5px_var(--color-border-strong)]",
        className,
      )}
    >
      {/* A plain img: next/image would proxy a third-party avatar through our server for nothing. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        className="size-full rounded-[25%] object-cover"
        onError={fail}
        // An image that failed before hydration never fires onError again.
        ref={(img) => {
          if (img?.complete && img.naturalWidth === 0) fail();
        }}
      />
    </span>
  );
}
