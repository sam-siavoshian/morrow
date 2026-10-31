import type { CliKind } from "@morrow/contracts";
import { useId } from "react";
import { cn } from "@/lib/cn";

export const HARNESS_LABEL: Record<CliKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  cursor: "Cursor Agent",
  gemini: "Gemini CLI",
  grok: "Grok",
};

/** Every coding CLI we run, in the order the copy names them. */
export const HARNESSES = ["claude", "codex", "opencode", "cursor", "gemini", "grok"] as const satisfies readonly CliKind[];

/*
 * Official marks, inlined so they paint with the first byte and cost no request:
 * - Claude Code: simple-icons@16.36.0 `claudecode` (CC0), brand colour #D97757.
 * - Codex, Cursor, Gemini, Grok: @lobehub/icons-static-svg@1.101.0 `codex-color`, `cursor`, `gemini-color`
 *   and `grok` (MIT).
 * - opencode: anomalyco/opencode `packages/identity/mark.svg` and `mark-light.svg`.
 */
const CLAUDE_CODE =
  "M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z";
const CODEX_TILE =
  "M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z";
const CODEX =
  "M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z";
const CURSOR =
  "M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z";
const GEMINI =
  "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z";
const GROK =
  "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815";

/** Single-colour glyphs drawn in `currentColor` on the tile, with their size as a share of the tile. */
const GLYPH: Partial<Record<CliKind, { d: string; scale: number }>> = {
  claude: { d: CLAUDE_CODE, scale: 0.72 },
  cursor: { d: CURSOR, scale: 0.66 },
  grok: { d: GROK, scale: 0.62 },
};

function Mark({ cli, size }: { cli: CliKind; size: number }) {
  // One gradient id per icon: many icons share a page, and SVG ids are document-wide. Only id-safe characters, so
  // `url(#...)` resolves whatever form React's ids take.
  const gradient = `harness-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  if (cli === "opencode") {
    // The full official mark is already a square tile; the light and dark variants swap with the theme.
    return (
      <svg viewBox="0 0 512 512" width={size} height={size} aria-hidden>
        <rect width="512" height="512" className="fill-[#FDFCFC] dark:fill-[#131010]" />
        <path d="M320 224V352H192V224H320Z" className="fill-[#E6E5E6] dark:fill-[#5A5858]" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
          className="fill-[#17181C] dark:fill-white"
        />
      </svg>
    );
  }
  if (cli === "codex") {
    // The colour mark is its own tile: a white square with the blue-violet glyph, which reads on dark scenes too.
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
        <path d={CODEX_TILE} fill="#fff" />
        <path d={CODEX} fill={`url(#${gradient})`} />
        <defs>
          <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="3" y2="21">
            <stop stopColor="#B1A7FF" />
            <stop offset=".5" stopColor="#7A9DFF" />
            <stop offset="1" stopColor="#3941FF" />
          </linearGradient>
        </defs>
      </svg>
    );
  }
  if (cli === "gemini") {
    // The four-colour sparkle on a white tile: a blue base with green, red and yellow washes from three corners.
    const px = size * 0.72;
    return (
      <svg viewBox="0 0 24 24" width={px} height={px} aria-hidden>
        <path d={GEMINI} fill="#3186FF" />
        <path d={GEMINI} fill={`url(#${gradient}-g)`} />
        <path d={GEMINI} fill={`url(#${gradient}-r)`} />
        <path d={GEMINI} fill={`url(#${gradient}-y)`} />
        <defs>
          <linearGradient id={`${gradient}-g`} gradientUnits="userSpaceOnUse" x1="7" x2="11" y1="15.5" y2="12">
            <stop stopColor="#08B962" />
            <stop offset="1" stopColor="#08B962" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${gradient}-r`} gradientUnits="userSpaceOnUse" x1="8" x2="11.5" y1="5.5" y2="11">
            <stop stopColor="#F94543" />
            <stop offset="1" stopColor="#F94543" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${gradient}-y`} gradientUnits="userSpaceOnUse" x1="3.5" x2="17.5" y1="13.5" y2="12">
            <stop stopColor="#FABC12" />
            <stop offset=".46" stopColor="#FABC12" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
    );
  }
  const glyph = GLYPH[cli];
  if (!glyph) return null;
  const px = size * glyph.scale;
  return (
    <svg viewBox="0 0 24 24" width={px} height={px} fill="currentColor" aria-hidden>
      <path fillRule="evenodd" clipRule="evenodd" d={glyph.d} />
    </svg>
  );
}

const TILE: Record<CliKind, string> = {
  claude: "bg-[#D97757] text-white",
  // The mark draws its own white tile; a hairline keeps it from melting into white cards.
  codex: "outline-1 -outline-offset-1 outline-black/10 dark:outline-transparent",
  // The light mark is near-white: a hairline keeps the tile visible on white cards.
  opencode: "outline-1 -outline-offset-1 outline-black/10 dark:outline-white/12",
  // Dark tiles in both themes; a hairline separates them from the night scene.
  cursor: "bg-[#14120B] text-[#EDECEC] dark:outline-1 dark:-outline-offset-1 dark:outline-white/14",
  // White tile like Codex; a hairline keeps it from melting into white cards.
  gemini: "bg-white outline-1 -outline-offset-1 outline-black/10 dark:outline-transparent",
  grok: "bg-black text-white dark:outline-1 dark:-outline-offset-1 dark:outline-white/14",
};

type HarnessIconProps = {
  cli: CliKind;
  /** Pixel size of the tile. */
  size?: number;
  /** Adds a ring so stacked icons separate cleanly. */
  stacked?: boolean;
  /** Decorative when the harness name is already visible next to it. */
  decorative?: boolean;
  className?: string;
};

export function HarnessIcon({ cli, size = 20, stacked = false, decorative = false, className }: HarnessIconProps) {
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : HARNESS_LABEL[cli]}
      aria-hidden={decorative || undefined}
      className={cn(
        "inline-grid shrink-0 place-items-center overflow-hidden rounded-[28%]",
        TILE[cli],
        stacked && "ring-2 ring-[var(--color-canvas)]",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Mark cli={cli} size={size} />
    </span>
  );
}

/** Overlapping row of harness icons, one per active worker. Shows "+N" past `max`. */
export function HarnessStack({ clis, size = 16, max = 4, className }: { clis: CliKind[]; size?: number; max?: number; className?: string }) {
  const shown = clis.slice(0, max);
  const extra = clis.length - shown.length;
  return (
    <span className={cn("inline-flex items-center", className)} aria-label={clis.map((c) => HARNESS_LABEL[c]).join(", ")} role="img">
      {shown.map((cli, i) => (
        <HarnessIcon key={`${cli}-${i}`} cli={cli} size={size} stacked decorative className={i > 0 ? "-ml-1" : undefined} />
      ))}
      {extra > 0 && <span className="ml-1 text-2xs text-[var(--color-muted)] tabular-nums">+{extra}</span>}
    </span>
  );
}
