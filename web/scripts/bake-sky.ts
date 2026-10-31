/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Ported from zephium-browser/Zephium `frame/scripts/bake-sky.mjs`
 * (https://github.com/zephium-browser/Zephium), adapted to Bun and to our
 * own sky sources.
 */

// Bakes every sky in assets/sky into public/sky:
//   <name>-1672 / <name>-900          plain picture, for the WebGL cloud shader
//   <name>-baked-2200 / -baked-1200   picture dissolving through a halftone
//                                     screen into the page below its horizon
//   frost-<name>.png                  tiny pre-blurred picture; stretched over
//                                     a panel it is frosted glass, no runtime blur
//   edge-light.json                   light at the picture's left edge per band
// Every picture ships as AVIF with a JPEG fallback.
//
// Run with `bun run bake:sky` after changing a source. Needs ffmpeg built
// with libsvtav1, and ImageMagick (`magick`).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Rgb = [number, number, number];

type Scene = {
  name: string;
  /** The page colour the sky dissolves into (the UI's `--sky-paper`). */
  paper: Rgb;
  /** Which clouds hold the edge longest: negative keeps the darker blue
   *  between clouds, positive keeps the bright cloud tops. */
  follow: number;
  /** Laid over the frost so interface ink stays legible on it. */
  veil: [number, number, number, number];
  glass?: { sigma?: number; flatten?: number; keepColour?: boolean };
};

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIR = join(WEB_ROOT, "assets/sky");
const OUT_DIR = join(WEB_ROOT, "public/sky");

/** Every source is this size; the bake works at twice it for dense displays. */
const WIDTH = 1672;
const HEIGHT = 941;
const SCALE = 2;
/** The halftone screen's pitch and the band it covers, in source pixels. */
const CELL = 7;
const BAND = { top: 486, bottom: 889 };

/** Widths shipped for the plain (shader) and baked pictures. */
const PLAIN_WIDTHS = [1672, 900];
const BAKED_WIDTHS = [2200, 1200];

/** The frost's width. Stretched over a panel it is a blur of about 1/40 of
 *  the panel's width with nothing drawn at run time. */
const FROST_WIDTH = 192;
/** Glass flattens what is behind it: each frost pixel moves this far toward
 *  the picture's mean, so a bright cloud cannot sit under a label. */
const FROST_FLATTEN = 0.5;

const EDGE_SHARE = 0.06;
const EDGE_BANDS = 32;

const DAY_PAPER: Rgb = [247, 247, 248];
const NIGHT_PAPER: Rgb = [26, 29, 37];
const DAWN_PAPER: Rgb = [242, 240, 250];

const SCENES: Scene[] = [
  { name: "day", paper: DAY_PAPER, follow: -1.8, veil: [255, 255, 255, 0.25] },
  {
    name: "night",
    paper: NIGHT_PAPER,
    follow: 1.1,
    veil: [10, 11, 14, 0.26],
    glass: { sigma: 2.3, flatten: 0.3, keepColour: true },
  },
  // Dawn's lower clouds are mid-tone lavender, so the dots keep their bright
  // tops longest (like night) and fall into a lavender-tinted paper.
  { name: "dawn", paper: DAWN_PAPER, follow: 1.1, veil: [250, 248, 255, 0.25] },
];

function run(command: string, args: string[]): void {
  const result = Bun.spawnSync([command, ...args], { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command} exited with ${result.exitCode}: ${result.stderr.toString().trim()}`);
  }
}

/** Height for `width` at the source's aspect, rounded to even (AV1 needs it). */
const evenHeight = (width: number, sourceWidth: number, sourceHeight: number) =>
  Math.round((width * sourceHeight) / sourceWidth / 2) * 2;

/** Decodes `source` scaled to width x height as packed RGB24. */
function decode(source: string, width: number, height: number, scratch: string): Buffer {
  const raw = join(scratch, "decoded.rgb");
  run("ffmpeg", [
    "-v", "error", "-y", "-i", source,
    "-vf", `scale=${width}:${height}:flags=lanczos`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", raw,
  ]);
  const pixels = readFileSync(raw);
  if (pixels.length !== width * height * 3) {
    throw new Error(`decoded ${source} to ${pixels.length} bytes, expected ${width * height * 3}`);
  }
  return pixels;
}

/** Writes an RGB24 buffer as AVIF + JPEG at each width, named `<stem>-<width>`. */
function encode(pixels: Buffer, width: number, height: number, stem: string, widths: number[], scratch: string) {
  const raw = join(scratch, `${stem}.rgb`);
  writeFileSync(raw, pixels);
  for (const outWidth of widths) {
    const outHeight = evenHeight(outWidth, width, height);
    const base = join(OUT_DIR, `${stem}-${outWidth}`);
    run("ffmpeg", [
      "-v", "error", "-y",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-i", raw,
      "-vf", `scale=${outWidth}:${outHeight}:flags=lanczos,scale=out_color_matrix=bt709:out_range=full,format=yuv420p10le`,
      "-c:v", "libsvtav1", "-svtav1-params", "tune=0:enable-variance-boost=1",
      "-crf", "22", "-preset", "2",
      "-colorspace", "bt709", "-color_primaries", "bt709",
      "-color_trc", "iec61966-2-1", "-color_range", "pc",
      "-frames:v", "1", `${base}.avif`,
    ]);
    run("magick", [
      "-size", `${width}x${height}`, "-depth", "8", `rgb:${raw}`,
      "-filter", "Lanczos", "-resize", `${outWidth}x${outHeight}!`,
      "-quality", "84", "-sampling-factor", "4:2:0", "-interlace", "Plane", "-strip",
      `${base}.jpg`,
    ]);
  }
}

/** The light of the RGB pixel starting at `at`. */
const light = (pixels: ArrayLike<number>, at: number) =>
  0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!;

const smooth = (t: number) => t * t * (3 - 2 * t);

/** A separable Gaussian over an RGB float image, clamped at its edges. */
function blur(pixels: Float32Array, width: number, height: number, sigma: number): Float32Array {
  const reach = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: reach * 2 + 1 }, (_, i) => Math.exp(-((i - reach) ** 2) / (2 * sigma * sigma)));
  const total = kernel.reduce((a, b) => a + b, 0);
  const pass = (source: Float32Array, horizontal: boolean) => {
    const target = new Float32Array(source.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let channel = 0; channel < 3; channel++) {
          let sum = 0;
          for (let k = -reach; k <= reach; k++) {
            const sx = horizontal ? Math.min(width - 1, Math.max(0, x + k)) : x;
            const sy = horizontal ? y : Math.min(height - 1, Math.max(0, y + k));
            sum += source[(sy * width + sx) * 3 + channel]! * kernel[k + reach]!;
          }
          target[(y * width + x) * 3 + channel] = sum / total;
        }
    return target;
  };
  return pass(pass(pixels, true), false);
}

/** The light at the picture's left edge, band by band down its height. */
function edgeLight(pixels: Buffer, width: number, height: number): Rgb[] {
  const reach = Math.round(width * EDGE_SHARE);
  return Array.from({ length: EDGE_BANDS }, (_, band) => {
    const top = Math.floor((band * height) / EDGE_BANDS);
    const bottom = Math.floor(((band + 1) * height) / EDGE_BANDS);
    const sum = [0, 0, 0];
    for (let y = top; y < bottom; y++)
      for (let x = 0; x < reach; x++)
        for (let channel = 0; channel < 3; channel++) sum[channel]! += pixels[(y * width + x) * 3 + channel]!;
    const count = (bottom - top) * reach;
    return sum.map((value) => Math.round(value / count)) as Rgb;
  });
}

function frost(scene: Scene, baked: Buffer, width: number, height: number, scratch: string) {
  const { sigma = 3.5, flatten = FROST_FLATTEN, keepColour = false } = scene.glass ?? {};
  const small = Math.round((FROST_WIDTH * height) / width);
  const raw = join(scratch, `${scene.name}.frost-src.rgb`);
  const shrunkRaw = join(scratch, `${scene.name}.frost-small.rgb`);
  writeFileSync(raw, baked);
  run("ffmpeg", [
    "-v", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-i", raw,
    "-vf", `scale=${FROST_WIDTH}:${small}:flags=area`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", shrunkRaw,
  ]);
  const soft = blur(Float32Array.from(readFileSync(shrunkRaw)), FROST_WIDTH, small, sigma);
  const mean = [0, 1, 2].map((channel) => {
    let sum = 0;
    for (let at = channel; at < soft.length; at += 3) sum += soft[at]!;
    return sum / (soft.length / 3);
  });
  const [vr, vg, vb, va] = scene.veil;
  const frosted = Buffer.alloc(soft.length);
  for (let at = 0; at < soft.length; at++) {
    const channel = at % 3;
    // Flattened in its light only, a pixel keeps its own colour.
    const flat = keepColour
      ? soft[at]! + (light(mean, 0) - light(soft, at - channel)) * flatten
      : soft[at]! + (mean[channel]! - soft[at]!) * flatten;
    const veiled = flat + ([vr, vg, vb][channel]! - flat) * va;
    frosted[at] = Math.min(255, Math.max(0, Math.round(veiled)));
  }
  const frostRaw = join(scratch, `${scene.name}.frost.rgb`);
  writeFileSync(frostRaw, frosted);
  run("magick", ["-size", `${FROST_WIDTH}x${small}`, "-depth", "8", `rgb:${frostRaw}`, "-strip", join(OUT_DIR, `frost-${scene.name}.png`)]);
}

/** Dissolves the sky into `paper` through a halftone screen below the horizon. */
function halftone(sky: Buffer, width: number, height: number, scene: Scene): Buffer {
  const cell = CELL * SCALE;
  const top = BAND.top * SCALE;
  const bottom = BAND.bottom * SCALE;

  // A dot to a cell: whole at the top of the band, gone at its foot, each row's
  // brighter and darker cells holding on longer or letting go sooner, so the
  // edge follows the clouds rather than a ruler.
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil((bottom - top) / cell);
  const radius = new Float32Array(columns * rows);
  // A little past a cell's corners, so the first rows close up without a seam.
  const reach = cell * 0.74;
  for (let row = 0; row < rows; row++) {
    const luma = new Float32Array(columns);
    let sum = 0;
    for (let column = 0; column < columns; column++) {
      let total = 0;
      let count = 0;
      for (let y = top + row * cell; y < Math.min(bottom, top + (row + 1) * cell); y++)
        for (let x = column * cell; x < Math.min(width, (column + 1) * cell); x++) {
          total += light(sky, (y * width + x) * 3);
          count++;
        }
      luma[column] = total / count / 255;
      sum += luma[column]!;
    }
    const mean = sum / columns;
    const t = (row + 0.5) / rows;
    const base = 1 - smooth(t);
    const lean = 4 * t * (1 - t) * scene.follow;
    for (let column = 0; column < columns; column++) {
      const cover = Math.min(1, Math.max(0, base + lean * (luma[column]! - mean)));
      radius[row * columns + column] = reach * Math.sqrt(cover);
    }
  }

  // Inside a dot is sky, outside is page, edged over one pixel; a dot larger
  // than its cell reaches its neighbours.
  const baked = Buffer.from(sky);
  for (let y = top; y < height; y++)
    for (let x = 0; x < width; x++) {
      let cover = 0;
      if (y < bottom) {
        const row = Math.floor((y - top) / cell);
        const column = Math.floor(x / cell);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const r = row + dy;
            const c = column + dx;
            if (r < 0 || r >= rows || c < 0 || c >= columns) continue;
            const reachOf = radius[r * columns + c]!;
            if (reachOf <= 0) continue;
            const cx = (c + 0.5) * cell;
            const cy = top + (r + 0.5) * cell;
            const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
            cover = Math.max(cover, Math.min(1, Math.max(0, reachOf - distance + 0.5)));
          }
        // The first row closes over the solid sky above it.
        if (y < top + cell / 2 && row === 0) cover = Math.max(cover, 1 - (y - top) / (cell / 2));
      }
      const at = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++)
        baked[at + channel] = Math.round(sky[at + channel]! * cover + scene.paper[channel]! * (1 - cover));
    }
  return baked;
}

function bake(scene: Scene, edges: Record<string, Rgb[]>) {
  const scratch = mkdtempSync(join(tmpdir(), `sky-${scene.name}-`));
  try {
    const source = join(SOURCE_DIR, `${scene.name}-source.png`);

    const plain = decode(source, WIDTH, HEIGHT, scratch);
    encode(plain, WIDTH, HEIGHT, scene.name, PLAIN_WIDTHS, scratch);

    const width = WIDTH * SCALE;
    const height = HEIGHT * SCALE;
    const baked = halftone(decode(source, width, height, scratch), width, height, scene);
    encode(baked, width, height, `${scene.name}-baked`, BAKED_WIDTHS, scratch);
    frost(scene, baked, width, height, scratch);
    edges[scene.name] = edgeLight(baked, width, height);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const edges: Record<string, Rgb[]> = {};
for (const scene of SCENES) {
  const started = performance.now();
  bake(scene, edges);
  console.log(`baked ${scene.name} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}
writeFileSync(join(OUT_DIR, "edge-light.json"), `${JSON.stringify(edges)}\n`);
