import type { DesktopContextMenuItem } from "@nestor/contracts";
import { openUrlInJobFinderBrowser } from "../components/open-outside-links";

/** One action of a row's right-click menu. */
export interface RowMenuAction {
  id: string;
  label: string;
  enabled?: boolean;
  run: () => void | Promise<unknown>;
}

export type RowMenuEntry = RowMenuAction | "separator";

/** Open listing and Copy link, last in every list's row menu. */
export function listingRowMenuEntries(
  url: string | null | undefined,
): RowMenuEntry[] {
  const href = url?.trim();
  if (!href) return [];
  return [
    "separator",
    {
      id: "open-listing",
      label: "Open listing",
      run: () => openUrlInJobFinderBrowser(href),
    },
    {
      id: "copy-link",
      label: "Copy link",
      run: () => navigator.clipboard?.writeText(href),
    },
  ];
}

/** Drops leading, trailing and doubled separators. */
export function tidyRowMenu(entries: readonly RowMenuEntry[]): RowMenuEntry[] {
  const tidy: RowMenuEntry[] = [];
  for (const entry of entries) {
    if (
      entry === "separator" &&
      (tidy.length === 0 || tidy.at(-1) === "separator")
    )
      continue;
    tidy.push(entry);
  }
  if (tidy.at(-1) === "separator") tidy.pop();
  return tidy;
}

/**
 * Shows a row's actions as the system's own right-click menu (also from the
 * keyboard's menu key or Shift+F10 on a focused row) and runs the chosen one.
 * Without the desktop bridge the browser's own menu stays.
 */
export function openRowContextMenu(
  event: {
    preventDefault: () => void;
    stopPropagation: () => void;
  },
  entries: readonly RowMenuEntry[],
): void {
  const showContextMenu = window.nestor?.window?.showContextMenu;
  const menu = tidyRowMenu(entries);
  if (!showContextMenu || menu.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  const items: DesktopContextMenuItem[] = menu.map((entry) =>
    entry === "separator"
      ? { type: "separator" }
      : {
          id: entry.id,
          label: entry.label,
          ...(entry.enabled === false ? { enabled: false } : {}),
        },
  );
  void showContextMenu({ items })
    .then(async (result) => {
      const chosen = menu.find(
        (entry): entry is RowMenuAction =>
          entry !== "separator" && entry.id === result.id,
      );
      await chosen?.run();
    })
    .catch(() => undefined);
}
