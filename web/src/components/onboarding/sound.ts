/**
 * The one sound setup makes: Zephium's intro, as the name forms (Zephium `desktop/src/intro_sound.rs`
 * plays it natively; a browser needs a user gesture first, so Begin starts it). The asset is fixed
 * and same-origin, so CSP `default-src 'self'` covers it.
 */
export const INTRO_SOUND_SRC = "/sounds/intro.m4a";

/** Loud enough to notice, never startling. */
export const INTRO_VOLUME = 0.7;

export const SOUND_STORAGE_KEY = "morrow:intro-sound";

/** What the person chose: `null` when they never touched the toggle. */
export type SoundChoice = "on" | "off" | null;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const local = (): StorageLike | null => (typeof window === "undefined" ? null : window.localStorage);

/** The stored choice. Storage can be blocked or throw (private mode); that reads as no choice. */
export function readSoundChoice(storage: () => StorageLike | null = local): SoundChoice {
  try {
    const value = storage()?.getItem(SOUND_STORAGE_KEY);
    return value === "on" || value === "off" ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the choice when storage works; otherwise it lasts for this page only. */
export function writeSoundChoice(choice: Exclude<SoundChoice, null>, storage: () => StorageLike | null = local): void {
  try {
    storage()?.setItem(SOUND_STORAGE_KEY, choice);
  } catch {
    // Blocked storage: the toggle still works until the page closes.
  }
}

/** Muted when the person said so, or by default when motion is reduced and they never asked for sound. */
export const isMuted = (choice: SoundChoice, reducedMotion: boolean): boolean => choice === "off" || (choice === null && reducedMotion);
