import { useEffect, useState } from "react";

/** How long an overlay takes to leave: --duration-base. */
const EXIT_MS = 160;

/**
 * Keeps an overlay drawn for its short exit after `open` turns false, so a
 * dialog fades and settles out instead of vanishing. While it leaves it is
 * `exiting`: callers drop its dialog role and make it inert, so nothing can
 * reach a dialog that is already closed. With reduced motion it goes at once.
 */
export function usePresence(open: boolean): {
  mounted: boolean;
  exiting: boolean;
  motion: "enter" | "exit";
} {
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  useEffect(() => {
    if (open || !shown) return undefined;
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(
      () => setShown(false),
      reduce ? 0 : EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [open, shown]);
  return {
    mounted: open || shown,
    exiting: !open && shown,
    motion: open ? "enter" : "exit",
  };
}
