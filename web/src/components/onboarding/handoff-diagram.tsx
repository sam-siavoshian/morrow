import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import styles from "./handoff-diagram.module.css";

/** Inner width of each box, in characters. Everything below is laid out on this grid. */
const INNER = 36;
/** Column of the connector under the first box. */
const JOIN = 17;

type Tone = "text" | "muted" | "faint" | "warn" | "ok" | "sky";
type Segment = readonly [string, Tone?];

const TONE: Record<Tone, string> = {
  text: "text-text",
  muted: "text-muted",
  faint: "text-faint",
  warn: "text-soft-peach-ink",
  ok: "text-soft-mint-ink",
  sky: "text-soft-sky-ink",
};

function Line({ children }: { children: ReactNode }) {
  return <div className="whitespace-pre">{children}</div>;
}

function Seg({ text, tone = "text", className, style }: { text: string; tone?: Tone; className?: string; style?: CSSProperties }) {
  return (
    <span className={cn(TONE[tone], className)} style={style}>
      {text}
    </span>
  );
}

function Top({ title }: { title: string }) {
  return (
    <Line>
      <Seg text="╭─ " tone="faint" />
      <Seg text={title} tone="text" className="font-[600]" />
      <Seg text={` ${"─".repeat(INNER - title.length - 3)}╮`} tone="faint" />
    </Line>
  );
}

function Row({ segments }: { segments: readonly Segment[] }) {
  const used = segments.reduce((n, [text]) => n + text.length, 0);
  return (
    <Line>
      <Seg text="│ " tone="faint" />
      {segments.map(([text, tone], index) => (
        <Seg key={index} text={text} tone={tone} />
      ))}
      <Seg text={`${" ".repeat(Math.max(0, INNER - 2 - used))} │`} tone="faint" />
    </Line>
  );
}

function Bottom({ join }: { join: boolean }) {
  return (
    <Line>
      <Seg
        text={join ? `╰${"─".repeat(JOIN)}┬${"─".repeat(INNER - 1 - JOIN)}╯` : `╰${"─".repeat(INNER)}╯`}
        tone="faint"
      />
    </Line>
  );
}

/** One cell of the connector; the light walks down them in order. */
function Wire({ index, glyph, label }: { index: number; glyph: string; label?: readonly Segment[] }) {
  return (
    <Line>
      {" ".repeat(JOIN + 1)}
      <Seg text={glyph} tone="faint" className={styles.flow} style={{ "--i": index } as CSSProperties} />
      {label?.map(([text, tone], i) => (
        <Seg key={i} text={text} tone={tone} />
      ))}
    </Line>
  );
}

/**
 * An agent hits its usage limit, its work is checkpointed to git, and an agent on another
 * teammate's machine picks it up. Drawn in box glyphs, opencode style.
 */
export function HandoffDiagram({ className }: { className?: string }) {
  return (
    <figure
      role="img"
      aria-label="Claude Code on Ada's machine hits its usage limit. Its work is saved as a git checkpoint, and Codex on Linus's machine acknowledges and carries on."
      className={cn("font-mono text-[11px] leading-[1.45] select-none min-[400px]:text-[12px] sm:text-[13px]", className)}
      style={{ fontVariantLigatures: "none" }}
    >
      <div aria-hidden="true">
        <Top title="Claude Code · ada" />
        <Row segments={[["w-9f2c-api", "muted"], ["  writing routes"]]} />
        <Row segments={[["▲ usage limit", "warn"], [", resets 4:10 pm", "muted"]]} />
        <Bottom join />
        <Wire index={0} glyph="│" label={[[" checkpoint ", "muted"], ["9f2c1e7", "sky"]]} />
        <Wire index={1} glyph="│" label={[[" on morrow/9f2c/api", "muted"]]} />
        <Wire index={2} glyph="▼" />
        <Top title="Codex · linus" />
        <Row segments={[["w-9f2c-api-e2", "muted"], ["  ACK, picking up"]]} />
        <Row segments={[["✓ 14 tests pass", "ok"]]} />
        <Bottom join={false} />
      </div>
    </figure>
  );
}
