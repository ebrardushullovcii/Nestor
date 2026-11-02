/**
 * Scroll-area marks for the scrollbar rules in styles/globals.css, so every
 * scroll area (lists, details, main columns, the assistant) has one finish:
 * a thin thumb, hidden at rest, shown on the one area that is in use.
 *
 * - `data-scrolling` while an area moves and for a moment after, so its
 *   thumb shows during keyboard and wheel scrolling too.
 * - `data-scroll-hover` on the innermost scroll area under the pointer. A
 *   CSS `:hover` also matches every ancestor, so with the pointer over a
 *   list the page column around it showed a permanent thumb as well.
 * - `data-scroll-focus` on the innermost scroll area holding keyboard
 *   focus, so a keyboard reader sees where they are before moving.
 *
 * One capturing listener each for the whole window; scroll events do not
 * bubble, but they are captured.
 */
const SHOW_MS = 900;

function scrolls(element: Element): boolean {
  if (
    element.scrollHeight <= element.clientHeight &&
    element.scrollWidth <= element.clientWidth
  )
    return false;
  const style = getComputedStyle(element);
  return /(auto|scroll)/u.test(`${style.overflowY} ${style.overflowX}`);
}

/** The nearest ancestor (or itself) that actually scrolls. */
export function nearestScrollArea(start: EventTarget | null): Element | null {
  let element: Element | null = start instanceof Element ? start : null;
  while (element && element !== document.documentElement) {
    if (scrolls(element)) return element;
    element = element.parentElement;
  }
  return null;
}

function marker(name: string) {
  let current: Element | null = null;
  return (next: Element | null) => {
    if (next === current) return;
    current?.removeAttribute(name);
    next?.setAttribute(name, "");
    current = next;
  };
}

export function installScrollActivity(target: Document = document): () => void {
  const timers = new WeakMap<Element, number>();
  const onScroll = (event: Event) => {
    const element =
      event.target instanceof Document
        ? event.target.scrollingElement
        : event.target;
    if (!(element instanceof Element)) return;
    if (!element.hasAttribute("data-scrolling"))
      element.setAttribute("data-scrolling", "");
    const previous = timers.get(element);
    if (previous !== undefined) window.clearTimeout(previous);
    timers.set(
      element,
      window.setTimeout(() => {
        element.removeAttribute("data-scrolling");
        timers.delete(element);
      }, SHOW_MS),
    );
  };
  const hover = marker("data-scroll-hover");
  const focus = marker("data-scroll-focus");
  const onPointerOver = (event: Event) =>
    hover(nearestScrollArea(event.target));
  const onPointerOut = (event: Event) => {
    // Leaving the window: nothing is under the pointer any more.
    if ((event as PointerEvent).relatedTarget === null) hover(null);
  };
  const onFocusIn = (event: Event) => focus(nearestScrollArea(event.target));
  const onFocusOut = (event: Event) => {
    if ((event as FocusEvent).relatedTarget === null) focus(null);
  };
  const options = { capture: true, passive: true } as const;
  target.addEventListener("scroll", onScroll, options);
  target.addEventListener("pointerover", onPointerOver, options);
  target.addEventListener("pointerout", onPointerOut, options);
  target.addEventListener("focusin", onFocusIn, options);
  target.addEventListener("focusout", onFocusOut, options);
  return () => {
    target.removeEventListener("scroll", onScroll, { capture: true });
    target.removeEventListener("pointerover", onPointerOver, { capture: true });
    target.removeEventListener("pointerout", onPointerOut, { capture: true });
    target.removeEventListener("focusin", onFocusIn, { capture: true });
    target.removeEventListener("focusout", onFocusOut, { capture: true });
  };
}
