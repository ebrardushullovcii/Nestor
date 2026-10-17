import { useLayoutEffect, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@renderer/components/ui/button";

interface PageNavigationProps {
  page: number;
  pageCount: number;
  pending: boolean;
  onPageChange: (page: number) => void;
  previousLabel?: string;
  nextLabel?: string;
}

function pageNumbers(
  page: number,
  count: number,
): (number | "start-gap" | "end-gap")[] {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1);
  const start = Math.max(2, Math.min(page - 1, count - 4));
  const end = Math.min(count - 1, Math.max(page + 1, 5));
  return [
    1,
    ...(start > 2 ? ["start-gap" as const] : []),
    ...Array.from({ length: end - start + 1 }, (_, index) => start + index),
    ...(end < count - 1 ? ["end-gap" as const] : []),
    count,
  ];
}

/**
 * Numbered shortcuts stay bounded even when a collection has thousands of
 * pages. The arrows are icons at every width, named for screen readers and in
 * their tooltips, so every list's pager looks the same whatever its width.
 */
export function PageNavigation({
  page,
  pageCount,
  pending,
  onPageChange,
  previousLabel = "Previous page",
  nextLabel = "Next page",
}: PageNavigationProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{
    element: HTMLElement;
    direction?: "previous" | "next";
  } | null>(null);

  useLayoutEffect(() => {
    if (pending || !pendingFocus.current) return;
    const { element, direction } = pendingFocus.current;
    pendingFocus.current = null;
    if (element.isConnected && !element.hasAttribute("disabled")) {
      element.focus();
      return;
    }
    const fallback = direction
      ? groupRef.current?.querySelector<HTMLButtonElement>(
          `[data-page-direction="${direction === "next" ? "previous" : "next"}"]`,
        )
      : groupRef.current?.querySelector<HTMLButtonElement>(
          '[aria-current="page"]',
        );
    fallback?.focus();
  }, [page, pending]);

  const move = (
    target: number,
    element: HTMLElement,
    direction?: "previous" | "next",
  ) => {
    if (pending || target === page) return;
    pendingFocus.current = { element, ...(direction ? { direction } : {}) };
    onPageChange(target);
  };

  return (
    <div className="flex shrink-0 items-center gap-1" ref={groupRef}>
      <Button
        aria-label="First page"
        title="First page"
        className="h-8 min-w-8 px-2"
        size="xs"
        variant="outline"
        type="button"
        pending={pending}
        disabled={page === 1}
        onClick={(event) => move(1, event.currentTarget, "previous")}
      >
        <ChevronsLeft aria-hidden="true" />
      </Button>
      <Button
        aria-label={previousLabel}
        title="Previous page"
        className="h-8 min-w-8 px-2"
        size="xs"
        variant="outline"
        type="button"
        data-page-direction="previous"
        pending={pending}
        disabled={page === 1}
        onClick={(event) => move(page - 1, event.currentTarget, "previous")}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <div className="hidden items-center gap-1 @min-[400px]:flex">
        {pageNumbers(page, pageCount).map((number) =>
          typeof number === "number" ? (
            <Button
              aria-label={`Page ${number}`}
              aria-current={number === page ? "page" : undefined}
              className="h-8 min-w-8 px-2 text-sm tabular-nums"
              key={number}
              size="xs"
              type="button"
              variant={number === page ? "primary" : "ghost"}
              pending={pending}
              onClick={(event) => move(number, event.currentTarget)}
            >
              {number}
            </Button>
          ) : (
            <span
              aria-hidden="true"
              className="px-0.5 text-xs text-foreground-muted"
              key={number}
            >
              …
            </span>
          ),
        )}
      </div>
      <Button
        aria-label={nextLabel}
        title="Next page"
        className="h-8 min-w-8 px-2"
        size="xs"
        variant="outline"
        type="button"
        data-page-direction="next"
        pending={pending}
        disabled={page === pageCount}
        onClick={(event) => move(page + 1, event.currentTarget, "next")}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
      <Button
        aria-label="Last page"
        title="Last page"
        className="h-8 min-w-8 px-2"
        size="xs"
        variant="outline"
        type="button"
        pending={pending}
        disabled={page === pageCount}
        onClick={(event) => move(pageCount, event.currentTarget, "next")}
      >
        <ChevronsRight aria-hidden="true" />
      </Button>
      <span className="sr-only">
        Page {page} of {pageCount}
      </span>
    </div>
  );
}
