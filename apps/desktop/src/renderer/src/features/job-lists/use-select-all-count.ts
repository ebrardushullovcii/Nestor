import { useEffect, useRef, useState } from "react";

import { countSelected, type ListSelection } from "./list-selection";

/**
 * How many rows the list matches, and how many the selection covers. A
 * list's total stops counting at 1,000, so a capped list asks for the exact
 * number (`count`) once per query: the list's count, "Select all N
 * matching" and the selected count all read 1,245, never "1,000+" beside a
 * tab that says 1,245. While "select all" waits for that number it says it
 * is counting: a bulk button never acts on "1,000+" jobs that turn out to be
 * 6,418.
 */
export function useSelectAllCount(options: {
  /** The list's query (and anything that moves its count); a new one counts again. */
  key: string;
  selection: ListSelection;
  total: number;
  totalCapped: boolean;
  count: () => Promise<number>;
}): {
  selectedCount: number;
  counting: boolean;
  /** The exact total once read; the list's own total until then. */
  total: number;
  totalCapped: boolean;
} {
  const countRef = useRef(options.count);
  countRef.current = options.count;
  const wanted = options.totalCapped;
  const [exact, setExact] = useState<{
    key: string;
    value: number | "failed";
  } | null>(null);

  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    const key = options.key;
    countRef.current().then(
      (value) => {
        if (live) setExact({ key, value });
      },
      () => {
        if (live) setExact({ key, value: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [wanted, options.key]);

  const current = exact?.key === options.key ? exact.value : null;
  const known = wanted && typeof current === "number" ? current : null;
  const total = known ?? options.total;
  return {
    selectedCount: countSelected(options.selection, total),
    counting: wanted && options.selection.all && current === null,
    total,
    totalCapped: options.totalCapped && known === null,
  };
}
