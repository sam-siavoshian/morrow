# Zephium design reference (dreamy cloud look, fonts, motion)

Port guide for the `web/` app (Next.js 16 App Router, Tailwind 4, `src/` layout). Everything here was read from source. Nothing is from memory.

**Clone root** (read-only shallow clones, referenced below as `website/...` and `Zephium/...`):
`/private/tmp/claude-501/-Users-samsiavoshian/60bb8e57-8f5c-453b-b0d6-1299ff591d77/scratchpad/repos/`

- `website/` = github.com/zephium-browser/website (the marketing site, zephium.app). **This is where the dreamy cloud hero lives.**
- `Zephium/` = github.com/zephium-browser/Zephium (the browser: Rust + Tauri shell, Svelte UI in `Zephium/frame/`). Source of the product tokens, the sky master images and the light theme.

---

## 0. TL;DR for the implementer

1. The clouds are **one still photograph** (`sky-day-source.png`, 1672x941) drawn by **one WebGL fragment shader** on a full-screen canvas. The shader adds the motion: slow fbm "breathing", pointer parallax by depth, a pointer "wake" that pushes cloud, and a **halftone-dot reveal** when it arrives/leaves. No video, no SVG clouds, no CSS-gradient clouds, no animation library. Section 3 has the full code, ready to drop in.
2. Font is **Geist Sans + Geist Mono** (variable, via the `geist` npm package, which wraps `next/font/local`). OFL-1.1, free to use. Section 2.
3. The site is **dark only** (`color-scheme: dark`, ground `#09090b`). The sky exists only in the hero, then "night falls" into graphite. Light-theme tokens exist only in the product (`Zephium/frame`). Section 4.
4. Motion is **pure CSS + requestAnimationFrame**. Two easings carry almost everything: `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)` and `--ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1)`. Section 5.
5. License: code and images are **MPL-2.0** (file-level copyleft). Fine to reuse with conditions. The **Zephium name, logo and wordmark are not licensed**. Don't copy them. Section 1.

---

## 1. Licenses: what we can legally reuse

### Repo licenses

| Repo | License | Evidence |
|---|---|---|
| website | MPL-2.0 | `website/LICENSE` (line 1: "Mozilla Public License Version 2.0"); `website/README.md` "License" section: "[MPL-2.0](LICENSE), the same license as the browser."; `website/lib/site.ts:20` `license: "MPL-2.0"` |
| Zephium | MPL-2.0 | `Zephium/LICENSE` (byte-identical to the website's, verified with `cmp`); `Zephium/README.md:267` "Zephium is licensed under the Mozilla Public License 2.0" |

Neither LICENSE carries Exhibit B ("Incompatible With Secondary Licenses"), so the code is also usable inside GPL-family Larger Works (`website/LICENSE` 3.3, lines 185-196). No per-file MPL headers exist in the source files (searched `components/` and `app/`).

### Explicit carve-outs (do NOT copy)

- `Zephium/README.md:273`: "The Zephium name and logo are not licensed under the MPL."
- `website/README.md` License section: "The Zephium name and mark identify the project; please don't use them to imply endorsement."
- `website/LICENSE` 2.3 (lines 129-130): "This License does not grant any rights in the trademarks, service marks, or logos of any Contributor".
- So skip: `website/public/brand/*`, `website/lib/wordmark.ts`, `website/components/brand.tsx`, `website/components/footer-mark.tsx`'s wordmark SVG, `Zephium/assets/brand/*`, the app icons in `website/app/*.png|ico`, and the OG images (`website/app/opengraph-image.jpg` is the film poster, branded).
- `website/public/marks/*.svg` (Claude, Figma, GitHub, Gmail, Linear, Notion, Slack, Spotify, YouTube, ChatGPT) are third-party trademarks. Not Zephium's to license. Skip.
- Product screenshots (`website/public/shots/*`, `website/public/film/*`, `website/media/*.png` other than the sky) show the Zephium product UI and brand. Skip.

### Asset licenses

| Asset | License | Notes |
|---|---|---|
| Sky images (`website/public/sky/*`, `website/media/sky-*`, `Zephium/assets/sky/*`, `Zephium/frame/src/shared/sky/assets/*`) | MPL-2.0 by inclusion (no separate asset license or attribution file anywhere) | `website/media/sky-day-source.png` and `Zephium/assets/sky/day-source.png` are the same file (identical SHA-1 `8dccd3ee...`). **No provenance statement found** for the photo (no credit, no stock-site mention, no NOTICE). Searched READMEs, `docs/`, `bake-sky.mjs`, sky folders. Only third-party asset notice in the repo is the EasyList CC BY-SA 3.0 for the ad blocker (`Zephium/README.md:269-271`). |
| Geist Sans / Geist Mono fonts | SIL Open Font License 1.1 | `geist@1.7.2` tarball `package/LICENSE.txt`: "This Font Software is licensed under the SIL Open Font License, Version 1.1." npm registry `license`: "SIL OPEN FONT LICENSE". Free to use, embed and ship. |
| Hugeicons free set (`@hugeicons/core-free-icons`, `@hugeicons/react`) | MIT | npm registry metadata for both packages. |
| simple-icons | CC0-1.0 | npm registry metadata. (Brand logos themselves are still trademarks.) |

### Verdict

- **Fonts: yes, freely.** Install `geist` from npm. OFL. No obligations beyond not selling the font files on their own.
- **Code (CSS, shader, React components): yes, under MPL-2.0 conditions.** MPL is file-level copyleft. Any file we copy or adapt from these repos stays MPL-2.0. Our own files stay ours (3.3 Larger Work). Since a web app ships JS/CSS to browsers (Executable Form), 3.2(a) (lines 170-183) requires that the MPL files' source be available and that recipients are told where. Practical compliance: keep ported code in its own files (e.g. `src/components/sky/clouds.tsx`, `src/styles/zephium-tokens.css`), put the Exhibit A header at the top of each, and link the source (our public repo, or the upstream file) from a credits/licenses page.
  ```
  /* This Source Code Form is subject to the terms of the Mozilla Public
   * License, v. 2.0. If a copy of the MPL was not distributed with this
   * file, You can obtain one at https://mozilla.org/MPL/2.0/.
   * Adapted from github.com/zephium-browser/website (components/scene/clouds.tsx). */
  ```
  Design values (a hex code, a cubic-bezier, "radius 14px") are not really copyrightable; the obligation bites on copied code files.
- **Sky images: yes under MPL as shipped in the repo, but provenance is unknown.** Risk note for a hackathon: low. Risk note for a real launch: the photo has no stated source, so swap in our own sky (any 16:9 photo of blue sky with a low bright cloud bank works with the same shader) before production.
- **Brand: no.** Never use the Zephium name, logo, wordmark, or icons.

---

## 2. Fonts

### Website (the look we want)

Loaded with the `geist` package, which is a thin `next/font/local` wrapper:

`website/app/layout.tsx:2-3, 63`
```tsx
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
...
<html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
```

What the package does (`geist@1.7.2`, `package/dist/sans.js` and `package/dist/mono.js`, read from the npm tarball):
```js
export const GeistSans = localFont({
  src: "./fonts/geist-sans/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

export const GeistMono = localFont({
  src: "./fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  adjustFontFallback: false,
  fallback: ["ui-monospace","SFMono-Regular","Roboto Mono","Menlo","Monaco","Liberation Mono","DejaVu Sans Mono","Courier New","monospace"],
  weight: "100 900",
});
```
Files: one variable `woff2` each (100 to 900). Self-hosted by Next, no Google Fonts request. Website pins `geist ^1.7.2` (`website/package.json`); latest on npm is 1.8.2.

Font stacks (`website/app/globals.css:41-44`):
```css
--font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
--font-mono: var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, monospace;
--font-system: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text",
  "Segoe UI", system-ui, sans-serif;
```

Body (`website/app/globals.css:74-85`): Geist Sans 16px / 1.5, antialiased, `text-rendering: optimizeLegibility`, `font-feature-settings: "ss01", "cv11";`.

Where each face is used:
- **Geist Sans**: everything on the marketing page: headings, body, nav, buttons.
- **Geist Mono**: code-ish data only. `download.module.css`, `docs.module.css` (x2), `browser-cards.module.css` (x3, e.g. the blocked-hosts list, `.hosts li { font-family: var(--font-mono); font-size: 12px; }`).
- **`--font-system`** (SF / Segoe): only inside the fake product window mockups (`product-window.module.css`, `new-tab.module.css`, `tab-pages.module.css`, `studio-page.module.css`, `work/canvas.module.css`, `work/live-pages.module.css`), to mimic the native app.

Weights actually used across `website/app` + `website/components` (count of declarations): 600 x82, 500 x32, **550 x30**, **450 x10**, 700 x9, 650 x2, 400 x2, 750 x1. Note the in-between weights (450, 550, 650): only possible because Geist is variable. Pattern: headings 600, buttons/labels 550, nav links 450, body 400 default.

### Product (for contrast, not to copy)

`Zephium/frame/src/styles/tokens.css:433-436` uses **no webfont**, only the platform face:
```css
--font-sans: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI Variable Text", "Segoe UI", "Noto Sans", "Cantarell", sans-serif;
--font-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Menlo", "Consolas", monospace;
```
(Comment at lines 428-432: native menus open in SF, so a webfont would "change typeface under the user's cursor".) Product type scale at lines 438-459: caption 11, label 12, body 13, page-title 14, title 22, display 36, headline 26, reading 15px.

### Display type scale (website)

`website/app/globals.css:46-54`
```css
--text-display: clamp(2.5rem, 1.1rem + 3.6vw, 4.5rem);   /* lh 1,    ls -0.045em */
--text-headline: clamp(2rem, 1.2rem + 2.6vw, 3.5rem);    /* lh 1.04, ls -0.035em */
--text-lede: clamp(1.0625rem, 0.95rem + 0.35vw, 1.25rem); /* lh 1.5,  ls -0.011em */
```
Hero title is bigger than the token: `clamp(2.5rem, 1rem + 3.7vw, 4.8rem)`, weight 600, line-height 0.98, letter-spacing -0.05em (`website/components/scene/scene.module.css:154-162`). Tight negative tracking everywhere is a big part of the look.

**Port:** `bun add geist`, then the exact `layout.tsx` lines above. Done.

---

## 3. The dreamy cloud sky

### How it is made

`website/components/scene/clouds.tsx` (447 lines) + `clouds.module.css` (34 lines). Mounted in `website/components/scene/scene.tsx:180` as `<Clouds className={styles.sky} />` inside a sticky full-viewport stage.

- **Input:** a single photo, `/sky/day-1672.avif` (desktop) or `/sky/day-900.avif` (width < 900px), JPEG fallback (`clouds.tsx:399-401`). Blue sky above, bright cumulus bank in the lower third, framed left and right.
- **Renderer:** WebGL1, one full-screen triangle (`[-1,-1, 3,-1, -1,3]`), context `{ alpha: false, antialias: false, powerPreference: "low-power" }` (`clouds.tsx:207, 221`).
- **Shader effects** (fragment shader `FRAG`, `clouds.tsx:30-158`):
  - `cover()`: object-fit cover, anchored at (0.5, 0.66) so the cloud bank stays low, scaled up 7% (`/ 1.07`) so parallax never shows an edge.
  - `cloudOf()`: classifies each pixel as cloud (bright, unsaturated) vs sky. Used as **depth**: cloud = near (moves more), open blue = far.
  - **Breathing**: 3-octave fbm value noise displaces UVs (`current * 0.011 * depth`) plus a slow sine sway (`sin(t*0.045)*0.004`).
  - **Pointer lean**: parallax `uv -= u_lean * vec2(0.014, 0.009) * depth`, eased in JS with `1 - exp(-dt * 2.4)`.
  - **Pointer wake**: last 10 pointer steps (position + velocity, 1.4s life, smoothstep fade) push UVs with a Gaussian falloff, and add "a breath of light" on cloud the pointer crosses.
  - **Halftone arrival/exit**: 7px (x DPR) cell dot screen. On load each dot grows from 0 to solid over 1.9s (ease-out cubic), bright cloud first. On scroll exit the sky dissolves bottom-up into `--color-ground` through the same dots.
  - **Anti-banding**: +/-1 LSB animated noise (`(hash - 0.5) * 2/255`).
- **Performance:** DPR capped at 1.5 (x0.85 on narrow), auto-drops resolution to 0.6 if frames run long, renders every other frame when idle, stops when offscreen/hidden/fully exited, honours `prefers-reduced-motion` (time frozen, no pointer listener), pointer listener only on `(pointer: fine)`.
- **Fallback:** if WebGL or the image fails, `data-flat` is set and CSS shows the photo as a plain `background-image` with a 1.2s fade-in (`clouds.module.css:11-27`).
- **Coupling to the page:** reads `--exit` (0..1) from its parent's inline style (`clouds.tsx:280`) and sets `stage.dataset.sky = "live"` on the parent (`clouds.tsx:414`). If the parent never sets `--exit`, it reads as 0 and the sky simply stays. So the component works standalone.

### Full source, ready to drop in

**Destination:** `web/src/components/sky/clouds.tsx`. Copied verbatim from `website/components/scene/clouds.tsx`. Only the import path of the CSS module needs to match where you put it. It depends on two CSS variables from section 4: `--color-ground` and `--ease-out`. If you change the page ground colour, also change `GROUND` (line "const GROUND") to the same RGB.

```tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * From github.com/zephium-browser/website components/scene/clouds.tsx */
"use client";

import { useEffect, useRef } from "react";
import styles from "./clouds.module.css";

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/** Steps of the pointer's wake the shader remembers. */
const WAKE = 10;

const FRAG = `
precision highp float;

uniform sampler2D u_img;
uniform vec2 u_res;
uniform vec2 u_img_size;
uniform float u_dpr;
uniform float u_time;
uniform vec2 u_lean;
uniform vec4 u_wake[${WAKE}];
uniform float u_develop;
uniform float u_exit;
uniform float u_dither;
uniform vec3 u_ground;

const mat2 R = mat2(0.8, 0.6, -0.6, 0.8);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.31, 289.17))) * 26737.367);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * noise(p);
    p = R * p * 2.07 + 11.3;
    amp *= 0.5;
  }
  return sum;
}

