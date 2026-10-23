/** Marks the text search of a list screen so "/" can find it. */
export const LIST_SEARCH_ATTRIBUTE = "data-list-search";

/**
 * Focuses the search field of the list on screen, if there is one, and
 * selects its text so typing replaces the old query. Screens kept mounted
 * behind another one (`data-kept-route="hidden"`) do not count.
 */
export function focusVisibleListSearch(root: ParentNode = document): boolean {
  const fields = root.querySelectorAll<HTMLInputElement>(
    `input[${LIST_SEARCH_ATTRIBUTE}]`,
  );
  for (const field of fields) {
    if (field.disabled || field.closest('[data-kept-route="hidden"]')) {
      continue;
    }
    if (field.getClientRects().length === 0) continue;
    field.focus();
    field.select();
    return true;
  }
  return false;
}

/**
 * Escape in a list search: clears the text first, then leaves the field so
 * the list's own keys work again.
 */
export function handleListSearchEscape(
  event: {
    currentTarget: HTMLInputElement;
    key: string;
    preventDefault: () => void;
    stopPropagation: () => void;
  },
  query: string,
  onQueryChange: (query: string) => void,
): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  if (query) {
    onQueryChange("");
    return;
  }
  event.currentTarget.blur();
}
