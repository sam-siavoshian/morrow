import { ImageIcon } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { parseMarkdown, type Block, type Inline } from "./markdown";

const LINK = "font-[500] text-soft-sky-ink underline decoration-soft-sky-edge underline-offset-[3px] transition-colors hover:decoration-current";

/**
 * GitHub markdown from a pull request or comment, as React elements only, never injected HTML:
 * raw HTML shows as text, links open in a new tab with no opener and no referrer, images are links.
 */
export const MarkdownView = memo(function MarkdownView({ source, className }: { source: string; className?: string }) {
  const tree = useMemo(() => parseMarkdown(source), [source]);
  if (tree.length === 0) return <p className={cn("text-[13px] text-faint italic", className)}>No description.</p>;
  return <div className={cn("flex flex-col gap-2.5 text-[13.5px] leading-[1.55] text-text [overflow-wrap:anywhere]", className)}>{tree.map(block)}</div>;
});

function block(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "p":
      return <p key={key}>{b.c.map(inline)}</p>;
    case "h": {
      const size = b.level <= 2 ? "text-[15px]" : "text-[14px]";
      return (
        <p key={key} role="heading" aria-level={Math.min(6, b.level + 2)} className={cn("font-[650] tracking-[-0.01em] text-text", size)}>
          {b.c.map(inline)}
        </p>
      );
    }
    case "code":
      return (
        <pre key={key} className="max-h-96 overflow-auto rounded-row bg-fill px-3 py-2 font-mono text-[12.5px] leading-[1.5] shadow-hairline">
          <code>{b.text}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote key={key} className="flex flex-col gap-2 border-l-2 border-border pl-3 text-muted">
          {b.c.map(block)}
        </blockquote>
      );
    case "list": {
      const items = b.items.map((item, i) => (
        <li key={i} className={cn("pl-0.5", item.task !== null && "list-none")}>
          {item.task !== null ? (
            <span aria-label={item.task ? "Done:" : "Not done:"} className="mr-1.5 inline-block align-[-1px] font-mono text-[12px] text-muted">
              {item.task ? "[x]" : "[ ]"}
            </span>
          ) : null}
          <div className="inline-flex flex-col gap-1.5 align-top [&>p]:inline">{item.c.map(block)}</div>
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start} className="flex list-decimal flex-col gap-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={key} className="flex list-disc flex-col gap-1 pl-5">
          {items}
        </ul>
      );
    }
    case "table":
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <thead>
              <tr>
                {b.head.map((cell, i) => (
                  <th key={i} className="border-b border-border px-2 py-1 font-[600]">
                    {cell.map(inline)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} className="border-b border-border px-2 py-1 align-top">
                      {cell.map(inline)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} className="border-border" />;
  }
}

function inline(n: Inline, key: number): ReactNode {
  switch (n.t) {
    case "text":
      return n.v;
    case "br":
      return <br key={key} />;
    case "code":
      return (
        <code key={key} className="rounded-[5px] bg-fill px-1 py-px font-mono text-[0.92em]">
          {n.v}
        </code>
      );
    case "strong":
      return (
        <strong key={key} className="font-[650]">
          {n.c.map(inline)}
        </strong>
      );
    case "em":
      return <em key={key}>{n.c.map(inline)}</em>;
    case "del":
      return <del key={key}>{n.c.map(inline)}</del>;
    case "link":
      return (
        <a key={key} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>
          {n.c.map(inline)}
        </a>
      );
    case "image": {
      const label = n.alt.trim() || "Image";
      return n.href ? (
        <a key={key} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className={cn(LINK, "inline-flex items-center gap-1")}>
          <ImageIcon aria-hidden className="size-3.5" />
          {label}
        </a>
      ) : (
        <span key={key} className="inline-flex items-center gap-1 text-muted">
          <ImageIcon aria-hidden className="size-3.5" />
          {label}
        </span>
      );
    }
  }
}