// The screen (0..1, y down) onto the picture, covering it, a little larger
// than the screen so leaning never shows an edge. The bank stays low.
vec2 cover(vec2 s) {
  float a = u_res.x / u_res.y;
  float A = u_img_size.x / u_img_size.y;
  vec2 ratio = vec2(min(a / A, 1.0), min(A / a, 1.0));
  vec2 anchor = vec2(0.5, 0.66);
  return (s - anchor) * ratio / 1.07 + anchor;
}

// How much a colour is cloud rather than sky: bright and unsaturated.
float cloudOf(vec3 c) {
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  return smoothstep(0.55, 0.92, lum) * (1.0 - smoothstep(0.12, 0.42, sat));
}

vec3 sky(vec2 s) {
  vec2 uv = cover(s);
  // Near is low and cloudy; the open blue is far.
  float depth = mix(0.22, 1.0, cloudOf(texture2D(u_img, uv).rgb)) * mix(0.55, 1.0, s.y);

  // The pointer's wake: each recent step pushes the air it passed through.
  float a = u_res.x / u_res.y;
  vec2 push = vec2(0.0);
  for (int i = 0; i < ${WAKE}; i++) {
    vec4 w = u_wake[i];
    vec2 d = (s - w.xy) * vec2(a, 1.0);
    push += w.zw * exp(-dot(d, d) * 26.0);
  }

  float t = u_time;
  vec2 q = uv * vec2(3.2, 5.0);
  vec2 current = vec2(fbm(q + vec2(t * 0.022, 0.0)), fbm(q + vec2(7.3, -t * 0.018))) - 0.5;

  uv += current * 0.011 * depth;
  uv.x += sin(t * 0.045) * 0.004 * depth;
  uv -= u_lean * vec2(0.014, 0.009) * depth;
  uv -= push * 0.055 * depth;
  vec3 c = texture2D(u_img, uv).rgb;

  // A breath of light on the cloud the pointer passes through.
  return c + cloudOf(c) * min(length(push), 0.3) * 0.35;
}

