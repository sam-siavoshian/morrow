"use client";

import { Avatar as Base } from "@base-ui/react/avatar";
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import { githubAvatar } from "@/lib/github-avatar";
import type { StatusTone } from "./status-dot";

const HUES = ["sky", "mint", "lemon", "peach", "rose", "lilac"] as const;

/** t3code's stable name hash: the same name always gets the same hue. */
function hueOf(name: string) {
  let index = 0;
  for (const char of name.normalize("NFKC").toLowerCase()) index = (index * 31 + char.codePointAt(0)!) % 997;
  return HUES[index % HUES.length]!;
}

/** First letter of the first two words, or the first two letters of one. */
export function initialsOf(name: string) {
  const words = name.trim().split(/[\s._-]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? [words[0]![0], words[1]![0]] : [...words[0]!].slice(0, 2);
  return letters.join("").toUpperCase();
}

const DOT_TONE: Record<StatusTone, string> = {
  neutral: "bg-muted",
  live: "bg-soft-sky",
  attention: "bg-warning",
  success: "bg-success",
  danger: "bg-danger",
  info: "bg-info",
  idle: "bg-faint",
};

type AvatarProps = {
  name: string;
  /** A stored GitHub avatar URL. Anything not on GitHub's avatar host is ignored. */
  src?: string | null;
  /** GitHub login: its GitHub picture is used when there is no stored URL. */
  login?: string | null;
  size?: number;
  /** A small dot set into a notch at the top right (opencode). */
  status?: StatusTone;
  shape?: "circle" | "squircle";
  className?: string;
};

/** Their GitHub photo when there is one, else initials on the name's soft hue. Never a broken image. */
export function Avatar({ name, src, login, size = 28, status, shape = "circle", className }: AvatarProps) {
  const photo = githubAvatar({ avatarUrl: src, login }, size);
  const hue = hueOf(name);
  const dot = Math.max(6, Math.round(size * 0.24));
  // The notch: a ring of transparency round where the dot sits, so it reads
  // as set into the avatar rather than stuck on top.
  const gap = dot / 2 + 1.5;
  const notch: CSSProperties = status
    ? { maskImage: `radial-gradient(circle at ${size - dot / 2 + 1}px ${dot / 2 - 1}px, transparent ${gap}px, #000 ${gap + 0.5}px)` }
    : {};

  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <Base.Root
        className={cn(
          "inline-flex size-full select-none items-center justify-center overflow-hidden align-middle",
          shape === "circle" ? "rounded-full" : "rounded-[28%]",
        )}
        style={{
          ...notch,
          background: `var(--color-soft-${hue}-wash)`,
          color: `var(--color-soft-${hue}-ink)`,
          boxShadow: `inset 0 0 0 0.5px var(--color-soft-${hue}-edge)`,
        }}
      >
        {photo ? <Base.Image src={photo} alt={name} width={size} height={size} className="size-full object-cover" /> : null}
        <Base.Fallback
          delay={photo ? 400 : 0}
          className="font-[600] tracking-[-0.02em] tabular-nums"
          style={{ fontSize: Math.max(9, Math.round(size * 0.38)) }}
        >
          <span aria-hidden="true">{initialsOf(name)}</span>
          <span className="sr-only">{name}</span>
        </Base.Fallback>
      </Base.Root>
      {status ? (
        <span
          aria-hidden="true"
          className={cn("absolute rounded-full", DOT_TONE[status])}
          style={{ width: dot, height: dot, top: -1, right: -1 }}
        />
      ) : null}
    </span>
  );
}
