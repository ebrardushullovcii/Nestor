import { useEffect, useRef, useState } from "react";

import { countSelected, type ListSelection } from "./list-selection";

/**
 * How many rows the selection covers. A list's total stops counting at
 * 1,000, so "select all" on a capped list asks for the exact number
 * (`count`) once, and says it is counting until the answer arrives: a bulk
 * button never acts on "1,000+" jobs that turn out to be 6,418.
 */
export function useSelectAllCount(options: {
  /** The list's query; a new one counts again. */
  key: string;
  selection: ListSelection;
  total: number;
  totalCapped: boolean;
  count: () => Promise<number>;
}): { selectedCount: number; counting: boolean; totalCapped: boolean } {
  const countRef = useRef(options.count);
  countRef.current = options.count;
  const wanted = options.selection.all && options.totalCapped;
  const [exact, setExact] = useState<number | "failed" | null>(null);

  useEffect(() => {
    setExact(null);
    if (!wanted) return undefined;
    let live = true;
    countRef.current().then(
      (total) => {
        if (live) setExact(total);
      },
      () => {
        if (live) setExact("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [wanted, options.key]);

  const known = wanted && typeof exact === "number" ? exact : null;
  return {
    selectedCount: countSelected(options.selection, known ?? options.total),
    counting: wanted && exact === null,
    totalCapped: options.totalCapped && known === null,
  };
}
