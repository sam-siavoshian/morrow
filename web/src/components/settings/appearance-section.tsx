"use client";

import { SceneSwitcher } from "@/components/ui/scene-switcher";
import { SettingsGroup, SettingsRow, SettingsSection } from "./rows";

/** How the app looks in this browser. Nothing here touches the team. */
export function AppearanceSection() {
  return (
    <SettingsSection title="Appearance" description="Saved in this browser only.">
      <SettingsGroup>
        <SettingsRow
          title="Theme"
          description="Day and Dawn are light, Night is dark. The sky on the home page changes with it. System follows your computer."
          control={
            // A phone has no room for four icons and words: the words share the row evenly.
            <SceneSwitcher size="md" labelled className="max-sm:w-full max-sm:[&>[role=radio]]:flex-1 max-sm:[&>[role=radio]]:px-2 max-sm:[&_svg]:hidden" />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
