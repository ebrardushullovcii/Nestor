import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { NeedsYouKind } from "@nestor/contracts";
import type { ListSelection } from "@renderer/features/job-lists";

/** A list window is not an existence check: an unchecked row can move off it. */
export function useNeedsSelection(options: {
  selection: ListSelection;
  setSelection: Dispatch<SetStateAction<ListSelection>>;
  rows: readonly { id: number }[];
  loading: boolean;
  tab: "tasks" | "saved";
  text: string;
  kind: NeedsYouKind | null;
}) {
  const { selection, setSelection, rows, loading, tab, text, kind } = options;
  const key = JSON.stringify([tab, text, kind]);
  const [checked, setChecked] = useState<{
    key: string;
    source: ListSelection | null;
    existing: Set<number>;
    matching: Set<number>;
  }>({ key: "", source: null, existing: new Set(), matching: new Set() });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (loading) return;
    if (!selection.ids.size) {
      setPending(false);
      setError(null);
      return;
    }
    let live = true;
    const ids = [...selection.ids];
    setPending(true);
    setError(null);
    void window.nestor.needsYou
      .run("validate_needs_you_selection", { tab, text, kind, ids })
      .then((value) => {
        if (!live) return;
        const existing = new Set(value.existingIds);
        setChecked({
          key,
          source: selection,
          existing,
          matching: new Set(value.matchingIds),
        });
        setSelection((current) => {
          // Keep IDs added while the read was in flight. Only confirmed missing
          // IDs from that read may be pruned, never off-window rows.
          const missing = new Set(ids.filter((id) => !existing.has(id)));
          const kept = new Set(
            [...current.ids].filter((id) => !missing.has(id)),
          );
          return kept.size === current.ids.size
            ? current
            : { ...current, ids: kept };
        });
        setPending(false);
      })
      .catch(() => {
        if (!live) return;
        setPending(false);
        setError(
          "Could not check the selection. Try selecting again before forgetting answers.",
        );
      });
    return () => {
      live = false;
    };
  }, [selection, setSelection, rows, loading, tab, text, kind, key]);
  const shown = new Set(rows.map((row) => row.id));
  const current = checked.key === key && checked.source === selection;
  return {
    selection: {
      ...selection,
      ids: new Set(
        [...selection.ids].filter(
          (id) => shown.has(id) || (current && checked.matching.has(id)),
        ),
      ),
    },
    pending:
      loading ||
      pending ||
      [...selection.ids].some(
        (id) => !shown.has(id) && !(current && checked.existing.has(id)),
      ),
    error,
  };
}
