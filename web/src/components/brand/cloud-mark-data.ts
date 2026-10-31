// The Morrow mark: a cloud of dots on a squircle of desaturated sky.
// Shared by the CloudMark component and scripts/bake-icons.ts.

export const MARK_SIZE = 64;
export const MARK_RADIUS = 15;
/** Top and bottom of the squircle's sky: day blue, eased toward grey. */
export const MARK_SKY = ["#5585d2", "#93b3e4"] as const;

const PITCH = 4;
/** The cloud drawn dot by dot on a 16x16 grid: three bumps over a flat base. */
const CLOUD = [
  "................",
  "................",
  "................",
  "................",
  ".......###......",
  "......#####.....",
  "......#####.##..",
  "...##.#########.",
  "..#############.",
  "..##############",
  "..##############",
  "...############.",
  "................",
  "................",
  "................",
  "................",
];

/** The dots, each with how far down the cloud it sits (0 top, 1 base). */
export const MARK_DOTS = CLOUD.flatMap((row, r) =>
  [...row].flatMap((cell, c) =>
    cell === "#" ? [{ x: c * PITCH + PITCH / 2 - 2, y: r * PITCH + PITCH / 2, depth: (r - 4) / 7 }] : [],
  ),
);

export const DOT_RADIUS = 1.6;

/** Base of the cloud picks up a little sky, so it reads as volume. */
export const dotFill = (depth: number) =>
  `color-mix(in srgb, #ffffff ${Math.round(100 - Math.max(0, Math.min(1, depth)) * 16)}%, #cfdcf2)`;

/** The mark as a standalone SVG document, for icon files. */
export function cloudMarkSvg({ squircle = true }: { squircle?: boolean } = {}) {
  const dots = MARK_DOTS.map(
    ({ x, y, depth }) =>
      `<circle cx="${x}" cy="${y}" r="${DOT_RADIUS}" fill="${hexFill(depth)}"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${MARK_SKY[0]}"/><stop offset="1" stop-color="${MARK_SKY[1]}"/></linearGradient></defs><rect width="${MARK_SIZE}" height="${MARK_SIZE}" rx="${squircle ? MARK_RADIUS : 0}" fill="url(#s)"/>${dots}</svg>`;
}

// Icon rasterisers do not know color-mix(), so files get the mix precomputed.
function hexFill(depth: number) {
  const t = (Math.max(0, Math.min(1, depth)) * 16) / 100;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  const [r, g, b] = [mix(255, 0xcf), mix(255, 0xdc), mix(255, 0xf2)];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
