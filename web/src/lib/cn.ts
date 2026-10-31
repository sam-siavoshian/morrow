import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge our theme names, otherwise `text-lede` reads as a colour
// and `rounded-control` / `shadow-raised` never dedupe against their peers.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["display", "headline", "lede", "2xs", "3xs", "4xs"],
      radius: [
        "swatch",
        "inset",
        "control-compact",
        "row",
        "control",
        "card",
        "control-large",
        "panel",
        "sheet",
        "capsule",
      ],
      shadow: [
        "raised",
        "float",
        "overlay",
        "menu",
        "sheet",
        "badge",
        "field-focus",
        "shine",
        "shine-top",
        "row-rim",
        "hairline",
        "composer",
        "sky",
      ],
      ease: ["emphasized", "smooth", "press", "exit", "drawer", "spring", "snap"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
