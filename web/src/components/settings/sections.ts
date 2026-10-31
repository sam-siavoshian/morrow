/** Settings shows one section at a time, deep-linkable as `?section=`. */
export const SETTINGS_SECTIONS = ["team", "members", "invites", "projects", "policy", "security", "appearance", "account"] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

/** The section a `?section=` value names; anything unknown (or missing) opens Team. */
export const sectionOf = (value: string | null): SettingsSectionId =>
  (SETTINGS_SECTIONS as readonly string[]).includes(value ?? "") ? (value as SettingsSectionId) : "team";

/** `/t/<team>/settings?section=<id>`. */
export const settingsPath = (teamId: string, section: SettingsSectionId) => `/t/${encodeURIComponent(teamId)}/settings?section=${section}`;
