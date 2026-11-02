import { useLayoutEffect, type RefObject } from "react";

const EDGE_FADE = "2.5rem";

/**
 * Fades the edge of a sideways-scrolling row that has more past it, and
 * marks it (`data-more-before`, `data-more-after`): the cue that the row
 * scrolls. Written to the row directly, since it changes with every scroll.
 */
export function paintScrollEdges(row: HTMLElement | null): void {
  if (!row) return;
  const before = row.scrollLeft > 1;
  const after = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
  if (before) row.dataset.moreBefore = "true";
  else delete row.dataset.moreBefore;
  if (after) row.dataset.moreAfter = "true";
  else delete row.dataset.moreAfter;
  const start = before ? `transparent, black ${EDGE_FADE}` : "black";
  const end = after ? `black calc(100% - ${EDGE_FADE}), transparent` : "black";
  const mask =
    before || after ? `linear-gradient(to right, ${start}, ${end})` : "";
  row.style.maskImage = mask;
  row.style.setProperty("-webkit-mask-image", mask);
}

/**
 * Keeps {@link paintScrollEdges} current for the row matching `selector`
 * inside `root` (or `root` itself without one): on scroll, and when the row
 * or its content changes size (a wider window, larger text, a label that
 * grows).
 */
export function useScrollEdgeFade(
  root: RefObject<HTMLElement | null>,
  selector?: string,
): void {
  useLayoutEffect(() => {
    const host = root.current;
    const row =
      host && selector ? host.querySelector<HTMLElement>(selector) : host;
    if (!row) return undefined;
    const paint = () => paintScrollEdges(row);
    paint();
    row.addEventListener("scroll", paint, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    observer?.observe(row);
    for (const child of row.children) observer?.observe(child);
    return () => {
      row.removeEventListener("scroll", paint);
      observer?.disconnect();
    };
  }, [root, selector]);
}
