// React port of opencode's Spinner (packages/ui/src/components/spinner.tsx),
// MIT License, Copyright (c) opencode. See THIRD_PARTY_NOTICES.md.
"use client";

import { useEffect, useRef, type CSSProperties, type SVGProps } from "react";
import { cn } from "@/lib/cn";
import { radarDots, radarLoop } from "./radar-layout";

// Pure math at module load: identical on server and client.
const DOTS = radarDots();

let resize: ResizeObserver | undefined;
let sight: IntersectionObserver | undefined;

// Every spinner's loop starts at time zero, so all of them on screen sweep in
// step however late each one mounted.
function pin(element: Element) {
  if (element.hasAttribute("data-offscreen")) return;
  for (const animation of element.getAnimations({ subtree: true })) {
    if (animation.effect?.getTiming().iterations === Infinity && animation.startTime !== 0) {
      animation.startTime = 0;
    }
  }
}

function observers() {
  resize ??= new ResizeObserver((entries) => entries.forEach((entry) => pin(entry.target)));
  sight ??= new IntersectionObserver((entries) =>
    entries.forEach((entry) => {
      entry.target.toggleAttribute("data-offscreen", !entry.isIntersecting);
      pin(entry.target);
    }),
  );
  return { resize, sight };
}

/**
 * opencode's Soft Radar: a 5x5 grid whose lit head sweeps each square ring
 * clockwise with a fading trail. CSS only, synced across the page, paused
 * offscreen, frozen a fifth of the way round for reduced motion. Pair it with
 * text, or wrap it in `role="status"` with a label.
 */
export function RadarSpinner({ className, style, ...props }: SVGProps<SVGSVGElement>) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { resize, sight } = observers();
    resize.observe(element);
    sight.observe(element);
    const onStart = () => pin(element);
    element.addEventListener("animationstart", onStart);
    return () => {
      resize.unobserve(element);
      sight.unobserve(element);
      element.removeEventListener("animationstart", onStart);
    };
  }, []);

  return (
    <svg
      ref={ref}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      data-slot="spinner-dots"
      className={cn("size-4 shrink-0", className)}
      style={style}
      {...props}
    >
      {DOTS.map((dot, index) => (
        <rect
          key={index}
          x={dot.x}
          y={dot.y}
          width={dot.size}
          height={dot.size}
          rx={dot.size * 0.24}
          style={
            {
              "--still": dot.still,
              animation: dot.steady
                ? undefined
                : `spinner-radar-${dot.shape} calc(${radarLoop}s * var(--spinner-time, 1)) linear calc(${-radarLoop * (1 - dot.at)}s * var(--spinner-time, 1)) infinite`,
            } as CSSProperties
          }
        />
      ))}
    </svg>
  );
}
