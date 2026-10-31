import { describe, expect, test } from "bun:test";
import { isMuted, readSoundChoice, SOUND_STORAGE_KEY, writeSoundChoice } from "./sound";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    storage: () => ({
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    }),
  };
}

const broken = () => ({
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
});

describe("intro sound preference", () => {
  test("round-trips through storage", () => {
    const { data, storage } = memory();
    expect(readSoundChoice(storage)).toBeNull();
    writeSoundChoice("off", storage);
    expect(data.get(SOUND_STORAGE_KEY)).toBe("off");
    expect(readSoundChoice(storage)).toBe("off");
    writeSoundChoice("on", storage);
    expect(readSoundChoice(storage)).toBe("on");
  });

  test("anything else stored reads as no choice", () => {
    expect(readSoundChoice(memory({ [SOUND_STORAGE_KEY]: "loud" }).storage)).toBeNull();
    expect(readSoundChoice(memory({ [SOUND_STORAGE_KEY]: "" }).storage)).toBeNull();
  });

  test("blocked or missing storage never throws", () => {
    expect(readSoundChoice(broken)).toBeNull();
    expect(() => writeSoundChoice("off", broken)).not.toThrow();
    expect(readSoundChoice(() => null)).toBeNull();
    expect(() => writeSoundChoice("on", () => null)).not.toThrow();
    expect(
      readSoundChoice(() => {
        throw new Error("no window");
      }),
    ).toBeNull();
  });

  test("on by default with full motion", () => expect(isMuted(null, false)).toBe(false));
  test("muted by default when motion is reduced", () => expect(isMuted(null, true)).toBe(true));
  test("an explicit choice wins over reduced motion", () => {
    expect(isMuted("on", true)).toBe(false);
    expect(isMuted("off", false)).toBe(true);
    expect(isMuted("off", true)).toBe(true);
  });
});
