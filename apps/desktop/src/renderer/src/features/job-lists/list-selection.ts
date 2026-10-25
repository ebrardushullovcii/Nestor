import type { JobFilterInput, JobSelectionInput } from "@nestor/contracts";

/**
 * Ticked rows of a list. `all` means every row the list's filter matches,
 * with `ids` as the ones left out, so "select all" covers thousands of rows
 * without loading them; otherwise `ids` are the ticked ones.
 */
export interface ListSelection {
  all: boolean;
  ids: ReadonlySet<number>;
  /** The last row ticked, for Shift+click ranges. */
  anchor: number | null;
}

export const NO_SELECTION: ListSelection = {
  all: false,
  ids: new Set(),
  anchor: null,
};

export function selectAll(): ListSelection {
  return { all: true, ids: new Set(), anchor: null };
}

export function isSelected(state: ListSelection, id: number): boolean {
  return state.all ? !state.ids.has(id) : state.ids.has(id);
}

export function countSelected(state: ListSelection, total: number) {
  return state.all ? Math.max(0, total - state.ids.size) : state.ids.size;
}

/** Ticks or unticks one row; with Shift, every row from the last one ticked. */
export function toggleSelection(
  state: ListSelection,
  id: number,
  shiftKey: boolean,
  rows: readonly { id: number }[],
): ListSelection {
  const target = !isSelected(state, id);
  let range = [id];
  if (shiftKey && state.anchor !== null) {
    const from = rows.findIndex((row) => row.id === state.anchor);
    const to = rows.findIndex((row) => row.id === id);
    if (from >= 0 && to >= 0) {
      range = rows
        .slice(Math.min(from, to), Math.max(from, to) + 1)
        .map((row) => row.id);
    }
  }
  const ids = new Set(state.ids);
  // In "all" mode `ids` lists the rows left out, so ticking removes from it.
  const add = state.all ? !target : target;
  for (const rowId of range) {
    if (add) ids.add(rowId);
    else ids.delete(rowId);
  }
  return { all: state.all, ids, anchor: id };
}

/**
 * The selection as `move_jobs` takes it, or null when nothing is ticked.
 * Other lists build their own command input from `all` and `ids`.
 */
export function toSelectionInput(
  state: ListSelection,
  filter: JobFilterInput,
): JobSelectionInput | null {
  if (state.all) return { filter, except: [...state.ids] };
  return state.ids.size > 0 ? { ids: [...state.ids] } : null;
}
