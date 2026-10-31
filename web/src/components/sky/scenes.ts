/** The three skies baked into public/sky by scripts/bake-sky.ts. */
export const SCENES = ["day", "dawn", "night"] as const;

export type Scene = (typeof SCENES)[number];

export type ScenePreference = Scene | "system";

export const SCENE_STORAGE_KEY = "morrow:scene";

export const SCENE_LABEL: Record<Scene, string> = {
  day: "Day",
  dawn: "Dawn",
  night: "Night",
};

/** Paper each sky dissolves into; mirrors `--color-ground` and the bake script. */
export const SCENE_PAPER: Record<Scene, readonly [number, number, number]> = {
  day: [247, 247, 248],
  dawn: [242, 240, 250],
  night: [26, 29, 37],
};

export const isScene = (value: unknown): value is Scene =>
  value === "day" || value === "dawn" || value === "night";

/** Plain picture for the WebGL shader, without extension. */
export const plainSky = (scene: Scene, narrow: boolean) => `/sky/${scene}-${narrow ? 900 : 1672}`;
