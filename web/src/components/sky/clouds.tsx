/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Adapted from zephium-browser/website components/scene/clouds.tsx
 * (https://github.com/zephium-browser/website). Changes: our own skies, one
 * per scene with a crossfade between them, ground colour per scene, live
 * reduced-motion switch, WebGL context-loss fallback, canvas hidden until its
 * first frame.
 */
"use client";

import { useEffect, useRef } from "react";
import { useSceneOf } from "@/components/ui/theme";
import { easeOutCubic, prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { plainSky, SCENE_PAPER, type Scene } from "./scenes";
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
uniform sampler2D u_prev;
uniform float u_mix;
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

// The picture, or while the scene changes, the old one melting into the new.
vec3 picture(vec2 uv) {
  vec3 now = texture2D(u_img, uv).rgb;
  if (u_mix < 1.0) now = mix(texture2D(u_prev, uv).rgb, now, u_mix);
  return now;
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
  float depth = mix(0.22, 1.0, cloudOf(picture(uv))) * mix(0.55, 1.0, s.y);

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
  vec3 c = picture(uv);

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
        vec3 tone = picture(cover(centre / u_res));
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

/** Seconds the sky takes to arrive. */
const ARRIVAL = 1.9;

/** Seconds one scene takes to melt into the next. */
const CROSSFADE = 1.4;

/** How long a step of the pointer's wake lasts, in seconds. */
const WAKE_LIFE = 1.4;

const groundOf = (scene: Scene) => SCENE_PAPER[scene].map((channel) => channel / 255);

const easeInOut = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

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

type Controls = { scene: (scene: Scene) => void };

export type CloudsProps = {
  /** Which sky to draw. Follows the nearest `data-theme` when left out. */
  scene?: Scene;
  /** Skip WebGL and show the still fallback, as when WebGL is unavailable. */
  flat?: boolean;
  className?: string;
};

/**
 * The living sky: one still picture drawn by a fragment shader that adds slow
 * breathing, pointer parallax, a pointer wake and a halftone arrival. Writes
 * `data-sky="live"` on its parent once drawing; reads `--exit` (0..1) from the
 * parent's inline style to dissolve into the page. Falls back to the plain
 * picture when WebGL is unavailable.
 */
export function Clouds({ scene: override, flat: forceFlat = false, className }: CloudsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controls = useRef<Controls | null>(null);
  const scene = useSceneOf(ref, override);
  const sceneRef = useRef(scene);

  useEffect(() => {
    sceneRef.current = scene;
    if (ref.current) ref.current.dataset.scene = scene;
    controls.current?.scene(scene);
  }, [scene]);

  useEffect(() => {
    const root = ref.current;
    const canvas = canvasRef.current;
    // The scene writes its progress (--exit) on the stage; the sky reads it there.
    const stage = root?.parentElement;
    if (!root || !canvas || !stage) return;
    root.dataset.scene = sceneRef.current;
    const flat = () => {
      root.dataset.flat = "";
    };

    if (forceFlat) {
      flat();
      return () => {
        delete root.dataset.flat;
      };
    }
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
      ground: at("u_ground"),
      mix: at("u_mix"),
    };
    gl.uniform1i(at("u_img"), 0);
    gl.uniform1i(at("u_prev"), 1);
    gl.uniform1f(u.mix, 1);

    let still = prefersReducedMotion();
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

    // Scene crossfade: the shown ground eases from the old paper to the new.
    const textures = [gl.createTexture(), gl.createTexture()];
    let current = 0;
    let shownScene = sceneRef.current;
    let ground = groundOf(shownScene);
    let fromGround = ground;
    let toGround = ground;
    let fadeStart = -1;
    let loads = 0;

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

      let mixing = false;
      if (fadeStart >= 0) {
        if (fadeStart === 0) fadeStart = time;
        const m = still ? 1 : easeInOut((time - fadeStart) / 1000 / CROSSFADE);
        ground = fromGround.map((channel, i) => channel + (toGround[i]! - channel) * m);
        gl.uniform1f(u.mix, m);
        if (m >= 1) fadeStart = -1;
        else mixing = true;
      }

      const exit = readExit();
      const develop = still ? 1 : easeOutCubic(age / ARRIVAL);
      const settling = Math.abs(aim.x - lean.x) + Math.abs(aim.y - lean.y) > 0.001;
      const gone = exit > 0.999;
      // While nothing but the slow current moves, every other frame is
      // enough; the pointer, the scroll and the arrival get every frame.
      const busy = develop < 1 || stirring || settling || mixing || Math.abs(exit - drawnExit) > 0.0005;
      tick += 1;
      if (!busy && !still && !gone && tick % 2 === 1) {
        if (visible) frame = requestAnimationFrame(draw);
        return;
      }
      gl.uniform1f(u.time, still ? 0 : age + 40);
      gl.uniform2f(u.lean, lean.x, lean.y);
      gl.uniform4fv(u.wake, wake);
      gl.uniform1f(u.develop, develop);
      gl.uniform1f(u.exit, exit);
      gl.uniform1f(u.dither, develop < 1 || exit > 0.001 ? 1 : 0);
      gl.uniform3fv(u.ground, ground);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawnExit = exit;
      // An opaque canvas is black until its first frame; it stays hidden over
      // the ground colour until then (a sky that starts below the fold).
      if (!canvas.hasAttribute("data-drawn")) canvas.setAttribute("data-drawn", "");

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
      if (visible && (moving || mixing || develop < 1 || ((stirring || settling) && !gone))) {
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
    const listenPointer = (on: boolean) => {
      if (on && fine) window.addEventListener("pointermove", move, { passive: true });
      else window.removeEventListener("pointermove", move);
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
    const motion = new MutationObserver(() => {
      const now = prefersReducedMotion();
      if (now === still) return;
      still = now;
      listenPointer(!still);
      wakeUp();
    });
    const onContextLost = (event: Event) => {
      event.preventDefault();
      alive = false;
      cancelAnimationFrame(frame);
      flat();
    };

    const upload = (texture: WebGLTexture | null, unit: number, image: HTMLImageElement) => {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    };

    const load = (target: Scene) => {
      const ticket = ++loads;
      const source = plainSky(target, narrow);
      picture(`${source}.avif`)
        .catch(() => picture(`${source}.jpg`))
        .then((image) => {
          if (!alive || ticket !== loads) return;
          if (!ready) {
            upload(textures[current], gl.TEXTURE1, image);
            upload(textures[current], gl.TEXTURE0, image);
            gl.uniform2f(u.size, image.naturalWidth, image.naturalHeight);
            ground = groundOf(target);
            shownScene = target;
            size();
            ready = true;
            stage.dataset.sky = "live";
          } else {
            const incoming = 1 - current;
            upload(textures[incoming], gl.TEXTURE0, image);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, textures[current]);
            current = incoming;
            fromGround = ground;
            toGround = groundOf(target);
            shownScene = target;
            gl.uniform1f(u.mix, 0);
            fadeStart = 0;
          }
          wakeUp();
        })
        .catch(() => {
          if (!ready) flat();
        });
    };

    controls.current = {
      scene: (target) => {
        if (target !== shownScene || loads === 0) load(target);
      },
    };
    load(sceneRef.current);

    resize.observe(root);
    sight.observe(root);
    motion.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("scroll", onScroll, { passive: true });
    canvas.addEventListener("webglcontextlost", onContextLost);
    listenPointer(!still);

    return () => {
      alive = false;
      controls.current = null;
      cancelAnimationFrame(frame);
      resize.disconnect();
      sight.disconnect();
      motion.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("scroll", onScroll);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      listenPointer(false);
      for (const texture of textures) gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      delete stage.dataset.sky;
      canvas.removeAttribute("data-drawn");
    };
  }, [forceFlat]);

  return (
    <div ref={ref} className={cn(styles.sky, className)} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
