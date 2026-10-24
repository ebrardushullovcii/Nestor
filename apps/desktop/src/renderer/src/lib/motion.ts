import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * Small motion for things that change in place. Every animation here only
 * decorates content that is already rendered: opacity and transform on the
 * compositor, 120-180 ms, nothing waits for it, and none of it runs when the
 * person asks for reduced motion (the global CSS rule cannot reach the Web
 * Animations API, so it is checked here).
 */
export function prefersMotion(): boolean {
  return !(
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const EASE_OUT = "cubic-bezier(0.2, 0, 0, 1)";

export function animateIn(
  element: Element | null | undefined,
  from: Keyframe,
  duration = 160,
): void {
  if (!element || typeof element.animate !== "function" || !prefersMotion())
    return;
  element.animate([from, { opacity: 1, transform: "none" }], {
    duration,
    easing: EASE_OUT,
  });
}

/** A screen that just replaced the previous one in the same box. */
export const ENTER_FROM_BELOW: Keyframe = {
  opacity: 0.55,
  transform: "translateY(6px)",
};

/**
 * Runs `animateIn` on the element whenever `key` changes after the first
 * render. The first render is the element's own entrance and is left alone.
 */
export function useEnterMotion(
  ref: RefObject<Element | null>,
  key: unknown,
  options: { from?: Keyframe; duration?: number } = {},
): void {
  const { from = ENTER_FROM_BELOW, duration = 160 } = options;
  const previousKey = useRef(key);
  useLayoutEffect(() => {
    if (Object.is(previousKey.current, key)) return;
    previousKey.current = key;
    animateIn(ref.current, from, duration);
  }, [duration, from, key, ref]);
}

/**
 * When one or a few rows leave a list (shortlisted, hidden, removed), the rows
 * that move up slide from their old slot into the new one; a row that comes
 * back (Undo) fades in and the rows under it slide down. Rows in these lists
 * share one height, so a move of `n` slots is `n * 100%` of the row's own
 * height and nothing is measured. A page, filter or sort change replaces the
 * list instead, and only fades it in.
 */
export function useListMoveMotion(
  listRef: RefObject<HTMLElement | null>,
  ids: readonly string[],
  maxChanged = 6,
): void {
  const previousIds = useRef(ids);
  useLayoutEffect(() => {
    const before = previousIds.current;
    if (before === ids) return;
    previousIds.current = ids;
    const list = listRef.current;
    if (!list || !prefersMotion()) return;
    const beforeIndex = new Map(before.map((id, index) => [id, index]));
    const afterIds = new Set(ids);
    const added = ids.filter((id) => !beforeIndex.has(id));
    const removed = before.filter((id) => !afterIds.has(id));
    if (added.length === 0 && removed.length === 0) return;
    if (added.length + removed.length > maxChanged) {
      animateIn(list, { opacity: 0.6 }, 140);
      return;
    }
    const rowById = new Map<string, HTMLElement>();
    for (const element of list.querySelectorAll<HTMLElement>(
      "[data-collection-item-id]",
    )) {
      // The row is the list's own child that holds this item.
      let row: HTMLElement = element;
      while (row.parentElement && row.parentElement !== list) {
        row = row.parentElement;
      }
      const id = element.dataset.collectionItemId;
      if (id && row.parentElement === list) rowById.set(id, row);
    }
    ids.forEach((id, index) => {
      const row = rowById.get(id);
      if (!row || typeof row.animate !== "function") return;
      const previous = beforeIndex.get(id);
      if (previous === undefined) {
        animateIn(row, { opacity: 0, transform: "scale(0.98)" }, 180);
        return;
      }
      const slots = previous - index;
      if (slots === 0) return;
      row.animate(
        [{ transform: `translateY(${slots * 100}%)` }, { transform: "none" }],
        { duration: 180, easing: EASE_OUT },
      );
    });
  }, [ids, listRef, maxChanged]);
}
