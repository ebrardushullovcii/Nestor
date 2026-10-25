import { useContext, useEffect, useRef } from "react";

import { KeptRouteVisibilityContext } from "@renderer/features/job-finder/lib/kept-route-visibility";

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export interface ListKeys {
  rows: readonly { id: number }[];
  activeId: number | null;
  setActiveId: (id: number) => void;
  /** Ticks or unticks a row (X or Space; Shift for a range). */
  toggle: (id: number, shiftKey: boolean) => void;
  /** Ctrl/Cmd+A. */
  selectAll: () => void;
  /** Escape. */
  clearSelection: () => void;
  /** U or Ctrl/Cmd+Z. */
  undo?: () => void;
  /** O or Enter on the active row. */
  open?: (id: number) => void;
  /** The screen's own keys, lowercase: `{ s: shortlist, h: hide }`. */
  actions?: Readonly<Record<string, () => void>>;
  /** Asked for when the active row nears the end of what is loaded. */
  loadMore?: () => void;
  /** Focused with "/". */
  filterSelector?: string;
}

/**
 * The same keys on every list: J/K or arrows to move, X or Space to tick,
 * Ctrl+A for all, Escape to clear, U to undo, O to open, "/" to filter, and
 * the screen's own letters. Quiet while typing, while a dialog is open, and
 * while the screen is kept hidden behind another one.
 */
export function useListKeys(keys: ListKeys): void {
  const latest = useRef(keys);
  latest.current = keys;
  const visibility = useContext(KeptRouteVisibilityContext);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (visibility.isHidden() || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("button, a, [role='button']") &&
        (event.key === "Enter" || event.key === " ")
      ) {
        return;
      }
      if (isTyping(target)) {
        if (event.key === "Escape" && target instanceof HTMLElement)
          target.blur();
        return;
      }
      if (document.querySelector('[aria-modal="true"]')) return;
      const current = latest.current;
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      const index = current.rows.findIndex(
        (row) => row.id === current.activeId,
      );
      const go = (delta: number) => {
        const next = Math.max(
          0,
          Math.min(current.rows.length - 1, index + delta),
        );
        const row = current.rows[next];
        if (row) current.setActiveId(row.id);
        if (delta > 0 && next >= current.rows.length - 5) current.loadMore?.();
      };
      if (mod && key === "a") current.selectAll();
      else if (mod && key === "z" && current.undo) current.undo();
      else if (mod || event.altKey) return;
      else if (key === "arrowdown" || key === "j") go(1);
      else if (key === "arrowup" || key === "k") go(-1);
      else if (key === "x" || key === " ") {
        if (current.activeId !== null)
          current.toggle(current.activeId, event.shiftKey);
      } else if (key === "escape") current.clearSelection();
      else if (key === "u" && current.undo) current.undo();
      else if ((key === "o" || key === "enter") && current.open) {
        if (current.activeId !== null) current.open(current.activeId);
      } else if (key === "/" && current.filterSelector) {
        document.querySelector<HTMLElement>(current.filterSelector)?.focus();
      } else {
        const action = current.actions?.[key];
        if (!action) return;
        action();
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visibility]);
}
