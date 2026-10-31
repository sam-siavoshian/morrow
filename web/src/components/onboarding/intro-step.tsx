/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Adapted from github.com/zephium-browser/Zephium (frame/src/features/onboarding/components/Onboarding.svelte: welcome). */
"use client";

import { APP_NAME } from "@morrow/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useReducedMotion } from "@/components/ui/theme";
import { cn } from "@/lib/cn";
import { formName } from "./formation";
import { INTRO_SOUND_SRC, INTRO_VOLUME, isMuted, readSoundChoice, SOUND_STORAGE_KEY } from "./sound";

const TAGLINE = "Your team's coding agents, pooled in the cloud.";

/** Waiting for a gesture, the dots gathering, then the name standing. */
type Phase = "waiting" | "forming" | "formed";

function subscribeSoundChoice(onChange: () => void) {
  const listen = (event: StorageEvent) => {
    if (event.key === SOUND_STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", listen);
  return () => window.removeEventListener("storage", listen);
}

/**
 * The door to setup. Browsers block sound until a gesture, so Begin (or Enter) starts both the
 * sound and the name forming out of the sky's halftone; then the tagline and Continue arrive.
 */
export function IntroStep({ onContinue }: { onContinue: () => void }) {
  const [phase, setPhase] = useState<Phase>("waiting");
  const stored = useSyncExternalStore(subscribeSoundChoice, () => readSoundChoice(), () => null);
  const reduced = useReducedMotion();
  const muted = isMuted(stored, reduced);

  const name = useRef<HTMLHeadingElement>(null);
  const air = useRef<HTMLCanvasElement>(null);
  const stop = useRef<(() => void) | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Nothing downloads until sound is on (the effect below): a muted intro costs no request.
    const sound = new Audio();
    sound.preload = "none";
    sound.volume = INTRO_VOLUME;
    audio.current = sound;
    return () => {
      sound.pause();
      sound.removeAttribute("src");
      sound.load();
      audio.current = null;
      stop.current?.();
    };
  }, []);

  // Muting mid-play silences what is already playing; turning sound on fetches it ahead of the click.
  useEffect(() => {
    const sound = audio.current;
    if (!sound) return;
    sound.muted = muted;
    if (!muted && !sound.getAttribute("src")) {
      sound.preload = "auto";
      sound.src = INTRO_SOUND_SRC;
    }
  }, [muted]);

  async function begin() {
    if (phase !== "waiting") return;
    setPhase("forming");
    const sound = audio.current;
    if (sound && !muted) {
      sound.currentTime = 0;
      // A refused play (no output device, a strict autoplay policy) is not worth an error: the name still forms.
      sound.play().catch(() => {});
    }
    const element = name.current;
    const canvas = air.current;
    if (reduced || !element || !canvas) return setPhase("formed");
    try {
      await document.fonts.ready;
    } catch {
      // Draw with whatever face is there.
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const size = parseFloat(style.fontSize) || 64;
    stop.current = formName(canvas, {
      stage: { width: window.innerWidth, height: window.innerHeight },
      box: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      draw: (context) => {
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        if ("letterSpacing" in context) context.letterSpacing = style.letterSpacing;
        const metrics = context.measureText(APP_NAME);
        // Where the DOM puts the baseline: the font's box centred in the line box.
        const ascent = metrics.fontBoundingBoxAscent;
        const baseline = (rect.height - (ascent + metrics.fontBoundingBoxDescent)) / 2 + ascent;
        context.fillStyle = "#000";
        context.fillText(APP_NAME, 0, baseline);
      },
      pitch: Math.min(3.6, Math.max(2.4, size / 26)),
      density: Math.min(2, window.devicePixelRatio || 1),
      color: getComputedStyle(document.documentElement).getPropertyValue("--sky-ink").trim() || "#ffffff",
      onformed: () => setPhase("formed"),
      ondone: () => {
        stop.current = null;
      },
    });
  }

  /** Enter while the dots gather: skip to the standing name. */
  function settle() {
    stop.current?.();
    stop.current = null;
    setPhase("formed");
  }

  const shown = phase === "formed";
  return (
    <section
      aria-labelledby="onboarding-intro-title"
      data-phase={phase}
      className="flex min-h-[calc(100svh-var(--nav-height)-6rem)] w-full flex-col items-center justify-center pb-[8vh] text-center text-white"
    >
      <canvas ref={air} aria-hidden="true" className="pointer-events-none fixed inset-0 z-20 size-full" />
      {/* Begin stands where the name will: pressed, it gives way and the name forms in its place. */}
      <div className="grid place-items-center">
        <h1
          ref={name}
          id="onboarding-intro-title"
          className={cn(
            "col-start-1 row-start-1 inline-block text-[clamp(56px,13vw,112px)] leading-none font-[650] tracking-[-0.05em] text-(--sky-ink) [text-shadow:0_2px_24px_var(--sky-shadow)]",
            "transition-opacity duration-700 ease-out",
            shown ? "opacity-100" : "opacity-0",
          )}
        >
          {APP_NAME}
        </h1>
        {phase === "waiting" ? (
          <Button variant="sky" size="xl" data-step-primary="" onClick={() => void begin()} className="col-start-1 row-start-1 gap-3 pr-3.5">
            Begin
            <EnterKey />
          </Button>
        ) : null}
      </div>
      <p
        className={cn(
          "mt-6 max-w-[34ch] text-[17px] leading-normal font-[500] text-balance [text-shadow:0_1px_18px_var(--sky-shadow)]",
          shown ? "motion-safe:animate-[rise_1s_var(--ease-emphasized)_backwards]" : "invisible",
        )}
      >
        {TAGLINE}
      </p>

      <div className="mt-8 grid min-h-12 place-items-center">
        {shown ? (
          <Button
            variant="sky"
            size="xl"
            data-step-primary=""
            onClick={onContinue}
            className="gap-3 pr-3.5 motion-safe:animate-[rise_1s_var(--ease-emphasized)_220ms_backwards]"
          >
            Set up your team
            <EnterKey />
          </Button>
        ) : phase === "forming" ? (
          <button type="button" data-step-primary="" onClick={settle} className="sr-only">
            Skip the animation
          </button>
        ) : null}
      </div>
    </section>
  );
}

function EnterKey() {
  return <Kbd keys="enter" aria-hidden className="[&>span[aria-hidden]]:bg-[rgb(11_31_54/0.08)] [&>span[aria-hidden]]:text-[rgb(11_31_54/0.6)]" />;
}
