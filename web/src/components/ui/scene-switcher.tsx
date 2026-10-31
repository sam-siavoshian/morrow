"use client";

import { Monitor, Moon, Sun, Sunrise } from "lucide-react";
import type { ScenePreference } from "@/components/sky/scenes";
import { Segmented, type SegmentedOption } from "./segmented";
import { setScenePreference, useScenePreference } from "./theme";

const OPTIONS: readonly SegmentedOption<ScenePreference>[] = [
  { value: "system", label: "Match system", icon: <Monitor />, iconOnly: true },
  { value: "day", label: "Day", icon: <Sun />, iconOnly: true },
  { value: "dawn", label: "Dawn", icon: <Sunrise />, iconOnly: true },
  { value: "night", label: "Night", icon: <Moon />, iconOnly: true },
];

const LABELLED = OPTIONS.map((option) => ({ ...option, label: option.value === "system" ? "System" : option.label, iconOnly: false }));

/** Picks the page's sky: system, day, dawn or night. Saved per browser. `labelled` writes each name next to its icon. */
export function SceneSwitcher({ size = "sm", labelled = false, className }: { size?: "sm" | "md"; labelled?: boolean; className?: string }) {
  const preference = useScenePreference();
  return (
    <Segmented
      aria-label="Theme"
      options={labelled ? LABELLED : OPTIONS}
      value={preference}
      onValueChange={setScenePreference}
      size={size}
      className={className}
    />
  );
}