// How much of the sky a halftone cell keeps, 0..1. Arriving, the bright
// cloud comes first and the blue after; leaving, the sky goes from the
// bottom up, the cloud holding on longest.
float coverage(vec2 centre, float lum) {
  vec2 cell = floor(centre / (7.0 * u_dpr));
  float grain = hash(cell) * 0.35 + noise(cell * 0.09) * 0.45;
  float arrive = clamp(u_develop * 2.35 - grain - (1.0 - lum) * 0.5, 0.0, 1.0);
  float rise = 1.0 - centre.y / u_res.y + (lum - 0.6) * 0.18 + (grain - 0.4) * 0.12;
  float front = u_exit * 2.0 - 0.6;
  return min(arrive, smoothstep(front, front + 0.38, rise));
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec3 col = sky(frag / u_res);

  if (u_dither > 0.5) {
    // A dot per cell, its radius from the sky's tone at the cell,
    // overlapping its neighbours as it grows to solid.
    float size = 7.0 * u_dpr;
    vec2 cell = floor(frag / size);
    float shown = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 centre = (cell + vec2(float(x), float(y)) + 0.5) * size;
        vec3 tone = texture2D(u_img, cover(centre / u_res)).rgb;
        float lum = dot(tone, vec3(0.299, 0.587, 0.114));
        float r = size * 0.74 * sqrt(coverage(centre, lum));
        shown = max(shown, clamp(r - length(frag - centre) + 0.5, 0.0, 1.0));
      }
    }
    col = mix(u_ground, col, shown);
  }

  // A whisper of grain, so the gradients never band.
  col += (hash(frag + fract(u_time) * 61.0) - 0.5) * (2.0 / 255.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** The page the sky dissolves into (--color-ground). */
const GROUND = [9 / 255, 9 / 255, 11 / 255];

/** Seconds the sky takes to arrive. */
const ARRIVAL = 1.9;

/** How long a step of the pointer's wake lasts, in seconds. */
const WAKE_LIFE = 1.4;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function picture(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

const easeOut = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

export function Clouds({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = ref.current;
    const canvas = canvasRef.current;
    // The scene writes its progress (--exit) on the stage; the sky reads it there.
    const stage = root?.parentElement;
    if (!root || !canvas || !stage) return;
    const flat = () => {
      root.dataset.flat = "";
    };

    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
    const vert = gl && compile(gl, gl.VERTEX_SHADER, VERT);
    const frag = gl && compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl?.createProgram();
    if (!gl || !vert || !frag || !program) return flat();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.bindAttribLocation(program, 0, "a_pos");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return flat();
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const at = (name: string) => gl.getUniformLocation(program, name);
    const u = {
      res: at("u_res"),
      size: at("u_img_size"),
      dpr: at("u_dpr"),
      time: at("u_time"),
      lean: at("u_lean"),
      wake: at("u_wake"),
      develop: at("u_develop"),
      exit: at("u_exit"),
      dither: at("u_dither"),
    };
    gl.uniform3fv(at("u_ground"), GROUND);
    gl.uniform1i(at("u_img"), 0);

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fine = window.matchMedia("(pointer: fine)").matches;
    const narrow = window.innerWidth < 900;

    // Soft shapes need few pixels: at most one and a half per CSS pixel, and
    // fewer if the device cannot keep up.
    let ratio = Math.min(window.devicePixelRatio || 1, 1.5) * (narrow ? 0.85 : 1);
    const size = () => {
      const box = root.getBoundingClientRect();
      const width = Math.max(1, Math.round(box.width * ratio));
      const height = Math.max(1, Math.round(box.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.uniform2f(u.res, width, height);
      gl.uniform1f(u.dpr, ratio);
    };

    let ready = false;
    let alive = true;
    let visible = true;
    let born = 0;
    let frame = 0;
    let last = 0;
    let frames = 0;
    let slow = 0;
    let tick = 0;
    let drawnExit = -1;

    const aim = { x: 0, y: 0 };
    const lean = { x: 0, y: 0 };
    // The wake: recent steps of the pointer, as position and velocity.
    const wake = new Float32Array(WAKE * 4);
    const pace = new Float32Array(WAKE * 2);
    const ages = new Float32Array(WAKE).fill(WAKE_LIFE);
    let next = 0;
    let pointer: { x: number; y: number; t: number } | null = null;

    const readExit = () => Number.parseFloat(stage.style.getPropertyValue("--exit")) || 0;

    const draw = (time: number) => {
      frame = 0;
      if (!alive || !ready) return;
      const dt = last ? Math.min(0.05, (time - last) / 1000) : 1 / 60;
      last = time;
      if (!born) born = time;
      const age = (time - born) / 1000;

      lean.x += (aim.x - lean.x) * (1 - Math.exp(-dt * 2.4));
      lean.y += (aim.y - lean.y) * (1 - Math.exp(-dt * 2.4));
      let stirring = false;
      for (let i = 0; i < WAKE; i++) {
        ages[i] += dt;
        const life = Math.max(0, 1 - ages[i] / WAKE_LIFE);
        const fade = life * life * (3 - 2 * life);
        wake[i * 4 + 2] = pace[i * 2] * fade;
        wake[i * 4 + 3] = pace[i * 2 + 1] * fade;
        if (life > 0) stirring = true;
      }

      const exit = readExit();
      const develop = still ? 1 : easeOut(age / ARRIVAL);
      const settling = Math.abs(aim.x - lean.x) + Math.abs(aim.y - lean.y) > 0.001;
      const gone = exit > 0.999;
      // While nothing but the slow current moves, every other frame is
      // enough; the pointer, the scroll and the arrival get every frame.
      const busy = develop < 1 || stirring || settling || Math.abs(exit - drawnExit) > 0.0005;
      tick += 1;
      if (!busy && tick % 2 === 1) {
        if (visible && !still && !gone) frame = requestAnimationFrame(draw);
        return;
      }
      gl.uniform1f(u.time, still ? 0 : age + 40);
      gl.uniform2f(u.lean, lean.x, lean.y);
      gl.uniform4fv(u.wake, wake);
      gl.uniform1f(u.develop, develop);
      gl.uniform1f(u.exit, exit);
      gl.uniform1f(u.dither, develop < 1 || exit > 0.001 ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawnExit = exit;

      // If frames run long, draw fewer pixels; the clouds are soft anyway.
      frames += 1;
      if (dt > (busy ? 1 / 40 : 1 / 20)) slow += 1;
      if (frames === 90) {
        if (slow > 30 && ratio > 0.6) {
          ratio = Math.max(0.6, ratio * 0.75);
          size();
        }
        frames = 0;
        slow = 0;
      }

      const moving = !still && !gone;
      if (visible && (moving || develop < 1 || ((stirring || settling) && !gone))) {
        frame = requestAnimationFrame(draw);
      }
    };
    const wakeUp = () => {
      if (!frame && visible && ready && alive) {
        last = 0;
        frame = requestAnimationFrame(draw);
      }
    };

    // Once the sky is gone (or with reduced motion) it redraws only when the
    // scene moves it.
    const onScroll = () => {
      if (Math.abs(readExit() - drawnExit) > 0.0005) wakeUp();
    };

    const move = (event: PointerEvent) => {
      const box = root.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width;
      const y = (event.clientY - box.top) / box.height;
      aim.x = x * 2 - 1;
      aim.y = y * 2 - 1;
      const now = event.timeStamp;
      if (pointer && now > pointer.t) {
        const dt = Math.max(0.008, (now - pointer.t) / 1000);
        // A step is kept once the pointer has moved a little, so the wake is
        // spread along its path rather than heaped where it rests.
        const prev = (next + WAKE - 1) % WAKE;
        const dx = x - wake[prev * 4];
        const dy = y - wake[prev * 4 + 1];
        if (dx * dx + dy * dy > 0.0004 || ages[prev] > 0.12) {
          wake[next * 4] = x;
          wake[next * 4 + 1] = y;
          pace[next * 2] = Math.max(-2.5, Math.min(2.5, (x - pointer.x) / dt)) * 0.12;
          pace[next * 2 + 1] = Math.max(-2.5, Math.min(2.5, (y - pointer.y) / dt)) * 0.12;
          ages[next] = 0;
          next = (next + 1) % WAKE;
        }
      }
      pointer = { x, y, t: now };
      wakeUp();
    };

    // Resizing clears the canvas, so the sky is drawn again at once, in the
    // same frame, rather than showing a blank one.
    const resize = new ResizeObserver(() => {
      size();
      if (!ready) return;
      cancelAnimationFrame(frame);
      frame = 0;
      draw(performance.now());
    });
    const sight = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting) && !document.hidden;
      wakeUp();
    });
    const onVisibility = () => {
      visible = !document.hidden && root.getBoundingClientRect().bottom > 0;
      wakeUp();
    };

    const texture = gl.createTexture();
    const source = narrow ? "/sky/day-900" : "/sky/day-1672";
    picture(`${source}.avif`)
      .catch(() => picture(`${source}.jpg`))
      .then((image) => {
        if (!alive) return;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
        gl.uniform2f(u.size, image.naturalWidth, image.naturalHeight);
        size();
        ready = true;
        stage.dataset.sky = "live";
        wakeUp();
      })
      .catch(flat);

    resize.observe(root);
    sight.observe(root);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("scroll", onScroll, { passive: true });
    if (fine && !still) window.addEventListener("pointermove", move, { passive: true });

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      resize.disconnect();
      sight.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", move);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      delete stage.dataset.sky;
    };
  }, []);

  return (
    <div ref={ref} className={`${styles.sky} ${className ?? ""}`} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
```

(Only change from upstream: the MPL header and a shortened header comment. Upstream's opening prose comment, lines 6-18, is dropped; the shader and logic are byte-for-byte.)

**`web/src/components/sky/clouds.module.css`** (verbatim, `website/components/scene/clouds.module.css`):
```css
.sky {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--color-ground);
}

.sky[data-flat] {
  background: var(--color-ground) url("/sky/day-1672.jpg") 50% 66% / cover no-repeat;
  background-image: image-set(url("/sky/day-1672.avif") type("image/avif"), url("/sky/day-1672.jpg") type("image/jpeg"));
  animation: arrive 1.2s var(--ease-out) backwards;
}

@media (max-width: 899px) {
  .sky[data-flat] {
    background-image: image-set(url("/sky/day-900.avif") type("image/avif"), url("/sky/day-900.jpg") type("image/jpeg"));
  }
}

@keyframes arrive {
  from {
    opacity: 0;
  }
}

.canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
```

### Minimal host (how the hero stacks it)

From `website/components/scene/scene.module.css:7-49, 66-74`:
```css
.stage { position: sticky; top: 0; height: 100svh; overflow: hidden; isolation: isolate; --exit: 0; }
.sky   { position: absolute; inset: 0; z-index: -2; }

/* Fallback "night falls" fade when WebGL is off; hidden while the shader runs */
.dusk {
  position: absolute; inset: 0; z-index: -1;
  background: linear-gradient(180deg, var(--color-ground) 0%, var(--color-ground) 50%, rgb(9 9 11 / 0.85) 100%);
  opacity: var(--exit);
  pointer-events: none;
}
.stage[data-sky="live"] .dusk { display: none; }

/* A soft shade of deeper sky behind the hero words, so white text holds over any cloud */
.copy::before {
  content: ""; position: absolute; inset: -12% -8% -18%; z-index: -1;
  background: radial-gradient(closest-side, rgb(18 58 108 / 0.22), rgb(18 58 108 / 0.08) 60%, transparent);
  pointer-events: none;
}
```
To get the "sky dissolves into the dark page" exit on scroll, write `--exit` (0..1) on the Clouds' parent element as an inline style. The site computes it in `scene.tsx:132-138` from scroll position (`(screens - exitFrom) / SCROLL.exit`) and smooths it with `now.exit += (goal.exit - now.exit) * (1 - Math.exp(-dt * 9))` (`scene.tsx:115`). For a non-scrolling app shell (our dashboard), skip `--exit` entirely and the sky stays.

Nav over the sky goes transparent: the scene toggles `data-sky` on `<html>` while `exit < 0.3` (`scene.tsx:139-143`), and the nav CSS keys off `:root[data-sky]` (section 7).

### Variants that do not need WebGL

- **"Desk" card**: a piece of sky inset in a dark card, zoomed 2.2x around a focal point (`website/components/sections/browser.module.css:74-97`):
  ```css
  .visual[data-desk] { position: relative; isolation: isolate; overflow: hidden; margin: 8px 8px 0; padding: clamp(28px, 3.4vw, 48px) clamp(16px, 3vw, 40px); border-radius: 21px; }
  .visual[data-desk]::before {
    content: ""; position: absolute; inset: 0; z-index: -1;
    background:
      linear-gradient(rgb(14 30 58 / 0.12), rgb(14 30 58 / 0.12)),
      image-set(url("/sky/day-900.avif") 1x type("image/avif"), url("/sky/day-1672.avif") 2x type("image/avif"), url("/sky/day-900.jpg") 1x type("image/jpeg"), url("/sky/day-1672.jpg") 2x type("image/jpeg")) var(--at, 50% 50%) / cover no-repeat;
    transform: scale(2.2);
    transform-origin: var(--at, 50% 50%);
    pointer-events: none;
  }
  ```
  Set `style={{"--at": "30% 70%"}}` per card to pick which bit of sky shows.
- **Night sky** (`/sky/night-*.jpg|avif`): pre-baked in the product by `Zephium/frame/scripts/bake-sky.mjs` with the halftone dissolve already printed into the bottom (7px cells, band y 486..889 of the 1672x941 source; page colour `[26, 29, 37]` = `#1a1d25`). Use as a static `<img>` hero for a dark/night mode. Placement used on the site's new-tab mockup (`website/components/scene/new-tab.module.css:6-31`): horizon at 60% of the box, image width `max(100cqw, 154.5cqh)`, `top: calc(var(--horizon) - var(--sw) * 0.3883)`.
- **Frost** (`Zephium/frame/src/shared/sky/assets/frost-day.png`, `frost-night.png`, 192x108): the sky pre-blurred tiny; stretched over a panel it *is* the frosted glass, zero runtime blur cost (`bake-sky.mjs:30-35`, `scenes.ts` `FROSTS`). Good cheap glass background for sidebars.

---

## 4. Color tokens

### Website tokens (Tailwind 4 `@theme`), ready to paste

Verbatim from `website/app/globals.css:9-66`. Put in `web/src/app/globals.css` after `@import "tailwindcss";`.

> Recommendation: drop the two `initial` reset lines (`--color-*: initial;` and `--radius-*: initial;`) for the hackathon. Upstream uses them to delete Tailwind's whole default palette and radius scale so markup can only use named tokens. That's strict and nice, but it will break any shadcn/default Tailwind class we pull in (`bg-red-500`, `rounded-lg`).

```css
@theme {
  --color-*: initial;            /* optional, see note above */
  --color-ink: #050506;
  --color-ground: #09090b;       /* page background */
  --color-plate: #111113;        /* card plate */
  --color-surface: #18181b;
  --color-raised: #212125;
  --color-line: rgb(255 255 255 / 0.07);
  --color-line-strong: rgb(255 255 255 / 0.12);
  --color-text: #f4f4f6;
  --color-muted: rgb(244 244 246 / 0.64);
  --color-faint: rgb(244 244 246 / 0.42);
  --color-lit: #ededf0;          /* the "on" / primary fill; no accent hue */
  --color-on-lit: #111113;
  --color-sheen: #c9d6ff;
  --color-lilac: #b7a6f0;
  --color-sky: #8db9f2;
  --color-mint: #88d0b3;
  --color-lemon: #e6cb80;
  --color-peach: #efaa89;
  --color-rose: #ee9aae;
  --color-transparent: transparent;
  --color-current: currentColor;

  --radius-*: initial;           /* optional, see note above */
  --radius-inset: 8px;
  --radius-row: 12px;
  --radius-control: 14px;
  --radius-card: 20px;
  --radius-panel: 28px;
  --radius-capsule: 999px;

  --font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, monospace;
  --font-system: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text",
    "Segoe UI", system-ui, sans-serif;

  --text-display: clamp(2.5rem, 1.1rem + 3.6vw, 4.5rem);
  --text-display--line-height: 1;
  --text-display--letter-spacing: -0.045em;
  --text-headline: clamp(2rem, 1.2rem + 2.6vw, 3.5rem);
  --text-headline--line-height: 1.04;
  --text-headline--letter-spacing: -0.035em;
  --text-lede: clamp(1.0625rem, 0.95rem + 0.35vw, 1.25rem);
  --text-lede--line-height: 1.5;
  --text-lede--letter-spacing: -0.011em;

  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
}

:root {
  color-scheme: dark;
  --gutter: clamp(20px, 4vw, 40px);
  --content: 1200px;
  --nav-height: 64px;
}

html { background: var(--color-ground); -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }

body {
  min-height: 100svh;
  background: var(--color-ground);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  font-feature-settings: "ss01", "cv11";
}

::selection { background: rgb(201 214 255 / 0.28); color: var(--color-text); }
:focus-visible { outline: 2px solid rgb(255 255 255 / 0.6); outline-offset: 3px; }

@utility container-page {
  width: 100%;
  max-width: calc(var(--content) + var(--gutter) * 2);
  margin-inline: auto;
  padding-inline: var(--gutter);
}

/* Two-tone headlines: the second clause steps back a rung. */
@utility text-quiet { color: rgb(244 244 246 / 0.5); }
```
Viewport meta: `themeColor: "#09090b"`, `colorScheme: "dark"` (`website/app/layout.tsx:40-43`).

**Sky-scene colours (hard-coded in `scene.module.css`, not tokens):**
- Text on sky: `#fff`; lede `rgb(255 255 255 / 0.9)`.
- Headline gradient line 1: `linear-gradient(180deg, #fff 20%, #eef5fd 100%)`; line 2: `linear-gradient(180deg, #e2eefb 0%, #b4cfee 100%)` (mobile line 2: `#eef5fd 0%, #cfe2f7 100%`) (`scene.module.css:173-179, 430-432`).
- Text shadows tinted sky-navy: `drop-shadow(0 2px 28px rgb(20 60 110 / 0.22))` on the title, `text-shadow: 0 1px 24px rgb(20 60 110 / 0.35)` on the lede.
- Primary button ink on white: `#0b1f36`; hover fill `#eef4fb`.
- "Zero" counter gradient: `linear-gradient(180deg, #fff 18%, #dfe9fb 62%, #9fbde8 100%)` (`privacy.module.css`).

### Product tokens (dark base + light theme)

Source `Zephium/frame/src/styles/tokens.css` (788 lines, `@theme static`, dark base, `[data-theme="light"]` override) and `tokens/primitive.css`, `tokens/sky.css`. Use these for the **app shell** (dashboard, chat, sidebar), where the marketing tokens are too sparse. Core subset, ready to paste:

```css
/* ---- Product: dark (base) ---- */
:root {
  --color-canvas: #1a1a1d;
  --color-page: #1a1a1d;
  --color-chrome: #1f1f22;
  --color-surface: #26262a;
  --color-raised: #2c2c30;
  --color-float: #3d3d44;
  --wash-raised: 62%;
  --color-menu: color-mix(in srgb, var(--color-float) var(--wash-raised), transparent);
  --color-menu-separator: rgb(255 255 255 / 0.1);

  --color-fill: rgb(255 255 255 / 0.05);
  --color-fill-hover: rgb(255 255 255 / 0.08);
  --color-fill-active: rgb(255 255 255 / 0.12);
  --color-fill-pressed: rgb(255 255 255 / 0.16);
  --color-fill-strong: rgb(255 255 255 / 0.22);
  --color-card: rgb(255 255 255 / 0.05);
  --color-border: rgb(255 255 255 / 0.07);
  --color-border-strong: rgb(255 255 255 / 0.13);

  --row-hover: rgb(255 255 255 / 0.04);
  --row-active: rgb(255 255 255 / 0.075);
  --row-pressed: rgb(255 255 255 / 0.1);
  --row-rim: inset 0 0 0 1px rgb(255 255 255 / 0.06);
  --scroll-thumb: rgb(255 255 255 / 0.16);
  --scroll-thumb-hover: rgb(255 255 255 / 0.28);

  --color-text: #f4f4f6;
  --color-label-secondary: #d8d8db;
  --color-muted: rgb(244 244 246 / 0.68);
  --color-faint: rgb(244 244 246 / 0.44);

  --color-control: rgb(255 255 255 / 0.09);
  --color-control-hover: rgb(255 255 255 / 0.13);
  --color-control-pressed: rgb(255 255 255 / 0.17);
  --color-field: rgb(255 255 255 / 0.09);
  --color-field-hover: rgb(255 255 255 / 0.12);
  --color-field-ring: rgb(255 255 255 / 0.16);

  --color-lit: #ededf0;
  --color-lit-hover: #f7f7fa;
  --color-on-lit: #161619;
  --color-lit-soft: rgb(237 237 240 / 0.16);
  --color-ring: rgb(255 255 255 / 0.5);

  --color-danger: #ef8a8e;
  --color-success: #7fcaa1;
  --color-warning: #dcb977;
  --color-info: #8fbcf7;

  /* six soft hues, used for agents and user-marked things */
  --color-soft-sky: #8db9f2;
  --color-soft-mint: #88d0b3;
  --color-soft-lemon: #e6cb80;
  --color-soft-peach: #efaa89;
  --color-soft-rose: #ee9aae;
  --color-soft-lilac: #b7a6f0;
  --soft-wash: 15%;
  --soft-edge: 26%;
  --soft-ink: 62%;
  /* recipe per hue (repeat for each): */
  --color-soft-sky-wash: color-mix(in oklab, var(--color-soft-sky) var(--soft-wash), var(--color-surface));
  --color-soft-sky-edge: color-mix(in oklab, var(--color-soft-sky) var(--soft-edge), transparent);
  --color-soft-sky-ink: color-mix(in oklab, var(--color-soft-sky) var(--soft-ink), var(--color-text));

  /* agent characters */
  --color-agent-lead: #ecebf4;
  --color-agent-lead-sheen: #c9d6ff;
  --color-agent-browser: var(--color-soft-sky);
  --color-agent-research: var(--color-soft-lemon);
  --color-agent-computer: var(--color-soft-mint);
  --color-agent-connection: var(--color-soft-lilac);

  /* chart ladder */
  --chart-1: #6193db; --chart-2: #b37046; --chart-3: #2da58f; --chart-4: #a47d00;
  --chart-5: #b77094; --chart-6: #679936; --chart-7: #7e68ab; --chart-8: #c6685b;

  /* shadows: one soft drop + a hairline rim, never stacked */
  --shadow-raised: 0 1px 2px rgb(0 0 0 / 0.16), 0 0 0 0.5px rgb(255 255 255 / 0.06);
  --shadow-float: 0 6px 22px rgb(0 0 0 / 0.34), 0 0 0 0.5px rgb(255 255 255 / 0.08);
  --shadow-overlay: 0 12px 36px rgb(0 0 0 / 0.3), 0 0 0 0.5px rgb(255 255 255 / 0.08);
  --shadow-menu: 0 0 0 1px rgb(255 255 255 / 0.08), 0 14px 44px -10px rgb(0 0 0 / 0.34);
  --shadow-sheet: 0 -10px 40px -20px rgb(0 0 0 / 0.4);
  --shadow-badge: 0 0 0 0.5px var(--color-border-strong), 0 1px 3px rgb(0 0 0 / 0.18);
  --shadow-field-focus: inset 0 0 0 1px var(--color-field-ring);
  --shine: inset 0 1px 0 0 rgb(255 255 255 / 0.13), inset 0 -1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 1px rgb(255 255 255 / 0.05);
  --shine-top: inset 0 1px 0 0 rgb(255 255 255 / 0.1);

  /* product radii (slightly tighter than the site's) */
  --radius-swatch: 3px;
  --radius-inset: 8px;
  --radius-row: 12px;
  --radius-control-compact: 10px;
  --radius-control: 14px;
  --radius-control-large: 18px;
  --radius-card: 18px;
  --radius-panel: 22px;
  --radius-capsule: 999px;

  /* masks */
  --mask-fade-end: linear-gradient(to right, #000 calc(100% - 26px), transparent);
  --mask-fade-bottom: linear-gradient(to bottom, #000 78%, transparent);
}

/* ---- Product: light ---- */
[data-theme="light"] {
  --color-page: #f1f1f3;
  --color-canvas: #f1f1f3;
  --color-chrome: #e6e6e9;
  --color-surface: #fff;
  --color-raised: #fff;
  --color-float: #fff;
  --color-menu-separator: rgb(24 24 27 / 0.09);
  --color-fill: rgb(24 24 27 / 0.05);
  --color-fill-hover: rgb(24 24 27 / 0.08);
  --color-fill-active: rgb(24 24 27 / 0.075);
  --color-fill-pressed: rgb(24 24 27 / 0.11);
  --color-fill-strong: rgb(24 24 27 / 0.16);
  --color-card: rgb(255 255 255 / 0.92);
  --color-border: rgb(24 24 27 / 0.07);
  --color-border-strong: rgb(24 24 27 / 0.13);
  --row-hover: rgb(24 24 27 / 0.04);
  --row-active: rgb(24 24 27 / 0.075);
  --row-pressed: rgb(24 24 27 / 0.1);
  --row-rim: inset 0 0 0 1px rgb(24 24 27 / 0.03);
  --scroll-thumb: rgb(24 24 27 / 0.2);
  --scroll-thumb-hover: rgb(24 24 27 / 0.34);
  --color-text: #1c1c1f;
  --color-label-secondary: #55555c;
  --color-muted: rgb(28 28 31 / 0.62);
  --color-faint: rgb(28 28 31 / 0.42);
  --color-control: #ffffff;
  --color-control-hover: #f9f9f9;
  --color-control-pressed: #f0f0f0;
  --color-field: rgb(228 228 230 / 0.7);
  --color-field-hover: rgb(170 170 170 / 0.2);
  --color-field-ring: rgb(0 0 0 / 0.14);
  --color-lit: #222226;          /* the lit end inverts to ink in light */
  --color-lit-hover: #2e2e35;
  --color-on-lit: #fff;
  --color-lit-soft: rgb(34 34 38 / 0.12);
  --color-ring: rgb(24 24 27 / 0.4);
  --color-danger: #c0474f;
  --color-success: #2f7f5a;
  --color-warning: #8c6a2a;
  --color-info: #2f6fd6;
  --color-soft-sky: #4f8fe0;
  --color-soft-mint: #2f9c77;
  --color-soft-lemon: #b88c14;
  --color-soft-peach: #d2703f;
  --color-soft-rose: #d35d7a;
  --color-soft-lilac: #7e67d6;
  --soft-wash: 13%;
  --soft-edge: 30%;
  --soft-ink: 78%;
  --shadow-raised: 0 1px 2px rgb(24 24 27 / 0.08), 0 0 0 0.5px rgb(24 24 27 / 0.06);
  --shadow-float: 0 6px 22px rgb(24 24 27 / 0.16), 0 0 0 0.5px rgb(24 24 27 / 0.1);
  --shadow-overlay: 0 12px 36px rgb(24 24 27 / 0.14), 0 0 0 0.5px rgb(24 24 27 / 0.1);
  --shadow-menu: 0 0 0 1px rgb(24 24 27 / 0.09), 0 14px 44px -10px rgb(24 24 27 / 0.16);
  --shadow-sheet: 0 -10px 40px -20px rgb(24 24 27 / 0.14);
  --shine: inset 0 1px 0 0 rgb(255 255 255 / 0.3);
  --shine-top: inset 0 1px 0 0 rgb(255 255 255 / 0.55);
}
```
Line refs: dark block `tokens.css:14-133, 156-160, 180-266, 279-284, 326-349, 372-426, 603-607`; light block `tokens.css:616-787`. Gray ramp + alpha primitives in `tokens/primitive.css:5-48` (`--gray-0 #fff` ... `--gray-950 #101012`; "Graphite, not slate: every rung holds its blue within three points of its red").

Design rule worth keeping (`tokens.css:132-135`): **no accent hue**. "The thing that is on is simply the brightest thing in the frame." Primary buttons are `--color-lit` (near-white in dark, near-black in light).

### Sky glass tokens (for UI standing on the sky)

`Zephium/frame/src/styles/tokens/sky.css:4-94`:
```css
:root {
  --sky-day-paper: #f7f7f8;
  --sky-night-paper: #1a1d25;
  --sky-day-shadow: rgb(18 48 112 / 22%);
  --sky-night-shadow: rgb(2 8 24 / 40%);
  --sky-day-disc-fill: rgb(255 255 255 / 18%);
  --sky-day-disc-rim: rgb(255 255 255 / 36%);
  --sky-night-disc-fill: rgb(255 255 255 / 10%);
  --sky-night-disc-rim: rgb(255 255 255 / 18%);
  --sky-day-glass: rgb(242 244 248 / 72%);
  --sky-night-glass: rgb(18 20 27 / 76%);
  --sky-ink: rgb(255 255 255);
  --sky-name: rgb(255 255 255 / 92%);
  --sky-day-lip: rgb(236 244 255 / 34%);
  --sky-night-lip: rgb(176 196 238 / 30%);
  --sky-day-edge: rgb(232 238 248 / 46%);
  --sky-night-edge: rgb(10 16 32 / 58%);
  /* glass card on the sky */
  --sky-day-card: rgb(255 255 255 / 64%);
  --sky-day-card-rim: rgb(255 255 255 / 90%);
  --sky-day-card-edge: rgb(255 255 255 / 70%);
  --sky-night-card: rgb(12 18 36 / 64%);
  --sky-night-card-rim: rgb(176 196 238 / 26%);
  --sky-night-card-edge: rgb(176 196 238 / 14%);
  --sky-on-ink: rgb(16 24 42);
  --sky-ink-hover: rgb(255 255 255 / 86%);
}
[data-sky="day"]   { --sky-paper: var(--sky-day-paper);   --sky-shadow: var(--sky-day-shadow);   --sky-lip: var(--sky-day-lip);   --sky-card: var(--sky-day-card);   --sky-card-rim: var(--sky-day-card-rim);   --sky-card-edge: var(--sky-day-card-edge); }
[data-sky="night"] { --sky-paper: var(--sky-night-paper); --sky-shadow: var(--sky-night-shadow); --sky-lip: var(--sky-night-lip); --sky-card: var(--sky-night-card); --sky-card-rim: var(--sky-night-card-rim); --sky-card-edge: var(--sky-night-card-edge); }
```

---

## 5. Motion

**Libraries: none.** No framer-motion/motion, GSAP, or lottie in either `website/package.json` or `Zephium/frame/package.json`; grep for `framer|motion/react|gsap|lottie` across `website/app components lib` returns nothing. Everything is CSS keyframes/transitions, `element.animate()` (WAAPI, for the orb), and hand-written rAF springs.

### Easing + duration tokens (ready to paste)

```css
:root {
  /* website/app/globals.css:56-58 and Zephium tokens.css:501-513 */
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);        /* default for fades, colors, hovers */
  --ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1);  /* anything that travels / arrives */
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);     /* loops: float, read, search */
  --ease-smooth: cubic-bezier(0.2, 0.8, 0.2, 1);     /* product only */
  --ease-press: cubic-bezier(0.2, 0, 0, 1);          /* product only */
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);           /* leaving is quicker than arriving */

  --motion-instant: 70ms;
  --motion-fast: 120ms;
  --motion-base: 200ms;
  --motion-slow: 300ms;
  --motion-page: 400ms;

  /* Damped spring sampled at 40 points, 2% overshoot (tokens.css:558-599) */
  --ease-spring: linear(0, 0.0232, 0.0821, 0.1636, 0.2572, 0.3552, 0.452, 0.5438, 0.628, 0.7032, 0.7689, 0.825, 0.8719, 0.9103, 0.9412, 0.9653, 0.9838, 0.9974, 1.007, 1.0135, 1.0174, 1.0194, 1.0199, 1.0194, 1.0182, 1.0166, 1.0147, 1.0128, 1.0109, 1.009, 1.0074, 1.0059, 1.0046, 1.0035, 1.0025, 1.0018, 1.0012, 1.0007, 1.0003, 1);

  /* Launched spring for direct click answers, 1.4% give (tokens.css:522-556) */
  --ease-snap: linear(0, 0.1776, 0.3343, 0.4698, 0.5848, 0.6808, 0.7597, 0.8234, 0.8742, 0.9138, 0.9443, 0.9672, 0.9839, 0.9959, 1.004, 1.0092, 1.0123, 1.0137, 1.0141, 1.0136, 1.0127, 1.0115, 1.0101, 1.0088, 1.0075, 1.0062, 1.0051, 1.0041, 1.0033, 1.0026, 1.002, 1.0015, 1);
}
```
Other one-offs: `cubic-bezier(0.2, 0.9, 0.1, 1)` for the counter roll (`privacy.module.css:74`).

Motion philosophy, quoted from `tokens.css:493-500`: hover/colour states "arrive almost at once", only things that travel get long durations, "a surface arriving gets the longest", "Leaving is always quicker than arriving."

Common durations in practice: hover colour 160-200ms `--ease-out`; press `transform: scale(0.97 or 0.98)` 160-200ms; sheet/menu open opacity 200ms + transform 300ms emphasized; entrances 1.0-1.6s emphasized.

### Hero entrance (page-enter), ready to paste

`website/components/scene/scene.module.css:362-409`. Headline is split into one `<span>` per word with `style={{"--i": index}}` (`scene.tsx:188-200`).
```css
@media (prefers-reduced-motion: no-preference) {
  .chip, .lede, .actions { animation: rise 1.1s var(--ease-emphasized) backwards; }
  .lede    { animation-delay: 0.55s; }
  .actions { animation-delay: 0.65s; }

  .word {
    display: inline-block;
    white-space: pre;
    animation: word 1.1s var(--ease-emphasized) backwards;
    animation-delay: calc(0.08s + var(--i) * 0.045s);   /* 45ms per-word stagger */
  }

  .frame > * { animation: lift 1.6s var(--ease-emphasized) 0.35s backwards; }
}

@keyframes rise { from { opacity: 0; transform: translateY(14px); } }
@keyframes word { from { opacity: 0; filter: blur(12px); transform: translateY(0.22em); } }
@keyframes lift { from { opacity: 0; transform: translateY(70px); } }
```
Each word also carries its own slice of the gradient text: `.word { -webkit-background-clip: text; background-clip: text; color: transparent; }` (`scene.module.css:167-171`).

### The beam chip (border light running around a pill)

`website/components/scene/scene.module.css:82-152`:
```css
@property --beam { syntax: "<angle>"; inherits: false; initial-value: 0deg; }

.chip {
  position: relative; display: inline-flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 12px 0 15px; border-radius: var(--radius-capsule);
  color: #fff; font-size: 13.5px; font-weight: 500; letter-spacing: -0.005em;
  background: rgb(255 255 255 / 0.14);
  box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.3);
  transition: background-color 200ms var(--ease-out);
}
.chip::before {
  content: ""; position: absolute; inset: 0; padding: 1px; border-radius: inherit;
  background: conic-gradient(from var(--beam), transparent 0deg, transparent 250deg, rgb(255 255 255 / 0.95) 320deg, transparent 360deg);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  pointer-events: none;
}
.chip:hover { background: rgb(255 255 255 / 0.22); }
.chip svg { opacity: 0.75; transition: transform 200ms var(--ease-out); }
.chip:hover svg { transform: translateX(2px); }
@media (prefers-reduced-motion: no-preference) { .chip::before { animation: beam 4.5s linear infinite; } }
@keyframes beam { to { --beam: 360deg; } }
```

### Scroll reveals (rise + blur on first view)

CSS: `website/app/globals.css:127-148`. JS: `website/components/reveals.tsx` (58 lines, mounted once in the site layout, `app/(site)/layout.tsx:26`). Mark any element `data-reveal` (or `data-reveal="fade"` for big images), stagger with `style={{"--delay": "0.08s"}}`.
```css
:root[data-reveals] [data-reveal]:not([data-shown]) {
  opacity: 0;
  transform: translateY(28px);
  filter: blur(10px);
}
:root[data-reveals] [data-reveal="fade"]:not([data-shown]) {
  transform: translateY(40px) scale(0.98);
  filter: none;
}
[data-reveal] {
  transition:
    opacity 1s var(--ease-out) var(--delay, 0s),
    transform 1.3s var(--ease-emphasized) var(--delay, 0s),
    filter 1s var(--ease-out) var(--delay, 0s);
}
```
```tsx
"use client";
import { useEffect } from "react";

export function Reveals() {
  useEffect(() => {
    const root = document.documentElement;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const show = (element: Element) => element.setAttribute("data-shown", "");
    const watch = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          show(entry.target);
          watch.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    const adopt = (scope: ParentNode) => {
      for (const element of scope.querySelectorAll("[data-reveal]:not([data-shown])")) {
        const box = element.getBoundingClientRect();
        if (box.top < window.innerHeight * 0.88 && box.bottom > 0) show(element);
        else watch.observe(element);
      }
    };
    adopt(document);
    root.setAttribute("data-reveals", "");
    let frame = 0;
    const added = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; adopt(document); });
    });
    added.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      added.disconnect();
      root.removeAttribute("data-reveals");
    };
  }, []);
  return null;
}
```
Nice property: before JS runs, nothing is hidden (the hide rule is gated on `:root[data-reveals]`), so no SSR flash and no-JS users see everything. Typical staggers in sections: `0.08s` for the subtitle under an h2, `index * 0.06s` for grids, `index * 0.04s` for FAQ rows.

Global reduced-motion kill switch (`globals.css:155-164`):
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

### Scroll-driven film (spring with a speed limit)

`website/components/scene/scene.tsx:104-127` + `film.ts`. Scroll sets a goal; a critically damped follow chases it, capped at `MAX_RATE = 2.2` chapters/second so a hard flick still plays every chapter:
```ts
const step = (goal.p - now.p) * (1 - Math.exp(-dt * 7));
const cap = MAX_RATE * dt;
now.p += Math.max(-cap, Math.min(cap, step));
now.intro += (goal.intro - now.intro) * (1 - Math.exp(-dt * 9));
now.exit  += (goal.exit  - now.exit)  * (1 - Math.exp(-dt * 9));
```
Everything continuous is written as CSS vars (`--p`, `--intro`, `--exit`, `--cx`, `--cy`, `--zoom`) on the stage, so React re-renders only when a discrete flag flips. Hero copy fades with `opacity: calc(1 - var(--intro) * 1.9); transform: translate(-50%, calc(var(--intro) * -80px));` (`scene.module.css:62-63`). Probably overkill for our hackathon, but the "exp follow" pattern is worth reusing for any pointer-follow effect.

### Small loops and state animations (ready to paste)

```css
/* Caption crossfade: stacked spans, one on (scene.module.css:300-316) */
.caption span { grid-area: 1 / 1; opacity: 0; filter: blur(6px); transform: translateY(6px);
  transition: opacity 500ms var(--ease-out), filter 500ms var(--ease-out), transform 700ms var(--ease-emphasized); }
.caption span[data-on] { opacity: 1; filter: none; transform: none; transition-delay: 150ms; }

/* Step dots: short dash grows into the current pill (scene.module.css:334-360) */
.steps button::before { content: ""; position: absolute; top: 50%; left: 50%; width: 6px; height: 6px; border-radius: 3px;
  background: rgb(255 255 255 / 0.4); translate: -50% -50%;
  transition: width 400ms var(--ease-emphasized), background-color 300ms var(--ease-out); }
.steps button[data-past]::before { background: rgb(255 255 255 / 0.65); }
.steps button[data-on]::before { width: 18px; background: #fff; }

/* Typing caret (work.module.css:61-74; product-window uses 1.06s) */
.caret { display: inline-block; width: 1.5px; height: 1.1em; margin-left: 2px; vertical-align: -0.18em;
  background: var(--color-text); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* Typewriter reveal (browser-cards.module.css:271-285) */
.typing { overflow: hidden; white-space: nowrap; animation: type 1.6s steps(25, end) backwards; }
@keyframes type { from { max-width: 0; } to { max-width: 100%; } }

/* Live dot (work/canvas.module.css:186-199) */
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-sky); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }

/* New list item lands from above (browser-cards.module.css:191-205, 322-332) */
@keyframes arrive { from { opacity: 0; transform: translateY(-6px); } }   /* 600ms emphasized */
@keyframes land   { from { opacity: 0; transform: translateY(-10px); } }  /* 700ms emphasized */

/* Strike-through as a request is blocked, staggered by --n */
.hosts span::after { content: ""; position: absolute; left: 0; right: 0; top: 55%; height: 1px;
  background: rgb(255 255 255 / 0.6); transform: scaleX(0); transform-origin: left; }
[data-seen] .hosts span::after { animation: strike 700ms var(--ease-out) calc(500ms + var(--n) * 160ms) both; }
@keyframes strike { to { transform: none; } }

/* Bars grow / meters fill on first view (browser-cards.module.css:518-602) */
[data-seen] .hours i { animation: grow 800ms var(--ease-emphasized) calc(300ms + var(--n) * 50ms) both; }
@keyframes grow { from { transform: scaleY(0); } to { transform: none; } }
[data-seen] .sites i { animation: fill 900ms var(--ease-emphasized) 600ms both; }
@keyframes fill { from { transform: scaleX(0); } to { transform: none; } }

/* Odometer roll to a number (privacy.module.css:58-95) */
[data-seen] .reel { animation: roll 2.4s cubic-bezier(0.2, 0.9, 0.1, 1) 0.2s both; }
@keyframes roll { 0% { transform: translateY(0); } 86% { transform: translateY(-90.6%); } 100% { transform: translateY(-90%); } }

/* Modal: page dims, frame comes forward (film.module.css:170-191) */
@media (prefers-reduced-motion: no-preference) {
  .dialog[open] .frame { animation: come 700ms var(--ease-emphasized); }
  .dialog[open]::backdrop { animation: dim 400ms var(--ease-out); }
}
@keyframes come { from { opacity: 0; transform: translateY(18px) scale(0.96); } }
@keyframes dim  { from { opacity: 0; } }

/* Status island pops in on the spring (island.module.css:76-86) */
.island { animation: island-in var(--motion-slow) var(--ease-spring) backwards; }
@keyframes island-in { from { opacity: 0; scale: 0.9; } }

/* Grid-rows expand/collapse, arrive on emphasized, fold on exit (island.module.css:99-120) */
.expand { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--motion-base) var(--ease-exit); }
.expand.shown { grid-template-rows: 1fr; transition-timing-function: var(--ease-emphasized); }
.expandInner { min-block-size: 0; overflow: hidden; opacity: 0; transition: opacity var(--motion-fast) var(--ease-exit); }
.shown .expandInner { opacity: 1; transition: opacity var(--motion-base) var(--ease-out); }

/* Tab page swap (product-window.module.css:752-760) */
.tabPage { animation: arrive 360ms var(--ease-out) backwards; }
```

### Agent presence (directly useful for "agents collaborate")

Three components ported from the product. All are MPL; copy the files whole.

1. **Shimmer text** ("Thinking...", "Searching..."): a light band slides across text by transform only. `website/components/island/shimmer.tsx` (35 lines) + `shimmer.module.css` (72 lines):
   ```css
   .shimmer { position: relative; display: inline-block; max-inline-size: 100%; overflow: hidden; vertical-align: bottom; white-space: nowrap; }
   .words { display: block; overflow: hidden; text-overflow: ellipsis; }
   .running .words { color: var(--shimmer-rest, rgb(244 244 246 / 0.68)); }
   .band { position: absolute; inset-block: 0; inset-inline-start: 0; inline-size: 40%; overflow: hidden;
     mask-image: linear-gradient(90deg, transparent, black 45%, black 55%, transparent);
     animation: band 2.4s linear infinite; }
   .lit { position: absolute; inset-block: 0; inset-inline-start: 0; display: block; inline-size: 250%; overflow: hidden;
     color: var(--shimmer-lit, #f4f4f6); text-overflow: ellipsis; animation: lit 2.4s linear infinite; }
   [data-still] .band, [data-still] .lit { animation-play-state: paused; }
   [data-still] .band { visibility: hidden; }
   @keyframes band { 0% { transform: translateX(-100%); } 72%, 100% { transform: translateX(250%); } }
   @keyframes lit  { 0% { transform: translateX(40%); }   72%, 100% { transform: translateX(-100%); } }
   ```
   Markup: `<span class="shimmer running"><span class="words">{text}</span><span class="band" aria-hidden><span class="lit">{text}</span></span></span>`.
2. **Orb** (working indicator): a dotted geodesic sphere turning while a light band rises through it, pre-rendered once into a 30-frame SVG strip used as a CSS mask, stepped by WAAPI at 20 fps (no paints). `website/components/island/orb.tsx` (61 lines), `orb-strip.ts` (227 lines), `orb.module.css` (21 lines). Needs `still.ts` (25 lines, pauses when offscreen/hidden/reduced motion).
3. **Character** (agent avatar): glossy "stone" body in the agent's hue, dark visor, two lit eyes whose shape shows mood (`rest | thinking | reading | searching | working | waiting | done | stopped`), kinds `lead | browser | research | computer | connection`, lead looks `orb | drop | prism | gem | egg | pearl`. `website/components/work/character.tsx` (130 lines), `character.module.css` (481 lines), `character-shapes.ts` (94 lines, the silhouette masks). Keyframes (`character.module.css:340-481`):
   ```css
   .live    { --beat: 3.4s; --beats: infinite; }
   .waiting { --beat: 1.6s; --beats: 2; }          /* asks twice, then holds still */
   .live .figure { animation: float var(--beat) var(--ease-in-out) var(--beats); }
   .live .ground { animation: ground var(--beat) var(--ease-in-out) var(--beats); }
   .live .eyes   { animation: blink 4.8s linear var(--blink-delay) var(--beats); }
   .thinking .face  { animation: ponder 6.4s var(--ease-in-out) infinite; }
   .reading .face   { animation: read 1.9s var(--ease-in-out) infinite; }
   .searching .face { animation: search 3.6s var(--ease-out) infinite; }
   .cheer .figure   { animation: hop var(--motion-page) var(--ease-spring); }

   @keyframes float  { 50% { transform: translateY(-0.045em); } }
   @keyframes ground { 50% { transform: scale(0.84); opacity: 0.7; } }
   @keyframes blink  { 0%, 93%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
   @keyframes eyes-open { from { transform: scaleY(0.1); } }
   @keyframes ponder { 0%, 100% { transform: translate(0.05em, -0.02em); } 34%, 46% { transform: translate(-0.05em, -0.02em); } 62%, 84% { transform: translate(0.05em, -0.02em); } }
   @keyframes read   { 0% { transform: translate(-0.07em, 0.01em); } 82% { transform: translate(0.07em, 0.01em); } 100% { transform: translate(-0.07em, 0.01em); } }
   @keyframes search { 0%, 20% { transform: translate(-0.08em, 0); } 26%, 48% { transform: translate(0.08em, 0); } 54%, 70% { transform: translate(0.01em, -0.02em); } 76%, 100% { transform: translate(-0.08em, 0); } }
   @keyframes hop    { 40% { transform: translateY(-0.12em); } }
   ```
   Body lighting recipe (`character.module.css:173-211`): 4 radial gradients (specular glint at 30% 19%, broad highlight at 36% 24%, rim light at bottom, chin shade) over a 155deg linear gradient `hue-light -> hue -> hue-to -> hue-to-deep`, all via `color-mix(in oklab, ...)`. Each agent kind gets a different `--blink-delay` (0.4s, 1.2s, 1.7s, 2.3s, 3.1s) so a group never blinks in sync. Careful: the CSS module inlines its own copy of `--ease-spring` and colour tokens on `.character` (lines 1-74), so it works without the global tokens.

### Pointer-follow spotlight (footer)

`website/components/footer-mark.tsx:12-40` + `site-footer.module.css:134-138`: an SVG layer masked by a radial gradient at `--x/--y`, following the pointer with `now += (aim - now) * 0.16` per frame:
```css
.light {
  -webkit-mask-image: radial-gradient(circle clamp(180px, 24vw, 340px) at var(--x) var(--y), #000, transparent 72%);
  mask-image: radial-gradient(circle clamp(180px, 24vw, 340px) at var(--x) var(--y), #000, transparent 72%);
  filter: drop-shadow(0 0 12px rgb(244 244 246 / 0.3));
}
```
Reusable on any big type (our own wordmark), not theirs.

---

## 6. Surfaces: glass, radii, shadows, grain

### Glass (vibrancy) recipes, all quoted

| Use | Recipe | Source |
|---|---|---|
| Generic vibrancy utility | `background: rgb(255 255 255 / 0.14); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.3); backdrop-filter: blur(20px) saturate(1.6);` | `globals.css:120-125` (`@utility vibrant`) |
| Nav bar over page | `background: rgb(12 12 14 / 0.72); box-shadow: inset 0 -0.5px 0 rgb(255 255 255 / 0.1); backdrop-filter: blur(20px) saturate(1.8);` | `site-nav.module.css:25-36` |
| Mobile menu sheet | `background: rgb(18 18 22 / 0.86); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.12); backdrop-filter: blur(24px) saturate(1.8); border-radius: 20px;` | `site-nav.module.css:194-213` |
| Panel floating over sky | `background: rgb(26 30 40 / 0.58); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.16), 0 18px 50px rgb(8 20 40 / 0.22); backdrop-filter: blur(28px) saturate(1.6); border-radius: 18px; padding: 16px;` | `browser-cards.module.css:8-21` |
| App window over sky | `background: rgb(16 34 56 / 0.62); border-radius: 20u; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.16), inset 0 1px 0 rgb(255 255 255 / 0.22), 0 2px 6px rgb(10 30 60 / 0.12), 0 30px 80px -20px rgb(10 30 60 / 0.45), 0 80px 160px -60px rgb(10 30 60 / 0.5); backdrop-filter: blur(50u) saturate(1.5);` (u = 1 design px) | `product-window.module.css:20-37` |
| Glass play disc | `background: rgb(255 255 255 / 0.18); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.5), inset 0 1px 0 rgb(255 255 255 / 0.4), 0 20px 50px -12px rgb(6 24 70 / 0.5); backdrop-filter: blur(18px) saturate(1.6);` hover `scale: 1.06` over 500ms emphasized | `film.module.css:41-77` |
| Dark meta pill on image | `background: rgb(10 14 24 / 0.42); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.2); backdrop-filter: blur(16px);` | `film.module.css:79-94` |
| Modal backdrop | `::backdrop { background: rgb(5 5 6 / 0.82); backdrop-filter: blur(24px) saturate(1.2); }` | `film.module.css:124-128` |
| Secondary button on sky (no blur on purpose) | `background: rgb(255 255 255 / 0.16); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.4);` | `scene.module.css:243-249` (comment: "through a backdrop filter the sky turns the button blue, and the plain veil reads cleaner") |

Pattern: **edges are 0.5px inset hairlines** (`box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / X)`), never `border`. Sky-floating things get navy-tinted drop shadows (`rgb(8 20 40 / ...)`, `rgb(10 30 60 / ...)`, `rgb(6 24 70 / ...)`) instead of black. Top-edge light: `inset 0 1px 0 rgb(255 255 255 / 0.22-0.4)`.

Product island (solid, not glass, because blur on a moving canvas costs every frame): `background: color-mix(in srgb, #3d3d44 62%, #1a1a1d); box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08), 0 14px 44px -10px rgb(0 0 0 / 0.34); border-radius: 22px;` (`island.module.css:92-97`).

### Radii

Site: inset 8, row 12, control 14, card 20, panel 28, capsule 999 (`globals.css:33-39`). In practice: feature cards 28px (`browser.module.css:61`), inset sky "desk" 21px (28 minus the 8px gap minus a hair), menu sheet 20px, keycaps 9px, buttons all capsules. Product: control 14, card 18, panel 22 (section 4).

### Grain / noise

Defined but **not used in any markup** (grep for `grain` and `vibrant` class usage finds only the definitions). Still, the recipe (`globals.css:111-114`):
```css
@utility grain {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .55 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 160px 160px;
}
```
The live grain is in the shader (+/-1/255 per pixel per frame).

### Gradients in use

- Headline text gradients and sky-navy text shadows (section 4).
- Footer hairline glow: `.top::after { width: min(1100px, 100vw); height: 220px; background: radial-gradient(50% 100% at 50% 0, rgb(244 244 246 / 0.05), transparent); }` (`site-footer.module.css:159-170`).
- Night-fall overlay `linear-gradient(180deg, var(--color-ground) 0%, var(--color-ground) 50%, rgb(9 9 11 / 0.85) 100%)`.
- Product sky edge-light falloff `--sky-edge-falloff` (`sky.css:21-29`).

---

## 7. Component patterns (exact CSS)

### Buttons

```css
/* Hero primary / secondary: 48px capsules (scene.module.css:218-258) */
.primary, .secondary {
  display: inline-flex; align-items: center; gap: 9px;
  height: 48px; padding-inline: 24px;            /* 20px under 720px */
  border-radius: var(--radius-capsule);
  font-size: 15.5px; font-weight: 550; letter-spacing: -0.012em;
  transition: background-color 200ms var(--ease-out), transform 200ms var(--ease-out);
}
.primary { background: #fff; color: #0b1f36; }
.primary:hover { background: #eef4fb; }
.secondary { color: #fff; background: rgb(255 255 255 / 0.16); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.4); }
.secondary:hover { background: rgb(255 255 255 / 0.24); }
.primary:active, .secondary:active { transform: scale(0.98); }
/* On phones over the cloud bank the white veil vanishes; use deep sky instead */
@media (max-width: 720px) { .secondary { background: rgb(18 52 96 / 0.24); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.45); } }

/* Dark-page ghost capsule (site-footer.module.css:51-74) */
.ghost { height: 48px; padding-inline: 22px; border-radius: var(--radius-capsule);
  background: rgb(255 255 255 / 0.08); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.16);
  font-size: 15.5px; font-weight: 550; letter-spacing: -0.012em;
  transition: background-color 200ms var(--ease-out), transform 200ms var(--ease-out); }
.ghost:hover { background: rgb(255 255 255 / 0.13); }
.ghost:active { transform: scale(0.98); }

/* Glass close button (film.module.css:144-166) */
.close { width: 40px; height: 40px; border-radius: 50%; color: var(--color-text);
  background: rgb(255 255 255 / 0.1); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.2);
  transition: background-color 200ms var(--ease-out); }
.close:hover { background: rgb(255 255 255 / 0.18); }
```

### Nav (transparent over sky, vibrancy over page)

`website/components/site-nav.module.css` (240 lines). Key parts:
```css
.nav { position: fixed; inset: 0 0 auto; z-index: 50; }
.bar { position: relative; display: flex; align-items: center; gap: 12px; width: 100%;
  max-width: calc(var(--content) + var(--gutter) * 2); height: var(--nav-height);
  margin-inline: auto; padding-inline: var(--gutter); color: var(--color-text); }
.nav::before { content: ""; position: absolute; inset: 0 0 auto; height: var(--nav-height); z-index: -1;
  background: rgb(12 12 14 / 0.72); box-shadow: inset 0 -0.5px 0 rgb(255 255 255 / 0.1);
  -webkit-backdrop-filter: blur(20px) saturate(1.8); backdrop-filter: blur(20px) saturate(1.8);
  transition: opacity 400ms var(--ease-out); }
:global(:root[data-sky]) .nav::before { opacity: 0; }
:global(:root[data-sky]) .bar { color: #fff; }

.link { padding: 6px 12px; border-radius: var(--radius-capsule); color: rgb(244 244 246 / 0.68);
  font-size: 14px; font-weight: 450; letter-spacing: -0.006em;
  transition: color 160ms var(--ease-out), background-color 160ms var(--ease-out); }
.link:hover { background: rgb(255 255 255 / 0.08); color: #fff; }
:global(:root[data-sky]) .link { color: rgb(255 255 255 / 0.85); }
:global(:root[data-sky]) .link:hover { background: rgb(255 255 255 / 0.16); }

.star { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding-inline: 11px 13px;
  border-radius: var(--radius-capsule); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.18);
  color: rgb(244 244 246 / 0.82); font-size: 14px; font-weight: 500; letter-spacing: -0.01em; }
.star:hover { background: rgb(255 255 255 / 0.06); color: #fff; }

.download { display: inline-flex; align-items: center; height: 34px; margin-left: 6px; padding-inline: 15px;
  border-radius: var(--radius-capsule); background: #fff; color: #0b1f36;
  font-size: 14px; font-weight: 550; letter-spacing: -0.01em;
  transition: background-color 160ms var(--ease-out), transform 160ms var(--ease-out); }
.download:hover { background: #eef4fb; }
.download:active { transform: scale(0.97); }

/* Mobile sheet: hidden -> shown */
.sheet { position: absolute; top: calc(var(--nav-height) + 4px); left: var(--gutter); right: var(--gutter);
  display: grid; padding: 8px; border-radius: 20px; background: rgb(18 18 22 / 0.86);
  box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.12);
  -webkit-backdrop-filter: blur(24px) saturate(1.8); backdrop-filter: blur(24px) saturate(1.8);
  opacity: 0; transform: translateY(-6px); visibility: hidden;
  transition: opacity 200ms var(--ease-out), transform 300ms var(--ease-emphasized), visibility 0s 300ms; }
.nav[data-open] .sheet { opacity: 1; transform: none; visibility: visible;
  transition: opacity 200ms var(--ease-out), transform 300ms var(--ease-emphasized); }
.sheet a { padding: 12px 14px; border-radius: 14px; font-size: 17px; font-weight: 500; letter-spacing: -0.015em; }
```
Breakpoint: links show at `min-width: 860px`. Uses `inert={!open}` on the sheet and closes on Escape (`site-nav.tsx:49-56, 96`).

### Cards

```css
/* Feature card (browser.module.css:55-64) */
.card { display: flex; flex-direction: column; min-height: 460px; overflow: hidden;
  border-radius: 28px; background: #111113; box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.09); }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 24px;
  padding: 20px clamp(24px, 3vw, 36px) clamp(26px, 3vw, 34px); }
.line { color: var(--color-muted); font-size: 17px; line-height: 1.45; letter-spacing: -0.012em; text-wrap: pretty; }
.line b { color: var(--color-text); font-weight: 600; }
/* 12-col grid at >=900px, gap 16px; spans 7/5, 4/4/4, 12 */
```
Section head: h2 `font-size: var(--text-headline); font-weight: 600; line-height: 1.02; letter-spacing: -0.045em;`, p `max-width: 34rem; margin-top: 14px; color: var(--color-muted); font-size: var(--text-lede); line-height: 1.45; text-wrap: balance;` (`browser.module.css:10-25`). Two-tone headings: second clause in `rgb(244 244 246 / 0.38)` (footer CTA) or `.text-quiet` 0.5.

### Inputs / composer

Compose field on glass (`browser-cards.module.css:213-225`): `min-height: 40px; padding: 0 8px 0 12px; border-radius: 12px; background: rgb(255 255 255 / 0.08);` placeholder `rgb(255 255 255 / 0.4)`. Inline parsed chip that pops in: `padding: 2px 8px; border-radius: 999px; background: rgb(255 255 255 / 0.14); font-size: 12px; opacity: 0; transform: scale(0.9); transition: opacity 300ms var(--ease-out), transform 400ms var(--ease-emphasized);` -> `[data-on] { opacity: 1; transform: none; }`. Product fields: `--color-field` fill, `--radius-field: 10px`, ring only on focus `inset 0 0 0 1px var(--color-field-ring)` (`tokens.css:113-116, 353, 375`).

Round send button (`island.module.css`): `28u x 28u; border-radius: 999px; background: var(--color-lit); color: var(--color-on-lit);` disabled `background: var(--color-control); color: var(--color-faint);`.

### Switch

`browser-cards.module.css:43-82`:
```css
.switch { position: relative; flex: none; width: 32px; height: 19px; padding: 0; border: 0; border-radius: 999px;
  background: rgb(255 255 255 / 0.16); cursor: pointer; transition: background-color 260ms var(--ease-out); }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%;
  background: #f4f4f6; box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
  transition: transform 420ms var(--ease-emphasized), background-color 260ms var(--ease-out); }
.switch[data-on] { background: #f4f4f6; }
.switch[data-on]::after { background: #1c2230; transform: translateX(13px); }
.switch:focus-visible { outline: 2px solid rgb(255 255 255 / 0.7); outline-offset: 2px; }
```

### Keycaps

`browser.module.css:180-195`: `min-width: 34px; height: 34px; padding-inline: 10px; border-radius: 9px; background: #1c1c20; box-shadow: inset 0 0.5px 0 rgb(255 255 255 / 0.18), 0 0 0 0.5px rgb(255 255 255 / 0.1); font-size: 14px; font-weight: 500;`.

### Accordion (FAQ, native `<details>` with animated height)

`website/components/sections/faq.module.css:21-88`:
```css
.list { border-top: 0.5px solid rgb(255 255 255 / 0.12); }
.list details { border-bottom: 0.5px solid rgb(255 255 255 / 0.12); interpolate-size: allow-keywords; }
.list summary { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding-block: 22px;
  font-size: 18px; font-weight: 550; letter-spacing: -0.015em; list-style: none; cursor: pointer; }
.list summary::-webkit-details-marker { display: none; }
.list summary svg { flex: none; color: var(--color-muted); transition: transform 300ms var(--ease-emphasized); }
.list details[open] summary svg { transform: rotate(45deg); }   /* plus -> x */
.list details::details-content { block-size: 0; overflow: hidden;
  transition: block-size 400ms var(--ease-emphasized), content-visibility 400ms allow-discrete; }
.list details[open]::details-content { block-size: auto; }
.list p { max-width: 40rem; padding-bottom: 24px; color: var(--color-muted); font-size: 16px; line-height: 1.6; }
```

### Segmented / tabs

The site has no generic tab bar. The closest are the chapter step dots (section 5) and the product's segmented control tokens: thumb `--segment-thumb` (dark: `--row-active` + `--row-rim`; light: `rgb(255 255 255 / 0.42)` + `0 0 0 0.5px rgb(24 24 27 / 0.05), 0 1px 2px rgb(24 24 27 / 0.05)`) (`tokens.css:86-89, 672-675`). Animate the thumb with `--ease-snap`.

### Icons

Hugeicons free set via `@hugeicons/react` (`<HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={2} />`). Typical sizes: 13-18px, stroke 1.7-2 (`scene.tsx:185, 206-216`; `site-nav.tsx:79, 91`).

---

## 8. Tech stack and porting notes

| | website | Zephium (product UI) |
|---|---|---|
| Framework | Next.js 16.3.4, React 19.2.8, App Router, `output: "export"` (fully static), `images: { unoptimized: true }` (`website/next.config.ts`) | Svelte 5.56.8 + Vite 8.3.5 inside Tauri 2 (`Zephium/frame/package.json`); Rust backend |
| Styling | Tailwind 4 (`@tailwindcss/postcss`) for tokens/utilities only; **almost all styling is CSS Modules** (`*.module.css`), Tailwind classes appear rarely (e.g. skip link in `app/layout.tsx:67`) | Tailwind 4.3.3 via `@tailwindcss/vite`, `@theme static` tokens, scoped Svelte `<style>` |
| Fonts | `geist` package (next/font/local) | System fonts only |
| Icons | `@hugeicons/react` + `@hugeicons/core-free-icons`, `simple-icons` | `@hugeicons/svelte` 1.1.4 |
| Motion | CSS + rAF + WAAPI, no libs | same |
| Package manager | pnpm (we use Bun; nothing pnpm-specific to port) | pnpm |

Port plan for `web/` (Next 16.4.3, React 19.3.0, Tailwind 4 via `@tailwindcss/turbopack`, `src/` layout):
1. `bun add geist @hugeicons/react @hugeicons/core-free-icons`.
2. `src/app/layout.tsx`: Geist classes on `<html>` (section 2), `viewport` themeColor `#09090b`.
3. `src/app/globals.css`: site `@theme` + base (section 4), easing/motion/spring tokens (section 5), reveal CSS + reduced-motion block. Add product tokens in a separate `src/styles/zephium-tokens.css` (MPL header) if we build the app shell on them.
4. `src/components/sky/clouds.tsx` + `clouds.module.css` (section 3). Mount inside a `position: relative|sticky` container that fills the viewport. It's a client component (`"use client"`), safe in a server-component page.
5. `src/components/reveals.tsx` once in the root layout.
6. Copy Shimmer / Orb / Character (+ `still.ts`, `orb-strip.ts`, `character-shapes.ts`) into `src/components/presence/` for agent status UI. Rename the `--u` design-pixel variable or set `--u: 1px` on a parent (they default to `1px` via `var(--u, 1px)` / `var(--u-)`).
7. Credits page linking the MPL source of ported files.

Gotchas:
- `clouds.tsx` fetches `/sky/day-*.avif` by absolute path, so the files must be at `web/public/sky/`.
- `@property --beam` and `::details-content` / `interpolate-size` are recent CSS. Beam just won't spin in old browsers; accordion snaps instead of animating. Fine.
- `website/AGENTS.md` warns that Next 16 has breaking changes vs older Next; read `node_modules/next/dist/docs/` before relying on memory for Next APIs.

---

## 9. Assets to copy (do not copy yet; list only)

Source paths are under the clone root above. Sizes in bytes; dimensions from `sips`.

### Needed for the cloud hero

| Source | Size | Dimensions | Destination |
|---|---|---|---|
| `website/public/sky/day-1672.avif` | 44,568 | 1672x942 | `web/public/sky/day-1672.avif` |
| `website/public/sky/day-1672.jpg` | 139,160 | 1672x942 | `web/public/sky/day-1672.jpg` |
| `website/public/sky/day-900.avif` | 20,623 | 900x506 | `web/public/sky/day-900.avif` |
| `website/public/sky/day-900.jpg` | 62,138 | 900x506 | `web/public/sky/day-900.jpg` |

### Optional

| Source | Size | Dimensions | Destination | Why |
|---|---|---|---|---|
| `website/public/sky/night-1200.avif` | 59,015 | 1200x676 | `web/public/sky/night-1200.avif` | Night sky with baked halftone dissolve |
| `website/public/sky/night-1200.jpg` | 103,124 | 1200x676 | `web/public/sky/night-1200.jpg` | fallback |
| `website/public/sky/night-2200.avif` | 133,937 | 2200x1238 | `web/public/sky/night-2200.avif` | retina |
| `website/public/sky/night-2200.jpg` | 269,546 | 2200x1238 | `web/public/sky/night-2200.jpg` | fallback |
| `Zephium/frame/src/shared/sky/assets/frost-day.png` | 9,846 | 192x108 | `web/public/sky/frost-day.png` | Pre-blurred sky for cheap frosted panels |
| `Zephium/frame/src/shared/sky/assets/frost-night.png` | 13,435 | 192x108 | `web/public/sky/frost-night.png` | same, night |
| `Zephium/assets/sky/day-source.png` | 1,691,968 | 1672x941 | keep out of `public/` (e.g. `web/design/sky/day-source.png`) | Master to re-encode other sizes. Identical to `website/media/sky-day-source.png` |
| `Zephium/assets/sky/night-source.png` | 1,895,201 | 1672x941 | keep out of `public/` | Night master, un-baked. Could feed the shader for a night hero |

Re-encode command the site uses (`website/scripts/images.sh:35-41`), if we need other widths:
```bash
ffmpeg -v error -y -i day-source.png -vf "scale=1672:-2:flags=lanczos,format=yuv420p10le" -frames:v 1 -c:v libsvtav1 -crf 18 -preset 4 day-1672.avif
ffmpeg -v error -y -i day-source.png -vf "scale=1672:-2:flags=lanczos" -q:v 3 day-1672.jpg
```

### Do not copy

`website/public/brand/*`, `website/public/marks/*`, `website/public/shots/*`, `website/public/film/*`, `website/public/demo/*`, `website/public/extensions/*`, `website/app/*.png|ico|jpg`, `website/media/*` (except the sky source), `Zephium/assets/brand/*`. Brand marks, third-party logos, or product screenshots (section 1).

### Install, don't copy

- Fonts: `geist` (npm). Don't vendor the woff2 files.
- Icons: `@hugeicons/react`, `@hugeicons/core-free-icons`.

---

## 10. File index (where to look if something is unclear)

| What | Path |
|---|---|
| Global tokens, reveal CSS, utilities | `website/app/globals.css` |
| Font loading | `website/app/layout.tsx` |
| Cloud shader | `website/components/scene/clouds.tsx`, `clouds.module.css` |
| Hero layout, title animation, beam chip, buttons | `website/components/scene/scene.tsx`, `scene.module.css` |
| Scroll film clock + camera | `website/components/scene/film.ts` |
| Reveal script / in-view hook | `website/components/reveals.tsx`, `website/components/motion/use-in-view.ts` |
| Nav | `website/components/site-nav.tsx`, `site-nav.module.css` |
| Footer CTA + spotlight | `website/components/site-footer.module.css`, `website/components/footer-mark.tsx` |
| Cards, desk, keycaps | `website/components/sections/browser.module.css` |
| Glass panels, switch, staggered fills | `website/components/sections/browser-cards.module.css` |
| FAQ accordion | `website/components/sections/faq.module.css` |
| Modal player | `website/components/film.module.css` |
| Agent status island | `website/components/island/island.module.css` |
| Shimmer / Orb / still-watcher | `website/components/island/shimmer.*`, `orb.*`, `orb-strip.ts`, `still.ts` |
| Agent character | `website/components/work/character.tsx`, `character.module.css`, `character-shapes.ts` |
| Product tokens (dark + light) | `Zephium/frame/src/styles/tokens.css` |
| Product primitives / sky glass | `Zephium/frame/src/styles/tokens/primitive.css`, `tokens/sky.css` |
| Sky baking (halftone, frost, edge light) | `Zephium/frame/scripts/bake-sky.mjs` |
