# Third-party notices

Morrow includes or adapts the work listed below. The web app's full list,
with every library and the license texts, is in
[`web/THIRD_PARTY_NOTICES.md`](web/THIRD_PARTY_NOTICES.md). This file covers
first-run setup and the agent logos.

## Zephium (MPL-2.0)

Source: https://github.com/zephium-browser/Zephium

Files that contain code adapted from Zephium stay under the Mozilla Public
License 2.0 and carry the MPL header at their top, with a line naming the
Zephium file they come from. Their source is the file itself in this
repository.

| Our file | Adapted from |
|---|---|
| `web/public/sounds/intro.m4a` | `assets/sounds/intro.m4a`, copied unchanged (the intro sound) |
| `web/src/components/onboarding/formation.ts` | `frame/src/features/onboarding/lib/formation.ts` (the name forming from halftone dots) |
| `web/src/components/onboarding/intro-step.tsx` | `frame/src/features/onboarding/components/Onboarding.svelte` (the welcome scene) |
| `web/src/components/onboarding/step-chrome.tsx` | `frame/src/features/onboarding/components/Onboarding.svelte` (heading, scene and step bar) |
| `web/src/components/onboarding/keys.ts` | `frame/src/features/onboarding/components/Onboarding.svelte` (the Enter handling) |
| `film/src/sky/Sky.tsx` | via `web/src/components/sky/clouds.tsx` (the sky shader, driven by the video frame) |
| `film/src/ui/Wordmark.tsx` | via `web/src/components/onboarding/formation.ts` (the name forming from halftone dots, driven by the video frame) |

The way the sound is played is our own; Zephium plays it natively from
`desktop/src/intro_sound.rs`. The Zephium name, logo and wordmark are not
licensed under the MPL and are not used here.

MPL-2.0 full text: https://mozilla.org/MPL/2.0/

## Launch film

`film/` is the Remotion project for the launch film. Besides the Zephium files
above:

- `film/public.nosync/audio/music.wav` is an edit of "Afro House" by ArtIssizm, from
  Pixabay (https://pixabay.com/music/afrobeat-afro-house-455843/), under the
  Pixabay Content License (https://pixabay.com/service/license-summary/). No
  attribution is required; the track is not registered with Content ID.

## Agent logos

The marks in `web/src/components/harness/harness-icon.tsx`, inlined as SVG
paths. The names and logos are trademarks of their owners and are used only to
show which CLI is which.

| Mark | Source | License |
|---|---|---|
| Claude Code | simple-icons `claudecode` (https://github.com/simple-icons/simple-icons) | CC0-1.0 |
| Codex | `@lobehub/icons-static-svg` 1.101.0 `codex-color` (https://github.com/lobehub/lobe-icons) | MIT |
| Cursor Agent | `@lobehub/icons-static-svg` 1.101.0 `cursor` (https://github.com/lobehub/lobe-icons) | MIT |
| Gemini CLI | `@lobehub/icons-static-svg` 1.101.0 `gemini-color` (https://github.com/lobehub/lobe-icons) | MIT |
| Grok | `@lobehub/icons-static-svg` 1.101.0 `grok` (https://github.com/lobehub/lobe-icons) | MIT |
| opencode | anomalyco/opencode `packages/identity/mark.svg` and `mark-light.svg` (https://github.com/anomalyco/opencode) | MIT |
