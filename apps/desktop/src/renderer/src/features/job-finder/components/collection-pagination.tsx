import { useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { PageNavigation } from "./page-navigation";

export const COLLECTION_PAGE_SIZE = 40;
export const APPLICATION_CRM_PAGE_SIZE = 50;
export const JOB_LIST_PAGE_SIZE = 50;

interface CollectionPaginationProps {
  itemLabel: string;
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}

/**
 * Keeps large local collections cheap to mount without changing their search
 * or selection semantics. The list itself remains the scroll container; this
 * footer is outside it so it cannot cover the last row.
 */
export function CollectionPagination({
  itemLabel,
  page,
  pageSize,
  totalCount,
  onPageChange,
}: CollectionPaginationProps) {
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const firstItem = (currentPage - 1) * pageSize + 1;
  const lastItem = Math.min(currentPage * pageSize, totalCount);
  const [isPagePending, startPageTransition] = useTransition();

  if (pageCount <= 1) {
    return null;
  }

  return (
    // One line: "1–40 of 353" on the left, the page buttons on the right.
    <nav
      aria-busy={isPagePending}
      aria-label={`${itemLabel} pagination`}
      className="@container flex h-11 flex-none items-center justify-between gap-3 border-t border-(--surface-panel-border) px-3"
      data-collection-pagination
    >
      <p
        aria-live="polite"
        className="inline-flex min-w-0 items-center gap-2 truncate text-(length:--text-small) tabular-nums text-foreground-muted"
      >
        {isPagePending ? (
          <>
            <LoaderCircle
              aria-hidden="true"
              className="size-3 motion-safe:animate-spin"
            />
            Loading {itemLabel.toLowerCase()}…
          </>
        ) : (
          `${firstItem}–${lastItem} of ${totalCount}`
        )}
        <span className="sr-only"> {itemLabel}</span>
      </p>
      <PageNavigation
        page={currentPage}
        pageCount={pageCount}
        pending={isPagePending}
        onPageChange={(nextPage) =>
          startPageTransition(() => onPageChange(nextPage))
        }
      />
    </nav>
  );
}
