"use client";

import { TASK_CRITERION_MAX } from "@morrow/contracts";
import { ChevronDown, ListChecks, Plus, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { requestComposerFocus } from "@/components/shell/composer-focus";
import { cn } from "@/lib/cn";
import { AttachedBanner } from "./attached-banner";
import { UI_MAX_CRITERIA } from "./drafts";

type CriteriaBannerProps = {
  criteria: string[];
  onChange: (criteria: string[]) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Bumped to move focus to a fresh line (the /criteria command). */
  focusRequest: number;
  disabled?: boolean;
};

/**
 * Acceptance criteria as a checklist attached above the card, not crammed into the prompt.
 * Enter adds a line, Backspace on an empty line removes it. Ten lines at most.
 */
export function CriteriaBanner({ criteria, onChange, expanded, onExpandedChange, focusRequest, disabled }: CriteriaBannerProps) {
  const list = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const filled = criteria.filter((c) => c.trim()).length;

  const focusLine = (index: number) => {
    pendingFocus.current = index;
  };

  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    list.current?.querySelectorAll("input")[index]?.focus();
  });

  useEffect(() => {
    if (focusRequest === 0) return;
    onExpandedChange(true);
    const empty = criteria.findIndex((c) => !c.trim());
    if (empty >= 0) focusLine(empty);
    else if (criteria.length < UI_MAX_CRITERIA) {
      focusLine(criteria.length);
      onChange([...criteria, ""]);
    } else focusLine(criteria.length - 1);
    // Only a new request should move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  const update = (index: number, value: string) =>
    onChange(criteria.map((c, i) => (i === index ? value.slice(0, TASK_CRITERION_MAX) : c)));

  const add = (after: number) => {
    if (criteria.length >= UI_MAX_CRITERIA) return;
    const next = [...criteria];
    next.splice(after + 1, 0, "");
    focusLine(after + 1);
    onChange(next);
  };

  const remove = (index: number) => {
    const next = criteria.filter((_, i) => i !== index);
    focusLine(Math.max(0, index - 1));
    onChange(next);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      add(index);
    } else if (event.key === "Backspace" && criteria[index] === "" && criteria.length > 0) {
      event.preventDefault();
      remove(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      requestComposerFocus();
    }
  };

  return (
    <AttachedBanner>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="composer-criteria"
        onClick={() => onExpandedChange(!expanded)}
        className="-mx-1 flex h-7 w-[calc(100%+0.5rem)] items-center gap-2 rounded-[8px] px-1 text-left text-[13px] font-[550] text-label-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ListChecks className="size-3.5 text-muted" aria-hidden="true" />
        <span className="flex-1">
          Acceptance criteria
          {filled > 0 ? <span className="ml-1.5 font-[450] text-muted tabular-nums">{filled}</span> : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 text-muted transition-transform duration-200 ease-out", !expanded && "-rotate-90")}
        />
      </button>
      {expanded ? (
        <div id="composer-criteria" className="pb-1.5">
          <ul ref={list} className="flex flex-col">
            {criteria.map((value, index) => (
              <li key={index} className="group flex items-center gap-2">
                <span aria-hidden="true" className="size-3 shrink-0 rounded-[3.5px] shadow-[inset_0_0_0_1.25px_var(--color-border-strong)]" />
                <input
                  value={value}
                  disabled={disabled}
                  maxLength={TASK_CRITERION_MAX}
                  onChange={(e) => update(index, e.target.value)}
                  onKeyDown={(e) => onKey(e, index)}
                  placeholder="Tests pass, the API returns 404 for unknown ids…"
                  aria-label={`Criterion ${index + 1}`}
                  className="h-8 min-w-0 flex-1 bg-transparent text-[16px] text-text outline-none placeholder:text-faint sm:h-7 sm:text-[13.5px]"
                />
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label={`Remove criterion ${index + 1}`}
                  className="grid size-7 place-items-center rounded-[6px] text-faint outline-none hover:bg-fill-hover hover:text-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:size-6 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          {criteria.length < UI_MAX_CRITERIA ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => add(criteria.length - 1)}
              className="mt-0.5 -ml-1 flex h-7 items-center gap-1.5 rounded-[6px] px-1 text-[13px] font-[500] text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-64"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              Add criterion
            </button>
          ) : (
            <p className="mt-1 text-[12px] text-faint">Ten is the limit. Fold related checks into one line.</p>
          )}
        </div>
      ) : null}
    </AttachedBanner>
  );
}
