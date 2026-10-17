import { Fragment, useState, type ReactNode } from "react";
import {
  APPLICATION_CRM_PAGE_SIZE,
  CollectionPagination,
} from "../../components/collection-pagination";

export const BOUNDED_COLLECTION_PAGE_SIZE = APPLICATION_CRM_PAGE_SIZE;

/** Only the mounted window is sliced. Callers retain the complete collection. */
export function useBoundedCollection<T>(
  collection: readonly T[],
  resetKey: string,
  selectedIndex = -1,
  selectedId: string | null | undefined = null,
  pageSize = BOUNDED_COLLECTION_PAGE_SIZE,
) {
  const [state, setState] = useState({
    page: 1,
    resetKey,
    selectedId,
    selectionFound: false,
  });
  let current = state;
  if (
    state.resetKey !== resetKey ||
    state.selectedId !== selectedId ||
    (!state.selectionFound && selectedIndex >= 0)
  ) {
    current = {
      page: selectedIndex >= 0 ? Math.floor(selectedIndex / pageSize) + 1 : 1,
      resetKey,
      selectedId,
      selectionFound: selectedIndex >= 0,
    };
    setState(current);
  }
  const pageCount = Math.max(1, Math.ceil(collection.length / pageSize));
  const page = Math.min(current.page, pageCount);
  if (current.page !== page) {
    setState({ ...current, page });
  }
  return {
    items: collection.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    totalCount: collection.length,
    onPageChange: (next: number) =>
      setState((previous) => ({
        ...previous,
        page: Math.min(Math.max(next, 1), pageCount),
      })),
  };
}

export function BoundedCollectionPagination(props: {
  itemLabel: string;
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}) {
  if (props.totalCount <= props.pageSize) {
    return (
      <p
        aria-live="polite"
        className="text-(length:--text-tiny) text-foreground-muted"
      >
        {props.totalCount === 0
          ? `No ${props.itemLabel}.`
          : `All ${props.itemLabel} shown (${props.totalCount}).`}
      </p>
    );
  }
  return <CollectionPagination {...props} />;
}

export function BoundedCollectionList<T>(props: {
  collection: readonly T[];
  resetKey: string;
  itemLabel: string;
  getId: (item: T) => string;
  selectedId?: string | null | undefined;
  className?: string;
  children: (item: T) => ReactNode;
}) {
  const page = useBoundedCollection(
    props.collection,
    props.resetKey,
    props.selectedId
      ? props.collection.findIndex(
          (item) => props.getId(item) === props.selectedId,
        )
      : -1,
    props.selectedId,
  );
  return (
    <>
      <ul
        aria-label={props.itemLabel}
        className={props.className ?? "grid gap-2"}
      >
        {page.items.map((item) => (
          <Fragment key={props.getId(item)}>{props.children(item)}</Fragment>
        ))}
      </ul>
      <BoundedCollectionPagination {...page} itemLabel={props.itemLabel} />
    </>
  );
}
