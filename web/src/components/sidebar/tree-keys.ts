// Port of t3code's sidebarTree keyboard model: one ARIA tree, one Tab stop, arrows move between
// rows, Home/End jump, Right opens a closed shelf or enters it, Left closes it or goes to its header.

import type { KeyboardEvent } from "react";

const TREE_ROW = '[role="treeitem"][data-tree-key]';

export type TreeMove = { focus: HTMLElement } | { click: HTMLElement } | null;

/** What a key does on a row. Pure over the rows the tree shows, so it is testable without a browser. */
export function resolveTreeKey(key: string, row: HTMLElement, rows: readonly HTMLElement[]): TreeMove {
  const index = rows.indexOf(row);
  if (index < 0) return null;
  switch (key) {
    case "ArrowDown":
      return rows[index + 1] ? { focus: rows[index + 1]! } : null;
    case "ArrowUp":
      return rows[index - 1] ? { focus: rows[index - 1]! } : null;
    case "Home":
      return rows[0] && rows[0] !== row ? { focus: rows[0] } : null;
    case "End":
      return rows.at(-1) && rows.at(-1) !== row ? { focus: rows.at(-1)! } : null;
    case "ArrowRight": {
      if (row.getAttribute("aria-expanded") === "false") return { click: row };
      const child = rows.find((r) => r.dataset.treeParent === row.dataset.treeKey);
      return child ? { focus: child } : null;
    }
    case "ArrowLeft": {
      if (row.getAttribute("aria-expanded") === "true") return { click: row };
      const parent = rows.find((r) => r.dataset.treeKey === row.dataset.treeParent);
      return parent ? { focus: parent } : null;
    }
    case " ":
      // Links open on Enter natively; Space opens rows and toggles shelves like a button.
      return { click: row };
    default:
      return null;
  }
}

export function handleTreeKeyDown(event: KeyboardEvent<HTMLElement>, tree: HTMLElement): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.nativeEvent.isComposing) return;
  const row = event.target;
  if (!(row instanceof HTMLElement) || !row.matches(TREE_ROW)) return;
  const rows = Array.from(tree.querySelectorAll<HTMLElement>(TREE_ROW));
  const move = resolveTreeKey(event.key, row, rows);
  if (!move) {
    // Arrow keys at the ends still belong to the tree, not the page scroll.
    if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") event.preventDefault();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if ("focus" in move) move.focus.focus({ preventScroll: false });
  else move.click.click();
}
