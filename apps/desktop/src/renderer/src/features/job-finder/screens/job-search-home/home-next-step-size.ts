import { useEffect, type RefObject } from "react";

/**
 * The Next step card's last height, so the launch Home can hold the same
 * space while the full workspace loads. The real card often runs to two
 * detail lines and an extra line below the buttons; without this the "Where
 * you are" tiles dropped about 50 px when it landed.
 */
const STORAGE_KEY = "nestor.job-finder.home.next-step-size.v1";

/** A wider or narrower window wraps the card differently. */
const SAME_WIDTH_TOLERANCE_PX = 32;

interface RememberedSize {
  height: number;
  windowWidth: number;
}

export function readRememberedNextStepHeight(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const size = JSON.parse(raw) as Partial<RememberedSize>;
    if (
      typeof size.height !== "number" ||
      typeof size.windowWidth !== "number" ||
      Math.abs(size.windowWidth - window.innerWidth) > SAME_WIDTH_TOLERANCE_PX
    )
      return null;
    return size.height;
  } catch {
    return null;
  }
}

/** Keeps the card's height as it changes; ResizeObserver forces no layout. */
export function useRememberNextStepHeight(
  ref: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    let last = 0;
    const observer = new ResizeObserver(([entry]) => {
      const height = Math.round(entry?.borderBoxSize[0]?.blockSize ?? 0);
      if (height <= 0 || height === last) return;
      last = height;
      try {
        globalThis.localStorage?.setItem(
          STORAGE_KEY,
          JSON.stringify({ height, windowWidth: window.innerWidth }),
        );
      } catch {
        // The launch card keeps its own size without a stored one.
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
}
