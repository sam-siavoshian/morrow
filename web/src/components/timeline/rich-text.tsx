import { memo } from "react";
import { cn } from "@/lib/cn";
import { linkify } from "./linkify";

/**
 * Untrusted agent or human text, rendered as text. Line breaks are kept; http(s) URLs become links
 * that open in a new tab with no opener and no referrer. Nothing is ever parsed as HTML or markdown.
 */
export const RichText = memo(function RichText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", className)}>
      {linkify(text).map((part, i) =>
        part.kind === "text" ? (
          part.text
        ) : (
          <a
            key={i}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="font-[500] text-soft-sky-ink underline decoration-soft-sky-edge underline-offset-[3px] transition-colors hover:decoration-current"
          >
            {part.text}
          </a>
        ),
      )}
    </span>
  );
});
