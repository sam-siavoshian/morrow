// Writes the app icons from the CloudMark data:
//   src/app/icon.svg        browsers, any size
//   src/app/apple-icon.png  180x180, full bleed (iOS rounds it itself)
//   src/app/favicon.ico     16, 32 and 48 for old browsers and bookmarks
// Run with `bun run bake:icons`. Needs rsvg-convert and ImageMagick (`magick`).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudMarkSvg } from "../src/components/brand/cloud-mark-data";

const APP = fileURLToPath(new URL("../src/app/", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "morrow-icons-"));

function run(command: string[]) {
  const result = Bun.spawnSync(command, { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString()}`);
}

try {
  writeFileSync(join(APP, "icon.svg"), `${cloudMarkSvg()}\n`);

  const bleed = join(work, "bleed.svg");
  writeFileSync(bleed, cloudMarkSvg({ squircle: false }));
  run(["rsvg-convert", "-w", "180", "-h", "180", bleed, "-o", join(APP, "apple-icon.png")]);

  const sizes = [16, 32, 48].map((size) => {
    const out = join(work, `icon-${size}.png`);
    run(["rsvg-convert", "-w", String(size), "-h", String(size), join(APP, "icon.svg"), "-o", out]);
    return out;
  });
  run(["magick", ...sizes, join(APP, "favicon.ico")]);
  console.log("icons written to src/app");
} finally {
  rmSync(work, { recursive: true, force: true });
}
