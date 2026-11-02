import type { JobFilterInput, JobSelectionInput } from "@nestor/contracts";

/**
 * Ticked rows of a list. `all` means every row the list's filter matches,
 * with `ids` as the ones left out, so "select all" covers thousands of rows
 * without loading them; otherwise `ids` are the ticked ones.
 *
 * Rows show their tick boxes only in select mode. The mode starts with the
 * list's Select button, a Shift or Cmd/Ctrl click, X on the open row or
 * Cmd/Ctrl+A, and ends with Done, Escape or a bulk action. `selecting` keeps
 * the mode on while nothing is ticked (after Select or Clear); any ticked row
 * means the mode is on anyway.
 */
export interface ListSelection {
  all: boolean;
  ids: ReadonlySet<number>;
  /** The last row ticked, for Shift+click ranges. */
  anchor: number | null;
  /** Select mode with nothing ticked yet. */
  selecting?: boolean;
}

export const NO_SELECTION: ListSelection = {
  all: false,
  ids: new Set(),
  anchor: null,
  selecting: false,
};

/** Select mode, nothing ticked: what the Select button and Clear leave. */
export const SELECTING: ListSelection = {
  all: false,
  ids: new Set(),
  anchor: null,
  selecting: true,
};

/** Every row the list's filter matches, loaded or not. */
export function selectAll(): ListSelection {
  return { all: true, ids: new Set(), anchor: null, selecting: true };
}

/** Whether the list shows its tick boxes and the select-mode toolbar. */
export function isSelecting(state: ListSelection): boolean {
  return Boolean(state.selecting) || state.all || state.ids.size > 0;
}

/** Unticks everything and stays in select mode (if it was on). */
export function clearSelected(state: ListSelection): ListSelection {
  return isSelecting(state) ? SELECTING : NO_SELECTION;
}

export function isSelected(state: ListSelection, id: number): boolean {
  return state.all ? !state.ids.has(id) : state.ids.has(id);
}

export function countSelected(state: ListSelection, total: number) {
  return state.all ? Math.max(0, total - state.ids.size) : state.ids.size;
}

/** Whether every loaded row is ticked. */
export function allLoadedSelected(
  state: ListSelection,
  rows: readonly { id: number }[],
): boolean {
  return rows.length > 0 && rows.every((row) => isSelected(state, row.id));
}

/**
 * Select all in two steps, as the header box and Cmd/Ctrl+A do it: first the
 * rows on screen (every matching row when they are all loaded), then, on a
 * second press, every row the filter matches. Never reads ids it does not
 * have: "all matching" is the filter with exceptions.
 */
export function stepSelectAll(
  state: ListSelection,
  rows: readonly { id: number }[],
  /** Every matching row is already loaded. */
  complete: boolean,
): ListSelection {
  if (state.all) return state;
  if (rows.length === 0) return isSelecting(state) ? state : SELECTING;
  if (complete || allLoadedSelected(state, rows)) return selectAll();
  return {
    all: false,
    ids: new Set(rows.map((row) => row.id)),
    anchor: null,
    selecting: true,
  };
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
  return { all: state.all, ids, anchor: id, selecting: true };
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
